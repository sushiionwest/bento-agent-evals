/**
 * Kanban workflow state machine — pure functions, no I/O.
 *
 * The canonical transition matrix lives in `transitions.ts`.
 * This module keeps the stable public API used by the legality gate and the
 * eval harness. It is the same module the production app ships.
 */

import type { WorkflowStage } from "../workflow";
import { denied } from "./helpers";
import { TRANSITIONS } from "./transitions";
import type {
  ActorRole,
  SideEffect,
  TransitionContext,
  TransitionDenied,
  TransitionOutcome,
  TransitionResult,
  WorkflowEvent,
} from "./types";

export { WORKFLOW_EVENTS } from "./types";
export type {
  ActorRole,
  SideEffect,
  TransitionContext,
  TransitionDenied,
  TransitionOutcome,
  TransitionResult,
  WorkflowEvent,
};

export function validateTransition(ctx: TransitionContext): TransitionOutcome {
  const stageRules = TRANSITIONS[ctx.fromStage];
  if (!stageRules) {
    return denied(`No transitions defined from ${ctx.fromStage}`);
  }

  const rule = stageRules[ctx.event];
  if (!rule) {
    return denied(`Event "${ctx.event}" is not allowed in ${ctx.fromStage} stage`);
  }

  return rule(ctx);
}

export function classifyDragEvent(fromStage: WorkflowStage, toStage: WorkflowStage): WorkflowEvent {
  if (fromStage === toStage) {
    return "REORDER";
  }

  const stageOrder: Record<WorkflowStage, number> = {
    READY: 0,
    DOING: 1,
    REVIEW: 2,
    DONE: 3,
  };

  return stageOrder[toStage] > stageOrder[fromStage] ? "MOVE_FORWARD" : "MOVE_BACKWARD";
}

export function getValidTransitions(fromStage: WorkflowStage, actorRole: ActorRole): WorkflowStage[] {
  const stages: WorkflowStage[] = ["READY", "DOING", "REVIEW", "DONE"];
  const valid: WorkflowStage[] = [];

  for (const toStage of stages) {
    if (toStage === fromStage) {
      valid.push(toStage);
      continue;
    }

    const event = classifyDragEvent(fromStage, toStage);
    const stageRules = TRANSITIONS[fromStage];
    if (stageRules?.[event]) {
      if (event === "MOVE_BACKWARD" && actorRole === "MEMBER") {
        continue;
      }
      if (toStage === "DONE" && fromStage !== "REVIEW") {
        continue;
      }
      valid.push(toStage);
    }
  }

  return valid;
}
