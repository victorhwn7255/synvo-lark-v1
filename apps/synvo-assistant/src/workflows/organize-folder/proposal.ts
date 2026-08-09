import type { DriveInventory } from "./contracts.js";
import { organizeFolderPilotPolicy } from "./pilot-policy.js";

export type ProposalStatus =
  | "PROPOSED"
  | "APPROVED"
  | "REJECTED"
  | "STALE";

export type OrganizeFolderProposal = {
  proposal_id: string;
  inventory_scan_id: string;
  moves: Array<{
    file_ref: string;
    file_identity_digest: string;
    file_name: string;
    destination_ref: string;
    destination_identity_digest: string;
    destination_name: "Product" | "Research";
  }>;
};

export type ProposalBuildErrorCode =
  | "INVENTORY_NOT_READY"
  | "MISSING_PREFIX"
  | "UNKNOWN_PREFIX"
  | "CONFLICTING_PREFIX"
  | "AMBIGUOUS_PREFIX"
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

function classifyFileName(
  fileName: string,
): (typeof organizeFolderPilotPolicy.classifications)[number] {
  const mentioned = organizeFolderPilotPolicy.classifications.filter(({ label }) =>
    fileName.includes(`[${label}]`),
  );
  if (mentioned.length > 1) {
    throw new ProposalBuildError(
      "CONFLICTING_PREFIX",
      "A file name contains conflicting organization prefixes.",
    );
  }

  const exact = organizeFolderPilotPolicy.classifications.find(({ prefix }) =>
    fileName.startsWith(prefix),
  );
  if (!exact) {
    if (mentioned.length === 1) {
      throw new ProposalBuildError(
        "AMBIGUOUS_PREFIX",
        "A file name contains an ambiguous organization prefix.",
      );
    }
    if (/^\[[^\]]+\]/u.test(fileName)) {
      throw new ProposalBuildError(
        "UNKNOWN_PREFIX",
        "A file name contains an unknown organization prefix.",
      );
    }
    throw new ProposalBuildError(
      "MISSING_PREFIX",
      "A file name is missing an organization prefix.",
    );
  }

  const remainder = fileName.slice(exact.prefix.length);
  if (
    remainder.trim().length === 0 ||
    organizeFolderPilotPolicy.classifications.some(({ label }) =>
      remainder.includes(`[${label}]`),
    )
  ) {
    throw new ProposalBuildError(
      "AMBIGUOUS_PREFIX",
      "A file name contains an ambiguous organization prefix.",
    );
  }
  return exact;
}

export function buildOrganizeFolderProposal(
  inventory: DriveInventory,
  runId: string,
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
  const moves = inventory.files.map((file) => {
    if (seenRefs.has(file.ref) || seenNames.has(file.name)) {
      throw new ProposalBuildError(
        "DUPLICATE_FILE",
        "The inventory contains a duplicate file.",
      );
    }
    seenRefs.add(file.ref);
    seenNames.add(file.name);

    if (file.parent_ref !== "root") {
      throw new ProposalBuildError(
        "INVENTORY_NOT_READY",
        "A proposed file is outside the approved root.",
      );
    }
    const classification = classifyFileName(file.name);
    const destination = destinations.get(classification.destinationName);
    if (!destination || destination.child_count !== 0) {
      throw new ProposalBuildError(
        "INVENTORY_NOT_READY",
        "An approved destination is not ready for a proposal.",
      );
    }
    return {
      file_ref: file.ref,
      file_identity_digest: file.identity_digest,
      file_name: file.name,
      destination_ref: destination.ref,
      destination_identity_digest: destination.identity_digest,
      destination_name: classification.destinationName,
    };
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
    moves.length !== 4 ||
    productFileCount !== 2 ||
    researchFileCount !== 2
  ) {
    throw new ProposalBuildError(
      "UNEXPECTED_PROPOSAL",
      "The proposal does not match the approved four-file pilot.",
    );
  }

  return {
    proposal_id: runId,
    inventory_scan_id: inventory.scan_id,
    moves,
  };
}

export function organizeFolderProposalAssociatedData(runId: string): string {
  return `organize-folder-run:${runId}:proposal:v1`;
}
