import type { DriveInventory, DriveScanFolderResult } from "@synvo/contracts";

const MAX_DISPLAY_VALUE_LENGTH = 160;
const COMMON_FILE_EXTENSIONS = new Set([
  "csv",
  "doc",
  "docx",
  "gif",
  "jpeg",
  "jpg",
  "json",
  "m4a",
  "md",
  "mov",
  "mp3",
  "mp4",
  "pdf",
  "png",
  "ppt",
  "pptx",
  "svg",
  "txt",
  "webp",
  "xls",
  "xlsx",
  "yaml",
  "yml",
  "zip",
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
      const hasUrlSuffix = candidate.length > hostname.length;
      return !hasUrlSuffix && COMMON_FILE_EXTENSIONS.has(extension)
        ? candidate
        : "[link removed]";
    },
  );
}

function sanitizeDisplayValue(value: string, fallback: string): string {
  const collapsed = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replaceAll("<", "\u2039")
    .replaceAll(">", "\u203a");
  const safeValue = neutralizeAutolinks(collapsed) || fallback;
  const codePoints = Array.from(safeValue);

  if (codePoints.length <= MAX_DISPLAY_VALUE_LENGTH) {
    return safeValue;
  }
  return `${codePoints.slice(0, MAX_DISPLAY_VALUE_LENGTH - 1).join("")}\u2026`;
}

function lineForDestination(
  destination: DriveInventory["destinations"][number],
): string {
  const contents =
    destination.child_count === 0
      ? "empty"
      : `${destination.child_count} child item(s)`;
  return `  - ${sanitizeDisplayValue(destination.name, "[unnamed]")}: ${contents}`;
}

export function formatDriveInventory(inventory: DriveInventory): string {
  const ownershipChecks = [
    inventory.root.owner_verification,
    ...inventory.destinations.map((item) => item.owner_verification),
    ...inventory.files.map((item) => item.owner_verification),
    ...inventory.skipped.map((item) => item.owner_verification),
  ];
  const allOwnersMatched = ownershipChecks.every(
    (status) => status === "matched",
  );
  const lines = [
    "Read-only folder inventory complete.",
    "",
    `Root: ${sanitizeDisplayValue(inventory.root.name, "[unnamed]")}`,
    `Root folders: ${inventory.summary.root_folder_count}`,
    `Root files: ${inventory.summary.root_file_count}`,
    `Unsupported root items: ${inventory.summary.root_skipped_count}`,
    `Ownership: ${allOwnersMatched ? "matched the requesting user" : "not fully verified"}`,
    "Additional manageability signal: not exposed by these read-only Lark APIs.",
    "",
    "Approved destinations:",
    ...inventory.destinations.map(lineForDestination),
    "",
    "Root files:",
    ...inventory.files.map(
      (file) => `  - ${sanitizeDisplayValue(file.name, "[unnamed]")}`,
    ),
  ];

  if (inventory.skipped.length > 0) {
    lines.push(
      "",
      "Skipped items:",
      ...inventory.skipped.map(
        (item) =>
          `  - ${sanitizeDisplayValue(item.name, "[unnamed]")} (${sanitizeDisplayValue(item.type, "[unknown type]")})`,
      ),
    );
  }
  if (inventory.issues.length > 0) {
    lines.push(
      "",
      "The sandbox differs from the expected baseline:",
      ...inventory.issues.map((issue) => `  - ${issue}`),
    );
  } else {
    lines.push("", "Baseline verified: two empty folders and four files.");
  }
  lines.push("", "No files were opened, downloaded, or changed.");
  return lines.join("\n");
}

export function formatDriveScanResult(result: DriveScanFolderResult): string {
  if (result.ok && result.inventory) {
    return formatDriveInventory(result.inventory);
  }
  return `${result.error?.message ?? "The read-only inventory failed."}\n\nNo files were changed.`;
}
