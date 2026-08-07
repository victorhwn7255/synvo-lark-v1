import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  driveScanFolderResultSchema,
  type DriveScanFolderResult,
} from "@synvo/contracts";

import type { AppConfig } from "../config.js";

export interface DriveInventoryClient {
  scanFolder(runId: string): Promise<DriveScanFolderResult>;
  close(): Promise<void>;
}

export type McpClientConnection = Pick<Client, "callTool" | "close">;

export class SynvoLarkMcpClient implements DriveInventoryClient {
  readonly #config: AppConfig;
  readonly #connectClient: () => Promise<McpClientConnection>;
  #client: McpClientConnection | null = null;
  #connecting: Promise<McpClientConnection> | null = null;

  constructor(
    config: AppConfig,
    options: { connect?: () => Promise<McpClientConnection> } = {},
  ) {
    this.#config = config;
    this.#connectClient = options.connect ?? (() => this.#connect());
  }

  async scanFolder(runId: string): Promise<DriveScanFolderResult> {
    const client = await this.#getClient();
    try {
      const response = await client.callTool({
        name: "drive_scan_folder",
        arguments: { run_id: runId },
      });
      return driveScanFolderResultSchema.parse(response.structuredContent);
    } catch (error) {
      await this.#discardClient(client);
      throw error;
    }
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    this.#connecting = null;
    if (client) {
      await client.close();
    }
  }

  async #getClient(): Promise<McpClientConnection> {
    if (this.#client) {
      return this.#client;
    }
    if (this.#connecting) {
      return this.#connecting;
    }

    this.#connecting = this.#connectClient();
    try {
      this.#client = await this.#connecting;
      return this.#client;
    } finally {
      this.#connecting = null;
    }
  }

  async #discardClient(client: McpClientConnection): Promise<void> {
    if (this.#client === client) {
      this.#client = null;
    }
    await client.close().catch(() => undefined);
  }

  async #connect(): Promise<Client> {
    const repositoryRoot = fileURLToPath(
      new URL("../../../../", import.meta.url),
    );
    const serverEntry = fileURLToPath(
      new URL("../../../synvo-lark-mcp/src/index.ts", import.meta.url),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", serverEntry],
      cwd: repositoryRoot,
      stderr: "inherit",
      env: {
        ...getDefaultEnvironment(),
        LARK_APP_ID: this.#config.appId,
        LARK_APP_SECRET: this.#config.appSecret,
        DATABASE_URL: this.#config.databaseUrl,
        OAUTH_TOKEN_ENCRYPTION_KEY: this.#config.oauthTokenEncryptionKey,
        ORGANIZE_FOLDER_ROOT_TOKEN: this.#config.organizeFolderRootToken,
        ORGANIZE_FOLDER_WRITE_ENABLED: "false",
      },
    });
    const client = new Client({
      name: "synvo-assistant-backend",
      version: "0.1.0",
    });
    await client.connect(transport);
    return client;
  }
}
