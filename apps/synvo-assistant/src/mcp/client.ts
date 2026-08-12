import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import type { AnalyzeDriveFileResult } from "../workflows/analyze-drive-file/workflow.js";
const EXPECTED_TOOLS = [
  "analyze_drive_file",
  "inspect_workspace",
  "search_workspace_knowledge",
] as const;
const MCP_INVENTORY_TIMEOUT_MS = 60_000;
const MCP_ANALYSIS_TIMEOUT_MS = 4 * 60_000;

const safeErrorFields = {
  message: z.string(),
  retryable: z.boolean(),
};
const inspectedPdfSchema = z.object({
  name: z.string(),
  path: z.string(),
  parent_path: z.string(),
}).strict();
const inspectedFolderSchema = z.object({
  name: z.string(),
  path: z.string(),
  depth: z.number().int().positive(),
}).strict();
const inventoryResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    workspace: z.object({
      complete: z.literal(true),
      folders: z.array(inspectedFolderSchema),
      pdfs: z.array(inspectedPdfSchema),
      totals: z.object({
        folders: z.number().int().nonnegative(),
        eligible_pdfs: z.number().int().nonnegative(),
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
const knowledgeAnswerSchema = z.object({
  supported: z.boolean(),
  answer: z.string(),
  citations: z.array(
    z.object({
      sourceName: z.string(),
      pageNumber: z.number().int().positive(),
    }).strict(),
  ),
}).strict();

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

  async inspectWorkspace(folderUrl: string) {
    const result = await this.#callTool(
      {
        name: "inspect_workspace",
        arguments: { folder_url: folderUrl },
      },
      MCP_INVENTORY_TIMEOUT_MS,
    );
    return this.#parseResult(
      inventoryResultSchema,
      result.structuredContent,
    );
  }

  async analyze(
    folderUrl: string,
    relativePath: string,
  ): Promise<AnalyzeDriveFileResult> {
    const result = await this.#callTool(
      {
        name: "analyze_drive_file",
        arguments: { folder_url: folderUrl, relative_path: relativePath },
      },
      MCP_ANALYSIS_TIMEOUT_MS,
    );
    return this.#parseResult(
      analysisResultSchema,
      result.structuredContent,
    ) as AnalyzeDriveFileResult;
  }

  async searchKnowledge(question: string) {
    const result = await this.#callTool(
      {
        name: "search_workspace_knowledge",
        arguments: { question },
      },
      MCP_ANALYSIS_TIMEOUT_MS,
    );
    return this.#parseResult(
      knowledgeAnswerSchema,
      result.structuredContent,
    );
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
