import { z } from "zod";

export function driveFolderInventoryResultAssociatedData(runId: string): string {
  return `organize-folder-run:${runId}:scan-result:v1`;
}

export const ownerVerificationSchema = z.enum([
  "matched",
  "missing",
  "mismatched",
]);

export const driveInventoryItemSchema = z.object({
  ref: z.string().min(1),
  name: z.string(),
  type: z.string().min(1),
  parent_ref: z.string().min(1),
  modified_time: z.string().optional(),
  owner_verification: ownerVerificationSchema,
}).strict();

export const driveInventoryFolderSchema = z.object({
  ref: z.string().min(1),
  name: z.string(),
  parent_ref: z.string().nullable(),
  owner_verification: ownerVerificationSchema,
  child_count: z.number().int().nonnegative(),
}).strict();

export const driveInventorySchema = z.object({
  run_id: z.uuid(),
  scan_id: z.uuid(),
  complete: z.boolean(),
  baseline_matches: z.boolean(),
  root: driveInventoryFolderSchema,
  destinations: z.array(driveInventoryFolderSchema),
  files: z.array(driveInventoryItemSchema),
  skipped: z.array(driveInventoryItemSchema),
  issues: z.array(z.string()),
  summary: z.object({
    root_folder_count: z.number().int().nonnegative(),
    root_file_count: z.number().int().nonnegative(),
    root_skipped_count: z.number().int().nonnegative(),
    destination_child_count: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const driveInventoryErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "WRONG_TENANT",
  "INVALID_FOLDER_LINK",
  "ROOT_NOT_ALLOWLISTED",
  "LIMIT_EXCEEDED",
  "INCOMPLETE_SCAN",
  "OAUTH_REQUIRED",
  "OAUTH_REVOKED",
  "LARK_RETRYABLE",
  "LARK_PERMANENT",
  "MALFORMED_RESPONSE",
  "RUN_NOT_FOUND",
  "RUN_NOT_READY",
  "UNEXPECTED_SANDBOX_STATE",
  "INTERNAL",
]);

export const driveInventorySafeErrorSchema = z.object({
  code: driveInventoryErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
}).strict();

export const driveFolderInventoryResultSchema = z.object({
  ok: z.boolean(),
  inventory: driveInventorySchema.optional(),
  error: driveInventorySafeErrorSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.ok) {
    if (!value.inventory || value.error) {
      context.addIssue({
        code: "custom",
        message: "A successful Drive scan must contain only an inventory.",
      });
    }
    return;
  }

  if (!value.error || value.inventory) {
    context.addIssue({
      code: "custom",
      message: "A failed Drive scan must contain only a safe error.",
    });
  }
});

export type DriveInventory = z.infer<typeof driveInventorySchema>;
export type DriveInventoryItem = z.infer<typeof driveInventoryItemSchema>;
export type DriveInventoryFolder = z.infer<typeof driveInventoryFolderSchema>;
export type DriveInventorySafeError = z.infer<typeof driveInventorySafeErrorSchema>;
export type DriveFolderInventoryResult = z.infer<typeof driveFolderInventoryResultSchema>;
