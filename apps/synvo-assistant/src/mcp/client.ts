import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import type { AnalyzeDriveFileResult } from "../workflows/analyze-drive-file/workflow.js";
import type { DriveFolderInventoryResult } from "../workflows/organize-folder/contracts.js";

const EXPECTED_TOOLS = [
  "analyze_drive_file",
  "organize_folder_inventory",
] as const;
const MCP_INVENTORY_TIMEOUT_MS = 60_000;
const MCP_ANALYSIS_TIMEOUT_MS = 4 * 60_000;

const safeErrorFields = {
  message: z.string(),
  retryable: z.boolean(),
};
const inventoryItemSchema = z.object({
  ref: z.string(),
  identity_digest: z.string(),
  name: z.string(),
  type: z.string(),
  parent_ref: z.string(),
  modified_time: z.string().optional(),
  owner_verification: z.enum(["matched", "missing", "mismatched"]),
}).strict();
const inventoryFolderSchema = z.object({
  ref: z.string(),
  identity_digest: z.string(),
  name: z.string(),
  parent_ref: z.string().nullable(),
  owner_verification: z.enum(["matched", "missing", "mismatched"]),
  child_count: z.number().int().nonnegative(),
}).strict();
const inventoryResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    inventory: z.object({
      run_id: z.string(),
      complete: z.boolean(),
      baseline_matches: z.boolean(),
      root: inventoryFolderSchema,
      destinations: z.array(inventoryFolderSchema),
      files: z.array(inventoryItemSchema),
      skipped: z.array(inventoryItemSchema),
      issues: z.array(z.string()),
      summary: z.object({
        root_folder_count: z.number().int().nonnegative(),
        root_file_count: z.number().int().nonnegative(),
        root_skipped_count: z.number().int().nonnegative(),
        destination_child_count: z.number().int().nonnegative(),
      }).strict(),
    }).strict(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object({
      ...safeErrorFields,
      code: z.string(),
    }).strict(),
  }).strict(),
]);
const analysisResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    analysis: z.object({
      filename: z.string(),
      page_count: z.number().int().positive(),
      text: z.string(),
      input_truncated: z.boolean(),
      output_truncated: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.object(safeErrorFields).strict(),
  }).strict(),
]);

export class SynvoMcpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SynvoMcpClientError";
  }
}

export class SynvoMcpClient {
  readonly #url: URL;
  readonly #authToken: string;
  #client: Client | null = null;

  constructor(options: { url: URL; authToken: string }) {
    this.#url = options.url;
    this.#authToken = options.authToken;
  }

  async connect(): Promise<void> {
    if (this.#client) {
      return;
    }
    const client = new Client(
      { name: "synvo-content-organizer", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(this.#url, {
      requestInit: {
        headers: { Authorization: `Bearer ${this.#authToken}` },
      },
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      if (
        names.length !== EXPECTED_TOOLS.length ||
        names.some((name, index) => name !== EXPECTED_TOOLS[index])
      ) {
        throw new SynvoMcpClientError(
          "The Synvo MCP endpoint exposed an unexpected tool set.",
        );
      }
      this.#client = client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error instanceof SynvoMcpClientError
        ? error
        : new SynvoMcpClientError("The Synvo MCP endpoint is unavailable.");
    }
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    await client?.close();
  }

  async inventory(folderUrl: string): Promise<DriveFolderInventoryResult> {
    const result = await this.#callTool(
      {
        name: "organize_folder_inventory",
        arguments: { folder_url: folderUrl },
      },
      MCP_INVENTORY_TIMEOUT_MS,
    );
    return this.#parseResult(
      inventoryResultSchema,
      result.structuredContent,
    ) as DriveFolderInventoryResult;
  }

  async analyze(
    folderUrl: string,
    fileName: string,
  ): Promise<AnalyzeDriveFileResult> {
    const result = await this.#callTool(
      {
        name: "analyze_drive_file",
        arguments: { folder_url: folderUrl, file_name: fileName },
      },
      MCP_ANALYSIS_TIMEOUT_MS,
    );
    return this.#parseResult(
      analysisResultSchema,
      result.structuredContent,
    ) as AnalyzeDriveFileResult;
  }

  #requiredClient(): Client {
    if (!this.#client) {
      throw new SynvoMcpClientError("The Synvo MCP client is not connected.");
    }
    return this.#client;
  }

  async #callTool(
    params: Parameters<Client["callTool"]>[0],
    timeout: number,
  ) {
    try {
      return await this.#requiredClient().callTool(params, {
        timeout,
        maxTotalTimeout: timeout,
      });
    } catch {
      throw new SynvoMcpClientError("The Synvo MCP tool call failed.");
    }
  }

  #parseResult<Schema extends z.ZodType>(
    schema: Schema,
    value: unknown,
  ): z.output<Schema> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new SynvoMcpClientError(
        "The Synvo MCP endpoint returned an invalid structured result.",
      );
    }
    return parsed.data;
  }
}
