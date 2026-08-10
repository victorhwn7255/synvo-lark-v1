import assert from "node:assert/strict";
import test from "node:test";

import type { DriveInventory } from "./contracts.js";
import {
  buildOrganizeFolderProposal,
  type ContentDecision,
  organizeFolderProposalAssociatedData,
  ProposalBuildError,
} from "./proposal.js";

const RUN_ID = "4d872758-1f71-4ed8-b141-a2d193ceea91";
const IDENTITY_DIGEST = "a".repeat(64);
const FILE_NAMES = [
  "document-01.pdf",
  "document-02.pdf",
  "document-03.pdf",
  "document-04.pdf",
] as const;

function inventory(fileNames: readonly string[] = FILE_NAMES): DriveInventory {
  return {
    run_id: RUN_ID,
    complete: true,
    baseline_matches: true,
    root: {
      ref: "root",
      identity_digest: IDENTITY_DIGEST,
      name: "Test_Synvo_AI_Assistant",
      parent_ref: null,
      owner_verification: "matched",
      child_count: 6,
    },
    destinations: [
      {
        ref: "d001",
        identity_digest: "b".repeat(64),
        name: "Product",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
      {
        ref: "d002",
        identity_digest: "c".repeat(64),
        name: "Research",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
    ],
    files: fileNames.map((name, index) => ({
      ref: `f${String(index + 1).padStart(3, "0")}`,
      identity_digest: String(index + 1).repeat(64),
      name,
      type: "file",
      parent_ref: "root",
      owner_verification: "matched" as const,
    })),
    skipped: [],
    issues: [],
    summary: {
      root_folder_count: 2,
      root_file_count: fileNames.length,
      root_skipped_count: 0,
      destination_child_count: 0,
    },
  };
}

function decisions(): ContentDecision[] {
  return FILE_NAMES.map((fileName, index) => ({
    file_name: fileName,
    destination: index < 2 ? "Research" : "Product",
    rationale: index < 2 ? "Research evidence." : "Product documentation evidence.",
  }));
}

test("builds the exact content-based four-file proposal", () => {
  const proposal = buildOrganizeFolderProposal(inventory(), RUN_ID, decisions());

  assert.equal(proposal.proposal_id, RUN_ID);
  assert.deepEqual(
    proposal.moves.map((move) => [
      move.file_name,
      move.destination_name,
      move.rationale,
    ]),
    [
      ["document-03.pdf", "Product", "Product documentation evidence."],
      ["document-04.pdf", "Product", "Product documentation evidence."],
      ["document-01.pdf", "Research", "Research evidence."],
      ["document-02.pdf", "Research", "Research evidence."],
    ],
  );
  assert.deepEqual(proposal.needs_review, []);
});

test("builds a non-approvable report when one file needs review", () => {
  const input = decisions();
  input[0] = {
    file_name: FILE_NAMES[0],
    destination: "Needs review",
    rationale: "The document evidence is ambiguous.",
  };

  const proposal = buildOrganizeFolderProposal(inventory(), RUN_ID, input);

  assert.equal(proposal.moves.length, 3);
  assert.deepEqual(proposal.needs_review, [
    {
      file_name: FILE_NAMES[0],
      rationale: "The document evidence is ambiguous.",
    },
  ]);
});

test("rejects missing, unknown, and duplicate content decisions", () => {
  assert.throws(
    () => buildOrganizeFolderProposal(inventory(), RUN_ID, decisions().slice(1)),
    (error) =>
      error instanceof ProposalBuildError && error.code === "MISSING_DECISION",
  );
  assert.throws(
    () =>
      buildOrganizeFolderProposal(inventory(), RUN_ID, [
        ...decisions(),
        {
          file_name: "unknown.pdf",
          destination: "Research",
          rationale: "Unknown input.",
        },
      ]),
    (error) =>
      error instanceof ProposalBuildError && error.code === "UNKNOWN_DECISION",
  );
  assert.throws(
    () =>
      buildOrganizeFolderProposal(inventory(), RUN_ID, [
        ...decisions(),
        decisions()[0]!,
      ]),
    (error) =>
      error instanceof ProposalBuildError && error.code === "DUPLICATE_DECISION",
  );
});

test("rejects duplicate files and an unverified inventory", () => {
  const duplicate = inventory();
  duplicate.files[1] = { ...duplicate.files[0]! };
  assert.throws(
    () => buildOrganizeFolderProposal(duplicate, RUN_ID, decisions()),
    (error) =>
      error instanceof ProposalBuildError && error.code === "DUPLICATE_FILE",
  );

  const unverified = inventory();
  unverified.baseline_matches = false;
  assert.throws(
    () => buildOrganizeFolderProposal(unverified, RUN_ID, decisions()),
    (error) =>
      error instanceof ProposalBuildError && error.code === "INVENTORY_NOT_READY",
  );
});

test("rejects an unexpected folder, nonempty destination, or wrong split", () => {
  const unexpectedFolder = inventory();
  unexpectedFolder.issues.push("Found one unexpected root folder.");
  assert.throws(
    () => buildOrganizeFolderProposal(unexpectedFolder, RUN_ID, decisions()),
    (error) =>
      error instanceof ProposalBuildError && error.code === "INVENTORY_NOT_READY",
  );

  const nonemptyDestination = inventory();
  nonemptyDestination.destinations[0]!.child_count = 1;
  assert.throws(
    () => buildOrganizeFolderProposal(nonemptyDestination, RUN_ID, decisions()),
    (error) =>
      error instanceof ProposalBuildError && error.code === "INVENTORY_NOT_READY",
  );

  const wrongSplit = decisions().map((decision) => ({
    ...decision,
    destination: "Research" as const,
  }));
  assert.throws(
    () => buildOrganizeFolderProposal(inventory(), RUN_ID, wrongSplit),
    (error) =>
      error instanceof ProposalBuildError && error.code === "UNEXPECTED_PROPOSAL",
  );
});

test("rejects an inventory from another workflow run", () => {
  assert.throws(
    () =>
      buildOrganizeFolderProposal(
        inventory(),
        "5f982758-1f71-4ed8-b141-a2d193ceea92",
        decisions(),
      ),
    (error) =>
      error instanceof ProposalBuildError && error.code === "INVENTORY_NOT_READY",
  );
});

test("binds encrypted proposal contents to the workflow run", () => {
  assert.equal(
    organizeFolderProposalAssociatedData(RUN_ID),
    `organize-folder-run:${RUN_ID}:proposal:v1`,
  );
});
