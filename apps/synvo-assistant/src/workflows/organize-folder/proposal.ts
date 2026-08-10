import type { DriveInventory } from "./contracts.js";
import { organizeFolderPilotPolicy } from "./pilot-policy.js";

export type ProposalStatus =
  | "PROPOSED"
  | "APPROVED"
  | "REJECTED"
  | "STALE";

export type OrganizeFolderProposal = {
  proposal_id: string;
  moves: Array<{
    file_ref: string;
    file_identity_digest: string;
    file_name: string;
    destination_ref: string;
    destination_identity_digest: string;
    destination_name: "Product" | "Research";
    rationale?: string;
  }>;
  needs_review?: Array<{
    file_name: string;
    rationale: string;
  }>;
};

export type ContentDecision = {
  file_name: string;
  destination: "Product" | "Research" | "Needs review";
  rationale: string;
};

export type ProposalBuildErrorCode =
  | "INVENTORY_NOT_READY"
  | "MISSING_DECISION"
  | "UNKNOWN_DECISION"
  | "DUPLICATE_DECISION"
  | "DUPLICATE_FILE"
  | "UNEXPECTED_PROPOSAL";

export class ProposalBuildError extends Error {
  readonly code: ProposalBuildErrorCode;

  constructor(code: ProposalBuildErrorCode, message: string) {
    super(message);
    this.name = "ProposalBuildError";
    this.code = code;
  }
}

export function buildOrganizeFolderProposal(
  inventory: DriveInventory,
  runId: string,
  decisions: ContentDecision[],
): OrganizeFolderProposal {
  if (
    inventory.run_id !== runId ||
    !inventory.complete ||
    !inventory.baseline_matches ||
    inventory.issues.length > 0 ||
    inventory.skipped.length > 0
  ) {
    throw new ProposalBuildError(
      "INVENTORY_NOT_READY",
      "The verified inventory is not ready for a proposal.",
    );
  }

  const destinations = new Map(
    inventory.destinations.map((destination) => [destination.name, destination]),
  );
  const seenRefs = new Set<string>();
  const seenNames = new Set<string>();
  for (const file of inventory.files) {
    if (seenRefs.has(file.ref) || seenNames.has(file.name)) {
      throw new ProposalBuildError(
        "DUPLICATE_FILE",
        "The inventory contains a duplicate file.",
      );
    }
    seenRefs.add(file.ref);
    seenNames.add(file.name);
  }
  const decisionsByName = new Map<string, ContentDecision>();
  for (const decision of decisions) {
    if (decisionsByName.has(decision.file_name)) {
      throw new ProposalBuildError(
        "DUPLICATE_DECISION",
        "The content plan contains a duplicate file decision.",
      );
    }
    decisionsByName.set(decision.file_name, decision);
  }
  const inventoryNames = new Set(inventory.files.map((file) => file.name));
  if ([...decisionsByName.keys()].some((name) => !inventoryNames.has(name))) {
    throw new ProposalBuildError(
      "UNKNOWN_DECISION",
      "The content plan contains a decision for an unknown file.",
    );
  }

  const needsReview: NonNullable<OrganizeFolderProposal["needs_review"]> = [];
  const moves = inventory.files.flatMap((file) => {
    if (file.parent_ref !== "root") {
      throw new ProposalBuildError(
        "INVENTORY_NOT_READY",
        "A proposed file is outside the approved root.",
      );
    }
    const decision = decisionsByName.get(file.name);
    if (!decision) {
      throw new ProposalBuildError(
        "MISSING_DECISION",
        "The content plan is missing a file decision.",
      );
    }
    if (decision.destination === "Needs review") {
      needsReview.push({
        file_name: file.name,
        rationale: decision.rationale,
      });
      return [];
    }
    const destination = destinations.get(decision.destination);
    if (!destination || destination.child_count !== 0) {
      throw new ProposalBuildError(
        "INVENTORY_NOT_READY",
        "An approved destination is not ready for a proposal.",
      );
    }
    return [{
      file_ref: file.ref,
      file_identity_digest: file.identity_digest,
      file_name: file.name,
      destination_ref: destination.ref,
      destination_identity_digest: destination.identity_digest,
      destination_name: decision.destination,
      rationale: decision.rationale,
    }];
  });

  moves.sort(
    (left, right) =>
      left.destination_name.localeCompare(right.destination_name) ||
      left.file_name.localeCompare(right.file_name) ||
      left.file_ref.localeCompare(right.file_ref),
  );
  const productFileCount = moves.filter(
    (move) => move.destination_name === "Product",
  ).length;
  const researchFileCount = moves.filter(
    (move) => move.destination_name === "Research",
  ).length;
  if (
    needsReview.length === 0 &&
    (moves.length !== organizeFolderPilotPolicy.rootFileCount ||
      productFileCount !== 2 ||
      researchFileCount !== 2)
  ) {
    throw new ProposalBuildError(
      "UNEXPECTED_PROPOSAL",
      "The proposal does not match the approved four-file pilot.",
    );
  }

  return {
    proposal_id: runId,
    moves,
    needs_review: needsReview,
  };
}

export function organizeFolderProposalAssociatedData(runId: string): string {
  return `organize-folder-run:${runId}:proposal:v1`;
}
