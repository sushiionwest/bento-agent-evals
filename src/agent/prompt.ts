/**
 * Prompt construction + LLM output parsing for the agent propose pipeline.
 * Pure module (no I/O) so the eval harness can exercise it directly.
 */

import type { BoardSnapshot } from "./types";
import {
  MAX_PROPOSED_OPERATIONS,
  proposedOperationSchema,
  proposedOperationsEnvelopeSchema,
  type ProposedOperation,
} from "../validation/proposed-operation";
import { z } from "zod";

export const AGENT_SYSTEM_PROMPT = `You translate messy free text (standup notes, ship reports, task dumps) into Kanban card operations for the board described in the user message.

Respond with ONLY a JSON object of this exact shape, no prose, no markdown fences:
{"operations": [ ... ]}

Each operation is one of:
- {"op":"create_card","columnId":"<column id>","title":"<max 100 chars>","description":"...","acceptanceCriteria":"...","priority":"P0|P1|P2|P3","assigneeId":"<user id>","note":"why"}
- {"op":"move_card","cardId":"<card id>","targetColumnId":"<column id>","note":"why"}
- {"op":"assign_card","cardId":"<card id>","assigneeId":"<user id>","note":"why"}
- {"op":"add_comment","cardId":"<card id>","body":"<max 2000 chars>","note":"why"}

Rules:
- Use ONLY the card ids, column ids, and user ids listed in the board state. Never invent ids.
- The workflow is Ready -> Doing -> Review -> Done. Cards must earn each step; do not skip stages and do not move Done cards back without an explicit, justified request.
- If the text asks for something the workflow forbids, prefer add_comment on the relevant card explaining what is blocked instead of forcing the move.
- Emit at most ${MAX_PROPOSED_OPERATIONS} operations. Emit an empty operations array if nothing actionable is present.
- Every operation must be traceable to the input text. Do not pad.`;

export function buildAgentUserPrompt(snapshot: BoardSnapshot, text: string): string {
  const columns = snapshot.columns
    .map((c) => `- ${c.id} "${c.name}" (stage=${c.stage ?? "UNMAPPED"}${c.wipLimit !== null ? `, wipLimit=${c.wipLimit}` : ""})`)
    .join("\n");

  const cards = snapshot.cards
    .map((card) => {
      const column = snapshot.columns.find((c) => c.id === card.columnId);
      const flags = [
        card.assigneeId ? `assignee=${card.assigneeId}` : "unassigned",
        card.isApproved ? "approved" : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${card.id} "${card.title}" [${column?.name ?? card.columnId}] (${flags}, priority=${card.priority})`;
    })
    .join("\n");

  const members = snapshot.teamMemberIds.length
    ? snapshot.teamMemberIds.map((id) => `- ${id}`).join("\n")
    : "- (no team members; personal board)";

  return `BOARD "${snapshot.boardName}" (${snapshot.boardId})

COLUMNS:
${columns}

CARDS:
${cards.length ? cards : "- (no cards)"}

TEAM MEMBERS (valid assignee ids):
${members}

INPUT TEXT:
"""
${text}
"""

Return the operations JSON now.`;
}

export interface ParsedOperations {
  ok: true;
  operations: ProposedOperation[];
}

export interface ParseFailure {
  ok: false;
  error: string;
  issues?: unknown[];
}

/**
 * Parse raw LLM output into schema-valid operations.
 * Tolerates markdown fences and leading prose; accepts either the
 * {"operations": [...]} envelope or a bare JSON array.
 */
export function parseOperationsFromLlm(raw: string): ParsedOperations | ParseFailure {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();

  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  let candidate: string | null = null;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    candidate = cleaned.slice(firstBrace, cleaned.lastIndexOf("}") + 1);
  } else if (firstBracket !== -1) {
    candidate = cleaned.slice(firstBracket, cleaned.lastIndexOf("]") + 1);
  }

  if (!candidate) {
    return { ok: false, error: "LLM output contained no JSON" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, error: "LLM output was not valid JSON" };
  }

  if (Array.isArray(parsed)) {
    const arrayResult = z.array(proposedOperationSchema).max(MAX_PROPOSED_OPERATIONS).safeParse(parsed);
    if (!arrayResult.success) {
      return { ok: false, error: "LLM operations failed schema validation", issues: arrayResult.error.issues };
    }
    return { ok: true, operations: arrayResult.data };
  }

  const envelopeResult = proposedOperationsEnvelopeSchema.safeParse(parsed);
  if (!envelopeResult.success) {
    return { ok: false, error: "LLM operations failed schema validation", issues: envelopeResult.error.issues };
  }
  return { ok: true, operations: envelopeResult.data.operations };
}
