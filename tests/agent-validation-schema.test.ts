/**
 * Tests for the agent ProposedOperation Zod schemas and the LLM output
 * parser — the FIRST gate of the propose pipeline (shape validation).
 */

import { describe, expect, test } from "vitest";
import {
  agentProposeRequestSchema,
  MAX_PROPOSED_OPERATIONS,
  proposedOperationSchema,
  proposedOperationsEnvelopeSchema,
} from "../src/validation/proposed-operation";
import { parseOperationsFromLlm } from "../src/agent/prompt";

const BOARD_ID = "ckgv4x8xw0000qzrmn831i7rn";

describe("proposedOperationSchema", () => {
  test("accepts a valid create_card operation", () => {
    const result = proposedOperationSchema.safeParse({
      op: "create_card",
      columnId: "col_ready",
      title: "Add rate limiting",
      priority: "P1",
    });
    expect(result.success).toBe(true);
  });

  test("accepts a valid move_card operation without targetIndex", () => {
    const result = proposedOperationSchema.safeParse({
      op: "move_card",
      cardId: "card_1",
      targetColumnId: "col_review",
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown operation types", () => {
    const result = proposedOperationSchema.safeParse({
      op: "delete_card",
      cardId: "card_1",
    });
    expect(result.success).toBe(false);
  });

  test("rejects create_card with an empty title", () => {
    const result = proposedOperationSchema.safeParse({
      op: "create_card",
      columnId: "col_ready",
      title: "   ",
    });
    expect(result.success).toBe(false);
  });

  test("rejects create_card with an out-of-range priority", () => {
    const result = proposedOperationSchema.safeParse({
      op: "create_card",
      columnId: "col_ready",
      title: "Task",
      priority: "P9",
    });
    expect(result.success).toBe(false);
  });

  test("rejects move_card with a negative targetIndex", () => {
    const result = proposedOperationSchema.safeParse({
      op: "move_card",
      cardId: "card_1",
      targetColumnId: "col_review",
      targetIndex: -1,
    });
    expect(result.success).toBe(false);
  });

  test("rejects add_comment with an empty body", () => {
    const result = proposedOperationSchema.safeParse({
      op: "add_comment",
      cardId: "card_1",
      body: "",
    });
    expect(result.success).toBe(false);
  });

  test("rejects add_comment beyond 2000 characters", () => {
    const result = proposedOperationSchema.safeParse({
      op: "add_comment",
      cardId: "card_1",
      body: "x".repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe("proposedOperationsEnvelopeSchema", () => {
  test("caps the number of operations", () => {
    const operations = Array.from({ length: MAX_PROPOSED_OPERATIONS + 1 }, (_, i) => ({
      op: "add_comment",
      cardId: `card_${i}`,
      body: "note",
    }));
    const result = proposedOperationsEnvelopeSchema.safeParse({ operations });
    expect(result.success).toBe(false);
  });

  test("accepts an empty operations array", () => {
    const result = proposedOperationsEnvelopeSchema.safeParse({ operations: [] });
    expect(result.success).toBe(true);
  });
});

describe("agentProposeRequestSchema", () => {
  test("accepts a minimal request and defaults apply to false", () => {
    const result = agentProposeRequestSchema.safeParse({
      boardId: BOARD_ID,
      text: "Standup notes here",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apply).toBe(false);
    }
  });

  test("rejects a non-cuid boardId", () => {
    const result = agentProposeRequestSchema.safeParse({
      boardId: "not-a-cuid",
      text: "Standup notes",
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty text", () => {
    const result = agentProposeRequestSchema.safeParse({ boardId: BOARD_ID, text: "  " });
    expect(result.success).toBe(false);
  });

  test("rejects text beyond 8000 characters", () => {
    const result = agentProposeRequestSchema.safeParse({
      boardId: BOARD_ID,
      text: "x".repeat(8001),
    });
    expect(result.success).toBe(false);
  });
});

describe("parseOperationsFromLlm", () => {
  const validOp = { op: "move_card", cardId: "card_1", targetColumnId: "col_review" };

  test("parses a clean envelope", () => {
    const result = parseOperationsFromLlm(JSON.stringify({ operations: [validOp] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operations).toHaveLength(1);
    }
  });

  test("parses an envelope wrapped in markdown fences and prose", () => {
    const raw = `Here you go:\n\`\`\`json\n${JSON.stringify({ operations: [validOp] })}\n\`\`\``;
    const result = parseOperationsFromLlm(raw);
    expect(result.ok).toBe(true);
  });

  test("parses a bare JSON array", () => {
    const result = parseOperationsFromLlm(JSON.stringify([validOp]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.operations).toHaveLength(1);
    }
  });

  test("fails on pure prose", () => {
    const result = parseOperationsFromLlm("Sure! I'd be happy to move that card for you.");
    expect(result.ok).toBe(false);
  });

  test("fails on schema-invalid operations with issues attached", () => {
    const result = parseOperationsFromLlm(
      JSON.stringify({ operations: [{ op: "delete_card", cardId: "card_1" }] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toBeDefined();
    }
  });

  test("fails on truncated JSON", () => {
    const result = parseOperationsFromLlm('{"operations": [{"op": "move_card"');
    expect(result.ok).toBe(false);
  });
});
