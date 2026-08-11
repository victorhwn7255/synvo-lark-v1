import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrganizeFolderDecisionCard,
  buildOrganizeFolderConfirmationCard,
  buildOrganizeFolderLoadingCard,
  buildOrganizeFolderOperationCard,
  buildOrganizeFolderRequestAcceptedCard,
  buildOrganizeFolderResultCard,
  parseOrganizeFolderCardAction,
} from "./organize-folder-card.js";

const PROPOSAL_ID = "93e2548b-8f12-45a2-be12-cd7009341b17";
const ROOT_FOLDER_URL = new URL(
  "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123?from=space",
);
const PROPOSAL = [
  `Organization proposal ${PROPOSAL_ID}`,
  "",
  "Product (1 file):",
  "  - document-01.pdf",
  "    Why: Product implementation guide.",
  "",
  "Research (1 file):",
  "  - document-02.pdf",
  "    Why: Research paper.",
  "",
  "Needs review (0 files):",
  "  - None",
  "No changes have been made.",
  "",
  `Approve: /approve-folder ${PROPOSAL_ID}`,
  `Reject: /reject-folder ${PROPOSAL_ID}`,
].join("\n");

test("shows one in-progress card without claiming that work is complete", () => {
  const card = buildOrganizeFolderLoadingCard();
  const serialized = JSON.stringify(card);
  assert.match(serialized, /Analyzing your folder/u);
  assert.match(serialized, /You’re in control/u);
  assert.match(serialized, /until you review and approve/u);
  assert.doesNotMatch(serialized, /completed/u);
});

test("confirms the fixed pilot root without exposing its token", () => {
  const serialized = JSON.stringify(buildOrganizeFolderConfirmationCard());
  assert.match(serialized, /Start folder analysis/u);
  assert.match(serialized, /approved pilot folder/u);
  assert.match(serialized, /Nothing moves during this analysis/u);
  assert.ok(serialized.includes('"action":"start_organize_folder"'));
  assert.doesNotMatch(serialized, /folder_token|fldcn|root_token/iu);
});

test("replaces the confirmation with a clear accepted state", () => {
  assert.match(
    JSON.stringify(buildOrganizeFolderRequestAcceptedCard()),
    /Folder analysis requested/u,
  );
});

test("shows the optional animated loader without requiring it", () => {
  const card = buildOrganizeFolderLoadingCard("img_v2_loading_hourglass");
  const serialized = JSON.stringify(card);
  assert.match(serialized, /img_v2_loading_hourglass/u);
  assert.match(serialized, /Read files/u);
  assert.match(serialized, /Classify content/u);
  assert.match(serialized, /Prepare proposal/u);
  assert.doesNotMatch(serialized, /⏳/u);
});

test("renders a readable proposal with approve and reject buttons", () => {
  const card = buildOrganizeFolderResultCard(PROPOSAL_ID, PROPOSAL);
  const serialized = JSON.stringify(card);
  assert.match(serialized, /📦 Product · 1 file/u);
  assert.match(serialized, /🔬 Research · 1 file/u);
  assert.match(serialized, /Product implementation guide/u);
  assert.ok(serialized.includes('"action":"approve_folder"'));
  assert.ok(serialized.includes('"action":"reject_folder"'));
  assert.doesNotMatch(serialized, /\/approve-folder/u);
  assert.doesNotMatch(serialized, /\/reject-folder/u);
});

test("does not show decision buttons while files need review", () => {
  const card = buildOrganizeFolderResultCard(
    PROPOSAL_ID,
    PROPOSAL
      .replace("Needs review (0 files):\n  - None", "Needs review (1 file):\n  - unclear.pdf")
      .replace(`Approve: /approve-folder ${PROPOSAL_ID}\n`, "")
      .replace(`Reject: /reject-folder ${PROPOSAL_ID}`, "This report cannot be approved until every file has a supported destination."),
  );
  const serialized = JSON.stringify(card);
  assert.match(serialized, /needs review/ui);
  assert.doesNotMatch(serialized, /approve_folder/u);
  assert.doesNotMatch(serialized, /reject_folder/u);
});

test("accepts only an exact supported decision and UUID", () => {
  assert.deepEqual(
    parseOrganizeFolderCardAction({ action: "start_organize_folder" }),
    { type: "start" },
  );
  assert.equal(
    parseOrganizeFolderCardAction({
      action: "start_organize_folder",
      folder_token: "must-not-be-accepted",
    }),
    null,
  );
  assert.deepEqual(
    parseOrganizeFolderCardAction({
      action: "approve_folder",
      proposal_id: PROPOSAL_ID,
    }),
    { type: "decision", proposalId: PROPOSAL_ID, decision: "APPROVED" },
  );
  assert.deepEqual(
    parseOrganizeFolderCardAction({
      action: "reject_folder",
      proposal_id: PROPOSAL_ID,
    }),
    { type: "decision", proposalId: PROPOSAL_ID, decision: "REJECTED" },
  );
  assert.deepEqual(
    parseOrganizeFolderCardAction({
      action: "undo_folder",
      proposal_id: PROPOSAL_ID,
    }),
    { type: "undo", proposalId: PROPOSAL_ID },
  );
  assert.equal(parseOrganizeFolderCardAction({ action: "approve_folder" }), null);
  assert.equal(
    parseOrganizeFolderCardAction({
      action: "delete_folder",
      proposal_id: PROPOSAL_ID,
    }),
    null,
  );
});

test("replaces action buttons with one terminal decision card", () => {
  const card = buildOrganizeFolderDecisionCard(
    `Proposal ${PROPOSAL_ID} is now rejected.\n\nNo files were moved.`,
  );
  const serialized = JSON.stringify(card);
  assert.match(serialized, /Proposal rejected/u);
  assert.equal(serialized.includes('"tag":"button"'), false);
});

test("renders a verified execution with an undo button and no slash command", () => {
  const card = buildOrganizeFolderOperationCard(
    [
      `Execution completed for proposal ${PROPOSAL_ID}.`,
      "",
      "- document-01.pdf: verified",
      "- document-02.pdf: verified",
      "",
      `Undo: /undo-folder ${PROPOSAL_ID}`,
    ].join("\n"),
    ROOT_FOLDER_URL,
  );
  assert.ok(card);
  const serialized = JSON.stringify(card);
  assert.match(serialized, /Folder organized successfully/u);
  assert.match(serialized, /Open the folder below/u);
  assert.match(serialized, /Open updated folder/u);
  assert.match(serialized, /synvo-ai\.larksuite\.com/u);
  assert.match(serialized, /Undo file moves/u);
  assert.ok(serialized.includes('"action":"undo_folder"'));
  assert.doesNotMatch(serialized, /\/undo-folder/u);
});
