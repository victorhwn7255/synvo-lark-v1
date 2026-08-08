import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { formatDriveFolderInventoryResult } from "../workflows/organize-folder/inventory-message.js";
import type { OrganizeFolderWorkflow } from "../workflows/organize-folder/workflow.js";

type InventoryReader = Pick<OrganizeFolderWorkflow, "readInventory">;

export type SynvoMcpOptions = {
  authToken: string;
  requesterOpenId: string;
  tenantKey: string;
  inventoryReader: InventoryReader;
};

export type SynvoMcpEndpoint = {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
};

export function createSynvoMcpServer(
  options: Omit<SynvoMcpOptions, "authToken">,
): McpServer {
  const server = new McpServer({ name: "synvo-mcp", version: "0.1.0" });

  server.registerTool(
    "organize_folder_inventory",
    {
      title: "Inventory an approved Synvo folder",
      description:
        "Read the bounded metadata-only inventory of the configured Lark Drive pilot folder. The tool never opens, downloads, moves, renames, or changes files.",
      inputSchema: z
        .object({
          folder_url: z
            .url()
            .max(2_048)
            .describe("The Lark Drive folder URL supplied by the user."),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ folder_url }) => {
      const result = await options.inventoryReader.readInventory({
        requesterOpenId: options.requesterOpenId,
        tenantKey: options.tenantKey,
        folderLink: folder_url,
      });

      return {
        content: [
          {
            type: "text",
            text: formatDriveFolderInventoryResult(result),
          },
        ],
        structuredContent: result,
        isError: !result.ok,
      };
    },
  );

  return server;
}

// Defends Synvo tools against callers that do not hold the configured service credential.
function hasExpectedBearerToken(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendUnauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "WWW-Authenticate": 'Bearer realm="synvo-mcp"',
  });
  response.end(JSON.stringify({ error: "unauthorized" }));
}

export function createSynvoMcpEndpoint(
  options: SynvoMcpOptions,
): SynvoMcpEndpoint {
  const handler = createMcpHandler(
    () => createSynvoMcpServer(options),
    {
      onerror: () => console.warn("[mcp] request failed"),
    },
  );
  const nodeHandler = toNodeHandler(handler, {
    onerror: () => console.warn("[mcp] request adapter failed"),
  });

  return {
    async handle(request, response) {
      if (
        !hasExpectedBearerToken(
          request.headers.authorization,
          options.authToken,
        )
      ) {
        sendUnauthorized(response);
        return;
      }
      await nodeHandler(request, response);
    },
    close: () => handler.close(),
  };
}
