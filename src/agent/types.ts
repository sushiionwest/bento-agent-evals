/**
 * Pure data contracts for the agent pipeline.
 *
 * Everything in this file (and in `legality.ts` / `prompt.ts`) must stay free
 * of database and other I/O imports so the eval harness (`evals/run.ts`) can
 * load the exact production gate under plain `tsx` with no database and no
 * mocks.
 */

import type { ActorRole, SideEffect, WorkflowEvent } from "../state-machine";
import type { WorkflowStage } from "../workflow";
import type { ProposedOperation } from "../validation/proposed-operation";

export interface BoardSnapshotColumn {
  id: string;
  name: string;
  stage: WorkflowStage | null;
  wipLimit: number | null;
}

export interface BoardSnapshotCard {
  id: string;
  title: string;
  columnId: string;
  assigneeId: string | null;
  isApproved: boolean;
  hasAcceptanceCriteria: boolean;
  teamId: string | null;
  priority: string;
}

export interface BoardSnapshot {
  boardId: string;
  boardName: string;
  teamId: string | null;
  /** Users allowed to be assignees on team cards. */
  teamMemberIds: string[];
  columns: BoardSnapshotColumn[];
  cards: BoardSnapshotCard[];
}

export interface AgentActor {
  actorId: string;
  role: ActorRole;
  isSoloLead: boolean;
}

/** A proposal that passed the legality gate, with the FSM's resolution attached. */
export interface LegalProposal {
  op: ProposedOperation;
  transition?: {
    event: WorkflowEvent;
    fromStage: WorkflowStage;
    toStage: WorkflowStage;
    sideEffects: SideEffect[];
  };
}

/** A proposal refused by the legality gate, with the state machine's deny reason. */
export interface RejectedProposal {
  op: ProposedOperation;
  reason: string;
}

export interface LegalityReport {
  legal: LegalProposal[];
  rejected: RejectedProposal[];
}
