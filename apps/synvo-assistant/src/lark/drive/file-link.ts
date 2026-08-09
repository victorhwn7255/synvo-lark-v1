import { driveToolError } from "./errors.js";
import { parseLarkDriveUrl } from "./folder-link.js";

export function parseLarkDriveFileLink(value: string): string {
  const url = parseLarkDriveUrl(
    value,
    "INVALID_FILE_LINK",
    "Provide a valid Lark Drive file link.",
  );
  const match = /^\/(?:drive\/)?file\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  const supportedQuery = url.search === "" || url.search === "?from=space";
  if (!match?.[1] || !supportedQuery) {
    throw driveToolError(
      "INVALID_FILE_LINK",
      "Provide a link to one ordinary Lark Drive file.",
    );
  }
  return match[1];
}
