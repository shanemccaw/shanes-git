/** Small shared arg-validation helpers used by every sub-issue/dependency tool. */

export function requireInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer issue number`);
  }
  return value;
}

export function requireIntArray(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of integer issue numbers`);
  }
  return value.map((v, i) => requireInt(v, `${name}[${i}]`));
}

/**
 * The shared `context` JSON-Schema fragment every real write tool exposes —
 * Git #3538. One copy so the description/type can't drift between tools.
 */
export const CONTEXT_SCHEMA_PROPERTY = {
  type: "string",
  description:
    "Required. A short free-text label identifying which chat/session/build is making this " +
    "write — e.g. a build id (\"build-2207\"), a chat/session label, or an Epic/issue number " +
    "(\"#3538\"). Every real write is authenticated as the same server-side PAT, so this is the " +
    "only way to trace which chat did what. Rejected before any GitHub call if missing or empty.",
} as const;

/**
 * Validates `context` (Git #3538) BEFORE any GitHub call is made — same
 * pre-flight-reject pattern as #3394's NOT_PLANNED-comment rule. Required on
 * every write tool; read-only tools never call this.
 */
export function requireContext(args: Record<string, unknown>): string {
  const raw = typeof args.context === "string" ? args.context.trim() : "";
  if (!raw) {
    throw new Error(
      "`context` is required on every write call (Git #3538) — a short label identifying which " +
        "chat/session/build is making this change (e.g. a build id, chat label, or issue number). " +
        "Supply a non-empty `context` and retry.",
    );
  }
  return raw;
}

/**
 * Prefixes a real GitHub comment body with a visible `[chat: <context>]` tag
 * so the trail is readable directly on GitHub, not just in the local audit
 * log (Git #3538, item 4). Applied only where a tool writes a real comment
 * body — post_comment and close_issue's NOT_PLANNED comment.
 */
export function tagCommentWithContext(context: string, body: string): string {
  return `[chat: ${context}]\n\n${body}`;
}
