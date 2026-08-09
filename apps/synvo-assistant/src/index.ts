import * as Lark from "@larksuiteoapi/node-sdk";
import {
  LarkOAuthHttpClient,
  LarkTokenBroker,
  PostgresOAuthGrantStore,
  TokenCipher,
} from "./lark/auth/index.js";
import { LarkDriveMover, LarkDriveReader } from "./lark/drive/index.js";

import { parseCommand } from "./lark/command-parser.js";
import { loadConfig } from "./config.js";
import { isDatabaseSchemaReady } from "./db/migrate.js";
import { createDatabasePool } from "./db/pool.js";
import { PostgresDeliveryQueue } from "./delivery/repository.js";
import { DeliveryWorker } from "./delivery/worker.js";
import { createSynvoMcpEndpoint } from "./mcp/server.js";
import { startAssistantWebServer } from "./web/server.js";
import { LarkOAuthService } from "./workflows/organize-folder/authorization.js";
import { PostgresOrganizeFolderRepository } from "./workflows/organize-folder/repository.js";
import { OrganizeFolderWorkflow } from "./workflows/organize-folder/workflow.js";

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
  if (!(await isDatabaseSchemaReady(pool))) {
    throw new Error("The assistant database schema is not ready; run migrations");
  }
  const cipher = TokenCipher.fromEncodedKey(config.oauthTokenEncryptionKey);
  const oauthClient = new LarkOAuthHttpClient();
  const grantStore = new PostgresOAuthGrantStore(pool);
  const repository = new PostgresOrganizeFolderRepository(pool);
  const oauthService = new LarkOAuthService({
    appId: config.appId,
    appSecret: config.appSecret,
    redirectUri: config.larkOAuthRedirectUri,
    cipher,
    oauthClient,
    grantStore,
    repository,
    authorizedOpenId: config.authorizedOpenId,
    authorizedTenantKey: config.authorizedTenantKey,
  });
  const tokenBroker = new LarkTokenBroker({
    clientId: config.appId,
    clientSecret: config.appSecret,
    cipher,
    grantStore,
    oauthClient,
  });
  const workflow = new OrganizeFolderWorkflow({
    config,
    grantStore,
    repository,
    oauthService,
    tokenBroker,
    cipher,
    driveReader: new LarkDriveReader(),
    driveMover: new LarkDriveMover(),
  });
  const mcpEndpoint =
    config.synvoMcpAuthToken &&
    config.authorizedOpenId &&
    config.authorizedTenantKey
      ? createSynvoMcpEndpoint({
          authToken: config.synvoMcpAuthToken,
          requesterOpenId: config.authorizedOpenId,
          tenantKey: config.authorizedTenantKey,
          inventoryReader: workflow,
        })
      : undefined;

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
  const deliveryWorker = new DeliveryWorker({
    queue: deliveryQueue,
    cipher,
    prepareMessage: (runId, kind) => {
      if (kind === "ORGANIZE_FOLDER_SCAN") {
        return workflow.buildProposalMessage(runId);
      }
      if (kind === "ORGANIZE_FOLDER_EXECUTE") {
        return workflow.buildExecutionMessage(runId);
      }
      if (kind === "ORGANIZE_FOLDER_UNDO") {
        return workflow.buildUndoMessage(runId);
      }
      throw new Error("Unsupported workflow delivery job");
    },
    prepareExhaustedMessage: (runId, kind) =>
      workflow.finalizeExhaustedOperation(runId, kind),
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
      console.info(`[lark] received direct text message ${messageId}`);
      const command = parseCommand(text);
      if (command.type === "ping") {
        await sendText(chatId, "pong", messageId);
        return;
      }
      if (command.type === "decide-folder") {
        const replyText = await workflow.decideProposal({
          proposalId: command.proposalId,
          requesterOpenId,
          tenantKey,
          decision: command.decision,
        });
        await sendText(
          chatId,
          replyText,
          messageId,
        );
        return;
      }
      if (command.type === "undo-folder") {
        const replyText = await workflow.requestUndo({
          proposalId: command.proposalId,
          requesterOpenId,
          tenantKey,
        });
        await sendText(chatId, replyText, messageId);
        return;
      }
      if (command.type !== "organize-folder") {
        await sendText(
          chatId,
          "Synvo AI Assistant is connected. Send /ping, /organize-folder <Lark Drive folder link>, /approve-folder <proposal ID>, /reject-folder <proposal ID>, or /undo-folder <proposal ID>.",
          messageId,
        );
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
        await sendText(
          chatId,
          start.replyText,
          messageId,
        );
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

  const webServer = await startAssistantWebServer({
    host: config.httpHost,
    port: config.httpPort,
    oauthService,
    healthCheck: async () => isDatabaseSchemaReady(pool),
    mcpEndpoint,
  });
  console.info(
    mcpEndpoint
      ? "[mcp] read-only endpoint enabled at /mcp"
      : "[mcp] endpoint disabled",
  );
  deliveryWorker.start();

  let shuttingDown = false;
  const shutDown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.info(`[app] received ${signal}; shutting down`);
    wsClient.close();
    await new Promise<void>((resolve) => webServer.close(() => resolve()));
    await mcpEndpoint?.close();
    await deliveryWorker.stop();
    await pool.end();
  };
  process.once("SIGINT", () => void shutDown("SIGINT"));
  process.once("SIGTERM", () => void shutDown("SIGTERM"));

  console.info("[lark] starting Synvo AI Assistant persistent connection");
  void wsClient.start({ eventDispatcher });
}

void main().catch((error: unknown) => {
  console.error("[app] Synvo AI Assistant failed to start", error);
  process.exitCode = 1;
});
