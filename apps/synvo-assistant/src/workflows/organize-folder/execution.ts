import type { DriveInventory } from "./contracts.js";
import { workspaceSnapshotMatches } from "./contracts.js";
import type { OrganizeFolderProposal } from "./proposal.js";

export type ExecutionStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "UNKNOWN"
  | "STALE";

export type UndoStatus =
  | "REQUESTED"
  | "RUNNING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "UNKNOWN";

export type OperationStatus =
  | "PENDING"
  | "REQUESTING"
  | "VERIFIED"
  | "FAILED"
  | "UNKNOWN";

export type DestinationOperation = {
  name: string;
  action: "REUSE" | "CREATE";
  folderToken?: string;
  createdByExecution: boolean;
  status: OperationStatus;
  attemptedAt?: string;
  verifiedAt?: string;
  errorCode?: string;
};

export type ExecutionMove = {
  fileRef: string;
  fileName: string;
  originalFolderToken: string;
  originalRelativePath: string;
  destinationName: string;
  destinationFolderToken?: string;
  status: OperationStatus;
  attemptedAt?: string;
  verifiedAt?: string;
  errorCode?: string;
};

export type UndoMove = {
  fileRef: string;
  status: OperationStatus;
  attemptedAt?: string;
  verifiedAt?: string;
  errorCode?: string;
};

export type OrganizeFolderExecutionRecord = {
  proposalId: string;
  rootFolderToken: string;
  startedAt: string;
  finishedAt?: string;
  errorCode?: string;
  destinations: DestinationOperation[];
  moves: ExecutionMove[];
  preservedCount: number;
  needsReviewCount: number;
  knowledgePathsUpdated?: number;
  knowledgeReconciliationError?: string;
  undo?: {
    requestedByOpenId: string;
    requestedAt: string;
    startedAt?: string;
    finishedAt?: string;
    errorCode?: string;
    moves: UndoMove[];
    knowledgePathsUpdated?: number;
    knowledgeReconciliationError?: string;
  };
};

export function executionAssociatedData(runId: string): string {
  return `organize-workspace-run:${runId}:execution:v2`;
}

export function createExecutionRecord(
  proposal: OrganizeFolderProposal,
  inventory: DriveInventory,
  rootFolderToken: string,
  now: Date,
): OrganizeFolderExecutionRecord {
  const files = new Map(inventory.files.map((file) => [file.ref, file]));
  const destinations = proposal.taxonomy.map(
    (folder): DestinationOperation => ({
      name: folder.name,
      action: folder.action,
      folderToken:
        folder.action === "REUSE" ? folder.existing_folder_ref : undefined,
      createdByExecution: false,
      status: folder.action === "REUSE" ? "VERIFIED" : "PENDING",
    }),
  );
  const moves = proposal.files
    .filter((file) => file.decision === "MOVE")
    .map((file): ExecutionMove => {
      const source = files.get(file.file_ref);
      if (
        !source ||
        !file.destination_name ||
        source.identity_digest !== file.file_identity_digest ||
        source.relative_path !== file.original_relative_path ||
        source.parent_ref !== file.original_parent_ref
      ) {
        throw new Error("EXECUTION_PREFLIGHT_IDENTITY_MISMATCH");
      }
      return {
        fileRef: source.ref,
        fileName: source.name,
        originalFolderToken: source.parent_ref,
        originalRelativePath: source.relative_path,
        destinationName: file.destination_name,
        destinationFolderToken: destinations.find(
          (destination) => destination.name === file.destination_name,
        )?.folderToken,
        status: "PENDING",
      };
    });
  return {
    proposalId: proposal.proposal_id,
    rootFolderToken,
    startedAt: now.toISOString(),
    destinations,
    moves,
    preservedCount: proposal.files.filter(
      (file) => file.decision === "PRESERVE",
    ).length,
    needsReviewCount: proposal.files.filter(
      (file) => file.decision === "NEEDS_REVIEW",
    ).length,
  };
}

export function inventoryMatchesApprovedSnapshot(
  approved: DriveInventory,
  observed: DriveInventory,
): boolean {
  return workspaceSnapshotMatches(approved, observed);
}

export function inventoryMatchesExecutionTarget(
  record: OrganizeFolderExecutionRecord,
  approved: DriveInventory,
  observed: DriveInventory,
): boolean {
  if (
    !observed.complete ||
    approved.files.length !== observed.files.length
  ) {
    return false;
  }
  const observedByRef = new Map(observed.files.map((file) => [file.ref, file]));
  const moveByRef = new Map(record.moves.map((move) => [move.fileRef, move]));
  return approved.files.every((file) => {
    const current = observedByRef.get(file.ref);
    const move = moveByRef.get(file.ref);
    const expectedParent = move?.destinationFolderToken ?? file.parent_ref;
    return (
      current?.identity_digest === file.identity_digest &&
      current.version === file.version &&
      current.parent_ref === expectedParent
    );
  });
}

export function inventoryMatchesUndoTarget(
  approved: DriveInventory,
  observed: DriveInventory,
): boolean {
  if (!observed.complete || approved.files.length !== observed.files.length) {
    return false;
  }
  const observedByRef = new Map(observed.files.map((file) => [file.ref, file]));
  return approved.files.every((file) => {
    const current = observedByRef.get(file.ref);
    return (
      current?.identity_digest === file.identity_digest &&
      current.version === file.version &&
      current.parent_ref === file.parent_ref
    );
  });
}

export function finalExecutionStatus(
  record: OrganizeFolderExecutionRecord,
): ExecutionStatus {
  if (record.errorCode) return "UNKNOWN";
  const operations = [...record.destinations, ...record.moves];
  if (operations.every((operation) => operation.status === "VERIFIED")) {
    return "COMPLETED";
  }
  if (operations.some((operation) => operation.status === "UNKNOWN")) {
    return "UNKNOWN";
  }
  const hasVerifiedMutation =
    record.destinations.some(
      (destination) =>
        destination.action === "CREATE" &&
        destination.createdByExecution &&
        destination.status === "VERIFIED",
    ) || record.moves.some((move) => move.status === "VERIFIED");
  if (hasVerifiedMutation) {
    return "PARTIAL";
  }
  return "FAILED";
}

export function finalUndoStatus(
  record: OrganizeFolderExecutionRecord,
): UndoStatus {
  const undo = record.undo;
  if (!undo) return "FAILED";
  if (undo.errorCode) return "UNKNOWN";
  if (undo.moves.every((move) => move.status === "VERIFIED")) {
    return "COMPLETED";
  }
  if (undo.moves.some((move) => move.status === "UNKNOWN")) return "UNKNOWN";
  if (undo.moves.some((move) => move.status === "VERIFIED")) return "PARTIAL";
  return "FAILED";
}

export function formatExecutionResult(
  record: OrganizeFolderExecutionRecord,
  status: ExecutionStatus,
): string {
  const created = record.destinations
    .filter((folder) => folder.createdByExecution && folder.status === "VERIFIED")
    .map((folder) => folder.name);
  const verified = record.moves.filter((move) => move.status === "VERIFIED");
  const errorCode = [...record.destinations, ...record.moves].find(
    (operation) => operation.errorCode,
  )?.errorCode ?? record.errorCode;
  const attention = errorCode === "REAUTHORIZATION_REQUIRED"
    ? "Lark Drive needs fresh authorization before it can create folders. Reconnect Lark Drive, then request a new proposal."
    : "";
  return [
    status === "COMPLETED"
      ? `Workspace organization completed for proposal ${record.proposalId}.`
      : `Workspace organization stopped for proposal ${record.proposalId}.`,
    "",
    `Moved and verified: ${verified.length} files`,
    `Already organized: ${record.preservedCount} files`,
    `Needs review: ${record.needsReviewCount} files`,
    created.length > 0 ? `Folders created: ${created.join(", ")}` : "",
    attention,
    record.knowledgeReconciliationError
      ? "Knowledge paths need a refresh; the Drive changes remain verified."
      : `Knowledge paths updated without re-embedding: ${record.knowledgePathsUpdated ?? 0}`,
    status === "COMPLETED" && verified.length > 0
      ? `\nUndo: /undo-workspace ${record.proposalId}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatUndoResult(
  record: OrganizeFolderExecutionRecord,
  status: UndoStatus,
): string {
  const createdFolders = record.destinations
    .filter((folder) => folder.createdByExecution)
    .map((folder) => folder.name);
  return [
    status === "COMPLETED"
      ? `Workspace undo completed for proposal ${record.proposalId}.`
      : `Workspace undo stopped for proposal ${record.proposalId}.`,
    "",
    `Restored and verified: ${
      record.undo?.moves.filter((move) => move.status === "VERIFIED").length ?? 0
    } files`,
    createdFolders.length > 0
      ? `Created folders were left in place: ${createdFolders.join(", ")}`
      : "",
    record.undo?.knowledgeReconciliationError
      ? "Knowledge paths need a refresh; restored Drive parents remain verified."
      : `Knowledge paths updated without re-embedding: ${
          record.undo?.knowledgePathsUpdated ?? 0
        }`,
  ]
    .filter(Boolean)
    .join("\n");
}
