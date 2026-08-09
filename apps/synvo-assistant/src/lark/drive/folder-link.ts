import { createHash } from "node:crypto";

import { driveToolError } from "./errors.js";

const allowedHostSuffixes = [
  ".larksuite.com",
  ".larkoffice.com",
  ".feishu.cn",
] as const;

function isAllowedHost(hostname: string): boolean {
  return allowedHostSuffixes.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
  );
}

export function parseLarkDriveUrl(
  value: string,
  errorCode: "INVALID_FOLDER_LINK" | "INVALID_FILE_LINK",
  message: string,
): URL {
  if (value.length > 2_048) {
    throw driveToolError(errorCode, message);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw driveToolError(errorCode, message);
  }

  if (
    url.protocol !== "https:" ||
    !isAllowedHost(url.hostname.toLowerCase()) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw driveToolError(errorCode, message);
  }
  return url;
}

export function parseLarkDriveFolderLink(value: string): string {
  const url = parseLarkDriveUrl(
    value,
    "INVALID_FOLDER_LINK",
    "Provide a valid Lark Drive folder link.",
  );

  const pathMatch = /^\/drive\/folder\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  const hasSupportedQuery =
    url.search === "" || url.search === "?from=space";

  if (!pathMatch || !hasSupportedQuery) {
    throw driveToolError(
      "INVALID_FOLDER_LINK",
      "Provide a link to one specific Lark Drive folder.",
    );
  }

  return pathMatch[1];
}

export function requireAllowlistedRoot(
  folderToken: string,
  allowlistedRootToken: string,
): void {
  if (folderToken !== allowlistedRootToken) {
    throw driveToolError(
      "ROOT_NOT_ALLOWLISTED",
      "That folder is outside the approved pilot sandbox.",
    );
  }
}

export function digestFolderToken(folderToken: string): string {
  return createHash("sha256").update(folderToken).digest("hex");
}
