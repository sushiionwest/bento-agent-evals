/**
 * Legality gate — validates every LLM-proposed operation against the REAL
 * Kanban state machine (`src/state-machine/transitions.ts`) plus the same
 * board-level invariants the production routes enforce (WIP limits, team
 * assignee rules, entity existence).
 *
 * Pure module: no database, no network. In the product it intentionally does
 * NOT import the DB-backed transition orchestrator (which pulls in the DB for
 * actor resolution); instead it uses the pure `classifyDragEvent` +
 * `validateTransition` and replicates the 3-line legacy fallback for unmapped
 * columns verbatim.
 *
 * Operations are evaluated SEQUENTIALLY against a working copy of the board
 * snapshot: an accepted move updates the simulated card position and FSM side
 * effects (auto-assign, approval reset, ...) before the next operation is
 * judged — so "submit card X for review, then approve it" is evaluated the
 * way the production system would actually experience it.
 */

import {
  classifyDragEvent,
  validateTransition,
  type SideEffect,
} from "../state-machine";
import type {
  AgentActor,
  BoardSnapshot,
  BoardSnapshotCard,
  BoardSnapshotColumn,
  LegalityReport,
  LegalProposal,
  RejectedProposal,
} from "./types";
import type {
  AssignCardOperation,
  CreateCardOperation,
  MoveCardOperation,
  ProposedOperation,
} from "../validation/proposed-operation";

interface WorkingState {
  columns: Map<string, BoardSnapshotColumn>;
  cards: Map<string, BoardSnapshotCard>;
  columnCounts: Map<string, number>;
}

function buildWorkingState(snapshot: BoardSnapshot): WorkingState {
  const columns = new Map(snapshot.columns.map((c) => [c.id, { ...c }]));
  const cards = new Map(snapshot.cards.map((c) => [c.id, { ...c }]));
  const columnCounts = new Map<string, number>();
  for (const column of snapshot.columns) columnCounts.set(column.id, 0);
  for (const card of snapshot.cards) {
    columnCounts.set(card.columnId, (columnCounts.get(card.columnId) ?? 0) + 1);
  }
  return { columns, cards, columnCounts };
}

function wipLimitReached(state: WorkingState, column: BoardSnapshotColumn): boolean {
  if (column.wipLimit === null) return false;
  return (state.columnCounts.get(column.id) ?? 0) >= column.wipLimit;
}

/** Mirrors the product's `assertWipLimitNotReached` message shape. */
function wipDenyReason(column: BoardSnapshotColumn): string {
  return `WIP limit of ${column.wipLimit} reached for ${column.name}`;
}

function applyMoveSideEffectsToCard(
  card: BoardSnapshotCard,
  sideEffects: SideEffect[],
  actorId: string
): void {
  for (const effect of sideEffects) {
    switch (effect) {
      case "AUTO_ASSIGN":
        // Production keeps an existing assignee (resolveMoveSideEffectData);
        // only fill when unassigned.
        if (!card.assigneeId) card.assigneeId = actorId;
        break;
      case "SET_APPROVED":
        card.isApproved = true;
        break;
      case "RESET_APPROVED":
        card.isApproved = false;
        break;
      default:
        break;
    }
  }
}

type OpOutcome =
  | { legal: true; proposal: LegalProposal }
  | { legal: false; reason: string };

function evaluateCreate(
  state: WorkingState,
  snapshot: BoardSnapshot,
  op: CreateCardOperation
): OpOutcome {
  const column = state.columns.get(op.columnId);
  if (!column) {
    return { legal: false, reason: `Target column ${op.columnId} not found on this board` };
  }
  if (wipLimitReached(state, column)) {
    return { legal: false, reason: wipDenyReason(column) };
  }
  if (op.assigneeId && snapshot.teamId && !snapshot.teamMemberIds.includes(op.assigneeId)) {
    return { legal: false, reason: "Assignee must be a team member" };
  }

  // Accepted: reflect the new card in the simulation so later WIP checks see it.
  const syntheticId = `proposed:${state.cards.size + 1}`;
  state.cards.set(syntheticId, {
    id: syntheticId,
    title: op.title,
    columnId: column.id,
    assigneeId: op.assigneeId ?? null,
    isApproved: false,
    hasAcceptanceCriteria: !!op.acceptanceCriteria && op.acceptanceCriteria.length >= 10,
    teamId: snapshot.teamId,
    priority: op.priority ?? "P2",
  });
  state.columnCounts.set(column.id, (state.columnCounts.get(column.id) ?? 0) + 1);

  return { legal: true, proposal: { op } };
}

function evaluateMove(
  state: WorkingState,
  actor: AgentActor,
  op: MoveCardOperation
): OpOutcome {
  const card = state.cards.get(op.cardId);
  if (!card) {
    return { legal: false, reason: `Card ${op.cardId} not found on this board` };
  }
  const targetColumn = state.columns.get(op.targetColumnId);
  if (!targetColumn) {
    return { legal: false, reason: `Target column ${op.targetColumnId} not found on this board` };
  }
  const sourceColumn = state.columns.get(card.columnId);
  if (!sourceColumn) {
    return { legal: false, reason: `Card ${op.cardId} is not on this board` };
  }

  const fromStage = sourceColumn.stage;
  const toStage = targetColumn.stage;

  if (fromStage && toStage) {
    const event = classifyDragEvent(fromStage, toStage);
    const outcome = validateTransition({
      fromStage,
      toStage,
      event,
      actorRole: actor.role,
      actorId: actor.actorId,
      cardAssigneeId: card.assigneeId,
      cardHasTeam: !!card.teamId,
      cardHasAcceptanceCriteria: card.hasAcceptanceCriteria,
      cardIsApproved: card.isApproved,
      isSoloLead: actor.isSoloLead,
    });

    if (!outcome.allowed) {
      return { legal: false, reason: outcome.reason };
    }

    const isSameColumn = card.columnId === targetColumn.id;
    if (!isSameColumn && wipLimitReached(state, targetColumn)) {
      return { legal: false, reason: wipDenyReason(targetColumn) };
    }

    // Accepted: simulate the move + FSM side effects.
    if (!isSameColumn) {
      state.columnCounts.set(card.columnId, (state.columnCounts.get(card.columnId) ?? 1) - 1);
      state.columnCounts.set(targetColumn.id, (state.columnCounts.get(targetColumn.id) ?? 0) + 1);
      card.columnId = targetColumn.id;
    }
    applyMoveSideEffectsToCard(card, outcome.sideEffects, actor.actorId);

    return {
      legal: true,
      proposal: {
        op,
        transition: {
          event,
          fromStage,
          toStage,
          sideEffects: outcome.sideEffects,
        },
      },
    };
  }

  // Legacy fallback for custom/unmapped columns — verbatim from the product's
  // workflow-transition orchestrator.
  if (actor.role === "MEMBER" && card.columnId !== targetColumn.id) {
    return { legal: false, reason: "Cannot move cards between unrecognized workflow columns" };
  }

  const isSameColumn = card.columnId === targetColumn.id;
  if (!isSameColumn && wipLimitReached(state, targetColumn)) {
    return { legal: false, reason: wipDenyReason(targetColumn) };
  }
  if (!isSameColumn) {
    state.columnCounts.set(card.columnId, (state.columnCounts.get(card.columnId) ?? 1) - 1);
    state.columnCounts.set(targetColumn.id, (state.columnCounts.get(targetColumn.id) ?? 0) + 1);
    card.columnId = targetColumn.id;
  }
  return { legal: true, proposal: { op } };
}

function evaluateAssign(
  state: WorkingState,
  snapshot: BoardSnapshot,
  op: AssignCardOperation
): OpOutcome {
  const card = state.cards.get(op.cardId);
  if (!card) {
    return { legal: false, reason: `Card ${op.cardId} not found on this board` };
  }
  if (card.teamId && !snapshot.teamMemberIds.includes(op.assigneeId)) {
    return { legal: false, reason: "Assignee must be a team member" };
  }
  card.assigneeId = op.assigneeId;
  return { legal: true, proposal: { op } };
}

function evaluateComment(state: WorkingState, op: ProposedOperation & { op: "add_comment" }): OpOutcome {
  const card = state.cards.get(op.cardId);
  if (!card) {
    return { legal: false, reason: `Card ${op.cardId} not found on this board` };
  }
  return { legal: true, proposal: { op } };
}

/**
 * Run every proposed operation through the legality gate, in order.
 * Returns the accepted operations (with FSM resolutions) and the refused ones
 * (with the state machine's own deny reasons).
 */
export function evaluateProposals(
  snapshot: BoardSnapshot,
  actor: AgentActor,
  operations: ProposedOperation[]
): LegalityReport {
  const state = buildWorkingState(snapshot);
  const legal: LegalProposal[] = [];
  const rejected: RejectedProposal[] = [];

  for (const op of operations) {
    let outcome: OpOutcome;
    switch (op.op) {
      case "create_card":
        outcome = evaluateCreate(state, snapshot, op);
        break;
      case "move_card":
        outcome = evaluateMove(state, actor, op);
        break;
      case "assign_card":
        outcome = evaluateAssign(state, snapshot, op);
        break;
      case "add_comment":
        outcome = evaluateComment(state, op);
        break;
    }

    if (outcome.legal) {
      legal.push(outcome.proposal);
    } else {
      rejected.push({ op, reason: outcome.reason });
    }
  }

  return { legal, rejected };
}
