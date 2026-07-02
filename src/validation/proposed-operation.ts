/**
 * Zod schemas for the agent propose pipeline.
 *
 * `ProposedOperation` is the structured-output contract the LLM must satisfy.
 * Schema validation is deliberately the FIRST gate (shape only); the legality
 * gate in `src/agent/legality.ts` is the SECOND gate (state-machine semantics).
 *
 * Note on id fields: unlike the product's strict cuid id validators, the
 * operation reference fields accept any short string. An LLM hallucinating a
 * column id must reach the legality gate so it is rejected with a domain
 * reason ("Target column ... not found on this board") instead of a generic
 * shape error — that distinction is measured by the eval harness.
 */

import { z } from "zod";

/** Inlined from the product's shared validation module (its only dependency here). */
export const PriorityEnum = z.enum(["P0", "P1", "P2", "P3"]);

const refIdSchema = z
  .string()
  .trim()
  .min(1, { error: "Reference id is required" })
  .max(64, { error: "Reference id must be 64 characters or less" });

const titleSchema = z
  .string()
  .trim()
  .min(1, { error: "Title is required" })
  .max(100, { error: "Title must be 100 characters or less" });

const noteSchema = z
  .string()
  .trim()
  .max(500, { error: "Note must be 500 characters or less" })
  .optional();

export const createCardOperationSchema = z.object({
  op: z.literal("create_card"),
  columnId: refIdSchema,
  title: titleSchema,
  description: z.string().trim().max(2000).optional(),
  acceptanceCriteria: z.string().trim().max(2000).optional(),
  priority: PriorityEnum.optional(),
  assigneeId: refIdSchema.optional().nullable(),
  note: noteSchema,
});

export const moveCardOperationSchema = z.object({
  op: z.literal("move_card"),
  cardId: refIdSchema,
  targetColumnId: refIdSchema,
  targetIndex: z.number().int().min(0).optional(),
  note: noteSchema,
});

export const assignCardOperationSchema = z.object({
  op: z.literal("assign_card"),
  cardId: refIdSchema,
  assigneeId: refIdSchema,
  note: noteSchema,
});

export const addCommentOperationSchema = z.object({
  op: z.literal("add_comment"),
  cardId: refIdSchema,
  body: z
    .string()
    .trim()
    .min(1, { error: "Comment cannot be empty" })
    .max(2000, { error: "Comment is too long (max 2000 characters)" }),
  note: noteSchema,
});

export const proposedOperationSchema = z.discriminatedUnion("op", [
  createCardOperationSchema,
  moveCardOperationSchema,
  assignCardOperationSchema,
  addCommentOperationSchema,
]);

/** Envelope the LLM is instructed to emit. Hard cap keeps proposals reviewable. */
export const MAX_PROPOSED_OPERATIONS = 20;

export const proposedOperationsEnvelopeSchema = z.object({
  operations: z.array(proposedOperationSchema).max(MAX_PROPOSED_OPERATIONS, {
    error: `At most ${MAX_PROPOSED_OPERATIONS} operations per proposal`,
  }),
});

export const agentProposeRequestSchema = z.object({
  boardId: z.string().cuid({ error: "Invalid board ID" }),
  text: z
    .string()
    .trim()
    .min(1, { error: "Text is required" })
    .max(8000, { error: "Text must be 8000 characters or less" }),
  apply: z.boolean().optional().default(false),
});

export type CreateCardOperation = z.infer<typeof createCardOperationSchema>;
export type MoveCardOperation = z.infer<typeof moveCardOperationSchema>;
export type AssignCardOperation = z.infer<typeof assignCardOperationSchema>;
export type AddCommentOperation = z.infer<typeof addCommentOperationSchema>;
export type ProposedOperation = z.infer<typeof proposedOperationSchema>;
export type AgentProposeRequest = z.infer<typeof agentProposeRequestSchema>;
