import assert from "node:assert/strict";
import test from "node:test";

import type { DriveInventory } from "./contracts.js";
import {
  buildOrganizeFolderProposal,
  ProposalBuildError,
  type ContentDecision,
  type ProposedTaxonomyFolder,
} from "./proposal.js";

const RUN_ID = "93e2548b-8f12-45a2-be12-cd7009341b17";

function inventory(count: number, options: { alreadyInEngineering?: boolean } = {}): DriveInventory {
  return {
    run_id: RUN_ID,
    workspace_identity_digest: "workspace-digest",
    complete: true,
    folders: [{
      ref: "folder-engineering",
      identity_digest: "folder-digest",
      name: "Engineering",
      relative_path: "Engineering",
      parent_ref: "root",
      depth: 1,
      owned_by_requester: true,
    }],
    files: Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      const parentPath = options.alreadyInEngineering && index === 0 ? "Engineering" : "Inbox";
      return {
        ref: `file-${number}`,
        identity_digest: `digest-${number}`,
        name: `document-${number}.pdf`,
        relative_path: `${parentPath} / document-${number}.pdf`,
        parent_ref: parentPath === "Engineering" ? "folder-engineering" : "folder-inbox",
        parent_path: parentPath,
        version: "1",
      };
    }),
  };
}

const taxonomy: ProposedTaxonomyFolder[] = [
  { name: "Engineering", description: "Product and implementation material." },
  { name: "Research", description: "Research reports and external evidence." },
];

function decisions(count: number): ContentDecision[] {
  return Array.from({ length: count }, (_, index) => ({
    file_ref: `file-${index + 1}`,
    destination: index % 2 === 0 ? "Engineering" : "Research",
    rationale: "The document content matches this destination.",
  }));
}

test("builds a complete dynamic proposal and reuses an owned folder", () => {
  const result = buildOrganizeFolderProposal(
    inventory(15, { alreadyInEngineering: true }),
    RUN_ID,
    taxonomy,
    decisions(15),
  );
  assert.equal(result.files.length, 15);
  assert.deepEqual(result.taxonomy.map((folder) => [folder.name, folder.action]), [
    ["Engineering", "REUSE"],
    ["Research", "CREATE"],
  ]);
  assert.equal(result.files.find((file) => file.file_ref === "file-1")?.decision, "PRESERVE");
  assert.equal(result.files.filter((file) => file.decision === "MOVE").length, 14);
});

test("preserves a correctly classified PDF inside a nested destination", () => {
  const nested = inventory(1);
  nested.files[0] = {
    ...nested.files[0]!,
    relative_path: "Engineering / Guides / document-1.pdf",
    parent_ref: "folder-guides",
    parent_path: "Engineering / Guides",
  };
  const result = buildOrganizeFolderProposal(
    nested,
    RUN_ID,
    [{ name: "Engineering", description: "Product and implementation material." }],
    [{ file_ref: "file-1", destination: "Engineering", rationale: "Implementation guide." }],
  );
  assert.equal(result.files[0]?.decision, "PRESERVE");
  assert.equal(result.files[0]?.original_parent_ref, "folder-guides");
});

test("supports the accepted 1, 15, and 99 PDF boundaries", () => {
  const one = buildOrganizeFolderProposal(
    inventory(1),
    RUN_ID,
    [{ name: "Reference", description: "The only useful category." }],
    [{ file_ref: "file-1", destination: "Reference", rationale: "One document." }],
  );
  assert.equal(one.files.length, 1);
  assert.equal(buildOrganizeFolderProposal(inventory(15), RUN_ID, taxonomy, decisions(15)).files.length, 15);
  assert.equal(buildOrganizeFolderProposal(inventory(99), RUN_ID, taxonomy, decisions(99)).files.length, 99);
});

test("accepts a planner-validated single-folder homogeneous workspace", () => {
  const result = buildOrganizeFolderProposal(
    inventory(15),
    RUN_ID,
    [{ name: "Engineering", description: "One genuinely homogeneous collection." }],
    Array.from({ length: 15 }, (_, index) => ({
      file_ref: `file-${index + 1}`,
      destination: "Engineering",
      rationale: "The document belongs to the shared engineering theme.",
    })),
  );
  assert.equal(result.taxonomy.length, 1);
  assert.equal(result.files.length, 15);
});

test("rejects 100 PDFs and invalid taxonomy", () => {
  assert.throws(
    () => buildOrganizeFolderProposal(inventory(100), RUN_ID, taxonomy, decisions(100)),
    (error: unknown) => error instanceof ProposalBuildError && error.code === "INVENTORY_NOT_READY",
  );
  assert.throws(
    () => buildOrganizeFolderProposal(inventory(4), RUN_ID, [
      { name: "Research", description: "One." },
      { name: "research", description: "Duplicate." },
    ], decisions(4)),
    (error: unknown) => error instanceof ProposalBuildError && error.code === "INVALID_TAXONOMY",
  );
});

test("requires exactly one known decision for every PDF", () => {
  assert.throws(
    () => buildOrganizeFolderProposal(inventory(3), RUN_ID, taxonomy, decisions(2)),
    (error: unknown) => error instanceof ProposalBuildError && error.code === "MISSING_DECISION",
  );
  assert.throws(
    () => buildOrganizeFolderProposal(inventory(3), RUN_ID, taxonomy, [
      ...decisions(3),
      { file_ref: "file-1", destination: "Engineering", rationale: "Duplicate." },
    ]),
    (error: unknown) => error instanceof ProposalBuildError && error.code === "DUPLICATE_DECISION",
  );
});

test("keeps Needs review out of the taxonomy and blocks empty destinations", () => {
  const withReview = buildOrganizeFolderProposal(inventory(3), RUN_ID, [
    { name: "Engineering", description: "Implementation." },
    { name: "Research", description: "Research." },
  ], [
    { file_ref: "file-1", destination: "Engineering", rationale: "Implementation." },
    { file_ref: "file-2", destination: "Research", rationale: "Research." },
    { file_ref: "file-3", destination: "Needs review", rationale: "Ambiguous evidence." },
  ]);
  assert.equal(
    withReview.files.find((file) => file.file_ref === "file-3")?.decision,
    "NEEDS_REVIEW",
  );
  assert.equal(withReview.taxonomy.some((folder) => folder.name === "Needs review"), false);

  assert.throws(
    () => buildOrganizeFolderProposal(inventory(3), RUN_ID, taxonomy, [
      { file_ref: "file-1", destination: "Engineering", rationale: "Engineering." },
      { file_ref: "file-2", destination: "Engineering", rationale: "Engineering." },
      { file_ref: "file-3", destination: "Needs review", rationale: "Ambiguous." },
    ]),
    (error: unknown) => error instanceof ProposalBuildError && error.code === "INVALID_TAXONOMY",
  );
});
