import type { WorkflowStage } from "../workflow";
import { allowed, denied } from "./helpers";
import type { TransitionRule, WorkflowEvent } from "./types";

export const TRANSITIONS: Partial<Record<WorkflowStage, Partial<Record<WorkflowEvent, TransitionRule>>>> = {
  READY: {
    CLAIM: (ctx) => {
      if (ctx.cardAssigneeId) {
        return denied("Card is already assigned");
      }
      return allowed("DOING", ["AUTO_ASSIGN", "INCREMENT_VERSION"]);
    },

    MOVE_FORWARD: (ctx) => {
      if (ctx.toStage !== "DOING") {
        return denied(`Cannot move directly from Ready to ${ctx.toStage}`);
      }
      return allowed("DOING", ["AUTO_ASSIGN", "INCREMENT_VERSION"]);
    },

    REORDER: () => allowed("READY", ["INCREMENT_VERSION"]),
  },

  DOING: {
    SUBMIT_FOR_REVIEW: () => {
      return allowed("REVIEW", ["CLEAR_REVIEW", "INCREMENT_VERSION"]);
    },

    MOVE_FORWARD: (ctx) => {
      if (ctx.toStage !== "REVIEW") {
        return denied(`Cannot move directly from Doing to ${ctx.toStage}`);
      }
      return allowed("REVIEW", ["CLEAR_REVIEW", "INCREMENT_VERSION"]);
    },

    MOVE_BACKWARD: (ctx) => {
      if (ctx.actorRole === "MEMBER") {
        return denied("Members cannot move cards from Doing to Ready");
      }
      if (ctx.toStage !== "READY") {
        return denied(`Cannot move backward from Doing to ${ctx.toStage}`);
      }
      if (!ctx.cardHasTeam) {
        return denied("Cannot move to Ready: Team must be set");
      }
      if (!ctx.cardHasAcceptanceCriteria) {
        return denied("Cannot move to Ready: acceptance criteria required");
      }
      return allowed("READY", ["RESET_APPROVED", "INCREMENT_VERSION"]);
    },

    SOLO_LEAD_APPROVE: (ctx) => {
      if (!ctx.isSoloLead) {
        return denied("Only solo leads can auto-approve");
      }
      return allowed("DONE", [
        "SET_APPROVED",
        "CLEAR_REVIEW",
        "SET_REVIEWER",
        "SET_COMPLETED_AT",
        "INCREMENT_VERSION",
      ]);
    },

    REORDER: () => allowed("DOING", ["INCREMENT_VERSION"]),
  },

  REVIEW: {
    APPROVE: (ctx) => {
      if (ctx.actorRole === "MEMBER") {
        return denied("Only team leads can approve cards");
      }
      if (ctx.actorId === ctx.cardAssigneeId && !ctx.isSoloLead) {
        return denied("You cannot approve your own card. Another lead must review it.");
      }
      return allowed("DONE", [
        "SET_APPROVED",
        "CLEAR_REVIEW",
        "SET_REVIEWER",
        "SET_COMPLETED_AT",
        "INCREMENT_VERSION",
      ]);
    },

    REQUEST_CHANGES: (ctx) => {
      if (ctx.actorRole === "MEMBER") {
        return denied("Only team leads can send cards back");
      }
      return allowed("DOING", ["RESET_APPROVED", "SET_REVIEWER", "INCREMENT_VERSION"]);
    },

    MOVE_BACKWARD: (ctx) => {
      if (ctx.actorRole === "MEMBER") {
        return denied("Members cannot move cards from Review to Doing");
      }
      if (ctx.toStage !== "DOING") {
        return denied(`Cannot move backward from Review to ${ctx.toStage}`);
      }
      return allowed("DOING", ["RESET_APPROVED", "INCREMENT_VERSION"]);
    },

    MOVE_FORWARD: (ctx) => {
      if (ctx.toStage !== "DONE") {
        return denied(`Cannot move forward from Review to ${ctx.toStage}`);
      }
      if (ctx.cardIsApproved) {
        return allowed("DONE", ["SET_COMPLETED_AT", "INCREMENT_VERSION"]);
      }
      if (ctx.isSoloLead && ctx.actorRole !== "MEMBER") {
        return allowed("DONE", [
          "SET_APPROVED",
          "CLEAR_REVIEW",
          "SET_REVIEWER",
          "SET_COMPLETED_AT",
          "INCREMENT_VERSION",
        ]);
      }
      return denied("Cannot move to Done: Card must be approved by a lead first");
    },

    REORDER: () => allowed("REVIEW", ["INCREMENT_VERSION"]),
  },

  DONE: {
    MOVE_BACKWARD: (ctx) => {
      if (ctx.actorRole === "MEMBER") {
        return denied("Members cannot move cards out of Done");
      }
      const validTargets: WorkflowStage[] = ["READY", "DOING", "REVIEW"];
      if (!validTargets.includes(ctx.toStage)) {
        return denied(`Cannot move backward from Done to ${ctx.toStage}`);
      }
      return allowed(ctx.toStage, ["RESET_APPROVED", "INCREMENT_VERSION"]);
    },

    REORDER: () => allowed("DONE", ["INCREMENT_VERSION"]),
  },
};
