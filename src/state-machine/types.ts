import type { WorkflowStage } from "../workflow";

export const WORKFLOW_EVENTS = [
  "CLAIM",
  "MOVE_FORWARD",
  "MOVE_BACKWARD",
  "SUBMIT_FOR_REVIEW",
  "APPROVE",
  "REQUEST_CHANGES",
  "REORDER",
  "SOLO_LEAD_APPROVE",
] as const;

export type WorkflowEvent = (typeof WORKFLOW_EVENTS)[number];

export type ActorRole = "MEMBER" | "LEAD" | "OWNER";

export type SideEffect =
  | "AUTO_ASSIGN"
  | "CLEAR_REVIEW"
  | "SET_APPROVED"
  | "RESET_APPROVED"
  | "SET_COMPLETED_AT"
  | "SET_REVIEWER"
  | "INCREMENT_VERSION";

export interface TransitionContext {
  fromStage: WorkflowStage;
  toStage: WorkflowStage;
  event: WorkflowEvent;
  actorRole: ActorRole;
  actorId: string;
  cardAssigneeId: string | null;
  cardHasTeam: boolean;
  cardHasAcceptanceCriteria: boolean;
  cardIsApproved: boolean;
  isSoloLead: boolean;
}

export interface TransitionResult {
  allowed: true;
  targetStage: WorkflowStage;
  sideEffects: SideEffect[];
}

export interface TransitionDenied {
  allowed: false;
  reason: string;
}

export type TransitionOutcome = TransitionResult | TransitionDenied;

export type TransitionRule = (ctx: TransitionContext) => TransitionOutcome;
