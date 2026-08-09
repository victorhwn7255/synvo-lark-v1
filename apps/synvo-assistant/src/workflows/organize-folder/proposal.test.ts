import assert from "node:assert/strict";
import test from "node:test";

import type { DriveInventory } from "./contracts.js";
import {
  buildOrganizeFolderProposal,
  organizeFolderProposalAssociatedData,
  ProposalBuildError,
} from "./proposal.js";

const IDENTITY_DIGEST = "a".repeat(64);

function inventory(fileNames: string[] = [
  "[research] - Agentic Context Engineering Research.pdf",
  "[research] - Anthropic Agentic Engineering.pdf",
  "[product] - Local_Cocoa_PDF_Chunking_Technical_Guide.pdf",
  "[product] - Local_Cocoa_Technical_Onboarding_Guide.pdf",
]): DriveInventory {
  return {
    run_id: "4d872758-1f71-4ed8-b141-a2d193ceea91",
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
      identity_digest: "d".repeat(64),
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

function assertProposalError(fileName: string, code: string): void {
  assert.throws(
    () => buildOrganizeFolderProposal(inventory([
      fileName,
      "[research] - Anthropic Agentic Engineering.pdf",
      "[product] - Local_Cocoa_PDF_Chunking_Technical_Guide.pdf",
      "[product] - Local_Cocoa_Technical_Onboarding_Guide.pdf",
    ]), "4d872758-1f71-4ed8-b141-a2d193ceea91"),
    (error) => error instanceof ProposalBuildError && error.code === code,
  );
}

test("builds the exact deterministic four-file proposal", () => {
  const proposal = buildOrganizeFolderProposal(
    inventory(),
    "4d872758-1f71-4ed8-b141-a2d193ceea91",
  );

  assert.equal(proposal.proposal_id, "4d872758-1f71-4ed8-b141-a2d193ceea91");
  assert.deepEqual(
    proposal.moves.map((move) => [move.file_ref, move.destination_ref]),
    [
      ["f003", "d001"],
      ["f004", "d001"],
      ["f001", "d002"],
      ["f002", "d002"],
    ],
  );
});

test("rejects missing, unknown, conflicting, and ambiguous prefixes", () => {
  assertProposalError("Unclassified.pdf", "MISSING_PREFIX");
  assertProposalError("[legal] - Unknown.pdf", "UNKNOWN_PREFIX");
  assertProposalError(
    "[product] - [research] - Conflicting.pdf",
    "CONFLICTING_PREFIX",
  );
  assertProposalError("notes [research].pdf", "AMBIGUOUS_PREFIX");
});

test("rejects duplicate files and an unverified inventory", () => {
  const duplicate = inventory();
  duplicate.files[1] = { ...duplicate.files[0]! };
  assert.throws(
    () => buildOrganizeFolderProposal(
      duplicate,
      "4d872758-1f71-4ed8-b141-a2d193ceea91",
    ),
    (error) => error instanceof ProposalBuildError && error.code === "DUPLICATE_FILE",
  );

  const unverified = inventory();
  unverified.baseline_matches = false;
  assert.throws(
    () => buildOrganizeFolderProposal(
      unverified,
      "4d872758-1f71-4ed8-b141-a2d193ceea91",
    ),
    (error) =>
      error instanceof ProposalBuildError && error.code === "INVENTORY_NOT_READY",
  );
});

test("rejects an unexpected folder or a nonempty destination", () => {
  const unexpectedFolder = inventory();
  unexpectedFolder.issues.push("Found one unexpected root folder.");
  assert.throws(
    () =>
      buildOrganizeFolderProposal(
        unexpectedFolder,
        "4d872758-1f71-4ed8-b141-a2d193ceea91",
      ),
    (error) =>
      error instanceof ProposalBuildError &&
      error.code === "INVENTORY_NOT_READY",
  );

  const nonemptyDestination = inventory();
  nonemptyDestination.destinations[0]!.child_count = 1;
  assert.throws(
    () =>
      buildOrganizeFolderProposal(
        nonemptyDestination,
        "4d872758-1f71-4ed8-b141-a2d193ceea91",
      ),
    (error) =>
      error instanceof ProposalBuildError &&
      error.code === "INVENTORY_NOT_READY",
  );
});

test("rejects an inventory from another workflow run", () => {
  assert.throws(
    () =>
      buildOrganizeFolderProposal(
        inventory(),
        "5f982758-1f71-4ed8-b141-a2d193ceea92",
      ),
    (error) =>
      error instanceof ProposalBuildError &&
      error.code === "INVENTORY_NOT_READY",
  );
});

test("binds encrypted proposal contents to the workflow run", () => {
  assert.equal(
    organizeFolderProposalAssociatedData(
      "4d872758-1f71-4ed8-b141-a2d193ceea91",
    ),
    "organize-folder-run:4d872758-1f71-4ed8-b141-a2d193ceea91:proposal:v1",
  );
});
