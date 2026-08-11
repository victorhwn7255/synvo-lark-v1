import { randomUUID } from "node:crypto";

import { encryptDeliveryMessage } from "../../delivery/crypto.js";
import type { DeliveryJob, DeliveryQueue } from "../../delivery/repository.js";
import { LarkAuthError, type TokenCipher } from "../../lark/auth/index.js";
import {
  DriveToolError,
  driveToolError,
  type DriveFileDownloader,
  type DriveReader,
  type NativeDriveItem,
  listFolderCompletely,
  parseLarkDriveFileLink,
  parseLarkDriveFolderLink,
  requireAllowlistedRoot,
  withReadOnlyDriveTokenRecovery,
} from "../../lark/drive/index.js";
import {
  formatPdfAnalysis,
  safeAnalysisFailureMessage,
  type AttachmentProgressMessenger,
} from "../analyze-attachment/workflow.js";
import { extractPdfText, PdfInputError } from "../analyze-attachment/pdf.js";
import type { ExtractedPdf } from "../analyze-attachment/pdf.js";
import {
  ANALYZE_ATTACHMENT_JOB_TTL_MS,
  ANALYZE_ATTACHMENT_MAX_BYTES,
} from "../analyze-attachment/policy.js";
import {
  NimAnalysisError,
  type NvidiaNimClient,
} from "../analyze-attachment/nim-client.js";
import { organizeFolderPilotPolicy } from "../organize-folder/pilot-policy.js";

const DEDUPE_PREFIX = "analyze-drive-file:";

type JobContext = {
  fileToken: string;
  progressMessageId: string | null;
};
type AccessTokenProvider = {
  getAccessToken(openId: string, tenantKey: string): Promise<string>;
  recoverAccessToken(
    openId: string,
    tenantKey: string,
    rejectedAccessToken: string,
  ): Promise<string>;
  markAccessTokenRejected(
    openId: string,
    tenantKey: string,
    rejectedAccessToken: string,
  ): Promise<void>;
};
type Analyzer = Pick<NvidiaNimClient, "analyze">;

export type AnalyzeDriveFileStartResult =
  | { kind: "queued" }
  | { kind: "rejected" | "duplicate"; replyText: string };

export type AnalyzeDriveFileResult =
  | {
      ok: true;
      analysis: {
        filename: string;
        page_count: number;
        text: string;
        input_truncated: boolean;
        output_truncated: boolean;
      };
    }
  | {
      ok: false;
      error: { message: string; retryable: boolean };
    };

export type KnowledgeDriveFile = {
  token: string;
  name: string;
  version: string;
};

export type KnowledgeDrivePdf = KnowledgeDriveFile & {
  bytes: Buffer;
};

function parseJobContext(value: string): JobContext {
  try {
    return JSON.parse(value) as JobContext;
  } catch {
    throw new Error("Drive file analysis context is invalid");
  }
}

function safeDriveFailureMessage(error: unknown): string | null {
  if (error instanceof LarkAuthError) {
    return "Your Lark Drive connection needs to be refreshed. Start a new folder organization request, authorize once, and then try this file again.";
  }
  if (!(error instanceof DriveToolError)) {
    return safeAnalysisFailureMessage(error);
  }
  switch (error.safeError.code) {
    case "INVALID_FOLDER_LINK":
    case "INVALID_FILE_LINK":
      return error.safeError.message;
    case "ROOT_NOT_ALLOWLISTED":
      return "I can only analyze files stored directly inside the approved folder.";
    case "UNAUTHORIZED":
    case "OAUTH_REQUIRED":
    case "OAUTH_REVOKED":
      return "I can’t access Lark Drive right now. Start a new folder organization request to reconnect it, then try again.";
    case "LIMIT_EXCEEDED":
      return "This PDF is larger than my current 10 MiB limit, or the approved folder contains more items than I can safely process.";
    case "LARK_RETRYABLE":
      return "Lark Drive is temporarily unavailable. Please try again in a moment.";
    case "LARK_PERMANENT":
    case "MALFORMED_RESPONSE":
    case "INCOMPLETE_SCAN":
      return "I couldn’t safely read that PDF from Lark Drive.";
    default:
      return null;
  }
}

function isRetryableDriveFailure(error: unknown): boolean {
  if (error instanceof DriveToolError) {
    return error.safeError.retryable;
  }
  if (error instanceof NimAnalysisError) {
    return error.retryable;
  }
  return error instanceof PdfInputError && error.code === "TIMEOUT";
}

export function formatAnalyzeDriveFileResult(
  result: AnalyzeDriveFileResult,
): string {
  if (!result.ok) {
    return result.error.message;
  }
  return formatPdfAnalysis(
    result.analysis.filename,
    {
      text: "",
      pageCount: result.analysis.page_count,
      truncated: result.analysis.input_truncated,
      pages: [],
    },
    {
      text: result.analysis.text,
      truncated: result.analysis.output_truncated,
    },
  );
}

export class AnalyzeDriveFileWorkflow {
  readonly #queue: DeliveryQueue;
  readonly #cipher: TokenCipher;
  readonly #tokenBroker: AccessTokenProvider;
  readonly #driveReader: DriveReader;
  readonly #downloader: DriveFileDownloader;
  readonly #analyzer: Analyzer;
  readonly #messenger: AttachmentProgressMessenger;
  readonly #rootToken: string;
  readonly #requesterOpenId: string;
  readonly #tenantKey: string;
  readonly #now: () => Date;
  readonly #extractPdf: (bytes: Buffer) => Promise<ExtractedPdf>;

  constructor(options: {
    queue: DeliveryQueue;
    cipher: TokenCipher;
    tokenBroker: AccessTokenProvider;
    driveReader: DriveReader;
    downloader: DriveFileDownloader;
    analyzer: Analyzer;
    messenger: AttachmentProgressMessenger;
    rootToken: string;
    requesterOpenId: string;
    tenantKey: string;
    now?: () => Date;
    extractPdf?: (bytes: Buffer) => Promise<ExtractedPdf>;
  }) {
    this.#queue = options.queue;
    this.#cipher = options.cipher;
    this.#tokenBroker = options.tokenBroker;
    this.#driveReader = options.driveReader;
    this.#downloader = options.downloader;
    this.#analyzer = options.analyzer;
    this.#messenger = options.messenger;
    this.#rootToken = options.rootToken;
    this.#requesterOpenId = options.requesterOpenId;
    this.#tenantKey = options.tenantKey;
    this.#now = options.now ?? (() => new Date());
    this.#extractPdf = options.extractPdf ?? extractPdfText;
  }

  async start(input: {
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    fileLink: string;
  }): Promise<AnalyzeDriveFileStartResult> {
    if (
      input.requesterOpenId !== this.#requesterOpenId ||
      input.tenantKey !== this.#tenantKey
    ) {
      return {
        kind: "rejected",
        replyText: "Drive file analysis isn’t available for this account yet.",
      };
    }
    let fileToken: string;
    try {
      fileToken = parseLarkDriveFileLink(input.fileLink);
      await this.#tokenBroker.getAccessToken(input.requesterOpenId, input.tenantKey);
    } catch (error) {
      return {
        kind: "rejected",
        replyText:
          safeDriveFailureMessage(error) ??
          "I couldn’t safely start this Drive file analysis.",
      };
    }

    const id = randomUUID();
    const context: JobContext = { fileToken, progressMessageId: null };
    const queued = await this.#queue.enqueue({
      id,
      dedupeKey: `${DEDUPE_PREFIX}${input.messageId}`,
      kind: "ANALYZE_DRIVE_FILE",
      chatId: input.chatId,
      payloadCiphertext: encryptDeliveryMessage(
        this.#cipher,
        id,
        JSON.stringify(context),
      ),
      expiresAt: new Date(this.#now().getTime() + ANALYZE_ATTACHMENT_JOB_TTL_MS),
    });
    return queued
      ? { kind: "queued" }
      : {
          kind: "duplicate",
          replyText: "I’m already analyzing the Drive file from that message.",
        };
  }

  async analyzeListedFile(input: {
    requesterOpenId: string;
    tenantKey: string;
    folderLink: string;
    fileName: string;
  }): Promise<AnalyzeDriveFileResult> {
    if (
      input.requesterOpenId !== this.#requesterOpenId ||
      input.tenantKey !== this.#tenantKey
    ) {
      return {
        ok: false,
        error: {
          message: "Drive file analysis is not available for this account.",
          retryable: false,
        },
      };
    }

    try {
      const folderToken = parseLarkDriveFolderLink(input.folderLink);
      requireAllowlistedRoot(folderToken, this.#rootToken);
      const items = await this.#listRoot();
      const matches = items.filter((item) => item.name === input.fileName);
      if (matches.length === 0) {
        throw driveToolError(
          "INVALID_FILE_LINK",
          "No file with that exact name exists in the approved folder root.",
        );
      }
      if (matches.length > 1) {
        throw driveToolError(
          "INVALID_FILE_LINK",
          "More than one root item has that exact name; select an unambiguous PDF.",
        );
      }
      return {
        ok: true,
        analysis: await this.#analyzeResolvedFile(matches[0]),
      };
    } catch (error) {
      const safeMessage = safeDriveFailureMessage(error);
      if (!safeMessage) {
        throw error;
      }
      return {
        ok: false,
        error: {
          message: safeMessage,
          retryable: isRetryableDriveFailure(error),
        },
      };
    }
  }

  async listKnowledgeFiles(input: {
    requesterOpenId: string;
    tenantKey: string;
  }): Promise<KnowledgeDriveFile[]> {
    this.#requirePilotIdentity(input.requesterOpenId, input.tenantKey);
    const items = await this.#listRoot();
    return items
      .filter(
        (item) =>
          item.parentToken === this.#rootToken &&
          item.ownerId === this.#requesterOpenId &&
          item.type === "file" &&
          /\.pdf$/iu.test(item.name) &&
          typeof item.modifiedTime === "string",
      )
      .map((item) => ({
        token: item.token,
        name: item.name,
        version: item.modifiedTime!,
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.token.localeCompare(right.token),
      );
  }

  async readKnowledgeFile(input: {
    requesterOpenId: string;
    tenantKey: string;
    fileToken: string;
    expectedVersion: string;
  }): Promise<KnowledgeDrivePdf> {
    this.#requirePilotIdentity(input.requesterOpenId, input.tenantKey);
    const before = await this.#findKnowledgeFile(
      input.fileToken,
      input.expectedVersion,
    );
    const bytes = await this.#withAccessToken((accessToken) =>
      this.#downloader.download({
        accessToken,
        fileToken: before.token,
        maxBytes: ANALYZE_ATTACHMENT_MAX_BYTES,
      }),
    );
    const after = await this.#findKnowledgeFile(
      input.fileToken,
      input.expectedVersion,
    );
    if (after.name !== before.name) {
      throw driveToolError(
        "INCOMPLETE_SCAN",
        "The Drive PDF changed while it was being read.",
      );
    }
    return { ...after, bytes };
  }

  async process(
    job: DeliveryJob,
    plaintextContext: string | null,
    storeContext: (context: string) => Promise<boolean>,
  ): Promise<void> {
    if (
      job.kind !== "ANALYZE_DRIVE_FILE" ||
      !job.dedupeKey.startsWith(DEDUPE_PREFIX) ||
      !plaintextContext
    ) {
      throw new Error("Drive file analysis job is invalid");
    }
    const context = parseJobContext(plaintextContext);
    let progressId = context.progressMessageId;
    if (!progressId) {
      progressId = await this.#messenger.create(
        job.chatId,
        "Drive PDF received. Preparing a bounded analysis…",
        job.id,
      );
      if (!(await storeContext(JSON.stringify({ ...context, progressMessageId: progressId })))) {
        throw new Error("Drive analysis progress lease was lost");
      }
    }

    try {
      await this.#messenger.update(progressId, "Verifying the PDF in Lark Drive…");
      const result = await this.#analyzeFileToken(
        context.fileToken,
        () => this.#messenger.update(progressId, "Analyzing the extracted text…"),
      );
      await this.#messenger.update(
        progressId,
        formatAnalyzeDriveFileResult({ ok: true, analysis: result }),
      );
    } catch (error) {
      const safeMessage = safeDriveFailureMessage(error);
      if (!safeMessage) {
        throw error;
      }
      await this.#messenger.update(progressId, safeMessage);
    }
  }

  async #analyzeFileToken(
    fileToken: string,
    beforeModelCall?: () => Promise<void>,
  ): Promise<Extract<AnalyzeDriveFileResult, { ok: true }>["analysis"]> {
    const items = await this.#listRoot();
    const matches = items.filter((item) => item.token === fileToken);
    const file = matches.length === 1 ? matches[0] : undefined;
    if (!file) {
      throw driveToolError(
        "ROOT_NOT_ALLOWLISTED",
        "The Drive file is outside the approved pilot root.",
      );
    }
    return this.#analyzeResolvedFile(file, beforeModelCall);
  }

  #listRoot(): Promise<NativeDriveItem[]> {
    return this.#withAccessToken((accessToken) =>
      listFolderCompletely(this.#driveReader, {
        accessToken,
        folderToken: this.#rootToken,
        maxItems: organizeFolderPilotPolicy.maxRootItems,
      }),
    );
  }

  #requirePilotIdentity(requesterOpenId: string, tenantKey: string): void {
    if (
      requesterOpenId !== this.#requesterOpenId ||
      tenantKey !== this.#tenantKey
    ) {
      throw driveToolError(
        "UNAUTHORIZED",
        "Drive knowledge is not available for this account.",
      );
    }
  }

  async #findKnowledgeFile(
    fileToken: string,
    expectedVersion: string,
  ): Promise<KnowledgeDriveFile> {
    const file = (await this.listKnowledgeFiles({
      requesterOpenId: this.#requesterOpenId,
      tenantKey: this.#tenantKey,
    })).find((candidate) => candidate.token === fileToken);
    if (!file || file.version !== expectedVersion) {
      throw driveToolError(
        "INCOMPLETE_SCAN",
        "The Drive PDF no longer matches the approved knowledge snapshot.",
      );
    }
    return file;
  }

  async #analyzeResolvedFile(
    file: NativeDriveItem,
    beforeModelCall?: () => Promise<void>,
  ): Promise<Extract<AnalyzeDriveFileResult, { ok: true }>["analysis"]> {
    if (
      file.parentToken !== this.#rootToken ||
      file.ownerId !== this.#requesterOpenId
    ) {
      throw driveToolError(
        "ROOT_NOT_ALLOWLISTED",
        "The Drive file is outside the approved pilot root.",
      );
    }
    if (file.type !== "file" || !/\.pdf$/iu.test(file.name)) {
      throw driveToolError(
        "INVALID_FILE_LINK",
        "Only ordinary PDF files are supported.",
      );
    }

    const bytes = await this.#withAccessToken((accessToken) =>
      this.#downloader.download({
        accessToken,
        fileToken: file.token,
        maxBytes: ANALYZE_ATTACHMENT_MAX_BYTES,
      }),
    );
    const pdf = await this.#extractPdf(bytes);
    await beforeModelCall?.();
    const analysis = await this.#analyzer.analyze({
      filename: file.name,
      text: pdf.text,
    });
    return {
      filename: file.name,
      page_count: pdf.pageCount,
      text: analysis.text,
      input_truncated: pdf.truncated,
      output_truncated: analysis.truncated,
    };
  }

  async #withAccessToken<Result>(
    operation: (accessToken: string) => Promise<Result>,
  ): Promise<Result> {
    const accessToken = await this.#tokenBroker.getAccessToken(
      this.#requesterOpenId,
      this.#tenantKey,
    );
    const recovered = await withReadOnlyDriveTokenRecovery(
      {
        accessToken,
        recoverAccessToken: (rejectedAccessToken) =>
          this.#tokenBroker.recoverAccessToken(
            this.#requesterOpenId,
            this.#tenantKey,
            rejectedAccessToken,
          ),
        markAccessTokenRejected: (rejectedAccessToken) =>
          this.#tokenBroker.markAccessTokenRejected(
            this.#requesterOpenId,
            this.#tenantKey,
            rejectedAccessToken,
          ),
      },
      operation,
    );
    return recovered.result;
  }
}
