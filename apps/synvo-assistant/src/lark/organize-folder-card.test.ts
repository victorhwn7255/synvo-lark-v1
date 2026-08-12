import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrganizeFolderConfirmationCard,
  buildOrganizeFolderLoadingCard,
  buildOrganizeFolderOperationCard,
  buildOrganizeFolderResultCard,
  parseOrganizeFolderCardAction,
} from "./organize-folder-card.js";

const PROPOSAL_ID = "93e2548b-8f12-45a2-be12-cd7009341b17";
const DIGEST = "a".repeat(64);
const ROOT_FOLDER_URL = new URL(
  "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123?from=space",
);
const PROPOSAL = [
  `Workspace organization proposal ${PROPOSAL_ID}`,
  "",
  "Summary: 15 PDFs · 11 to move · 4 already organized · 0 need review",
  "",
  "Engineering (8 PDFs · reuse folder)",
  "Purpose: Product architecture and implementation material.",
  ...Array.from({ length: 8 }, (_, index) => [
    `- document-${String(index + 1).padStart(2, "0")}.pdf`,
    "  Move from Inbox / source.pdf",
    "  Why: Engineering implementation guide.",
  ]).flat(),
  "",
  "Research (7 PDFs · create folder)",
  "Purpose: Research reports and external analysis.",
  ...Array.from({ length: 7 }, (_, index) => [
    `- paper-${String(index + 1).padStart(2, "0")}.pdf`,
    "  Keep in place",
    "  Why: Research evidence.",
  ]).flat(),
  "",
  "Needs review (0 PDFs)",
  "- None",
  "",
  "No Drive files or folders have been changed.",
  "",
  `Approve: /approve-workspace ${PROPOSAL_ID}`,
  `Reject: /reject-workspace ${PROPOSAL_ID}`,
].join("\n");

test("renders exact provider consent without native identifiers", () => {
  const serialized = JSON.stringify(buildOrganizeFolderConfirmationCard({
    pdfPaths: Array.from({ length: 25 }, (_, index) => `Inbox / document-${index + 1}.pdf`),
    newOrChangedCount: 3,
    snapshotDigest: DIGEST,
    expiresAt: 1_800_000_000_000,
  }));
  assert.match(serialized, /25 eligible PDFs/u);
  assert.match(serialized, /3 PDFs are new or changed/u);
  assert.match(serialized, /…and 5 more PDFs/u);
  assert.match(serialized, /Voyage/u);
  assert.match(serialized, /NVIDIA NIM/u);
  assert.ok(serialized.includes('"action":"start_organize_workspace"'));
  assert.doesNotMatch(serialized, /folder_token|fldcn|root_token/iu);
});

test("shows one read-only workspace progress card", () => {
  const serialized = JSON.stringify(buildOrganizeFolderLoadingCard("img_loading"));
  assert.match(serialized, /Analyzing your workspace/u);
  assert.match(serialized, /img_loading/u);
  assert.match(serialized, /No Drive files or folders are changed/u);
});

test("paginates a large proposal and keeps approval on every page", () => {
  const first = JSON.stringify(buildOrganizeFolderResultCard(PROPOSAL_ID, PROPOSAL));
  assert.match(first, /Page 1 of/u);
  assert.ok(first.includes('"action":"workspace_proposal_page"'));
  assert.ok(first.includes('"action":"approve_workspace"'));
  assert.ok(first.includes('"action":"reject_workspace"'));
  assert.doesNotMatch(first, /\/approve-workspace/u);

  const second = JSON.stringify(buildOrganizeFolderResultCard(PROPOSAL_ID, PROPOSAL, 1));
  assert.match(second, /Page 2 of/u);
  assert.ok(second.includes('"action":"approve_workspace"'));
});

test("withholds approval while any PDF needs review", () => {
  const unresolved = PROPOSAL
    .replace("Needs review (0 PDFs)\n- None", "Needs review (1 PDF)\n- unclear.pdf")
    .replace(`Approve: /approve-workspace ${PROPOSAL_ID}\n`, "")
    .replace(`Reject: /reject-workspace ${PROPOSAL_ID}`, "Resolve every Needs Review item before approving this proposal.");
  const serialized = JSON.stringify(buildOrganizeFolderResultCard(PROPOSAL_ID, unresolved));
  assert.match(serialized, /need your review/u);
  assert.doesNotMatch(serialized, /approve_workspace/u);
});

test("accepts only exact workspace actions", () => {
  assert.deepEqual(parseOrganizeFolderCardAction({
    action: "start_organize_workspace",
    snapshot_digest: DIGEST,
    expires_at: 1_800_000_000_000,
  }), { type: "start", snapshotDigest: DIGEST, expiresAt: 1_800_000_000_000 });
  assert.deepEqual(parseOrganizeFolderCardAction({
    action: "workspace_proposal_page",
    proposal_id: PROPOSAL_ID,
    page: 2,
  }), { type: "page", proposalId: PROPOSAL_ID, page: 2 });
  assert.deepEqual(parseOrganizeFolderCardAction({
    action: "approve_workspace",
    proposal_id: PROPOSAL_ID,
  }), { type: "decision", proposalId: PROPOSAL_ID, decision: "APPROVED" });
  assert.deepEqual(parseOrganizeFolderCardAction({
    action: "undo_workspace",
    proposal_id: PROPOSAL_ID,
  }), { type: "undo", proposalId: PROPOSAL_ID });
  assert.equal(parseOrganizeFolderCardAction({ action: "approve_folder", proposal_id: PROPOSAL_ID }), null);
});

test("renders verified execution with an undo button", () => {
  const card = buildOrganizeFolderOperationCard([
    `Workspace organization completed for proposal ${PROPOSAL_ID}.`,
    "",
    "Moved and verified: 11 files",
    "Already organized: 4 files",
    "",
    `Undo: /undo-workspace ${PROPOSAL_ID}`,
  ].join("\n"), ROOT_FOLDER_URL);
  assert.ok(card);
  const serialized = JSON.stringify(card);
  assert.match(serialized, /Workspace organized/u);
  assert.match(serialized, /Open workspace/u);
  assert.ok(serialized.includes('"action":"undo_workspace"'));
  assert.doesNotMatch(serialized, /\/undo-workspace/u);
});
