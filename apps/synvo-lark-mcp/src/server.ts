import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  driveScanFolderInputSchema,
  driveScanFolderResultSchema,
  type DriveScanFolderResult,
} from "@synvo/contracts";
import { LarkAuthError } from "@synvo/lark-auth";

import {
  DriveToolError,
  driveToolError,
  normalizeDriveError,
} from "./modules/drive/errors.js";
import type { DriveReader } from "./modules/drive/client.js";
import { scanAllowlistedFolder } from "./modules/drive/scan-folder.js";
import type {
  DriveRunResolution,
  PostgresDriveRunRepository,
} from "./repositories/run-context.js";

function normalizeAuthError(error: LarkAuthError): DriveToolError {
  switch (error.code) {
    case "OAUTH_REQUIRED":
      return driveToolError(
        "OAUTH_REQUIRED",
        "Lark authorization is required.",
      );
    case "OAUTH_REVOKED":
      return driveToolError(
        "OAUTH_REVOKED",
        "The Lark authorization is no longer usable.",
      );
    case "OAUTH_RETRYABLE":
      return driveToolError(
        "LARK_RETRYABLE",
        "Lark authorization is temporarily unavailable.",
        true,
      );
    case "WRONG_SCOPE":
      return driveToolError(
        "OAUTH_REQUIRED",
        "The Lark authorization must be renewed for the approved read-only scopes.",
      );
    case "WRONG_TENANT":
      return driveToolError(
        "WRONG_TENANT",
        "The stored Lark authorization belongs to a different tenant.",
      );
    case "WRONG_USER":
      return driveToolError(
        "UNAUTHORIZED",
        "The stored Lark authorization does not match the requesting user.",
      );
    case "OAUTH_REJECTED":
    case "OAUTH_MALFORMED":
      return driveToolError(
        "LARK_PERMANENT",
        "The Lark authorization could not be used safely.",
      );
  }
}

export function createSynvoLarkMcpServer(options: {
  runRepository: PostgresDriveRunRepository;
  driveReader: DriveReader;
}): McpServer {
  const server = new McpServer(
    { name: "synvo-lark-mcp", version: "0.1.0" },
    {
      instructions:
        "This private Phase 2 server exposes one bounded read-only Lark Drive inventory tool. It has no mutation or content-download tool.",
    },
  );

  server.registerTool(
    "drive_scan_folder",
    {
      description:
        "List the server-owned, allowlisted Drive pilot root and its two approved destination folders using a server-owned run ID.",
      inputSchema: driveScanFolderInputSchema,
      outputSchema: driveScanFolderResultSchema,
    },
    async ({ run_id }) => {
      let resolution: DriveRunResolution;
      try {
        resolution = await options.runRepository.resolve(run_id);
      } catch (error) {
        const normalized =
          error instanceof LarkAuthError
            ? normalizeAuthError(error)
            : normalizeDriveError(error);
        const result: DriveScanFolderResult = {
          ok: false,
          error: normalized.safeError,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: true,
        };
      }

      if (resolution.kind === "cached") {
        return {
          content: [
            { type: "text", text: JSON.stringify(resolution.result) },
          ],
          structuredContent: resolution.result,
          isError: !resolution.result.ok,
        };
      }

      let result: DriveScanFolderResult;
      try {
        const context = await resolution.loadContext();
        const inventory = await scanAllowlistedFolder(
          options.driveReader,
          context,
        );
        result = { ok: true, inventory };
      } catch (error) {
        const normalized =
          error instanceof LarkAuthError
            ? normalizeAuthError(error)
            : normalizeDriveError(error);
        result = { ok: false, error: normalized.safeError };
      }

      try {
        if (result.ok) {
          await options.runRepository.complete(
            run_id,
            resolution.scanAttempt,
            result,
          );
        } else {
          await options.runRepository.fail(
            run_id,
            resolution.scanAttempt,
            result,
          );
        }
      } catch (error) {
        const normalized =
          error instanceof LarkAuthError
            ? normalizeAuthError(error)
            : normalizeDriveError(error);
        result = { ok: false, error: normalized.safeError };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: !result.ok,
      };
    },
  );

  return server;
}
