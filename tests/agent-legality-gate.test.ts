/**
 * Tests for the agent legality gate — every proposed operation must be
 * validated against the REAL state machine, and every refusal must carry the
 * state machine's own deny reason.
 */

import { describe, expect, test } from "vitest";
import { evaluateProposals } from "../src/agent/legality";
import type { AgentActor, BoardSnapshot } from "../src/agent/types";
import type { ProposedOperation } from "../src/validation/proposed-operation";

const TEAM_ID = "team_1";

function makeBoard(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    boardId: "board_1",
    boardName: "Test Board",
    teamId: TEAM_ID,
    teamMemberIds: ["user_lead", "user_member", "user_member2"],
    columns: [
      { id: "col_ready", name: "Ready", stage: "READY", wipLimit: null },
      { id: "col_doing", name: "Doing", stage: "DOING", wipLimit: null },
      { id: "col_review", name: "Review", stage: "REVIEW", wipLimit: null },
      { id: "col_done", name: "Done", stage: "DONE", wipLimit: null },
    ],
    cards: [
      {
        id: "card_ready",
        title: "Ready card",
        columnId: "col_ready",
        assigneeId: null,
        isApproved: false,
        hasAcceptanceCriteria: true,
        teamId: TEAM_ID,
        priority: "P2",
      },
      {
        id: "card_doing",
        title: "Doing card",
        columnId: "col_doing",
        assigneeId: "user_member",
        isApproved: false,
        hasAcceptanceCriteria: true,
        teamId: TEAM_ID,
        priority: "P2",
      },
      {
        id: "card_review",
        title: "Review card",
        columnId: "col_review",
        assigneeId: "user_member",
        isApproved: false,
        hasAcceptanceCriteria: true,
        teamId: TEAM_ID,
        priority: "P1",
      },
      {
        id: "card_done",
        title: "Done card",
        columnId: "col_done",
        assigneeId: "user_member",
        isApproved: true,
        hasAcceptanceCriteria: true,
        teamId: TEAM_ID,
        priority: "P2",
      },
    ],
    ...overrides,
  };
}

const MEMBER: AgentActor = { actorId: "user_member", role: "MEMBER", isSoloLead: false };
const LEAD: AgentActor = { actorId: "user_lead", role: "LEAD", isSoloLead: false };
const SOLO_LEAD: AgentActor = { actorId: "user_lead", role: "LEAD", isSoloLead: true };

function moveOp(cardId: string, targetColumnId: string): ProposedOperation {
  return { op: "move_card", cardId, targetColumnId };
}

describe("evaluateProposals — move legality", () => {
  test("member claiming a Ready card into Doing is legal with AUTO_ASSIGN", () => {
    const report = evaluateProposals(makeBoard(), MEMBER, [moveOp("card_ready", "col_doing")]);
    expect(report.rejected).toHaveLength(0);
    expect(report.legal).toHaveLength(1);
    expect(report.legal[0].transition?.event).toBe("MOVE_FORWARD");
    expect(report.legal[0].transition?.sideEffects).toContain("AUTO_ASSIGN");
  });

  test("skipping review (Doing -> Done) is refused with the FSM's reason", () => {
    const report = evaluateProposals(makeBoard(), MEMBER, [moveOp("card_doing", "col_done")]);
    expect(report.legal).toHaveLength(0);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0].reason).toBe("Cannot move directly from Doing to DONE");
  });

  test("member resurrecting a Done card is refused", () => {
    const report = evaluateProposals(makeBoard(), MEMBER, [moveOp("card_done", "col_doing")]);
    expect(report.rejected[0].reason).toBe("Members cannot move cards out of Done");
  });

  test("unapproved Review -> Done is refused; solo lead is allowed", () => {
    const asMember = evaluateProposals(makeBoard(), MEMBER, [moveOp("card_review", "col_done")]);
    expect(asMember.rejected[0].reason).toBe(
      "Cannot move to Done: Card must be approved by a lead first"
    );

    const asSoloLead = evaluateProposals(makeBoard(), SOLO_LEAD, [moveOp("card_review", "col_done")]);
    expect(asSoloLead.legal).toHaveLength(1);
    expect(asSoloLead.legal[0].transition?.sideEffects).toContain("SET_APPROVED");
  });

  test("moving to a nonexistent column is refused with a domain reason", () => {
    const report = evaluateProposals(makeBoard(), LEAD, [moveOp("card_ready", "col_blocked")]);
    expect(report.rejected[0].reason).toContain("not found on this board");
  });

  test("moving a nonexistent card is refused with a domain reason", () => {
    const report = evaluateProposals(makeBoard(), LEAD, [moveOp("card_ghost", "col_review")]);
    expect(report.rejected[0].reason).toContain("not found on this board");
  });

  test("same-column move is a legal REORDER", () => {
    const report = evaluateProposals(makeBoard(), MEMBER, [moveOp("card_done", "col_done")]);
    expect(report.legal).toHaveLength(1);
    expect(report.legal[0].transition?.event).toBe("REORDER");
  });

  test("WIP limit on the target column refuses the move", () => {
    const board = makeBoard();
    board.columns = board.columns.map((c) =>
      c.id === "col_doing" ? { ...c, wipLimit: 1 } : c
    );
    const report = evaluateProposals(board, MEMBER, [moveOp("card_ready", "col_doing")]);
    expect(report.rejected[0].reason).toBe("WIP limit of 1 reached for Doing");
  });
});

describe("evaluateProposals — sequential simulation", () => {
  test("claim then illegal jump: first accepted, second refused from the NEW stage", () => {
    const report = evaluateProposals(makeBoard(), MEMBER, [
      moveOp("card_ready", "col_doing"),
      moveOp("card_ready", "col_done"),
    ]);
    expect(report.legal).toHaveLength(1);
    expect(report.rejected).toHaveLength(1);
    // Card is simulated in Doing after the first op, so the deny reason is
    // the Doing rule — not the Ready rule.
    expect(report.rejected[0].reason).toBe("Cannot move directly from Doing to DONE");
  });

  test("solo lead submit-then-close pipeline is fully legal", () => {
    const report = evaluateProposals(makeBoard(), SOLO_LEAD, [
      moveOp("card_doing", "col_review"),
      moveOp("card_doing", "col_done"),
    ]);
    expect(report.rejected).toHaveLength(0);
    expect(report.legal).toHaveLength(2);
  });

  test("accepted creates count toward WIP for later operations", () => {
    const board = makeBoard({ cards: [] });
    board.columns = board.columns.map((c) =>
      c.id === "col_doing" ? { ...c, wipLimit: 1 } : c
    );
    const create = (title: string): ProposedOperation => ({
      op: "create_card",
      columnId: "col_doing",
      title,
    });
    const report = evaluateProposals(board, LEAD, [create("First"), create("Second")]);
    expect(report.legal).toHaveLength(1);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0].reason).toBe("WIP limit of 1 reached for Doing");
  });
});

describe("evaluateProposals — create/assign/comment guards", () => {
  test("create into a nonexistent column is refused", () => {
    const report = evaluateProposals(makeBoard(), LEAD, [
      { op: "create_card", columnId: "col_icebox", title: "Task" },
    ]);
    expect(report.rejected[0].reason).toContain("not found on this board");
  });

  test("create with a non-member assignee on a team board is refused", () => {
    const report = evaluateProposals(makeBoard(), LEAD, [
      { op: "create_card", columnId: "col_ready", title: "Task", assigneeId: "user_stranger" },
    ]);
    expect(report.rejected[0].reason).toBe("Assignee must be a team member");
  });

  test("assign to a team member is legal; to an outsider is refused", () => {
    const legalReport = evaluateProposals(makeBoard(), LEAD, [
      { op: "assign_card", cardId: "card_ready", assigneeId: "user_member2" },
    ]);
    expect(legalReport.legal).toHaveLength(1);

    const refusedReport = evaluateProposals(makeBoard(), LEAD, [
      { op: "assign_card", cardId: "card_ready", assigneeId: "user_stranger" },
    ]);
    expect(refusedReport.rejected[0].reason).toBe("Assignee must be a team member");
  });

  test("comment on an existing card is legal; on a missing card is refused", () => {
    const report = evaluateProposals(makeBoard(), MEMBER, [
      { op: "add_comment", cardId: "card_doing", body: "Blocked on parts." },
      { op: "add_comment", cardId: "card_ghost", body: "Hello?" },
    ]);
    expect(report.legal).toHaveLength(1);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0].reason).toContain("not found on this board");
  });
});

describe("evaluateProposals — unmapped columns (legacy fallback)", () => {
  test("member cross-column move between unmapped columns is refused", () => {
    const board = makeBoard({
      columns: [
        { id: "col_a", name: "Icebox", stage: null, wipLimit: null },
        { id: "col_b", name: "Someday", stage: null, wipLimit: null },
      ],
      cards: [
        {
          id: "card_x",
          title: "X",
          columnId: "col_a",
          assigneeId: null,
          isApproved: false,
          hasAcceptanceCriteria: false,
          teamId: TEAM_ID,
          priority: "P2",
        },
      ],
    });
    const report = evaluateProposals(board, MEMBER, [moveOp("card_x", "col_b")]);
    expect(report.rejected[0].reason).toBe(
      "Cannot move cards between unrecognized workflow columns"
    );

    const leadReport = evaluateProposals(board, LEAD, [moveOp("card_x", "col_b")]);
    expect(leadReport.legal).toHaveLength(1);
  });
});
