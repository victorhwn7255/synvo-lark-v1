import { createHash } from "node:crypto";

export function driveFolderInventoryResultAssociatedData(runId: string): string {
  return `organize-workspace-run:${runId}:snapshot:v2`;
}

export type WorkspaceFolderSnapshot = {
  ref: string;
  identity_digest: string;
  name: string;
  relative_path: string;
  parent_ref: string;
  depth: number;
  owned_by_requester: boolean;
};

export type WorkspaceFileSnapshot = {
  ref: string;
  identity_digest: string;
  name: string;
  relative_path: string;
  parent_ref: string;
  parent_path: string;
  version: string;
};

export type DriveInventory = {
  run_id: string;
  workspace_identity_digest: string;
  complete: true;
  folders: WorkspaceFolderSnapshot[];
  files: WorkspaceFileSnapshot[];
};

export type DriveInventoryErrorCode =
  | "UNAUTHORIZED"
  | "WRONG_TENANT"
  | "INVALID_FOLDER_LINK"
  | "INVALID_FILE_LINK"
  | "ROOT_NOT_ALLOWLISTED"
  | "LIMIT_EXCEEDED"
  | "INCOMPLETE_SCAN"
  | "OAUTH_REQUIRED"
  | "OAUTH_REVOKED"
  | "LARK_RETRYABLE"
  | "LARK_PERMANENT"
  | "MALFORMED_RESPONSE"
  | "RUN_NOT_FOUND"
  | "RUN_NOT_READY"
  | "UNEXPECTED_WORKSPACE_STATE"
  | "INTERNAL";

export type DriveInventorySafeError = {
  code: DriveInventoryErrorCode;
  message: string;
  retryable: boolean;
};

export type DriveFolderInventoryResult =
  | { ok: true; inventory: DriveInventory; error?: never }
  | { ok: false; error: DriveInventorySafeError; inventory?: never };

function comparableInventory(inventory: DriveInventory): unknown {
  return {
    workspace_identity_digest: inventory.workspace_identity_digest,
    complete: inventory.complete,
    folders: inventory.folders,
    files: inventory.files,
  };
}

export function workspaceSnapshotDigest(inventory: DriveInventory): string {
  // Defends exact provider consent against a changed Drive snapshot between review and confirmation.
  return createHash("sha256")
    .update(JSON.stringify(comparableInventory(inventory)))
    .digest("hex");
}

export function workspaceSnapshotMatches(
  approved: DriveInventory,
  observed: DriveInventory,
): boolean {
  return JSON.stringify(comparableInventory(approved)) ===
    JSON.stringify(comparableInventory(observed));
}
