export function driveFolderInventoryResultAssociatedData(runId: string): string {
  return `organize-folder-run:${runId}:scan-result:v1`;
}

export type OwnerVerification = "matched" | "missing" | "mismatched";

export type DriveInventoryItem = {
  ref: string;
  identity_digest: string;
  name: string;
  type: string;
  parent_ref: string;
  modified_time?: string;
  owner_verification: OwnerVerification;
};

export type DriveInventoryFolder = {
  ref: string;
  identity_digest: string;
  name: string;
  parent_ref: string | null;
  owner_verification: OwnerVerification;
  child_count: number;
};

export type DriveInventory = {
  run_id: string;
  scan_id: string;
  complete: boolean;
  baseline_matches: boolean;
  root: DriveInventoryFolder;
  destinations: DriveInventoryFolder[];
  files: DriveInventoryItem[];
  skipped: DriveInventoryItem[];
  issues: string[];
  summary: {
    root_folder_count: number;
    root_file_count: number;
    root_skipped_count: number;
    destination_child_count: number;
  };
};

export type DriveInventoryErrorCode =
  | "UNAUTHORIZED"
  | "WRONG_TENANT"
  | "INVALID_FOLDER_LINK"
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
  | "UNEXPECTED_SANDBOX_STATE"
  | "INTERNAL";

export type DriveInventorySafeError = {
  code: DriveInventoryErrorCode;
  message: string;
  retryable: boolean;
};

export type DriveFolderInventoryResult =
  | {
      ok: true;
      inventory: DriveInventory;
      error?: never;
    }
  | {
      ok: false;
      error: DriveInventorySafeError;
      inventory?: never;
    };
