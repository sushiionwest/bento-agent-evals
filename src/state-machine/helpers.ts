import type { WorkflowStage } from "../workflow";
import type { SideEffect, TransitionDenied, TransitionResult } from "./types";

export function allowed(targetStage: WorkflowStage, sideEffects: SideEffect[]): TransitionResult {
  return { allowed: true, targetStage, sideEffects };
}

export function denied(reason: string): TransitionDenied {
  return { allowed: false, reason };
}
