import assert from "node:assert/strict";
import test from "node:test";

import type { DriveInventory } from "./contracts.js";
import { formatDriveInventory, formatOrganizeFolderProposal, sanitizeDisplayValue } from "./inventory-message.js";
import type { OrganizeFolderProposal } from "./proposal.js";

const inventory: DriveInventory = {
  run_id: "run",
  workspace_identity_digest: "workspace",
  complete: true,
  folders: [],
  files: Array.from({ length: 25 }, (_, index) => ({
    ref: `file-${index}`,
    identity_digest: `digest-${index}`,
    name: `document-${index}.pdf`,
    relative_path: `Research / document-${index}.pdf`,
    parent_ref: "research",
    parent_path: "Research",
    version: "1",
  })),
};

test("formats a bounded safe workspace inventory", () => {
  const message = formatDriveInventory(inventory);
  assert.match(message, /Eligible PDFs: 25/u);
  assert.match(message, /…and 5 more/u);
  assert.doesNotMatch(message, /file-24|workspace_identity/u);
});

test("neutralizes links and control characters in untrusted display values", () => {
  assert.equal(sanitizeDisplayValue("  hello\nhttps://evil.example/x  ", "fallback"), "hello [link removed]");
  assert.equal(sanitizeDisplayValue("", "fallback"), "fallback");
});

test("formats dynamic taxonomy, preserve, move, and review decisions", () => {
  const proposal: OrganizeFolderProposal = {
    proposal_id: "93e2548b-8f12-45a2-be12-cd7009341b17",
    workspace_identity_digest: "workspace",
    taxonomy: [
      { name: "Engineering", description: "Implementation", action: "REUSE", existing_folder_ref: "eng", existing_folder_identity_digest: "digest" },
      { name: "Research", description: "Research", action: "CREATE" },
    ],
    files: [
      { file_ref: "a", file_identity_digest: "a", file_name: "guide.pdf", original_parent_ref: "eng", original_relative_path: "Engineering / guide.pdf", decision: "PRESERVE", destination_name: "Engineering", rationale: "Already correct." },
      { file_ref: "b", file_identity_digest: "b", file_name: "paper.pdf", original_parent_ref: "root", original_relative_path: "paper.pdf", decision: "MOVE", destination_name: "Research", rationale: "Research evidence." },
      { file_ref: "c", file_identity_digest: "c", file_name: "unclear.pdf", original_parent_ref: "root", original_relative_path: "unclear.pdf", decision: "NEEDS_REVIEW", rationale: "Insufficient evidence." },
    ],
  };
  const message = formatOrganizeFolderProposal(proposal);
  assert.match(message, /1 to move · 1 already organized · 1 need review/u);
  assert.match(message, /reuse folder/u);
  assert.match(message, /create folder/u);
  assert.match(message, /Resolve every Needs Review item/u);
  assert.doesNotMatch(message, /Approve:/u);
});
