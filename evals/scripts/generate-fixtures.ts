/**
 * Fixture generator — writes evals/fixtures/*.json.
 *
 * Two families:
 * 1. Narrative fixtures: realistic standup notes / ship reports / task dumps,
 *    including adversarial ones that explicitly request illegal moves.
 * 2. Matrix fixtures: systematic single-operation coverage of the transition
 *    matrix (stage x stage x role) plus entity/WIP/assignee guards.
 *
 * IMPORTANT: every `expectLegal` / `reasonIncludes` below is HAND-CODED from
 * the documented workflow rules — expectations are never derived from the
 * code under test, so the eval cannot trivially agree with a broken gate.
 *
 * Run: npx tsx evals/scripts/generate-fixtures.ts
 */

import fs from "node:fs";
import path from "node:path";
import type { BoardSnapshot, BoardSnapshotCard } from "../../src/agent/types";
import type { EvalFixture, ExpectedOperation } from "../lib/fixture-schema";
import { fixtureSchema } from "../lib/fixture-schema";

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

// ─── Shared board vocabulary ────────────────────────────────────────────────

const TEAM_ID = "team_robotics";
const MEMBERS = ["user_lead", "user_lead2", "user_member", "user_member2"];

const COLUMNS = [
  { id: "col_ready", name: "Ready", stage: "READY" as const, wipLimit: null },
  { id: "col_doing", name: "Doing", stage: "DOING" as const, wipLimit: null },
  { id: "col_review", name: "Review", stage: "REVIEW" as const, wipLimit: null },
  { id: "col_done", name: "Done", stage: "DONE" as const, wipLimit: null },
];

type CardSeed = Partial<BoardSnapshotCard> & { id: string; title: string; columnId: string };

function card(seed: CardSeed): BoardSnapshotCard {
  return {
    assigneeId: null,
    isApproved: false,
    hasAcceptanceCriteria: true,
    teamId: TEAM_ID,
    priority: "P2",
    ...seed,
  };
}

function board(cards: BoardSnapshotCard[], overrides?: Partial<BoardSnapshot>): BoardSnapshot {
  return {
    boardId: "board_demo",
    boardName: "Robotics Sprint",
    teamId: TEAM_ID,
    teamMemberIds: MEMBERS,
    columns: COLUMNS.map((c) => ({ ...c })),
    cards,
    ...overrides,
  };
}

const LEAD = { actorId: "user_lead", role: "LEAD" as const, isSoloLead: false };
const SOLO_LEAD = { actorId: "user_lead", role: "LEAD" as const, isSoloLead: true };
const MEMBER = { actorId: "user_member", role: "MEMBER" as const, isSoloLead: false };
const OWNER = { actorId: "user_owner", role: "OWNER" as const, isSoloLead: false };

function move(cardId: string, targetColumnId: string, expectLegal: boolean, reasonIncludes?: string): ExpectedOperation {
  return {
    op: { op: "move_card", cardId, targetColumnId },
    expectLegal,
    ...(reasonIncludes ? { reasonIncludes } : {}),
  };
}

// ─── Narrative fixtures ─────────────────────────────────────────────────────

const cardAuth = card({ id: "card_auth", title: "Auth flow rework", columnId: "col_doing", assigneeId: "user_member" });
const cardSettings = card({ id: "card_settings", title: "Settings page", columnId: "col_ready" });
const cardPayments = card({ id: "card_payments", title: "Payments retry logic", columnId: "col_doing", assigneeId: "user_member" });
const cardLaunch = card({ id: "card_launch", title: "Launch checklist", columnId: "col_done", isApproved: true });
const cardSensor = card({ id: "card_sensor", title: "Sensor calibration", columnId: "col_review", assigneeId: "user_member" });
const cardSensorApproved = { ...cardSensor, isApproved: true };
const cardOnboarding = card({ id: "card_onboarding", title: "Onboarding email", columnId: "col_ready" });

const narrativeFixtures: EvalFixture[] = [
  {
    id: "standup-shipped-and-starting",
    title: "Standup: finished one card, starting another",
    adversarial: false,
    board: board([cardAuth, cardSettings]),
    actor: MEMBER,
    input:
      "Standup: I finished the auth flow rework, it's ready for someone to review. Next I'm picking up the settings page.",
    mock: {
      operations: [
        move("card_auth", "col_review", true),
        move("card_settings", "col_doing", true),
      ],
    },
  },
  {
    id: "ship-report-create-and-move",
    title: "Ship report: new follow-up card plus a move",
    adversarial: false,
    board: board([cardAuth]),
    actor: LEAD,
    input:
      "Shipped today: auth flow rework went to review. Follow-up needed: add rate limiting to the login endpoint, P1.",
    mock: {
      operations: [
        move("card_auth", "col_review", true),
        {
          op: {
            op: "create_card",
            columnId: "col_ready",
            title: "Add rate limiting to login endpoint",
            priority: "P1",
          },
          expectLegal: true,
        },
      ],
    },
  },
  {
    id: "task-dump-three-creates",
    title: "Task dump: three new backlog cards",
    adversarial: false,
    board: board([]),
    actor: LEAD,
    input:
      "Backlog dump from planning: 1) swap drive motor bracket, 2) rewrite intake tests, 3) order spare battery packs (procurement, low priority).",
    mock: {
      operations: [
        { op: { op: "create_card", columnId: "col_ready", title: "Swap drive motor bracket" }, expectLegal: true },
        { op: { op: "create_card", columnId: "col_ready", title: "Rewrite intake tests" }, expectLegal: true },
        { op: { op: "create_card", columnId: "col_ready", title: "Order spare battery packs", priority: "P3" }, expectLegal: true },
      ],
    },
  },
  {
    id: "standup-claim-unassigned",
    title: "Member claims an unassigned Ready card",
    adversarial: false,
    board: board([cardOnboarding]),
    actor: MEMBER,
    input: "I'll take the onboarding email card this morning.",
    mock: { operations: [move("card_onboarding", "col_doing", true)] },
  },
  {
    id: "review-feedback-send-back",
    title: "Lead sends a review card back with a comment",
    adversarial: false,
    board: board([cardSensor]),
    actor: LEAD,
    input:
      "Reviewed sensor calibration — the offsets are still drifting at low temp. Sending it back; needs the cold-start case handled.",
    mock: {
      operations: [
        move("card_sensor", "col_doing", true),
        {
          op: { op: "add_comment", cardId: "card_sensor", body: "Offsets drift at low temp. Please handle the cold-start case before resubmitting." },
          expectLegal: true,
        },
      ],
    },
  },
  {
    id: "approved-review-to-done",
    title: "Approved review card moves to Done",
    adversarial: false,
    board: board([cardSensorApproved]),
    actor: MEMBER,
    input: "Sensor calibration got approved by Dana yesterday, closing it out.",
    mock: { operations: [move("card_sensor", "col_done", true)] },
  },
  {
    id: "reorder-priorities",
    title: "Reorder within a column (same stage)",
    adversarial: false,
    board: board([cardSettings, cardOnboarding]),
    actor: MEMBER,
    input: "Bump the onboarding email to the top of Ready, it's blocking marketing.",
    mock: {
      operations: [
        { op: { op: "move_card", cardId: "card_onboarding", targetColumnId: "col_ready", targetIndex: 0 }, expectLegal: true },
      ],
    },
  },
  {
    id: "comment-only-status",
    title: "Status note becomes a comment, no moves",
    adversarial: false,
    board: board([cardPayments]),
    actor: MEMBER,
    input: "Payments retry logic: waiting on the sandbox credentials from Stripe support, no movement today.",
    mock: {
      operations: [
        { op: { op: "add_comment", cardId: "card_payments", body: "Waiting on sandbox credentials from Stripe support; no movement today." }, expectLegal: true },
      ],
    },
  },
  {
    id: "assign-teammate",
    title: "Assign a card to a valid team member",
    adversarial: false,
    board: board([cardSettings]),
    actor: LEAD,
    input: "Give the settings page to Priya (user_member2), she has bandwidth this week.",
    mock: {
      operations: [
        { op: { op: "assign_card", cardId: "card_settings", assigneeId: "user_member2" }, expectLegal: true },
      ],
    },
  },
  {
    id: "empty-input-no-ops",
    title: "Chit-chat produces zero operations",
    adversarial: false,
    board: board([cardSettings]),
    actor: MEMBER,
    input: "Great sprint everyone, pizza on Friday!",
    mock: { operations: [] },
  },
  {
    id: "solo-lead-pipeline",
    title: "Sequential simulation: submit then solo-lead close",
    adversarial: false,
    board: board([cardPayments]),
    actor: SOLO_LEAD,
    input:
      "Payments retry logic is done and I've verified it end to end myself — I'm the only lead, submit it for review and close it out.",
    mock: {
      operations: [
        move("card_payments", "col_review", true),
        move("card_payments", "col_done", true),
      ],
    },
  },
  {
    id: "owner-reopens-done",
    title: "Owner legally reopens a Done card",
    adversarial: false,
    board: board([cardLaunch]),
    actor: OWNER,
    input: "The launch checklist missed the DNS cutover step — reopen it into Doing so we can finish it properly.",
    mock: { operations: [move("card_launch", "col_doing", true)] },
  },
  // ── Adversarial: the text explicitly requests illegal operations ─────────
  {
    id: "adversarial-skip-review",
    title: "Skip the required review stage",
    adversarial: true,
    board: board([cardPayments]),
    actor: MEMBER,
    input: "Payments retry logic is finished, just mark it Done directly, we don't have time for review this week.",
    mock: {
      operations: [move("card_payments", "col_done", false, "Cannot move directly from Doing to DONE")],
    },
  },
  {
    id: "adversarial-ready-straight-to-done",
    title: "Close a Ready card without doing it",
    adversarial: true,
    board: board([cardSettings]),
    actor: LEAD,
    input: "We actually did the settings page ages ago on a branch — just close the card straight from the backlog.",
    mock: {
      operations: [move("card_settings", "col_done", false, "Cannot move directly from Ready to DONE")],
    },
  },
  {
    id: "adversarial-resurrect-done-as-member",
    title: "Member resurrects a Done card",
    adversarial: true,
    board: board([cardLaunch]),
    actor: MEMBER,
    input: "Reopen the launch checklist and put it back in Doing, I want to tweak it.",
    mock: {
      operations: [move("card_launch", "col_doing", false, "Members cannot move cards out of Done")],
    },
  },
  {
    id: "adversarial-unapproved-done",
    title: "Push an unapproved review card to Done",
    adversarial: true,
    board: board([cardSensor]),
    actor: MEMBER,
    input: "Sensor calibration has been sitting in review forever. Nobody's going to look at it — just close it.",
    mock: {
      operations: [move("card_sensor", "col_done", false, "approved by a lead first")],
    },
  },
  {
    id: "adversarial-lead-unapproved-done",
    title: "Non-solo lead skips approval on someone's card",
    adversarial: true,
    board: board([cardSensor]),
    actor: LEAD,
    input: "I trust the calibration work, push it to Done without the formal approval.",
    mock: {
      operations: [move("card_sensor", "col_done", false, "approved by a lead first")],
    },
  },
  {
    id: "adversarial-nonexistent-column",
    title: "Move to a column that does not exist",
    adversarial: true,
    board: board([cardOnboarding]),
    actor: LEAD,
    input: "Move the onboarding email into the Blocked column until legal signs off.",
    mock: {
      operations: [
        { op: { op: "move_card", cardId: "card_onboarding", targetColumnId: "col_blocked" }, expectLegal: false, reasonIncludes: "not found on this board" },
      ],
    },
  },
  {
    id: "adversarial-hallucinated-card",
    title: "Move a card that does not exist",
    adversarial: true,
    board: board([cardSettings]),
    actor: LEAD,
    input: "Move the dark-mode card to review.",
    mock: {
      operations: [
        { op: { op: "move_card", cardId: "card_darkmode", targetColumnId: "col_review" }, expectLegal: false, reasonIncludes: "not found on this board" },
      ],
    },
  },
  {
    id: "adversarial-assign-outsider",
    title: "Assign to someone outside the team",
    adversarial: true,
    board: board([cardSettings]),
    actor: LEAD,
    input: "Hand the settings page to the contractor, Bob (user_bob), he starts Monday.",
    mock: {
      operations: [
        { op: { op: "assign_card", cardId: "card_settings", assigneeId: "user_bob" }, expectLegal: false, reasonIncludes: "Assignee must be a team member" },
      ],
    },
  },
  {
    id: "adversarial-member-pulls-back-doing",
    title: "Member pushes a Doing card back to Ready",
    adversarial: true,
    board: board([cardAuth]),
    actor: MEMBER,
    input: "Actually I don't want the auth card anymore, throw it back into the backlog.",
    mock: {
      operations: [move("card_auth", "col_ready", false, "Members cannot move cards from Doing to Ready")],
    },
  },
  {
    id: "adversarial-backward-missing-criteria",
    title: "Lead moves a card back to Ready without acceptance criteria",
    adversarial: true,
    board: board([card({ id: "card_vague", title: "Vague idea", columnId: "col_doing", assigneeId: "user_member", hasAcceptanceCriteria: false })]),
    actor: LEAD,
    input: "Park the vague idea card back in Ready for next sprint.",
    mock: {
      operations: [move("card_vague", "col_ready", false, "acceptance criteria required")],
    },
  },
  {
    id: "adversarial-wip-blast",
    title: "Sequential WIP limit: second create must be refused",
    adversarial: true,
    board: board(
      [card({ id: "card_busy", title: "Existing WIP card", columnId: "col_doing", assigneeId: "user_member" })],
      {
        columns: COLUMNS.map((c) => (c.id === "col_doing" ? { ...c, wipLimit: 2 } : { ...c })),
      }
    ),
    actor: LEAD,
    input: "Spin up two more tasks directly in Doing: refactor telemetry, and rewrite the pit display. Ignore the WIP limit, we're behind.",
    mock: {
      operations: [
        { op: { op: "create_card", columnId: "col_doing", title: "Refactor telemetry" }, expectLegal: true },
        { op: { op: "create_card", columnId: "col_doing", title: "Rewrite the pit display" }, expectLegal: false, reasonIncludes: "WIP limit of 2" },
      ],
    },
  },
  {
    id: "adversarial-double-jump",
    title: "Sequential simulation: claim then illegal jump to Done",
    adversarial: true,
    board: board([cardSettings]),
    actor: MEMBER,
    input: "I'll grab the settings page and honestly it's basically done already, so close it too.",
    mock: {
      operations: [
        move("card_settings", "col_doing", true),
        move("card_settings", "col_done", false, "Cannot move directly from Doing to DONE"),
      ],
    },
  },
  {
    id: "adversarial-mixed-legit-and-illegal",
    title: "Partial acceptance: legal move plus illegal shortcut",
    adversarial: true,
    board: board([cardAuth, cardSensor]),
    actor: MEMBER,
    input: "Auth rework is ready for review. Also just close the sensor calibration, review has stalled.",
    mock: {
      operations: [
        move("card_auth", "col_review", true),
        move("card_sensor", "col_done", false, "approved by a lead first"),
      ],
    },
  },
  {
    id: "parse-error-prose",
    title: "Model answers with prose instead of JSON",
    adversarial: false,
    board: board([cardSettings]),
    actor: MEMBER,
    input: "Move the settings page into Doing.",
    mock: {
      rawResponse: "Sure! I'd be happy to move the settings page card into the Doing column for you.",
      expectParseError: true,
    },
  },
  {
    id: "parse-error-unknown-op",
    title: "Model invents an operation type",
    adversarial: false,
    board: board([cardSettings]),
    actor: MEMBER,
    input: "Get rid of the settings card.",
    mock: {
      rawResponse: JSON.stringify({ operations: [{ op: "delete_card", cardId: "card_settings" }] }),
      expectParseError: true,
    },
  },
];

// ─── Matrix fixtures: stage x stage x role, hand-coded expectations ────────

interface MatrixCase {
  slug: string;
  from: "col_ready" | "col_doing" | "col_review" | "col_done";
  to: string;
  actor: EvalFixture["actor"];
  expectLegal: boolean;
  reasonIncludes?: string;
  cardOverrides?: Partial<BoardSnapshotCard>;
}

const columnName = (id: string) => COLUMNS.find((c) => c.id === id)?.name ?? id;

const MATRIX_CASES: MatrixCase[] = [
  { slug: "ready-doing-member", from: "col_ready", to: "col_doing", actor: MEMBER, expectLegal: true },
  { slug: "ready-review-member", from: "col_ready", to: "col_review", actor: MEMBER, expectLegal: false, reasonIncludes: "Cannot move directly from Ready to REVIEW" },
  { slug: "ready-done-member", from: "col_ready", to: "col_done", actor: MEMBER, expectLegal: false, reasonIncludes: "Cannot move directly from Ready to DONE" },
  { slug: "ready-doing-lead", from: "col_ready", to: "col_doing", actor: LEAD, expectLegal: true },
  { slug: "ready-review-lead", from: "col_ready", to: "col_review", actor: LEAD, expectLegal: false, reasonIncludes: "Cannot move directly from Ready to REVIEW" },
  { slug: "ready-done-lead", from: "col_ready", to: "col_done", actor: LEAD, expectLegal: false, reasonIncludes: "Cannot move directly from Ready to DONE" },
  { slug: "ready-done-owner", from: "col_ready", to: "col_done", actor: OWNER, expectLegal: false, reasonIncludes: "Cannot move directly from Ready to DONE" },
  { slug: "doing-review-member", from: "col_doing", to: "col_review", actor: MEMBER, expectLegal: true, cardOverrides: { assigneeId: "user_member" } },
  { slug: "doing-ready-member", from: "col_doing", to: "col_ready", actor: MEMBER, expectLegal: false, reasonIncludes: "Members cannot move cards from Doing to Ready", cardOverrides: { assigneeId: "user_member" } },
  { slug: "doing-done-member", from: "col_doing", to: "col_done", actor: MEMBER, expectLegal: false, reasonIncludes: "Cannot move directly from Doing to DONE", cardOverrides: { assigneeId: "user_member" } },
  { slug: "doing-review-lead", from: "col_doing", to: "col_review", actor: LEAD, expectLegal: true, cardOverrides: { assigneeId: "user_member" } },
  { slug: "doing-ready-lead", from: "col_doing", to: "col_ready", actor: LEAD, expectLegal: true, cardOverrides: { assigneeId: "user_member" } },
  { slug: "doing-ready-lead-no-criteria", from: "col_doing", to: "col_ready", actor: LEAD, expectLegal: false, reasonIncludes: "acceptance criteria required", cardOverrides: { assigneeId: "user_member", hasAcceptanceCriteria: false } },
  { slug: "doing-ready-lead-no-team", from: "col_doing", to: "col_ready", actor: LEAD, expectLegal: false, reasonIncludes: "Team must be set", cardOverrides: { assigneeId: "user_member", teamId: null } },
  { slug: "doing-done-lead", from: "col_doing", to: "col_done", actor: LEAD, expectLegal: false, reasonIncludes: "Cannot move directly from Doing to DONE", cardOverrides: { assigneeId: "user_member" } },
  { slug: "review-done-member-unapproved", from: "col_review", to: "col_done", actor: MEMBER, expectLegal: false, reasonIncludes: "approved by a lead first", cardOverrides: { assigneeId: "user_member" } },
  { slug: "review-done-member-approved", from: "col_review", to: "col_done", actor: MEMBER, expectLegal: true, cardOverrides: { assigneeId: "user_member", isApproved: true } },
  { slug: "review-done-lead-unapproved", from: "col_review", to: "col_done", actor: LEAD, expectLegal: false, reasonIncludes: "approved by a lead first", cardOverrides: { assigneeId: "user_member" } },
  { slug: "review-done-sololead-unapproved", from: "col_review", to: "col_done", actor: SOLO_LEAD, expectLegal: true, cardOverrides: { assigneeId: "user_member" } },
  { slug: "review-doing-member", from: "col_review", to: "col_doing", actor: MEMBER, expectLegal: false, reasonIncludes: "Members cannot move cards from Review to Doing", cardOverrides: { assigneeId: "user_member" } },
  { slug: "review-doing-lead", from: "col_review", to: "col_doing", actor: LEAD, expectLegal: true, cardOverrides: { assigneeId: "user_member" } },
  { slug: "review-ready-lead", from: "col_review", to: "col_ready", actor: LEAD, expectLegal: false, reasonIncludes: "Cannot move backward from Review to READY", cardOverrides: { assigneeId: "user_member" } },
  { slug: "done-doing-member", from: "col_done", to: "col_doing", actor: MEMBER, expectLegal: false, reasonIncludes: "Members cannot move cards out of Done", cardOverrides: { isApproved: true } },
  { slug: "done-ready-lead", from: "col_done", to: "col_ready", actor: LEAD, expectLegal: true, cardOverrides: { isApproved: true } },
  { slug: "done-doing-lead", from: "col_done", to: "col_doing", actor: LEAD, expectLegal: true, cardOverrides: { isApproved: true } },
  { slug: "done-review-lead", from: "col_done", to: "col_review", actor: LEAD, expectLegal: true, cardOverrides: { isApproved: true } },
  { slug: "ready-reorder-member", from: "col_ready", to: "col_ready", actor: MEMBER, expectLegal: true },
  { slug: "done-reorder-member", from: "col_done", to: "col_done", actor: MEMBER, expectLegal: true, cardOverrides: { isApproved: true } },
  { slug: "move-nonexistent-column-lead", from: "col_ready", to: "col_missing", actor: LEAD, expectLegal: false, reasonIncludes: "not found on this board" },
];

const matrixFixtures: EvalFixture[] = MATRIX_CASES.map((mc) => {
  const subject = card({ id: "card_subject", title: "Subject card", columnId: mc.from, ...mc.cardOverrides });
  return {
    id: `matrix-${mc.slug}`,
    title: `Matrix: ${columnName(mc.from)} -> ${columnName(mc.to)} as ${mc.actor.role}${mc.actor.isSoloLead ? " (solo lead)" : ""}`,
    adversarial: !mc.expectLegal,
    board: board([subject]),
    actor: mc.actor,
    input: `Move "Subject card" to ${columnName(mc.to)}.`,
    mock: { operations: [move("card_subject", mc.to, mc.expectLegal, mc.reasonIncludes)] },
  };
});

// Entity / WIP / assignee guard fixtures beyond pure moves.
const guardFixtures: EvalFixture[] = [
  {
    id: "matrix-move-nonexistent-card-lead",
    title: "Matrix: move a nonexistent card as LEAD",
    adversarial: true,
    board: board([]),
    actor: LEAD,
    input: 'Move "Ghost card" to Review.',
    mock: {
      operations: [
        { op: { op: "move_card", cardId: "card_ghost", targetColumnId: "col_review" }, expectLegal: false, reasonIncludes: "not found on this board" },
      ],
    },
  },
  {
    id: "matrix-create-valid-member",
    title: "Matrix: valid create as MEMBER",
    adversarial: false,
    board: board([]),
    actor: MEMBER,
    input: "New task: label the spare parts bin.",
    mock: {
      operations: [{ op: { op: "create_card", columnId: "col_ready", title: "Label the spare parts bin" }, expectLegal: true }],
    },
  },
  {
    id: "matrix-create-wip-full",
    title: "Matrix: create into a WIP-full column",
    adversarial: true,
    board: board(
      [card({ id: "card_busy", title: "Existing WIP card", columnId: "col_doing", assigneeId: "user_member" })],
      { columns: COLUMNS.map((c) => (c.id === "col_doing" ? { ...c, wipLimit: 1 } : { ...c })) }
    ),
    actor: LEAD,
    input: "Add a new card straight into Doing: fix the flaky limit switch.",
    mock: {
      operations: [
        { op: { op: "create_card", columnId: "col_doing", title: "Fix the flaky limit switch" }, expectLegal: false, reasonIncludes: "WIP limit of 1" },
      ],
    },
  },
  {
    id: "matrix-create-nonexistent-column",
    title: "Matrix: create into a nonexistent column",
    adversarial: true,
    board: board([]),
    actor: LEAD,
    input: "Add 'Test the claw' to the Icebox.",
    mock: {
      operations: [
        { op: { op: "create_card", columnId: "col_icebox", title: "Test the claw" }, expectLegal: false, reasonIncludes: "not found on this board" },
      ],
    },
  },
  {
    id: "matrix-assign-outsider",
    title: "Matrix: assign to a non-member",
    adversarial: true,
    board: board([card({ id: "card_subject", title: "Subject card", columnId: "col_ready" })]),
    actor: LEAD,
    input: "Assign the subject card to user_stranger.",
    mock: {
      operations: [
        { op: { op: "assign_card", cardId: "card_subject", assigneeId: "user_stranger" }, expectLegal: false, reasonIncludes: "Assignee must be a team member" },
      ],
    },
  },
  {
    id: "matrix-assign-teammate",
    title: "Matrix: assign to a team member",
    adversarial: false,
    board: board([card({ id: "card_subject", title: "Subject card", columnId: "col_ready" })]),
    actor: LEAD,
    input: "Assign the subject card to user_member2.",
    mock: {
      operations: [
        { op: { op: "assign_card", cardId: "card_subject", assigneeId: "user_member2" }, expectLegal: true },
      ],
    },
  },
  {
    id: "matrix-comment-valid",
    title: "Matrix: comment on an existing card",
    adversarial: false,
    board: board([card({ id: "card_subject", title: "Subject card", columnId: "col_doing", assigneeId: "user_member" })]),
    actor: MEMBER,
    input: "Note on subject card: blocked on parts delivery.",
    mock: {
      operations: [
        { op: { op: "add_comment", cardId: "card_subject", body: "Blocked on parts delivery." }, expectLegal: true },
      ],
    },
  },
  {
    id: "matrix-comment-missing-card",
    title: "Matrix: comment on a nonexistent card",
    adversarial: true,
    board: board([]),
    actor: MEMBER,
    input: "Note on the ghost card: still waiting.",
    mock: {
      operations: [
        { op: { op: "add_comment", cardId: "card_ghost", body: "Still waiting." }, expectLegal: false, reasonIncludes: "not found on this board" },
      ],
    },
  },
];

// ─── Write files ────────────────────────────────────────────────────────────

const all = [...narrativeFixtures, ...matrixFixtures, ...guardFixtures];

const ids = new Set<string>();
for (const fixture of all) {
  if (ids.has(fixture.id)) {
    throw new Error(`Duplicate fixture id: ${fixture.id}`);
  }
  ids.add(fixture.id);
  // Validate against the loader schema so generated fixtures can never drift.
  fixtureSchema.parse(fixture);
}

fs.mkdirSync(FIXTURES_DIR, { recursive: true });
for (const stale of fs.readdirSync(FIXTURES_DIR)) {
  if (stale.endsWith(".json")) fs.unlinkSync(path.join(FIXTURES_DIR, stale));
}
for (const fixture of all) {
  fs.writeFileSync(path.join(FIXTURES_DIR, `${fixture.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
}

console.log(`Wrote ${all.length} fixtures to ${FIXTURES_DIR}`);
console.log(`  narrative: ${narrativeFixtures.length}`);
console.log(`  matrix:    ${matrixFixtures.length + guardFixtures.length}`);
console.log(`  adversarial: ${all.filter((f) => f.adversarial).length}`);
