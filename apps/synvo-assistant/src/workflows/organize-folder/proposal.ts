import type { DriveInventory } from "./contracts.js";
import {
  isSafeDestinationName,
  normalizeDestinationName,
  workspaceOrganizationPolicy,
} from "./policy.js";

export type ProposalStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "STALE";
export type WorkspaceFileDecision = "PRESERVE" | "MOVE" | "NEEDS_REVIEW";

export type OrganizeFolderProposal = {
  proposal_id: string;
  workspace_identity_digest: string;
  taxonomy: Array<{
    name: string;
    description: string;
    action: "REUSE" | "CREATE";
    existing_folder_ref?: string;
    existing_folder_identity_digest?: string;
  }>;
  files: Array<{
    file_ref: string;
    file_identity_digest: string;
    file_name: string;
    original_parent_ref: string;
    original_relative_path: string;
    decision: WorkspaceFileDecision;
    destination_name?: string;
    rationale: string;
  }>;
};

export type ProposedTaxonomyFolder = {
  name: string;
  description: string;
};

export type ContentDecision = {
  file_ref: string;
  destination: string | "Needs review";
  rationale: string;
};

export type ProposalBuildErrorCode =
  | "INVENTORY_NOT_READY"
  | "MISSING_DECISION"
  | "UNKNOWN_DECISION"
  | "DUPLICATE_DECISION"
  | "DUPLICATE_FILE"
  | "INVALID_TAXONOMY"
  | "UNEXPECTED_PROPOSAL";

export class ProposalBuildError extends Error {
  readonly code: ProposalBuildErrorCode;

  constructor(code: ProposalBuildErrorCode, message: string) {
    super(message);
    this.name = "ProposalBuildError";
    this.code = code;
  }
}

function currentTopLevelDestination(
  relativePath: string,
  fileName: string,
): string | null {
  const suffix = ` / ${fileName}`;
  if (!relativePath.endsWith(suffix)) {
    return null;
  }
  const parentPath = relativePath.slice(0, -suffix.length);
  return parentPath.split(" / ")[0] ?? null;
}

export function buildOrganizeFolderProposal(
  inventory: DriveInventory,
  runId: string,
  taxonomyInput: ProposedTaxonomyFolder[],
  decisions: ContentDecision[],
): OrganizeFolderProposal {
  if (inventory.run_id !== runId || !inventory.complete) {
    throw new ProposalBuildError(
      "INVENTORY_NOT_READY",
      "The verified workspace snapshot is not ready for a proposal.",
    );
  }
  if (
    inventory.files.length < 1 ||
    inventory.files.length > workspaceOrganizationPolicy.maxEligiblePdfs
  ) {
    throw new ProposalBuildError(
      "INVENTORY_NOT_READY",
      "The workspace does not contain a supported number of PDFs.",
    );
  }

  if (
    taxonomyInput.length < 1 ||
    taxonomyInput.length > workspaceOrganizationPolicy.maximumDestinations
  ) {
    throw new ProposalBuildError(
      "INVALID_TAXONOMY",
      "The proposed taxonomy is outside the supported folder range.",
    );
  }

  const topLevelOwnedFolders = new Map(
    inventory.folders
      .filter((folder) => folder.depth === 1 && folder.owned_by_requester)
      .map((folder) => [normalizeDestinationName(folder.name), folder]),
  );
  const seenTaxonomy = new Set<string>();
  const taxonomy = taxonomyInput.map((folder) => {
    const normalized = normalizeDestinationName(folder.name);
    if (
      !isSafeDestinationName(folder.name) ||
      normalized === "needs review" ||
      seenTaxonomy.has(normalized) ||
      !folder.description.trim()
    ) {
      throw new ProposalBuildError(
        "INVALID_TAXONOMY",
        "The proposed taxonomy contains an invalid or duplicate folder.",
      );
    }
    seenTaxonomy.add(normalized);
    const existing = topLevelOwnedFolders.get(normalized);
    return {
      name: folder.name,
      description: folder.description,
      action: existing ? "REUSE" as const : "CREATE" as const,
      ...(existing
        ? {
            existing_folder_ref: existing.ref,
            existing_folder_identity_digest: existing.identity_digest,
          }
        : {}),
    };
  });

  const seenFiles = new Set<string>();
  for (const file of inventory.files) {
    if (seenFiles.has(file.ref)) {
      throw new ProposalBuildError(
        "DUPLICATE_FILE",
        "The workspace snapshot contains a duplicate PDF.",
      );
    }
    seenFiles.add(file.ref);
  }

  const decisionsByRef = new Map<string, ContentDecision>();
  for (const decision of decisions) {
    if (decisionsByRef.has(decision.file_ref)) {
      throw new ProposalBuildError(
        "DUPLICATE_DECISION",
        "The content plan contains a duplicate PDF decision.",
      );
    }
    if (!seenFiles.has(decision.file_ref)) {
      throw new ProposalBuildError(
        "UNKNOWN_DECISION",
        "The content plan contains a decision for an unknown PDF.",
      );
    }
    decisionsByRef.set(decision.file_ref, decision);
  }

  const assignmentCounts = new Map(taxonomy.map((folder) => [folder.name, 0]));
  const files = inventory.files.map((file) => {
    const decision = decisionsByRef.get(file.ref);
    if (!decision) {
      throw new ProposalBuildError(
        "MISSING_DECISION",
        "The content plan is missing a PDF decision.",
      );
    }
    if (decision.destination === "Needs review") {
      return {
        file_ref: file.ref,
        file_identity_digest: file.identity_digest,
        file_name: file.name,
        original_parent_ref: file.parent_ref,
        original_relative_path: file.relative_path,
        decision: "NEEDS_REVIEW" as const,
        rationale: decision.rationale,
      };
    }
    const destination = taxonomy.find(
      (folder) =>
        normalizeDestinationName(folder.name) ===
        normalizeDestinationName(decision.destination),
    );
    if (!destination) {
      throw new ProposalBuildError(
        "UNKNOWN_DECISION",
        "The content plan references an undeclared destination.",
      );
    }
    assignmentCounts.set(
      destination.name,
      (assignmentCounts.get(destination.name) ?? 0) + 1,
    );
    const current = currentTopLevelDestination(file.relative_path, file.name);
    return {
      file_ref: file.ref,
      file_identity_digest: file.identity_digest,
      file_name: file.name,
      original_parent_ref: file.parent_ref,
      original_relative_path: file.relative_path,
      decision:
        current &&
        normalizeDestinationName(current) ===
          normalizeDestinationName(destination.name)
          ? "PRESERVE" as const
          : "MOVE" as const,
      destination_name: destination.name,
      rationale: decision.rationale,
    };
  });

  if ([...assignmentCounts.values()].some((count) => count === 0)) {
    throw new ProposalBuildError(
      "INVALID_TAXONOMY",
      "The proposed taxonomy contains an empty destination folder.",
    );
  }

  files.sort(
    (left, right) =>
      (left.destination_name ?? "Needs review").localeCompare(
        right.destination_name ?? "Needs review",
      ) || left.original_relative_path.localeCompare(right.original_relative_path),
  );
  return {
    proposal_id: runId,
    workspace_identity_digest: inventory.workspace_identity_digest,
    taxonomy,
    files,
  };
}

export function organizeFolderProposalAssociatedData(runId: string): string {
  return `organize-workspace-run:${runId}:proposal:v2`;
}
