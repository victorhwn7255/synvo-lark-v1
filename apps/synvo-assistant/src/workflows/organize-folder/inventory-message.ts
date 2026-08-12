import type {
  DriveFolderInventoryResult,
  DriveInventory,
} from "./contracts.js";
import type { OrganizeFolderProposal } from "./proposal.js";

const MAX_DISPLAY_VALUE_LENGTH = 160;
const COMMON_FILE_EXTENSIONS = new Set([
  "csv", "doc", "docx", "gif", "jpeg", "jpg", "json", "m4a", "md",
  "mov", "mp3", "mp4", "pdf", "png", "ppt", "pptx", "svg", "txt",
  "webp", "xls", "xlsx", "yaml", "yml", "zip",
]);

function neutralizeAutolinks(value: string): string {
  const withoutExplicitUrls = value.replace(
    /\b(?:[a-z][a-z\d+.-]{1,31}:\/\/|https?:|ftp:|mailto:|tel:|www\.)[^\s\u2039\u203a"']*/giu,
    "[link removed]",
  );
  return withoutExplicitUrls.replace(
    /\b(?:[a-z\d](?:[a-z\d-]{0,62}\.)+)[a-z]{2,63}(?:[/:?#][^\s\u2039\u203a"']*)?/giu,
    (candidate) => {
      const hostname = candidate.split(/[/:?#]/u, 1)[0] ?? "";
      const extension = hostname.split(".").at(-1)?.toLowerCase() ?? "";
      return candidate.length === hostname.length && COMMON_FILE_EXTENSIONS.has(extension)
        ? candidate
        : "[link removed]";
    },
  );
}

export function sanitizeDisplayValue(
  value: string,
  fallback: string,
  maxCodePoints = MAX_DISPLAY_VALUE_LENGTH,
): string {
  const collapsed = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replaceAll("<", "\u2039")
    .replaceAll(">", "\u203a");
  const safe = neutralizeAutolinks(collapsed) || fallback;
  const points = Array.from(safe);
  return points.length <= maxCodePoints
    ? safe
    : `${points.slice(0, Math.max(0, maxCodePoints - 1)).join("")}\u2026`;
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "PDF" : "PDFs"}`;
}

export function formatDriveInventory(inventory: DriveInventory): string {
  const files = inventory.files.slice(0, 20).map(
    (file) => `- ${sanitizeDisplayValue(file.relative_path, "[unnamed PDF]")}`,
  );
  return [
    "Workspace inspection complete.",
    "",
    `Eligible PDFs: ${inventory.files.length}`,
    `Folders inspected: ${inventory.folders.length}`,
    ...files,
    ...(inventory.files.length > files.length
      ? [`- …and ${inventory.files.length - files.length} more`]
      : []),
    "",
    "No file contents were read and no Drive files were changed.",
  ].join("\n");
}

export function formatDriveFolderInventoryResult(
  result: DriveFolderInventoryResult,
): string {
  return result.ok
    ? formatDriveInventory(result.inventory)
    : `${result.error.message}\n\nNo Drive files were changed.`;
}

export function formatOrganizeFolderProposal(
  proposal: OrganizeFolderProposal,
): string {
  const preserved = proposal.files.filter((file) => file.decision === "PRESERVE");
  const moved = proposal.files.filter((file) => file.decision === "MOVE");
  const review = proposal.files.filter((file) => file.decision === "NEEDS_REVIEW");
  const lines = [
    `Workspace organization proposal ${proposal.proposal_id}`,
    "",
    `Summary: ${countLabel(proposal.files.length)} · ${moved.length} to move · ${preserved.length} already organized · ${review.length} need review`,
  ];
  for (const folder of proposal.taxonomy) {
    const assigned = proposal.files.filter(
      (file) => file.destination_name === folder.name,
    );
    lines.push(
      "",
      `${folder.name} (${countLabel(assigned.length)} · ${folder.action === "REUSE" ? "reuse folder" : "create folder"})`,
      `Purpose: ${sanitizeDisplayValue(folder.description, "[no description]")}`,
      ...assigned.flatMap((file) => [
        `- ${sanitizeDisplayValue(file.file_name, "[unnamed PDF]")}`,
        `  ${file.decision === "PRESERVE" ? "Keep in place" : `Move from ${sanitizeDisplayValue(file.original_relative_path, "[unknown path]")}`}`,
        `  Why: ${sanitizeDisplayValue(file.rationale, "[no rationale]")}`,
      ]),
    );
  }
  lines.push("", `Needs review (${countLabel(review.length)})`);
  lines.push(...(review.length === 0
    ? ["- None"]
    : review.flatMap((file) => [
        `- ${sanitizeDisplayValue(file.file_name, "[unnamed PDF]")}`,
        `  Why: ${sanitizeDisplayValue(file.rationale, "[no rationale]")}`,
      ])));
  lines.push("", "No Drive files or folders have been changed.");
  if (review.length === 0) {
    lines.push(
      "",
      `Approve: /approve-workspace ${proposal.proposal_id}`,
      `Reject: /reject-workspace ${proposal.proposal_id}`,
    );
  } else {
    lines.push("", "Resolve every Needs Review item before approving this proposal.");
  }
  return lines.join("\n");
}
