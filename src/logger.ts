import pino from "pino";

// This is Shane's admin-side GitHub operating tool, so it logs under the
// platform taxonomy's admin.* family (CLAUDE.md "Logging & telemetry"). Unlike
// the stdio MCP server, this one talks HTTP — stdout is free — but logging to
// stderr keeps a clean separation from anything a future stdout use might want.
const base = pino(
  { timestamp: pino.stdTimeFunctions.isoTime, base: undefined },
  pino.destination(2),
);

export const logger = base.child({ channel: "admin.mcp" });

// Audit-trail lines (activity.ts) log under the taxonomy's own `audit` channel,
// a child of the ROOT logger so each line carries exactly one channel binding.
export const auditLogger = base.child({ channel: "audit" });
