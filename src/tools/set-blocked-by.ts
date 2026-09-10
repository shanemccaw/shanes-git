import type { ToolDef } from "./registry.ts";
import { addBlockedBy, listBlockedBy, removeBlockedBy } from "../github.ts";
import { CONTEXT_SCHEMA_PROPERTY, requireContext, requireInt, requireIntArray } from "./args.ts";

/**
 * set_blocked_by(number, blocker_numbers[]) — makes `number`'s real blocked_by
 * edges match blocker_numbers[] exactly (a true "set", not just an add). This
 * matters per CLAUDE.md's own Git #1987 rule: a stale blocked_by edge left
 * pointing at a closed/wrong issue silently reads as "clear" to the queue even
 * while a comment says otherwise — so calling this with the current real
 * blocker list must also drop any edge that's no longer accurate, not just add
 * new ones. Pass an empty array to clear all blockers.
 */
export const setBlockedByTool: ToolDef = {
  name: "set_blocked_by",
  description:
    "Sets number's real blocked_by dependency edges to exactly blocker_numbers[] — adds any missing " +
    "edge and removes any existing edge not in the list (pass [] to clear all blockers). Returns the " +
    "resulting real blocked_by list. Required: context (Git #3538 — a short label identifying " +
    "which chat/session/build is making this write; rejected before any GitHub call if missing).",
  inputSchema: {
    type: "object",
    properties: {
      number: { type: "integer", description: "The issue whose blockers are being set." },
      blocker_numbers: {
        type: "array",
        items: { type: "integer" },
        description: "The exact set of issue numbers that should block `number`.",
      },
      context: CONTEXT_SCHEMA_PROPERTY,
    },
    required: ["number", "blocker_numbers", "context"],
    additionalProperties: false,
  },
  handler: async (args) => {
    requireContext(args);
    const number = requireInt(args.number, "number");
    const desired = requireIntArray(args.blocker_numbers, "blocker_numbers");
    const desiredSet = new Set(desired);

    const current = await listBlockedBy(number);
    const currentNumbers = new Set(current.map((c) => c.number));

    const toAdd = desired.filter((n) => !currentNumbers.has(n));
    const toRemove = current.filter((c) => !desiredSet.has(c.number));

    for (const blockerNumber of toAdd) {
      await addBlockedBy(number, blockerNumber);
    }
    for (const stale of toRemove) {
      await removeBlockedBy(number, stale.number);
    }

    const blockedBy = await listBlockedBy(number);
    return { number, added: toAdd, removed: toRemove.map((r) => r.number), blockedBy };
  },
};
