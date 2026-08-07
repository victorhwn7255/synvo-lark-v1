import { randomUUID } from "node:crypto";

import * as Lark from "@larksuiteoapi/node-sdk";
import {
  LarkOAuthHttpClient,
  PostgresOAuthGrantStore,
  TokenCipher,
} from "@synvo/lark-auth";

import { parseCommand } from "./commands.js";
import { loadConfig } from "./config.js";
import { isPhase2SchemaReady } from "./db/migrate.js";
import { createDatabasePool } from "./db/pool.js";
import { encryptDeliveryMessage } from "./delivery/crypto.js";
import { PostgresDeliveryQueue } from "./delivery/repository.js";
import { DeliveryWorker } from "./delivery/worker.js";
import { startPhase2HttpServer } from "./http/server.js";
import { SynvoLarkMcpClient } from "./mcp/client.js";
import { LarkOAuthService } from "./oauth/service.js";
import { PostgresInbox } from "./repositories/inbox.js";
import { PostgresPhase2Repository } from "./repositories/phase2.js";
import { OrganizeFolderWorkflow } from "./workflows/organize-folder/service.js";

function readTextContent(content: string | undefined): string | null {
  if (!content) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "text" in parsed &&
      typeof parsed.text === "string"
    ) {
      return parsed.text;
    }
  } catch {
    return null;
  }

  return null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.organizeFolderWriteEnabled) {
    throw new Error(
      "ORGANIZE_FOLDER_WRITE_ENABLED must remain false during Phase 2",
    );
  }

  const larkConnection = {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: Lark.Domain.Lark,
  };
  const apiClient = new Lark.Client({
    ...larkConnection,
    appType: Lark.AppType.SelfBuild,
  });
  const pool = createDatabasePool(config.databaseUrl);
  if (!(await isPhase2SchemaReady(pool))) {
    throw new Error("Phase 2 database schema is not ready; run migrations");
  }
  const cipher = TokenCipher.fromEncodedKey(config.oauthTokenEncryptionKey);
  const grantStore = new PostgresOAuthGrantStore(pool);
  const repository = new PostgresPhase2Repository(pool);
  const inbox = new PostgresInbox(pool);
  const oauthService = new LarkOAuthService({
    appId: config.appId,
    appSecret: config.appSecret,
    redirectUri: config.larkOAuthRedirectUri,
    cipher,
    oauthClient: new LarkOAuthHttpClient(),
    grantStore,
    repository,
    authorizedOpenId: config.authorizedOpenId,
    authorizedTenantKey: config.authorizedTenantKey,
  });
  const mcpClient = new SynvoLarkMcpClient(config);
  const workflow = new OrganizeFolderWorkflow({
    config,
    grantStore,
    repository,
    oauthService,
    mcpClient,
  });

  const sendText = async (
    chatId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<void> => {
    const response = await apiClient.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
        uuid: idempotencyKey,
      },
    });
    if (response.code !== 0) {
      throw new Error(`Lark send failed with code ${response.code ?? "unknown"}`);
    }
  };
  const deliveryQueue = new PostgresDeliveryQueue(pool);
  const enqueueText = async (
    chatId: string,
    text: string,
    dedupeKey: string,
  ): Promise<void> => {
    const id = randomUUID();
    await deliveryQueue.enqueue({
      id,
      dedupeKey,
      kind: "TEXT",
      chatId,
      payloadCiphertext: encryptDeliveryMessage(cipher, id, text),
    });
  };
  const deliveryWorker = new DeliveryWorker({
    queue: deliveryQueue,
    cipher,
    scanFolder: (runId) => workflow.scan(runId),
    finalizeExhaustedScan: async (job, payloadCiphertext) => {
      if (!job.runId || job.kind !== "ORGANIZE_FOLDER_SCAN") {
        return false;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const delivery = await client.query(
          `UPDATE lark_delivery_jobs
              SET payload_ciphertext = $3,
                  updated_at = now()
            WHERE id = $1
              AND state = 'PROCESSING'
              AND attempt_count = $2
              AND kind = 'ORGANIZE_FOLDER_SCAN'
              AND run_id = $4
          RETURNING id`,
          [job.id, job.attemptCount, payloadCiphertext, job.runId],
        );
        if (delivery.rowCount !== 1) {
          await client.query("ROLLBACK");
          return false;
        }

        const run = await client.query(
          `UPDATE organize_folder_runs
              SET state = 'FAILED_NO_CHANGE',
                  terminal_error_code = 'SCAN_ATTEMPTS_EXHAUSTED',
                  scan_lease_expires_at = NULL,
                  updated_at = now()
            WHERE id = $1
              AND state IN ('READY_TO_SCAN', 'SCANNING')
          RETURNING id`,
          [job.runId],
        );
        if (run.rowCount !== 1) {
          throw new Error("Exhausted scan run could not be finalized");
        }

        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    sendText,
  });

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (event) => {
      const { message, sender } = event;
      if (sender?.sender_type !== "user") {
        return;
      }
      if (message?.chat_type !== "p2p" || message.message_type !== "text") {
        return;
      }

      const messageId = message.message_id;
      const chatId = message.chat_id;
      const requesterOpenId = sender.sender_id?.open_id;
      const tenantKey = sender.tenant_key ?? event.tenant_key;
      const text = readTextContent(message.content);
      if (!messageId || !chatId || !requesterOpenId || !tenantKey || text === null) {
        return;
      }
      if (!(await inbox.claim(messageId, "im.message.receive_v1"))) {
        return;
      }

      try {
        console.info(`[lark] received direct text message ${messageId}`);
        const command = parseCommand(text);
        if (command.type === "ping") {
          await enqueueText(chatId, "pong", `ping:${messageId}`);
          await inbox.complete(messageId);
          return;
        }
        if (command.type !== "organize-folder") {
          await enqueueText(
            chatId,
            "Synvo AI Assistant is connected. Send /ping or /organize-folder <Lark Drive folder link>.",
            `help:${messageId}`,
          );
          await inbox.complete(messageId);
          return;
        }

        const start = await workflow.start({
          messageId,
          chatId,
          requesterOpenId,
          tenantKey,
          folderLink: command.folderLink,
        });
        if (start.kind === "rejected") {
          await enqueueText(
            chatId,
            start.replyText,
            `organize-folder-rejected:${messageId}`,
          );
        }
        await inbox.complete(messageId);
      } catch (error) {
        await inbox.release(messageId, "EVENT_PROCESSING_RETRYABLE");
        throw error;
      }
    },
  });

  const wsClient = new Lark.WSClient({
    ...larkConnection,
    loggerLevel: Lark.LoggerLevel.info,
    onReady: () => {
      console.info("[lark] persistent connection is ready");
    },
    onReconnecting: () => {
      console.warn("[lark] persistent connection lost; reconnecting");
    },
    onReconnected: () => {
      console.info("[lark] persistent connection restored");
    },
    onError: () => {
      console.error("[lark] persistent connection failed");
    },
  });

  const httpServer = await startPhase2HttpServer({
    host: config.httpHost,
    port: config.httpPort,
    oauthService,
    healthCheck: async () => isPhase2SchemaReady(pool),
  });
  deliveryWorker.start();

  let shuttingDown = false;
  const shutDown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.info(`[app] received ${signal}; shutting down`);
    wsClient.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await deliveryWorker.stop();
    await mcpClient.close();
    await pool.end();
  };
  process.once("SIGINT", () => void shutDown("SIGINT"));
  process.once("SIGTERM", () => void shutDown("SIGTERM"));

  console.info("[lark] starting Synvo AI Assistant persistent connection");
  void wsClient.start({ eventDispatcher });
}

void main().catch(() => {
  console.error("[app] Synvo AI Assistant failed to start");
  process.exitCode = 1;
});
