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
  isRecentLarkMessage,
  PostgresInboundMessageStore,
} from "./lark/inbound-message.js";
import {
  buildAnalysisCard,
  buildAssistantAcknowledgementCard,
  buildAssistantClarificationCard,
  buildAssistantHelpCard,
  buildAssistantOnlineCard,
  buildAssistantWorkingCard,
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
import {
  buildKnowledgeConsentCard,
  buildKnowledgeNotNowCard,
  buildKnowledgeProgressCard,
  buildKnowledgeRefreshProposalCard,
  buildKnowledgeRemovalConfirmationCard,
  buildKnowledgeRemovedCard,
  parseKnowledgeCardAction,
} from "./lark/knowledge-card.js";
import { SynvoMcpClient } from "./mcp/client.js";
import { createSynvoMcpEndpoint } from "./mcp/server.js";
import { startAssistantWebServer } from "./web/server.js";
import { acceptAttachmentEvent } from "./workflows/analyze-attachment/event.js";
import { NvidiaNimClient } from "./workflows/analyze-attachment/nim-client.js";
import { ANALYZE_ATTACHMENT_NIM_TIMEOUT_MS } from "./workflows/analyze-attachment/policy.js";
import { AnalyzeAttachmentWorkflow } from "./workflows/analyze-attachment/workflow.js";
import { AuthorizedDrivePdfReader } from "./workflows/analyze-drive-file/authorized-reader.js";
import { AnalyzeDriveFileWorkflow } from "./workflows/analyze-drive-file/workflow.js";
import { KnowledgeRepository } from "./workflows/knowledge/repository.js";
import { VoyageEmbeddingClient } from "./workflows/knowledge/voyage-client.js";
import { KnowledgeWorkflow } from "./workflows/knowledge/workflow.js";
import { understandNaturalLanguage } from "./workflows/natural-language/intent.js";
import { LarkOAuthService } from "./workflows/organize-folder/authorization.js";
import { ContentAwareFolderPlanner } from "./workflows/organize-folder/content-planner.js";
import { PostgresOrganizeFolderRepository } from "./workflows/organize-folder/repository.js";
import { OrganizeFolderWorkflow } from "./workflows/organize-folder/workflow.js";
import { loadWorkspaceContext } from "./workflows/workspace-context/context.js";

const NATURAL_LANGUAGE_FEEDBACK_DELAY_MS = 750;

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
  const startedAt = new Date();
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
  const inboundMessages = new PostgresInboundMessageStore(pool);
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
  const attachmentClient = pilotIdentity
    ? new LarkAttachmentClient({
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
      })
    : undefined;
  const attachmentWorkflow =
    pilotIdentity && attachmentClient
      ? new AnalyzeAttachmentWorkflow({
          queue: deliveryQueue,
          requesterOpenId: pilotIdentity.openId,
          tenantKey: pilotIdentity.tenantKey,
          attachmentClient,
          nimClient,
          messenger: { create: createAnalysisCard, update: updateAnalysisCard },
        })
      : undefined;
  const authorizedDrivePdfReader = pilotIdentity
    ? new AuthorizedDrivePdfReader({
        tokenBroker,
        driveReader,
        downloader: new LarkDriveFileDownloader(),
        rootToken: config.organizeFolderRootToken,
        requesterOpenId: pilotIdentity.openId,
        tenantKey: pilotIdentity.tenantKey,
      })
    : undefined;
  const driveFileWorkflow = pilotIdentity && authorizedDrivePdfReader
    ? new AnalyzeDriveFileWorkflow({
        queue: deliveryQueue,
        cipher,
        pdfReader: authorizedDrivePdfReader,
        analyzer: nimClient,
        messenger: { create: createAnalysisCard, update: updateAnalysisCard },
        rootToken: config.organizeFolderRootToken,
        requesterOpenId: pilotIdentity.openId,
        tenantKey: pilotIdentity.tenantKey,
      })
    : undefined;
  const knowledgeWorkflow =
    pilotIdentity && attachmentClient && authorizedDrivePdfReader
      ? new KnowledgeWorkflow({
          queue: deliveryQueue,
          cipher,
          repository: new KnowledgeRepository(pool),
          embedder: new VoyageEmbeddingClient({ apiKey: config.voyageApiKey }),
          attachmentReader: attachmentClient,
          driveReader: authorizedDrivePdfReader,
          answerer: nimClient,
          messenger: {
            create: (chatId, progress, idempotencyKey) =>
              createCard(
                chatId,
                buildKnowledgeProgressCard(
                  progress,
                  config.larkLoadingImageKey,
                ),
                idempotencyKey,
              ),
            update: (messageId, progress) =>
              updateCard(
                messageId,
                buildKnowledgeProgressCard(
                  progress,
                  config.larkLoadingImageKey,
                ),
              ),
          },
          scope: {
            tenantKey: pilotIdentity.tenantKey,
            userOpenId: pilotIdentity.openId,
            workspaceFolderToken: config.organizeFolderRootToken,
          },
          verifyWorkspace: async () =>
            Boolean(await loadWorkspaceCardContext()),
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
      await createCard(request.chatId, buildNoticeCard(result.replyText), request.messageId);
    }
  };
  const startFolderAnalysis = async (
    request: Parameters<OrganizeFolderWorkflow["start"]>[0],
  ): Promise<void> => {
    const result = await workflow.start(request);
    if (result.kind === "rejected") {
      await createCard(request.chatId, buildNoticeCard(result.replyText), request.messageId);
    }
  };
  const mcpEndpoint =
    config.synvoMcpAuthToken && pilotIdentity && driveFileWorkflow && knowledgeWorkflow
      ? createSynvoMcpEndpoint({
          authToken: config.synvoMcpAuthToken,
          requesterOpenId: pilotIdentity.openId,
          tenantKey: pilotIdentity.tenantKey,
          inventoryReader: workflow,
          driveFileAnalyzer: driveFileWorkflow,
          knowledgeSearcher: knowledgeWorkflow,
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
    handleKnowledge: knowledgeWorkflow
      ? (job, payload, storePayload, finalAttempt) =>
          knowledgeWorkflow.process(
            job,
            payload,
            storePayload,
            finalAttempt,
          )
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
      if (
        sender?.sender_type !== "user" ||
        message?.chat_type !== "p2p" ||
        (message?.message_type !== "file" && message?.message_type !== "text") ||
        !messageId ||
        !chatId ||
        !requesterOpenId ||
        !tenantKey ||
        !pilotIdentity ||
        requesterOpenId !== pilotIdentity.openId ||
        tenantKey !== pilotIdentity.tenantKey
      ) {
        return;
      }
      if (!isRecentLarkMessage(message.create_time, startedAt)) {
        console.info("[lark] ignored stale direct message after reconnect");
        return;
      }
      if (!(await inboundMessages.claim(tenantKey, messageId))) {
        console.info("[lark] ignored replayed direct message");
        return;
      }
      if (message?.message_type === "file") {
        if (!attachmentWorkflow || !knowledgeWorkflow) {
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
            content: message.content,
          },
          pilotIdentity,
        );
        const workspace = accepted ? await loadWorkspaceCardContext() : undefined;
        if (accepted && workspace) {
          await createCard(
            accepted.chatId,
            buildKnowledgeConsentCard({
              filename: accepted.filename,
              sourceMessageId: accepted.messageId,
              workspaceName: workspace.activeWorkspaceName,
            }),
            accepted.messageId,
          );
          console.info("[lark] requested PDF knowledge consent");
        } else if (accepted) {
          await createCard(
            accepted.chatId,
            buildNoticeCard(
              "I received the PDF, but I couldn’t verify the active workspace. Please reconnect Lark Drive and send the file again.",
              "Workspace verification is required",
            ),
            accepted.messageId,
          );
        }
        return;
      }
      const text = readTextContent(message.content);
      if (text === null) {
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

      let classificationFinished = false;
      let workingCardPromise: Promise<string> | undefined;
      const feedbackTimer = setTimeout(() => {
        if (!classificationFinished) {
          workingCardPromise = createCard(
            chatId,
            buildAssistantWorkingCard(config.larkLoadingImageKey),
            `${messageId}:understanding`,
          );
        }
      }, NATURAL_LANGUAGE_FEEDBACK_DELAY_MS);
      const understood = await understandNaturalLanguage(
        {
          text,
          mentionKeys: message.mentions?.flatMap((mention) =>
            mention.key ? [mention.key] : [],
          ),
        },
        nimClient,
      );
      classificationFinished = true;
      clearTimeout(feedbackTimer);
      const workingCardId = await workingCardPromise;
      const resolveCard = async (card: Lark.InteractiveCard): Promise<string> => {
        if (workingCardId) {
          await updateCard(workingCardId, card);
          return workingCardId;
        }
        return createCard(chatId, card, messageId);
      };
      const finishWorkingCard = async (
        card: Lark.InteractiveCard,
      ): Promise<void> => {
        if (workingCardId) {
          await updateCard(workingCardId, card);
        }
      };
      if (understood.intent === "greeting") {
        await resolveCard(
          buildAssistantOnlineCard(
            config.authorizedFirstName,
            await loadWorkspaceCardContext(),
          ),
        );
        return;
      }
      if (understood.intent === "acknowledgement") {
        await resolveCard(buildAssistantAcknowledgementCard());
        return;
      }
      if (understood.intent === "help") {
        await resolveCard(buildAssistantHelpCard());
        return;
      }
      if (understood.intent === "current_workspace") {
        await resolveCard(
          buildCurrentWorkspaceCard(await loadWorkspaceCardContext()),
        );
        return;
      }
      if (understood.intent === "ask_workspace") {
        const workspace = await loadWorkspaceCardContext();
        if (!knowledgeWorkflow || !workspace) {
          await resolveCard(
            buildNoticeCard(
              "I can’t verify the active workspace knowledge right now. Please reconnect Lark Drive and try again.",
            ),
          );
          return;
        }
        const progressMessageId = await resolveCard(
          buildKnowledgeProgressCard(
            {
              stage: "answering",
              message: "Finding the most relevant evidence and preparing a cited answer",
            },
            config.larkLoadingImageKey,
          ),
        );
        await knowledgeWorkflow.enqueueQuestion({
          messageId,
          chatId,
          question: understood.sanitizedText,
          progressMessageId,
        });
        return;
      }
      if (understood.intent === "organize_folder") {
        if (
          understood.links.length === 0 &&
          understood.folder_reference === "active_workspace"
        ) {
          await resolveCard(buildOrganizeFolderConfirmationCard());
          return;
        }
        if (understood.links.length === 1 && understood.links[0]) {
          await finishWorkingCard(
            buildNoticeCard(
              "I found the folder link and I’m starting the analysis now.",
              "Folder analysis requested",
            ),
          );
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
          await resolveCard(buildFolderLinkRequiredCard());
          return;
        }
      }
      if (
        understood.intent === "analyze_drive_file" &&
        understood.links.length === 1 &&
        understood.links[0]
      ) {
        await finishWorkingCard(
          buildNoticeCard(
            "I found the file link and I’m starting the analysis now.",
            "File analysis requested",
          ),
        );
        await startDriveFileAnalysis({
          messageId,
          chatId,
          requesterOpenId,
          tenantKey,
          fileLink: understood.links[0],
        });
        return;
      }
      await resolveCard(buildAssistantClarificationCard());
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
      const knowledgeAction = parseKnowledgeCardAction(event.action.value);
      if (knowledgeAction) {
        if (!knowledgeWorkflow || !attachmentWorkflow) {
          return buildCardCallbackResponse(
            buildNoticeCard("Workspace knowledge is not configured yet."),
            { type: "error", content: "Knowledge is unavailable." },
          );
        }
        if (knowledgeAction.type === "attachment_not_now") {
          return buildCardCallbackResponse(buildKnowledgeNotNowCard(), {
            type: "info",
            content: "Nothing was added.",
          });
        }
        if (knowledgeAction.type === "attachment_analyze") {
          const queued = await attachmentWorkflow.enqueue({
            messageId: knowledgeAction.sourceMessageId,
            chatId: event.chatId,
          });
          return buildCardCallbackResponse(
            queued
              ? buildNoticeCard(
                  "I’ll analyze this PDF once. No knowledge chunks will be stored.",
                  "One-time analysis started",
                )
              : buildNoticeCard("I’m already analyzing this PDF."),
            {
              type: queued ? "success" : "info",
              content: queued ? "Analysis started." : "Already started.",
            },
          );
        }
        if (knowledgeAction.type === "attachment_add") {
          const queued = await knowledgeWorkflow.enqueueAttachment({
            sourceMessageId: knowledgeAction.sourceMessageId,
            cardMessageId: event.messageId,
            chatId: event.chatId,
          });
          return buildCardCallbackResponse(
            buildKnowledgeProgressCard(
              {
                stage: "ingesting",
                message: queued
                  ? "Reading the approved PDF → creating searchable chunks → updating the vault"
                  : "This PDF is already being added to workspace knowledge.",
              },
              config.larkLoadingImageKey,
            ),
            {
              type: queued ? "success" : "info",
              content: queued ? "Knowledge ingestion started." : "Already started.",
            },
          );
        }
        if (knowledgeAction.type === "refresh_propose") {
          try {
            const proposal = await knowledgeWorkflow.proposeRefresh();
            return buildCardCallbackResponse(
              buildKnowledgeRefreshProposalCard(proposal),
              {
                type: proposal.hasChanges ? "info" : "success",
                content: proposal.hasChanges
                  ? "Review the knowledge update."
                  : "Workspace knowledge is already current.",
              },
            );
          } catch {
            return buildCardCallbackResponse(
              buildNoticeCard("I couldn’t compare the Drive folder safely. Please try again."),
              { type: "error", content: "Refresh check failed." },
            );
          }
        }
        if (knowledgeAction.type === "refresh_confirm") {
          try {
            const result = await knowledgeWorkflow.enqueueRefresh({
              messageId: event.messageId,
              chatId: event.chatId,
              snapshot: knowledgeAction.snapshot,
            });
            return buildCardCallbackResponse(
              buildKnowledgeProgressCard(
                {
                  stage: "refreshing",
                  message: result.queued
                    ? "Reading the approved PDFs → refreshing searchable knowledge"
                    : "This knowledge update is already running.",
                  jobId: result.queued ? result.jobId : undefined,
                  completedFiles: result.queued ? 0 : undefined,
                  totalFiles: result.queued ? result.totalFiles : undefined,
                },
                config.larkLoadingImageKey,
              ),
              {
                type: result.queued ? "success" : "info",
                content: result.queued ? "Knowledge update started." : "Already started.",
              },
            );
          } catch {
            return buildCardCallbackResponse(
              buildNoticeCard("That refresh approval expired. Please review a new workspace update."),
              { type: "warning", content: "Approval expired." },
            );
          }
        }
        if (knowledgeAction.type === "refresh_stop") {
          const result = await knowledgeWorkflow.requestRefreshStop({
            jobId: knowledgeAction.jobId,
            chatId: event.chatId,
            requesterOpenId: event.operator.openId,
            tenantKey: pilotIdentity.tenantKey,
          });
          if (result === "unauthorized") {
            return buildCardCallbackResponse(
              buildNoticeCard("I couldn’t verify who requested that stop."),
              { type: "error", content: "Stop request was not authorized." },
            );
          }
          if (result === "requested") {
            return buildCardCallbackResponse(
              buildKnowledgeProgressCard(
                {
                  stage: "stopping",
                  message: "I’m finishing the current provider request, then I’ll stop before starting anything else.",
                  jobId: knowledgeAction.jobId,
                },
                config.larkLoadingImageKey,
              ),
              { type: "info", content: "Stopping this knowledge update." },
            );
          }
          if (result === "stopped") {
            return buildCardCallbackResponse(
              buildKnowledgeProgressCard({
                stage: "stopped",
                message: "The update stopped before processing began. Select **Resume update** to review and continue it.",
                jobId: knowledgeAction.jobId,
              }),
              { type: "success", content: "Knowledge update stopped." },
            );
          }
          return buildCardCallbackResponse(
            buildNoticeCard("This knowledge update has already finished or stopped."),
            { type: "info", content: "Nothing else needs to stop." },
          );
        }
        if (knowledgeAction.type === "remove_request") {
          return buildCardCallbackResponse(
            buildKnowledgeRemovalConfirmationCard({
              sourceReference: knowledgeAction.sourceReference,
              sourceName: knowledgeAction.sourceName,
            }),
            { type: "warning", content: "Please confirm removal." },
          );
        }
        try {
          await knowledgeWorkflow.removeSource(knowledgeAction.sourceReference);
          return buildCardCallbackResponse(
            buildKnowledgeRemovedCard(knowledgeAction.sourceName),
            { type: "success", content: "Removed from knowledge." },
          );
        } catch {
          return buildCardCallbackResponse(
            buildNoticeCard("I couldn’t remove that knowledge source safely."),
            { type: "error", content: "Removal failed." },
          );
        }
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
