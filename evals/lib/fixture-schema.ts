/**
 * Schema for eval fixture files (evals/fixtures/*.json).
 *
 * A fixture is: compact board state + actor + free-text input + the mocked
 * LLM response + per-operation expectations. Mock operations are validated
 * against the REAL ProposedOperation schema at load time so fixtures cannot
 * drift from the production contract.
 */

import { z } from "zod";
import { proposedOperationSchema } from "../../src/validation/proposed-operation";

const workflowStageSchema = z.enum(["READY", "DOING", "REVIEW", "DONE"]).nullable();

const boardSnapshotSchema = z.object({
  boardId: z.string(),
  boardName: z.string(),
  teamId: z.string().nullable(),
  teamMemberIds: z.array(z.string()),
  columns: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      stage: workflowStageSchema,
      wipLimit: z.number().int().nullable(),
    })
  ),
  cards: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      columnId: z.string(),
      assigneeId: z.string().nullable(),
      isApproved: z.boolean(),
      hasAcceptanceCriteria: z.boolean(),
      teamId: z.string().nullable(),
      priority: z.string(),
    })
  ),
});

const actorSchema = z.object({
  actorId: z.string(),
  role: z.enum(["MEMBER", "LEAD", "OWNER"]),
  isSoloLead: z.boolean(),
});

const expectedOperationSchema = z.object({
  op: proposedOperationSchema,
  /** What the legality gate MUST decide for this operation. */
  expectLegal: z.boolean(),
  /** For illegal ops: substring the deny reason must contain (case-insensitive). */
  reasonIncludes: z.string().optional(),
});

export const fixtureSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Text explicitly requests something the workflow forbids. */
  adversarial: z.boolean(),
  board: boardSnapshotSchema,
  actor: actorSchema,
  input: z.string(),
  mock: z.union([
    z.object({ operations: z.array(expectedOperationSchema) }),
    /** Malformed-output fixtures: raw text the parser must reject. */
    z.object({ rawResponse: z.string(), expectParseError: z.literal(true) }),
  ]),
});

export type EvalFixture = z.infer<typeof fixtureSchema>;
export type ExpectedOperation = z.infer<typeof expectedOperationSchema>;
