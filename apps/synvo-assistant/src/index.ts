import * as Lark from "@larksuiteoapi/node-sdk";
import {
  LarkOAuthHttpClient,
  LarkTokenBroker,
  PostgresOAuthGrantStore,
  TokenCipher,
} from "./lark/auth/index.js";
import {
  LarkDriveFileDownloader,
  LarkDriveMover,
  LarkDriveReader,
} from "./lark/drive/index.js";

import { parseCommand } from "./lark/command-parser.js";
import { loadConfig } from "./config.js";
import { isDatabaseSchemaReady } from "./db/migrate.js";
import { createDatabasePool } from "./db/pool.js";
import { PostgresDeliveryQueue } from "./delivery/repository.js";
import { DeliveryWorker } from "./delivery/worker.js";
import { LarkAttachmentClient } from "./lark/attachment.js";
import {
  buildAnalysisCard,
  buildAssistantClarificationCard,
  buildAssistantHelpCard,
  buildAssistantOnlineCard,
  buildAuthorizationCard,
  buildCardCallbackResponse,
  buildCurrentWorkspaceCard,
  buildFolderLinkRequiredCard,
  buildNoticeCard,
} from "./lark/assistant-card.js";
import {
  buildOrganizeFolderConfirmationCard,
  buildOrganizeFolderDecisionCard,
  buildOrganizeFolderLoadingCard,
  buildOrganizeFolderOperationCard,
  buildOrganizeFolderRequestAcceptedCard,
  buildOrganizeFolderResultCard,
  parseOrganizeFolderCardAction,
} from "./lark/organize-folder-card.js";
import { SynvoMcpClient } from "./mcp/client.js";
import { createSynvoMcpEndpoint } from "./mcp/server.js";
import { startAssistantWebServer } from "./web/server.js";
import { acceptAttachmentEvent } from "./workflows/analyze-attachment/event.js";
import { NvidiaNimClient } from "./workflows/analyze-attachment/nim-client.js";
import { ANALYZE_ATTACHMENT_NIM_TIMEOUT_MS } from "./workflows/analyze-attachment/policy.js";
import { AnalyzeAttachmentWorkflow } from "./workflows/analyze-attachment/workflow.js";
import { AnalyzeDriveFileWorkflow } from "./workflows/analyze-drive-file/workflow.js";
import { understandNaturalLanguage } from "./workflows/natural-language/intent.js";
import { LarkOAuthService } from "./workflows/organize-folder/authorization.js";
import { ContentAwareFolderPlanner } from "./workflows/organize-folder/content-planner.js";
import { PostgresOrganizeFolderRepository } from "./workflows/organize-folder/repository.js";
import { OrganizeFolderWorkflow } from "./workflows/organize-folder/workflow.js";
import { loadWorkspaceContext } from "./workflows/workspace-context/context.js";

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
    // Defends credentials and resource identifiers against SDK HTTP-object dumps.
    logger: {
      error: () => console.error("[lark] API request failed"),
      warn: () => console.warn("[lark] API request warning"),
      info: () => {},
      debug: () => {},
      trace: () => {},
    },
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
  const driveReader = new LarkDriveReader();
  const deliveryQueue = new PostgresDeliveryQueue(pool);
  const nimClient = new NvidiaNimClient({
    apiKey: config.llmApiKey,
    timeoutMs: ANALYZE_ATTACHMENT_NIM_TIMEOUT_MS,
  });
  const pilotIdentity =
    config.authorizedOpenId && config.authorizedTenantKey
      ? {
          openId: config.authorizedOpenId,
          tenantKey: config.authorizedTenantKey,
        }
      : undefined;
  const contentMcpClient = config.synvoMcpAuthToken && pilotIdentity
    ? new SynvoMcpClient({
        url: new URL(
          `http://${config.httpHost.includes(":") ? "[::1]" : "127.0.0.1"}:${config.httpPort}/mcp`,
        ),
        authToken: config.synvoMcpAuthToken,
      })
    : undefined;
  const workflow = new OrganizeFolderWorkflow({
    config,
    grantStore,
    repository,
    oauthService,
    tokenBroker,
    cipher,
    driveReader,
    driveMover: new LarkDriveMover(),
    contentPlanner: contentMcpClient
      ? new ContentAwareFolderPlanner({
          tools: contentMcpClient,
          classifier: nimClient,
        })
      : undefined,
  });
  const organizeFolderRootUrl = new URL(
    `/drive/folder/${config.organizeFolderRootToken}?from=space`,
    "https://larksuite.com",
  );
  const loadWorkspaceCardContext = async () => {
    if (!pilotIdentity) {
      return undefined;
    }
    try {
      const context = await loadWorkspaceContext({
        requesterOpenId: pilotIdentity.openId,
        tenantKey: pilotIdentity.tenantKey,
        activeRootToken: config.organizeFolderRootToken,
        tokenBroker,
        driveReader,
      });
      return context
        ? { ...context, workspaceUrl: organizeFolderRootUrl }
        : undefined;
    } catch {
      return undefined;
    }
  };

  const createCard = async (
    chatId: string,
    card: Lark.InteractiveCard,
    idempotencyKey: string,
  ): Promise<string> => {
    const response = await apiClient.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
        uuid: idempotencyKey,
      },
    });
    const messageId = response.data?.message_id;
    if (response.code !== 0 || !messageId) {
      throw new Error(`Lark card send failed with code ${response.code ?? "unknown"}`);
    }
    return messageId;
  };
  const updateCard = async (
    messageId: string,
    card: Lark.InteractiveCard,
  ): Promise<void> => {
    const response = await apiClient.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
    if (response.code !== 0) {
      throw new Error(`Lark card update failed with code ${response.code ?? "unknown"}`);
    }
  };
  const sendText = async (
    chatId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<void> => {
    const card =
      buildAuthorizationCard(text) ??
      buildOrganizeFolderOperationCard(text, organizeFolderRootUrl);
    if (card) {
      await createCard(chatId, card, idempotencyKey);
      return;
    }
    await createCard(chatId, buildNoticeCard(text), idempotencyKey);
  };
  const createAnalysisCard = (
    chatId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<string> =>
    createCard(
      chatId,
      buildAnalysisCard(text, config.larkLoadingImageKey),
      idempotencyKey,
    );
  const updateAnalysisCard = (
    messageId: string,
    text: string,
  ): Promise<void> =>
    updateCard(
      messageId,
      buildAnalysisCard(text, config.larkLoadingImageKey),
    );
  const attachmentWorkflow =
    pilotIdentity
      ? new AnalyzeAttachmentWorkflow({
          queue: deliveryQueue,
          requesterOpenId: pilotIdentity.openId,
          tenantKey: pilotIdentity.tenantKey,
          attachmentClient: new LarkAttachmentClient({
            getMessage: (messageId, tenantKey) =>
              apiClient.im.v1.message.get(
                {
                  params: { user_id_type: "open_id" },
                  path: { message_id: messageId },
                },
                Lark.withTenantKey(tenantKey),
              ),
            getMessageResource: (messageId, fileKey, tenantKey) =>
              apiClient.im.v1.messageResource.get(
                {
                  params: { type: "file" },
                  path: { message_id: messageId, file_key: fileKey },
                },
                Lark.withTenantKey(tenantKey),
              ),
          }),
          nimClient,
          messenger: { create: createAnalysisCard, update: updateAnalysisCard },
        })
      : undefined;
  const driveFileWorkflow = pilotIdentity
    ? new AnalyzeDriveFileWorkflow({
        queue: deliveryQueue,
        cipher,
        tokenBroker,
        driveReader,
        downloader: new LarkDriveFileDownloader(),
        analyzer: nimClient,
        messenger: { create: createAnalysisCard, update: updateAnalysisCard },
        rootToken: config.organizeFolderRootToken,
        requesterOpenId: pilotIdentity.openId,
        tenantKey: pilotIdentity.tenantKey,
      })
    : undefined;
  const startDriveFileAnalysis = async (
    request: Parameters<AnalyzeDriveFileWorkflow["start"]>[0],
  ): Promise<void> => {
    if (!driveFileWorkflow) {
      await createCard(
        request.chatId,
        buildNoticeCard(
          "I can’t analyze Drive files for this account yet. Please ask the app administrator to finish the Drive setup.",
        ),
        request.messageId,
      );
      return;
    }
    const result = await driveFileWorkflow.start(request);
    if (result.kind !== "queued") {
      await createCard(
        request.chatId,
        buildNoticeCard(result.replyText),
        request.messageId,
      );
    }
  };
  const startFolderAnalysis = async (
    request: Parameters<OrganizeFolderWorkflow["start"]>[0],
  ): Promise<void> => {
    const result = await workflow.start(request);
    if (result.kind === "rejected") {
      await createCard(
        request.chatId,
        buildNoticeCard(result.replyText),
        request.messageId,
      );
    }
  };
  const mcpEndpoint =
    config.synvoMcpAuthToken && pilotIdentity && driveFileWorkflow
      ? createSynvoMcpEndpoint({
          authToken: config.synvoMcpAuthToken,
          requesterOpenId: pilotIdentity.openId,
          tenantKey: pilotIdentity.tenantKey,
          inventoryReader: workflow,
          driveFileAnalyzer: driveFileWorkflow,
        })
      : undefined;
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
    handleAnalyzeAttachment: attachmentWorkflow
      ? (job, progressMessageId, storeProgressMessageId) =>
          attachmentWorkflow.process(
            job,
            progressMessageId,
            storeProgressMessageId,
          )
      : undefined,
    handleAnalyzeDriveFile: driveFileWorkflow
      ? (job, payload, storePayload) =>
          driveFileWorkflow.process(job, payload, storePayload)
      : undefined,
    handleOrganizeFolderScan: async (
      job,
      progressMessageId,
      storeProgressMessageId,
      finalAttempt,
    ) => {
      if (!job.runId) {
        throw new Error("Folder analysis delivery has no run");
      }
      let messageId = progressMessageId?.startsWith("om_")
        ? progressMessageId
        : null;
      if (!messageId) {
        messageId = await createCard(
          job.chatId,
          buildOrganizeFolderLoadingCard(config.larkLoadingImageKey),
          job.id,
        );
        if (!(await storeProgressMessageId(messageId))) {
          throw new Error("Folder progress message could not be stored");
        }
      }

      let result: string;
      try {
        result = await workflow.buildProposalMessage(job.runId);
      } catch (error) {
        if (!finalAttempt) {
          throw error;
        }
        result = await workflow.finalizeExhaustedOperation(
          job.runId,
          "ORGANIZE_FOLDER_SCAN",
        );
      }
      await updateCard(
        messageId,
        buildOrganizeFolderResultCard(job.runId, result),
      );
    },
  });

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (event) => {
      const { message, sender } = event;
      const messageId = message?.message_id;
      const chatId = message?.chat_id;
      const requesterOpenId = sender?.sender_id?.open_id;
      const tenantKey = sender?.tenant_key ?? event.tenant_key;
      if (message?.message_type === "file") {
        if (!attachmentWorkflow || !pilotIdentity) {
          return;
        }
        const accepted = acceptAttachmentEvent(
          {
            senderType: sender?.sender_type,
            chatType: message.chat_type,
            messageType: message.message_type,
            messageId,
            chatId,
            requesterOpenId,
            tenantKey,
          },
          pilotIdentity,
        );
        if (accepted && (await attachmentWorkflow.enqueue(accepted))) {
          console.info("[lark] queued direct PDF analysis");
        }
        return;
      }
      if (
        sender?.sender_type !== "user" ||
        message?.chat_type !== "p2p" ||
        message?.message_type !== "text"
      ) {
        return;
      }
      const text = readTextContent(message.content);
      if (!messageId || !chatId || !requesterOpenId || !tenantKey || text === null) {
        return;
      }
      if (
        !pilotIdentity ||
        requesterOpenId !== pilotIdentity.openId ||
        tenantKey !== pilotIdentity.tenantKey
      ) {
        return;
      }
      console.info("[lark] received direct text message");
      const command = parseCommand(text);
      if (command.type === "ping") {
        await createCard(
          chatId,
          buildAssistantOnlineCard(config.authorizedFirstName),
          messageId,
        );
        return;
      }
      if (command.type === "decide-folder") {
        const replyText = await workflow.decideProposal({
          proposalId: command.proposalId,
          requesterOpenId,
          tenantKey,
          decision: command.decision,
        });
        await createCard(
          chatId,
          buildOrganizeFolderDecisionCard(
            replyText,
            config.larkLoadingImageKey,
          ),
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
        await createCard(
          chatId,
          buildOrganizeFolderDecisionCard(
            replyText,
            config.larkLoadingImageKey,
          ),
          messageId,
        );
        return;
      }
      if (command.type === "analyze-file") {
        await startDriveFileAnalysis({
          messageId,
          chatId,
          requesterOpenId,
          tenantKey,
          fileLink: command.fileLink,
        });
        return;
      }
      if (command.type === "organize-folder") {
        await startFolderAnalysis({
          messageId,
          chatId,
          requesterOpenId,
          tenantKey,
          folderLink: command.folderLink,
        });
        return;
      }

      if (text.trimStart().startsWith("/")) {
        await createCard(chatId, buildAssistantHelpCard(), messageId);
        return;
      }

      const understood = await understandNaturalLanguage(
        {
          text,
          mentionKeys: message.mentions?.flatMap((mention) =>
            mention.key ? [mention.key] : [],
          ),
        },
        nimClient,
      );
      if (understood.intent === "greeting") {
        await createCard(
          chatId,
          buildAssistantOnlineCard(
            config.authorizedFirstName,
            await loadWorkspaceCardContext(),
          ),
          messageId,
        );
        return;
      }
      if (understood.intent === "help") {
        await createCard(chatId, buildAssistantHelpCard(), messageId);
        return;
      }
      if (understood.intent === "current_workspace") {
        await createCard(
          chatId,
          buildCurrentWorkspaceCard(await loadWorkspaceCardContext()),
          messageId,
        );
        return;
      }
      if (understood.intent === "organize_folder") {
        if (
          understood.links.length === 0 &&
          understood.canConfirmApprovedRoot
        ) {
          await createCard(
            chatId,
            buildOrganizeFolderConfirmationCard(),
            messageId,
          );
          return;
        }
        if (understood.links.length === 1 && understood.links[0]) {
          await startFolderAnalysis({
            messageId,
            chatId,
            requesterOpenId,
            tenantKey,
            folderLink: understood.links[0],
          });
          return;
        }
        if (understood.links.length === 0) {
          await createCard(
            chatId,
            buildFolderLinkRequiredCard(),
            messageId,
          );
          return;
        }
      }
      if (
        understood.intent === "analyze_drive_file" &&
        understood.links.length === 1 &&
        understood.links[0]
      ) {
        await startDriveFileAnalysis({
          messageId,
          chatId,
          requesterOpenId,
          tenantKey,
          fileLink: understood.links[0],
        });
        return;
      }
      await createCard(
        chatId,
        buildAssistantClarificationCard(),
        messageId,
      );
    },
    "card.action.trigger": async (rawEvent: Lark.RawCardActionEvent) => {
      const event = Lark.normalizeCardAction(rawEvent);
      if (
        !event ||
        !pilotIdentity ||
        event.operator.openId !== pilotIdentity.openId ||
        event.action.tag !== "button"
      ) {
        return;
      }
      const action = parseOrganizeFolderCardAction(event.action.value);
      if (!action) {
        return;
      }
      if (action.type === "start") {
        const result = await workflow.start({
          messageId: event.messageId,
          chatId: event.chatId,
          requesterOpenId: event.operator.openId,
          tenantKey: pilotIdentity.tenantKey,
          folderLink: organizeFolderRootUrl.toString(),
        });
        console.info("[lark] accepted confirmed folder analysis request");
        if (result.kind === "rejected") {
          return buildCardCallbackResponse(buildNoticeCard(result.replyText), {
            type: "error",
            content: "I couldn’t start the folder analysis.",
          });
        }
        return result.kind === "authorization_required"
          ? buildCardCallbackResponse(
              buildNoticeCard(
                "Please use the secure Lark authorization card I’ve sent in this chat.",
              ),
              {
                type: "info",
                content: "Lark Drive authorization is required.",
              },
            )
          : buildCardCallbackResponse(
              buildOrganizeFolderRequestAcceptedCard(),
              {
                type: "success",
                content: "Folder analysis started.",
              },
            );
      }
      if (action.type === "undo") {
        const result = await workflow.requestUndo({
          proposalId: action.proposalId,
          requesterOpenId: event.operator.openId,
          tenantKey: pilotIdentity.tenantKey,
        });
        console.info("[lark] recorded folder undo request");
        return buildCardCallbackResponse(
          buildOrganizeFolderDecisionCard(
            result,
            config.larkLoadingImageKey,
          ),
          { type: "success", content: "Undo request saved." },
        );
      }
      const result = await workflow.decideProposal({
        proposalId: action.proposalId,
        requesterOpenId: event.operator.openId,
        tenantKey: pilotIdentity.tenantKey,
        decision: action.decision,
      });
      console.info("[lark] recorded folder proposal decision");
      return buildCardCallbackResponse(
        buildOrganizeFolderDecisionCard(
          result,
          config.larkLoadingImageKey,
        ),
        {
          type: "success",
          content:
            action.decision === "APPROVED"
              ? "Approval saved."
              : "Proposal rejected.",
        },
      );
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
    healthCheck: async () => {
      await pool.query("SELECT 1");
      return true;
    },
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
    await deliveryWorker.stop();
    await contentMcpClient?.close().catch(() => {});
    await new Promise<void>((resolve) => webServer.close(() => resolve()));
    await mcpEndpoint?.close();
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
