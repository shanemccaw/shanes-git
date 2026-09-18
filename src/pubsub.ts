// Channel-agnostic publish/subscribe transport over Postgres LISTEN/NOTIFY (Git #4782).
//
// This module knows nothing about what any channel *means* — a channel is just a string, a payload
// is just whatever text NOTIFY carried. A future feature publishes with `publish()`; anything
// holding an SSE connection open (see subscribe.ts) receives it.
//
// Why a dedicated connection: LISTEN is per-*session* state. On the shared pool (db.ts) the
// connection that ran LISTEN can be handed to an unrelated query mid-listen — or recycled/closed by
// the pool — and the subscription dies silently. So the listener is ONE persistent `pg.Client`,
// never checked in to any pool, held for the life of the process. `publish()` deliberately uses the
// pool: NOTIFY has no session state, and any connection's NOTIFY reaches every listener.
//
// Delivery guarantees, stated honestly: NOTIFY is fire-and-forget. A notification sent while the
// listener connection is down is lost. On reconnect every subscriber is sent a `resync` event so a
// client that cares can re-fetch its real state — this transport cannot replay what it never saw.
//
// Postgres namespace: every channel is mapped to the Postgres channel `sg:<name>`. The listener
// shares a database with unrelated code that may use NOTIFY itself; without the prefix a subscriber
// could name one of those channels and read it. Channel names are case-sensitive; to publish from
// psql use the quoted form:  NOTIFY "sg:test", 'payload';

import pg from "pg";
import { requiredEnv } from "./env.ts";
import { query } from "./db.ts";
import { logger } from "./logger.ts";

const log = logger.child({ subsystem: "pubsub" });

const PG_PREFIX = "sg:";
/** Postgres identifiers cap at 63 bytes; the `sg:` prefix uses 3. */
const MAX_CHANNEL_LENGTH = 60;
/** Restricted so the name can be double-quoted straight into LISTEN/UNLISTEN with no escaping. */
const CHANNEL_PATTERN = /^[A-Za-z0-9_.:-]+$/;
/** NOTIFY payloads must be strictly shorter than 8000 bytes. */
export const MAX_PAYLOAD_BYTES = 7999;

/** How the listener shows up in pg_stat_activity — tells it from pool connections, and one process's
 *  listener from another's (the pid suffix). */
export function listenerApplicationName(): string {
  return `shanes-git-sse-listener:${process.pid}`;
}

const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;
/** How long a new subscriber waits for the listener before being told to retry. */
const READY_WAIT_MS = 5_000;

export interface Subscriber {
  /** Called for every notification on the channel, and for `resync` after a listener reconnect. */
  deliver(event: string, data: string): void;
  /** Called when the transport is shutting down. */
  end(): void;
}

export class PubSubUnavailableError extends Error {}

/** Returns a human-readable problem with `channel`, or null if it is a valid channel name. */
export function validateChannel(channel: unknown): string | null {
  if (typeof channel !== "string" || channel.length === 0) return "Channel name is required.";
  if (channel.length > MAX_CHANNEL_LENGTH) {
    return `Channel name is too long (max ${MAX_CHANNEL_LENGTH} characters).`;
  }
  if (!CHANNEL_PATTERN.test(channel)) {
    return "Channel name may only contain letters, digits, and the characters _ . : -";
  }
  return null;
}

function pgChannel(channel: string): string {
  return `"${PG_PREFIX}${channel}"`;
}

interface ChannelEntry {
  subs: Set<Subscriber>;
  /** Settles once LISTEN has been acknowledged by Postgres. */
  listening: Promise<void>;
}

const channels = new Map<string, ChannelEntry>();

let current: pg.Client | null = null;
let connected = false;
let connecting = false;
let everConnected = false;
let closed = false;
let backoffMs = 1_000;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let waiters: Array<{ resolve: () => void; timer: NodeJS.Timeout }> = [];

function dispatch(pgName: string, payload: string): void {
  if (!pgName.startsWith(PG_PREFIX)) return;
  const entry = channels.get(pgName.slice(PG_PREFIX.length));
  if (!entry) return;
  for (const sub of [...entry.subs]) {
    try {
      sub.deliver("message", payload);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "subscriber delivery threw");
    }
  }
}

function broadcast(event: string, data: string): void {
  for (const entry of channels.values()) {
    for (const sub of [...entry.subs]) {
      try {
        sub.deliver(event, data);
      } catch {
        // one bad subscriber must not stop the rest
      }
    }
  }
}

function stopPing(): void {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

function scheduleReconnect(): void {
  if (closed || reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  log.warn({ delayMs: delay }, "LISTEN connection down; reconnecting");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

/** The listener connection is gone (error, end, failed ping, failed connect). Idempotent per client. */
function onDown(client: pg.Client, err: unknown): void {
  if (client !== current) return;
  current = null;
  connected = false;
  connecting = false;
  stopPing();
  if (err) log.warn({ err: err instanceof Error ? err.message : String(err) }, "LISTEN connection lost");
  client.removeAllListeners();
  // A dead client can still emit 'error' while being torn down; swallow it so it cannot crash the process.
  client.on("error", () => {});
  client.end().catch(() => {});
  scheduleReconnect();
}

async function connect(): Promise<void> {
  if (closed || connecting || connected) return;
  connecting = true;
  const client = new pg.Client({
    connectionString: requiredEnv("DATABASE_URL"),
    application_name: listenerApplicationName(),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  current = client;
  client.on("error", (err) => onDown(client, err));
  client.on("end", () => onDown(client, null));
  client.on("notification", (msg) => dispatch(msg.channel, msg.payload ?? ""));

  try {
    await client.connect();
    // Re-establish every channel that still has subscribers (a fresh session listens to nothing).
    for (const name of channels.keys()) await client.query(`LISTEN ${pgChannel(name)}`);
  } catch (err) {
    onDown(client, err);
    return;
  }
  if (client !== current) return; // torn down while we were awaiting

  connecting = false;
  connected = true;
  backoffMs = 1_000;
  const wasReconnect = everConnected;
  everConnected = true;
  log.info({ channels: channels.size, reconnect: wasReconnect }, "LISTEN connection established");

  // A connection can die without any event ever firing (a dead TCP path). Probe it.
  stopPing();
  pingTimer = setInterval(() => {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("LISTEN connection ping timed out")), PING_TIMEOUT_MS);
    });
    Promise.race([client.query("SELECT 1"), timeout])
      .catch((err) => onDown(client, err))
      .finally(() => clearTimeout(timer));
  }, PING_INTERVAL_MS);

  const waiting = waiters;
  waiters = [];
  for (const w of waiting) {
    clearTimeout(w.timer);
    w.resolve();
  }

  // Anything published while we were disconnected is gone. Tell subscribers so they can re-fetch.
  if (wasReconnect) broadcast("resync", JSON.stringify({ reason: "listener-reconnected" }));
}

/** Starts the listener connection (idempotent). Failures retry in the background; never throws. */
export function startListener(): void {
  if (closed) return;
  void connect();
}

function whenConnected(timeoutMs: number): Promise<void> {
  if (connected) return Promise.resolve();
  startListener();
  return new Promise<void>((resolve, reject) => {
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        waiters = waiters.filter((w) => w !== waiter);
        reject(new PubSubUnavailableError("The push channel's database connection is not available yet."));
      }, timeoutMs),
    };
    waiters.push(waiter);
  });
}

/**
 * Registers `sub` for `channel`. Resolves once Postgres has acknowledged LISTEN, so anything
 * published after this resolves is guaranteed to reach `sub`. Returns the unsubscribe function.
 */
export async function subscribe(channel: string, sub: Subscriber): Promise<() => void> {
  const problem = validateChannel(channel);
  if (problem) throw new Error(problem);
  await whenConnected(READY_WAIT_MS);

  let entry = channels.get(channel);
  if (!entry) {
    const client = current;
    if (!client || !connected) throw new PubSubUnavailableError("The push channel's database connection just dropped.");
    entry = { subs: new Set(), listening: client.query(`LISTEN ${pgChannel(channel)}`).then(() => {}) };
    channels.set(channel, entry);
  }
  entry.subs.add(sub);
  try {
    await entry.listening;
  } catch (err) {
    removeSubscriber(channel, sub);
    throw new PubSubUnavailableError(err instanceof Error ? err.message : String(err));
  }
  return () => removeSubscriber(channel, sub);
}

function removeSubscriber(channel: string, sub: Subscriber): void {
  const entry = channels.get(channel);
  if (!entry) return;
  entry.subs.delete(sub);
  if (entry.subs.size > 0) return;
  channels.delete(channel);
  // Queued behind any in-flight LISTEN on the same connection, so a quick re-subscribe still wins.
  if (connected && current) current.query(`UNLISTEN ${pgChannel(channel)}`).catch(() => {});
}

/**
 * Publishes `payload` (JSON-encoded) to every subscriber of `channel`, in every process attached
 * to this database. Postgres caps a NOTIFY payload at 8000 bytes, so this throws rather than
 * letting an oversized payload fail inside Postgres or get truncated: publish a small invalidation
 * (an id) and let the subscriber fetch the real content over an ordinary request.
 */
export async function publish(channel: string, payload: unknown): Promise<void> {
  const problem = validateChannel(channel);
  if (problem) throw new Error(problem);
  const text = JSON.stringify(payload);
  if (text === undefined) throw new Error("publish payload is not JSON-serializable.");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `publish payload is ${bytes} bytes; Postgres NOTIFY allows at most ${MAX_PAYLOAD_BYTES}. ` +
        "Publish an id and have the subscriber fetch the content instead.",
    );
  }
  await query("SELECT pg_notify($1, $2)", [`${PG_PREFIX}${channel}`, text]);
}

export function pubsubStats(): { connected: boolean; channels: number; subscribers: number } {
  let subscribers = 0;
  for (const entry of channels.values()) subscribers += entry.subs.size;
  return { connected, channels: channels.size, subscribers };
}

/** Ends every subscriber and closes the listener connection. Process shutdown only. */
export async function closePubSub(): Promise<void> {
  closed = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  stopPing();
  for (const w of waiters) clearTimeout(w.timer);
  waiters = [];
  for (const entry of channels.values()) {
    for (const sub of [...entry.subs]) {
      try {
        sub.end();
      } catch {
        // shutting down anyway
      }
    }
  }
  channels.clear();
  const client = current;
  current = null;
  connected = false;
  connecting = false;
  if (client) {
    client.removeAllListeners();
    client.on("error", () => {});
    await client.end().catch(() => {});
  }
}

/** Test seam: reset module state so a script can stop and start the transport in one process. */
export function resetPubSubForTests(): void {
  closed = false;
  everConnected = false;
  backoffMs = 1_000;
}
