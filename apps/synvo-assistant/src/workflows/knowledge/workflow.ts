import { createHash, randomUUID } from "node:crypto";

import { encryptDeliveryMessage } from "../../delivery/crypto.js";
import type { DeliveryJob, DeliveryQueue } from "../../delivery/repository.js";
import type { TokenCipher } from "../../lark/auth/index.js";
import { LarkAttachmentError, type LarkAttachmentClient } from "../../lark/attachment.js";
import { DriveToolError, driveToolError } from "../../lark/drive/index.js";
import type {
  KnowledgeDriveFile,
  AuthorizedDrivePdfReader,
} from "../analyze-drive-file/authorized-reader.js";
import {
  extractPdfText,
  PdfInputError,
  type ExtractedPdf,
} from "../analyze-attachment/pdf.js";
import { chunkPdfForKnowledge } from "./chunking.js";
import {
  KNOWLEDGE_EMBEDDING_BATCH_SIZE,
  KNOWLEDGE_JOB_TTL_MS,
  KNOWLEDGE_MAX_EVIDENCE_CODE_POINTS,
  KNOWLEDGE_MAX_QUESTION_CODE_POINTS,
  KNOWLEDGE_SEARCH_MIN_SIMILARITY,
  KNOWLEDGE_SEARCH_TOP_K,
  KNOWLEDGE_REFRESH_SNAPSHOT_MAX_CODE_UNITS,
} from "./policy.js";
import {
  type KnowledgeRepository,
  type KnowledgeScope,
  type KnowledgeSearchHit,
  type KnowledgeSource,
  type KnowledgeSourceKind,
} from "./repository.js";
import {
  VoyageEmbeddingError,
  type VoyageEmbeddingClient,
  type VoyageEmbeddingHooks,
  type VoyageEmbeddingProgress,
} from "./voyage-client.js";

const JOB_PREFIX = "knowledge:";
const REFRESH_SNAPSHOT_AAD = "synvo-knowledge-refresh-snapshot:v1";
const SOURCE_REFERENCE_AAD = "synvo-knowledge-source-reference:v1";
const REFRESH_SNAPSHOT_TTL_MS = 10 * 60_000;

type AttachmentReader = Pick<LarkAttachmentClient, "downloadPdf">;
type DriveKnowledgeReader = Pick<
  AuthorizedDrivePdfReader,
  "listKnowledgeFiles" | "readKnowledgeFile"
>;
type Embedder = Pick<VoyageEmbeddingClient, "embedDocuments" | "embedQuery">;
type KnowledgeStore = Pick<
  KnowledgeRepository,
  "replaceSource" | "listSources" | "deleteSource" | "updateSourceName" | "search"
>;

export type KnowledgeProgress = {
  stage:
    | "ingesting"
    | "refreshing"
    | "stopping"
    | "stopped"
    | "answering"
    | "complete"
    | "failed";
  message: string;
  sourceName?: string;
  sourceReference?: string;
  answer?: KnowledgeAnswer;
  jobId?: string;
  completedFiles?: number;
  totalFiles?: number;
  currentFile?: string;
  chunkCount?: number;
  completedBatches?: number;
  totalBatches?: number;
};

export type KnowledgeAnswer = {
  supported: boolean;
  answer: string;
  citations: Array<{ sourceName: string; pageNumber: number }>;
};

export type KnowledgeRefreshProposal = {
  files: Array<{ name: string }>;
  pathUpdates: Array<{ name: string; previousName: string }>;
  removedSources: Array<{ name: string }>;
  hasChanges: boolean;
  snapshot: string;
};

export type GroundedAnswerer = {
  answerGrounded(input: {
    question: string;
    evidence: Array<{
      label: string;
      text: string;
    }>;
  }): Promise<{ supported: boolean; answer: string; citations: string[] }>;
};

export type KnowledgeMessenger = {
  create(
    chatId: string,
    progress: KnowledgeProgress,
    idempotencyKey: string,
  ): Promise<string>;
  update(messageId: string, progress: KnowledgeProgress): Promise<void>;
};

type KnowledgeJobContext =
  | {
      operation: "ingest_attachment";
      sourceMessageId: string;
      progressMessageId: string | null;
    }
  | {
      operation: "refresh_drive";
      observedFiles: KnowledgeDriveFile[] | null;
      files: KnowledgeDriveFile[];
      pathUpdates: KnowledgeDriveFile[];
      removedSourceKeys: string[];
      progressMessageId: string | null;
    }
  | {
      operation: "question";
      question: string;
      progressMessageId: string | null;
    };

type RefreshSnapshot = {
  tenantKey: string;
  userOpenId: string;
  workspaceFolderToken: string;
  expiresAt: string;
  observedFiles: KnowledgeDriveFile[];
  files: KnowledgeDriveFile[];
  pathUpdates: KnowledgeDriveFile[];
  removedSourceKeys: string[];
};

type SourceReference = KnowledgeScope & {
  sourceKind: KnowledgeSourceKind;
  sourceKey: string;
};

type EnqueuedKnowledgeJob = {
  queued: boolean;
  jobId: string;
};

type RefreshStopResult = "requested" | "stopped" | "terminal" | "unauthorized";

class KnowledgeUpdateStopped extends Error {
  constructor() {
    super("Knowledge update stopped");
    this.name = "KnowledgeUpdateStopped";
  }
}

function parseJobContext(value: string | null): KnowledgeJobContext {
  if (!value) {
    throw new Error("Knowledge job context is missing");
  }
  try {
    const parsed = JSON.parse(value) as KnowledgeJobContext & {
      observedFiles?: KnowledgeDriveFile[];
      pathUpdates?: KnowledgeDriveFile[];
    };
    return parsed.operation === "refresh_drive"
      ? {
          ...parsed,
          observedFiles: parsed.observedFiles ?? null,
          pathUpdates: parsed.pathUpdates ?? [],
        }
      : parsed;
  } catch {
    throw new Error("Knowledge job context is invalid");
  }
}

function codePointSlice(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join("");
}

function isRetryable(error: unknown): boolean {
  return (
    (error instanceof VoyageEmbeddingError && error.retryable) ||
    (error instanceof LarkAttachmentError && error.retryable) ||
    (error instanceof DriveToolError && error.safeError.retryable)
  );
}

function failureCategory(error: unknown): string {
  if (error instanceof VoyageEmbeddingError) {
    return `VOYAGE_${error.category}`;
  }
  if (error instanceof LarkAttachmentError) {
    return error.retryable ? "LARK_ATTACHMENT_TEMPORARY" : "LARK_ATTACHMENT_REJECTED";
  }
  if (error instanceof DriveToolError) {
    return `LARK_DRIVE_${error.safeError.code}`;
  }
  if (error instanceof PdfInputError) {
    return `PDF_${error.code}`;
  }
  return "INTERNAL";
}

export class KnowledgeWorkflow {
  readonly #queue: DeliveryQueue;
  readonly #cipher: TokenCipher;
  readonly #repository: KnowledgeStore;
  readonly #embedder: Embedder;
  readonly #attachmentReader: AttachmentReader;
  readonly #driveReader: DriveKnowledgeReader;
  readonly #answerer: GroundedAnswerer;
  readonly #messenger: KnowledgeMessenger;
  readonly #scope: KnowledgeScope;
  readonly #verifyWorkspace: () => Promise<boolean>;
  readonly #now: () => Date;
  readonly #extractPdf: (bytes: Buffer) => Promise<ExtractedPdf>;

  constructor(options: {
    queue: DeliveryQueue;
    cipher: TokenCipher;
    repository: KnowledgeStore;
    embedder: Embedder;
    attachmentReader: AttachmentReader;
    driveReader: DriveKnowledgeReader;
    answerer: GroundedAnswerer;
    messenger: KnowledgeMessenger;
    scope: KnowledgeScope;
    verifyWorkspace: () => Promise<boolean>;
    now?: () => Date;
    extractPdf?: (bytes: Buffer) => Promise<ExtractedPdf>;
  }) {
    this.#queue = options.queue;
    this.#cipher = options.cipher;
    this.#repository = options.repository;
    this.#embedder = options.embedder;
    this.#attachmentReader = options.attachmentReader;
    this.#driveReader = options.driveReader;
    this.#answerer = options.answerer;
    this.#messenger = options.messenger;
    this.#scope = options.scope;
    this.#verifyWorkspace = options.verifyWorkspace;
    this.#now = options.now ?? (() => new Date());
    this.#extractPdf = options.extractPdf ?? extractPdfText;
  }

  async enqueueAttachment(input: {
    sourceMessageId: string;
    cardMessageId: string;
    chatId: string;
  }): Promise<boolean> {
    return (await this.#enqueue(
      `${JOB_PREFIX}attachment:${input.sourceMessageId}`,
      input.chatId,
      {
        operation: "ingest_attachment",
        sourceMessageId: input.sourceMessageId,
        progressMessageId: input.cardMessageId,
      },
    )).queued;
  }

  async enqueueQuestion(input: {
    messageId: string;
    chatId: string;
    question: string;
    progressMessageId?: string;
  }): Promise<boolean> {
    const question = codePointSlice(input.question.trim(), KNOWLEDGE_MAX_QUESTION_CODE_POINTS);
    if (!question) {
      return false;
    }
    return (await this.#enqueue(
      `${JOB_PREFIX}question:${input.messageId}`,
      input.chatId,
      {
        operation: "question",
        question,
        progressMessageId: input.progressMessageId ?? null,
      },
    )).queued;
  }

  async proposeRefresh(): Promise<KnowledgeRefreshProposal> {
    const [files, stored] = await Promise.all([
      this.#driveReader.listKnowledgeFiles({
        requesterOpenId: this.#scope.userOpenId,
        tenantKey: this.#scope.tenantKey,
      }),
      this.#repository.listSources(this.#scope),
    ]);
    const storedDrive = stored.filter((source) => source.sourceKind === "drive_file");
    const storedByKey = new Map(storedDrive.map((source) => [source.sourceKey, source]));
    const changed = files.filter(
      (file) => storedByKey.get(file.token)?.sourceVersionOrHash !== file.version,
    );
    const pathUpdates = files.filter((file) => {
      const source = storedByKey.get(file.token);
      return (
        source?.sourceVersionOrHash === file.version &&
        source.sourceName !== file.name
      );
    });
    const present = new Set(files.map((file) => file.token));
    const removedSources = storedDrive.filter(
      (source) => !present.has(source.sourceKey),
    );
    const removedSourceKeys = removedSources.map((source) => source.sourceKey);
    const snapshot: RefreshSnapshot = {
      ...this.#scope,
      expiresAt: new Date(this.#now().getTime() + REFRESH_SNAPSHOT_TTL_MS).toISOString(),
      observedFiles: files,
      files: changed,
      pathUpdates,
      removedSourceKeys,
    };
    // Defends native Drive tokens in the Lark card payload while binding approval to one exact snapshot.
    const encrypted = this.#cipher.encrypt(
      JSON.stringify(snapshot),
      REFRESH_SNAPSHOT_AAD,
    );
    if (encrypted.length > KNOWLEDGE_REFRESH_SNAPSHOT_MAX_CODE_UNITS) {
      throw driveToolError(
        "LIMIT_EXCEEDED",
        "The workspace knowledge review exceeds the safe Lark card limit.",
      );
    }
    return {
      files: changed.map((file) => ({ name: file.name })),
      pathUpdates: pathUpdates.map((file) => ({
        name: file.name,
        previousName: storedByKey.get(file.token)!.sourceName,
      })),
      removedSources: removedSources.map((source) => ({
        name: source.sourceName,
      })),
      hasChanges:
        changed.length > 0 ||
        pathUpdates.length > 0 ||
        removedSourceKeys.length > 0,
      snapshot: encrypted,
    };
  }

  async enqueueRefresh(input: {
    messageId: string;
    chatId: string;
    snapshot: string;
  }): Promise<EnqueuedKnowledgeJob & { totalFiles: number }> {
    const parsed = this.#readRefreshSnapshot(input.snapshot);
    const observedFiles = await this.#driveReader.listKnowledgeFiles({
      requesterOpenId: this.#scope.userOpenId,
      tenantKey: this.#scope.tenantKey,
    });
    if (!this.#sameKnowledgeFiles(parsed.observedFiles, observedFiles)) {
      throw new Error("The workspace changed after the knowledge review");
    }
    const approvalId = createHash("sha256")
      .update(input.snapshot)
      .digest("hex");
    const enqueued = await this.#enqueue(
      `${JOB_PREFIX}refresh:${approvalId}`,
      input.chatId,
      {
        operation: "refresh_drive",
        observedFiles: parsed.observedFiles,
        files: parsed.files,
        pathUpdates: parsed.pathUpdates,
        removedSourceKeys: parsed.removedSourceKeys,
        progressMessageId: input.messageId,
      },
    );
    return {
      ...enqueued,
      totalFiles: parsed.files.length + parsed.pathUpdates.length,
    };
  }

  requestRefreshStop(input: {
    jobId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
  }): Promise<RefreshStopResult> {
    if (
      input.requesterOpenId !== this.#scope.userOpenId ||
      input.tenantKey !== this.#scope.tenantKey
    ) {
      return Promise.resolve("unauthorized");
    }
    return this.#queue.requestCancellation({
      jobId: input.jobId,
      chatId: input.chatId,
    });
  }

  async removeSource(sourceReference: string): Promise<boolean> {
    const source = this.#readSourceReference(sourceReference);
    return this.#repository.deleteSource(
      this.#scope,
      source.sourceKind,
      source.sourceKey,
    );
  }

  async searchWorkspace(question: string): Promise<KnowledgeAnswer> {
    const boundedQuestion = codePointSlice(
      question.trim(),
      KNOWLEDGE_MAX_QUESTION_CODE_POINTS,
    );
    if (!boundedQuestion) {
      return this.#unsupportedAnswer();
    }
    if (!(await this.#verifyWorkspace())) {
      return this.#unsupportedAnswer(
        "I couldn’t verify the active workspace, so I didn’t search its knowledge vault.",
      );
    }
    const embedding = await this.#embedder.embedQuery(boundedQuestion);
    const hits = await this.#repository.search({
      scope: this.#scope,
      embedding,
      limit: KNOWLEDGE_SEARCH_TOP_K,
      minimumSimilarity: KNOWLEDGE_SEARCH_MIN_SIMILARITY,
    });
    const evidence = this.#boundEvidence(hits);
    if (evidence.length === 0) {
      return this.#unsupportedAnswer();
    }
    const result = await this.#answerer.answerGrounded({
      question: boundedQuestion,
      evidence: evidence.map((hit, index) => ({
        label: `S${index + 1}`,
        text: hit.text,
      })),
    });
    if (!result.supported) {
      return this.#unsupportedAnswer(result.answer);
    }
    const labels = new Map<string, KnowledgeSearchHit>(
      evidence.map((hit, index) => [`S${index + 1}`, hit] as const),
    );
    const cited = [...new Set(result.citations)]
      .map((label) => labels.get(label))
      .filter((hit): hit is KnowledgeSearchHit => Boolean(hit));
    if (cited.length === 0) {
      throw new Error("Grounded answer has no valid citation");
    }
    return {
      supported: true,
      answer: result.answer,
      citations: cited.map((hit) => ({
        sourceName: hit.sourceName,
        pageNumber: hit.pageNumber,
      })),
    };
  }

  async process(
    job: DeliveryJob,
    plaintextContext: string | null,
    storeContext: (context: string) => Promise<boolean>,
    finalAttempt: boolean,
  ): Promise<void> {
    if (job.kind !== "KNOWLEDGE" || !job.dedupeKey.startsWith(JOB_PREFIX)) {
      throw new Error("Knowledge job is invalid");
    }
    let context = parseJobContext(plaintextContext);
    let progressId = context.progressMessageId;
    const initial = context.operation === "ingest_attachment"
      ? { stage: "ingesting" as const, message: "Reading the approved PDF → creating searchable chunks → updating the vault" }
      : context.operation === "refresh_drive"
        ? {
            stage: "refreshing" as const,
            message: "Reading the approved PDFs → refreshing searchable knowledge",
            jobId: job.id,
            completedFiles: 0,
            totalFiles: context.files.length + context.pathUpdates.length,
          }
        : { stage: "answering" as const, message: "Finding the most relevant evidence and preparing a cited answer" };
    if (
      context.operation === "refresh_drive" &&
      await this.#queue.isCancellationRequested(job)
    ) {
      await this.#updateStoppedProgress(context, progressId, job);
      return;
    }
    if (!progressId) {
      progressId = await this.#messenger.create(job.chatId, initial, job.id);
      context = { ...context, progressMessageId: progressId };
      if (!(await storeContext(JSON.stringify(context)))) {
        throw new Error("Knowledge progress lease was lost");
      }
    } else {
      await this.#messenger.update(progressId, initial);
    }

    try {
      if (context.operation === "ingest_attachment") {
        if (!(await this.#verifyWorkspace())) {
          throw new Error("Active workspace could not be verified");
        }
        await this.#ingestAttachment(context.sourceMessageId, job.chatId, progressId);
      } else if (context.operation === "refresh_drive") {
        await this.#refreshDrive(job, context, progressId);
      } else {
        const answer = await this.searchWorkspace(context.question);
        await this.#messenger.update(progressId, {
          stage: "complete",
          message: answer.answer,
          answer,
        });
      }
    } catch (error) {
      if (
        context.operation === "refresh_drive" &&
        (error instanceof KnowledgeUpdateStopped ||
          await this.#queue.isCancellationRequested(job))
      ) {
        await this.#updateStoppedProgress(context, progressId, job);
        return;
      }
      console.warn(
        `[knowledge] operation=${context.operation} failed category=${failureCategory(error)}`,
      );
      if (isRetryable(error) && !finalAttempt) {
        throw error;
      }
      await this.#messenger.update(progressId, {
        stage: "failed",
        message: "I couldn’t complete that knowledge task safely. Nothing was changed in Lark Drive. Please try again.",
      });
    }
  }

  async #enqueue(
    dedupeKey: string,
    chatId: string,
    context: KnowledgeJobContext,
  ): Promise<EnqueuedKnowledgeJob> {
    const id = randomUUID();
    const queued = await this.#queue.enqueue({
      id,
      dedupeKey,
      kind: "KNOWLEDGE",
      chatId,
      payloadCiphertext: encryptDeliveryMessage(
        this.#cipher,
        id,
        JSON.stringify(context),
      ),
      expiresAt: new Date(this.#now().getTime() + KNOWLEDGE_JOB_TTL_MS),
    });
    return { queued, jobId: id };
  }

  async #ingestAttachment(
    sourceMessageId: string,
    chatId: string,
    progressMessageId: string,
  ): Promise<void> {
    const file = await this.#attachmentReader.downloadPdf({
      messageId: sourceMessageId,
      chatId,
      requesterOpenId: this.#scope.userOpenId,
      tenantKey: this.#scope.tenantKey,
    });
    const version = createHash("sha256").update(file.bytes).digest("hex");
    const result = await this.#indexPdf({
      sourceKind: "chat_attachment",
      sourceKey: sourceMessageId,
      sourceName: file.filename,
      sourceVersionOrHash: version,
      bytes: file.bytes,
    });
    const sourceReference = this.#encodeSourceReference({
      ...this.#scope,
      sourceKind: "chat_attachment",
      sourceKey: sourceMessageId,
    });
    await this.#messenger.update(progressMessageId, {
      stage: "complete",
      message: result === "unchanged"
        ? `**${file.filename}** was already current in workspace knowledge.`
        : `**${file.filename}** is now searchable in the active workspace knowledge vault.`,
      sourceName: file.filename,
      sourceReference,
    });
  }

  async #refreshDrive(
    job: DeliveryJob,
    context: Extract<KnowledgeJobContext, { operation: "refresh_drive" }>,
    progressMessageId: string,
  ): Promise<void> {
    if (context.observedFiles) {
      const observed = await this.#driveReader.listKnowledgeFiles({
        requesterOpenId: this.#scope.userOpenId,
        tenantKey: this.#scope.tenantKey,
      });
      if (!this.#sameKnowledgeFiles(context.observedFiles, observed)) {
        throw new Error("The workspace changed after the knowledge update was approved");
      }
    }
    const currentSources = await this.#storedDriveSources();
    const totalFiles = context.files.length + context.pathUpdates.length;
    const isCurrent = (file: KnowledgeDriveFile): boolean => {
      const source = currentSources.get(file.token);
      return (
        source?.sourceVersionOrHash === file.version &&
        source.sourceName === file.name
      );
    };
    let completedFiles = [...context.files, ...context.pathUpdates].filter(
      isCurrent,
    ).length;
    let indexed = 0;
    let pathsUpdated = 0;
    await this.#messenger.update(progressMessageId, {
      stage: "refreshing",
      message: "Reading the approved PDFs → refreshing searchable knowledge",
      jobId: job.id,
      completedFiles,
      totalFiles,
    });
    for (const file of context.files) {
      if (isCurrent(file)) {
        continue;
      }
      await this.#assertRefreshRunning(job);
      const downloaded = await this.#driveReader.readKnowledgeFile({
        requesterOpenId: this.#scope.userOpenId,
        tenantKey: this.#scope.tenantKey,
        fileToken: file.token,
        expectedVersion: file.version,
        expectedName: file.name,
      });
      let currentChunkCount = 0;
      await this.#indexPdf({
        sourceKind: "drive_file",
        sourceKey: downloaded.token,
        sourceName: downloaded.name,
        sourceVersionOrHash: downloaded.version,
        bytes: downloaded.bytes,
        beforeEmbeddingBatch: () =>
          this.#assertRefreshRunning(job),
        onChunksReady: async (chunkCount, totalBatches) => {
          currentChunkCount = chunkCount;
          await this.#messenger.update(progressMessageId, {
            stage: "refreshing",
            message: "Creating and embedding searchable chunks",
            jobId: job.id,
            completedFiles,
            totalFiles,
            currentFile: downloaded.name,
            chunkCount,
            completedBatches: 0,
            totalBatches,
          });
        },
        onEmbeddingProgress: async ({ completedBatches, totalBatches }) => {
          await this.#messenger.update(progressMessageId, {
            stage: "refreshing",
            message: "Creating and embedding searchable chunks",
            jobId: job.id,
            completedFiles,
            totalFiles,
            currentFile: downloaded.name,
            chunkCount: currentChunkCount,
            completedBatches,
            totalBatches,
          });
        },
      });
      indexed += 1;
      currentSources.set(downloaded.token, {
        sourceKind: "drive_file",
        sourceKey: downloaded.token,
        sourceName: downloaded.name,
        sourceVersionOrHash: downloaded.version,
      });
      completedFiles += 1;
      await this.#messenger.update(progressMessageId, {
        stage: "refreshing",
        message: "Reading the approved PDFs → refreshing searchable knowledge",
        jobId: job.id,
        completedFiles,
        totalFiles,
      });
    }
    if (context.pathUpdates.length > 0) {
      await this.#assertRefreshRunning(job);
      const observed = new Map(
        (await this.#driveReader.listKnowledgeFiles({
          requesterOpenId: this.#scope.userOpenId,
          tenantKey: this.#scope.tenantKey,
        })).map((file) => [file.token, file]),
      );
      for (const file of context.pathUpdates) {
        if (isCurrent(file)) {
          continue;
        }
        await this.#assertRefreshRunning(job);
        const current = observed.get(file.token);
        if (
          !current ||
          current.version !== file.version ||
          current.name !== file.name
        ) {
          throw new Error("A Drive PDF path changed after approval");
        }
        if (
          !(await this.#repository.updateSourceName({
            scope: this.#scope,
            sourceKind: "drive_file",
            sourceKey: file.token,
            sourceVersionOrHash: file.version,
            sourceName: file.name,
          }))
        ) {
          throw new Error("The indexed Drive PDF no longer matches the approved path update");
        }
        currentSources.set(file.token, {
          sourceKind: "drive_file",
          sourceKey: file.token,
          sourceName: file.name,
          sourceVersionOrHash: file.version,
        });
        pathsUpdated += 1;
        completedFiles += 1;
        await this.#messenger.update(progressMessageId, {
          stage: "refreshing",
          message: "Updating verified PDF paths without reprocessing content",
          jobId: job.id,
          completedFiles,
          totalFiles,
          currentFile: file.name,
        });
      }
    }
    await this.#assertRefreshRunning(job);
    const finalObserved = await this.#driveReader.listKnowledgeFiles({
      requesterOpenId: this.#scope.userOpenId,
      tenantKey: this.#scope.tenantKey,
    });
    if (
      context.observedFiles &&
      !this.#sameKnowledgeFiles(context.observedFiles, finalObserved)
    ) {
      throw new Error("The workspace changed while knowledge was being updated");
    }
    const present = new Set(finalObserved.map((file) => file.token));
    let removed = 0;
    for (const sourceKey of context.removedSourceKeys) {
      await this.#assertRefreshRunning(job);
      if (present.has(sourceKey)) {
        throw new Error("A removed Drive source reappeared before reconciliation");
      }
      if (
        await this.#repository.deleteSource(
          this.#scope,
          "drive_file",
          sourceKey,
        )
      ) {
        removed += 1;
      }
    }
    await this.#messenger.update(progressMessageId, {
      stage: "complete",
      message: `Workspace knowledge is current. Added or refreshed: **${indexed}**. Paths updated without reprocessing: **${pathsUpdated}**. Removed unavailable Drive sources: **${removed}**.`,
      completedFiles: totalFiles,
      totalFiles,
    });
  }

  async #indexPdf(input: {
    sourceKind: KnowledgeSourceKind;
    sourceKey: string;
    sourceName: string;
    sourceVersionOrHash: string;
    bytes: Buffer;
    beforeEmbeddingBatch?: VoyageEmbeddingHooks["beforeBatch"];
    onChunksReady?: (chunkCount: number, totalBatches: number) => Promise<void>;
    onEmbeddingProgress?: (progress: VoyageEmbeddingProgress) => Promise<void>;
  }): Promise<"replaced" | "unchanged"> {
    const pdf = await this.#extractPdf(input.bytes);
    const chunks = chunkPdfForKnowledge(pdf);
    const totalBatches = Math.ceil(
      chunks.length / KNOWLEDGE_EMBEDDING_BATCH_SIZE,
    );
    await input.onChunksReady?.(chunks.length, totalBatches);
    const embeddings = await this.#embedder.embedDocuments(
      chunks.map((chunk) => chunk.text),
      {
        beforeBatch: input.beforeEmbeddingBatch,
        onBatchComplete: input.onEmbeddingProgress,
      },
    );
    return this.#repository.replaceSource({
      scope: this.#scope,
      sourceKind: input.sourceKind,
      sourceKey: input.sourceKey,
      sourceName: input.sourceName,
      sourceVersionOrHash: input.sourceVersionOrHash,
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        embedding: embeddings[index]!,
      })),
    });
  }

  async #assertRefreshRunning(job: DeliveryJob): Promise<void> {
    if (await this.#queue.isCancellationRequested(job)) {
      throw new KnowledgeUpdateStopped();
    }
  }

  async #updateStoppedProgress(
    context: Extract<KnowledgeJobContext, { operation: "refresh_drive" }>,
    progressMessageId: string | null,
    job: DeliveryJob,
  ): Promise<void> {
    if (!progressMessageId) {
      return;
    }
    const sources = await this.#storedDriveSources();
    const allFiles = [...context.files, ...context.pathUpdates];
    const completedFiles = allFiles.filter((file) => {
      const source = sources.get(file.token);
      return (
        source?.sourceVersionOrHash === file.version &&
        source.sourceName === file.name
      );
    }).length;
    const totalFiles = allFiles.length;
    await this.#messenger.update(progressMessageId, {
      stage: "stopped",
      message: [
        "The knowledge update stopped safely.",
        "",
        `Completed: **${completedFiles} files**`,
        `Not processed: **${Math.max(0, totalFiles - completedFiles)} files**`,
        "",
        "Select **Resume update** to review and continue the remaining work.",
      ].join("\n"),
      jobId: job.id,
      completedFiles,
      totalFiles,
    });
  }

  #readRefreshSnapshot(ciphertext: string): RefreshSnapshot {
    let snapshot: RefreshSnapshot;
    try {
      snapshot = JSON.parse(
        this.#cipher.decrypt(ciphertext, REFRESH_SNAPSHOT_AAD),
      ) as RefreshSnapshot;
    } catch {
      throw new Error("Knowledge refresh approval is invalid");
    }
    if (
      snapshot.tenantKey !== this.#scope.tenantKey ||
      snapshot.userOpenId !== this.#scope.userOpenId ||
      snapshot.workspaceFolderToken !== this.#scope.workspaceFolderToken ||
      new Date(snapshot.expiresAt).getTime() <= this.#now().getTime() ||
      !Array.isArray(snapshot.observedFiles) ||
      !Array.isArray(snapshot.files) ||
      !Array.isArray(snapshot.pathUpdates) ||
      !Array.isArray(snapshot.removedSourceKeys) ||
      !snapshot.observedFiles.every((file) => this.#isKnowledgeFile(file)) ||
      !snapshot.files.every((file) => this.#isKnowledgeFile(file)) ||
      !snapshot.pathUpdates.every((file) => this.#isKnowledgeFile(file)) ||
      !snapshot.removedSourceKeys.every((key) => typeof key === "string" && key.length > 0)
    ) {
      throw new Error("Knowledge refresh approval is expired or unauthorized");
    }
    return snapshot;
  }

  #isKnowledgeFile(value: unknown): value is KnowledgeDriveFile {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const file = value as Partial<KnowledgeDriveFile>;
    return (
      typeof file.token === "string" &&
      file.token.length > 0 &&
      typeof file.name === "string" &&
      file.name.length > 0 &&
      typeof file.version === "string" &&
      file.version.length > 0
    );
  }

  async #storedDriveSources(): Promise<Map<string, KnowledgeSource>> {
    return new Map(
      (await this.#repository.listSources(this.#scope))
        .filter((source) => source.sourceKind === "drive_file")
        .map((source) => [source.sourceKey, source]),
    );
  }

  #sameKnowledgeFiles(
    expected: KnowledgeDriveFile[],
    observed: KnowledgeDriveFile[],
  ): boolean {
    if (expected.length !== observed.length) {
      return false;
    }
    return expected.every((file, index) => {
      const current = observed[index];
      return (
        current?.token === file.token &&
        current.name === file.name &&
        current.version === file.version
      );
    });
  }

  #encodeSourceReference(source: SourceReference): string {
    return this.#cipher.encrypt(JSON.stringify(source), SOURCE_REFERENCE_AAD);
  }

  #readSourceReference(ciphertext: string): SourceReference {
    let source: SourceReference;
    try {
      source = JSON.parse(
        this.#cipher.decrypt(ciphertext, SOURCE_REFERENCE_AAD),
      ) as SourceReference;
    } catch {
      throw new Error("Knowledge source reference is invalid");
    }
    if (
      source.tenantKey !== this.#scope.tenantKey ||
      source.userOpenId !== this.#scope.userOpenId ||
      source.workspaceFolderToken !== this.#scope.workspaceFolderToken ||
      !new Set<KnowledgeSourceKind>(["drive_file", "chat_attachment"]).has(
        source.sourceKind,
      ) ||
      !source.sourceKey
    ) {
      throw new Error("Knowledge source reference is unauthorized");
    }
    return source;
  }

  #boundEvidence(hits: KnowledgeSearchHit[]): KnowledgeSearchHit[] {
    const result: KnowledgeSearchHit[] = [];
    let used = 0;
    for (const hit of hits) {
      const length = Array.from(hit.text).length;
      if (used + length > KNOWLEDGE_MAX_EVIDENCE_CODE_POINTS) {
        break;
      }
      result.push(hit);
      used += length;
    }
    return result;
  }

  #unsupportedAnswer(message?: string): KnowledgeAnswer {
    return {
      supported: false,
      answer:
        message?.trim() ||
        "The current workspace knowledge does not contain enough evidence to answer that question.",
      citations: [],
    };
  }
}
