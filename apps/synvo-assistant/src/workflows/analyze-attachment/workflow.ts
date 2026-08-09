import { randomUUID } from "node:crypto";

import type { DeliveryJob, DeliveryQueue } from "../../delivery/repository.js";
import {
  LarkAttachmentError,
  type LarkAttachmentClient,
} from "../../lark/attachment.js";
import { NimAnalysisError, type NvidiaNimClient } from "./nim-client.js";
import { extractPdfText, PdfInputError, type ExtractedPdf } from "./pdf.js";
import { ANALYZE_ATTACHMENT_JOB_TTL_MS } from "./policy.js";

const DEDUPE_PREFIX = "analyze-attachment:";

export type AttachmentProgressMessenger = {
  create(chatId: string, text: string, idempotencyKey: string): Promise<string>;
  update(messageId: string, text: string): Promise<void>;
};

type AttachmentReader = Pick<LarkAttachmentClient, "downloadPdf">;
type AttachmentAnalyzer = Pick<NvidiaNimClient, "analyze">;

// Defends the Lark conversation against control characters in an untrusted filename.
function safeFilename(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 255) || "PDF attachment";
}

export function safeAnalysisFailureMessage(error: unknown): string | null {
  if (error instanceof LarkAttachmentError) {
    switch (error.code) {
      case "INVALID_MESSAGE":
        return "I couldn't verify that this PDF belongs to the triggering Lark message. Please send the PDF directly to the bot again.";
      case "PERMISSION_DENIED":
        return "The assistant needs the approved Lark message-read permission before it can analyze attachments. Please contact the app administrator.";
      case "UNSUPPORTED_FILE":
        return "This pilot supports one text-based PDF sent directly to the bot.";
      case "TOO_LARGE":
        return "This PDF exceeds the 10 MiB pilot limit.";
      case "TIMEOUT":
      case "UNAVAILABLE":
        return "Lark could not provide this attachment right now. Please send it again later.";
    }
  }
  if (error instanceof PdfInputError) {
    switch (error.code) {
      case "ENCRYPTED":
        return "Encrypted PDFs are not supported in this pilot.";
      case "TOO_MANY_PAGES":
        return "This PDF exceeds the 50-page pilot limit.";
      case "NO_TEXT":
        return "I couldn't find extractable text in this PDF. OCR and image-only PDFs are not supported yet.";
      case "TIMEOUT":
        return "PDF extraction timed out. No document content was retained.";
      case "MALFORMED":
        return "I couldn't safely read this PDF. Please send a valid text-based PDF.";
    }
  }
  if (error instanceof NimAnalysisError) {
    switch (error.code) {
      case "UNAUTHORIZED":
        return "Document analysis is temporarily unavailable because the model credential needs attention.";
      case "RATE_LIMITED":
      case "TIMEOUT":
      case "UNAVAILABLE":
        return "Document analysis is temporarily unavailable. Please try again later.";
      case "INVALID_RESPONSE":
        return "The model did not return a usable analysis. Please try again later.";
    }
  }
  return null;
}

export function formatPdfAnalysis(
  filename: string,
  pdf: ExtractedPdf,
  analysis: { text: string; truncated: boolean },
): string {
  const limitations: string[] = [];
  if (pdf.truncated) {
    limitations.push("Analysis used only the first 100,000 extracted characters.");
  }
  if (analysis.truncated) {
    limitations.push("The model response reached the configured output limit.");
  }
  const limitationText = limitations.length > 0
    ? `\n\nLimitations:\n${limitations.map((item) => `- ${item}`).join("\n")}`
    : "";
  return `Analysis complete: ${safeFilename(filename)}\nPages: ${pdf.pageCount}\n\n${analysis.text}${limitationText}`;
}

export class AnalyzeAttachmentWorkflow {
  readonly #queue: DeliveryQueue;
  readonly #attachmentClient: AttachmentReader;
  readonly #nimClient: AttachmentAnalyzer;
  readonly #messenger: AttachmentProgressMessenger;
  readonly #requesterOpenId: string;
  readonly #tenantKey: string;
  readonly #now: () => Date;
  readonly #extractPdf: typeof extractPdfText;

  constructor(options: {
    queue: DeliveryQueue;
    attachmentClient: AttachmentReader;
    nimClient: AttachmentAnalyzer;
    messenger: AttachmentProgressMessenger;
    requesterOpenId: string;
    tenantKey: string;
    now?: () => Date;
    extractPdf?: typeof extractPdfText;
  }) {
    this.#queue = options.queue;
    this.#attachmentClient = options.attachmentClient;
    this.#nimClient = options.nimClient;
    this.#messenger = options.messenger;
    this.#requesterOpenId = options.requesterOpenId;
    this.#tenantKey = options.tenantKey;
    this.#now = options.now ?? (() => new Date());
    this.#extractPdf = options.extractPdf ?? extractPdfText;
  }

  enqueue(input: { messageId: string; chatId: string }): Promise<boolean> {
    return this.#queue.enqueue({
      id: randomUUID(),
      dedupeKey: `${DEDUPE_PREFIX}${input.messageId}`,
      kind: "ANALYZE_ATTACHMENT",
      chatId: input.chatId,
      expiresAt: new Date(this.#now().getTime() + ANALYZE_ATTACHMENT_JOB_TTL_MS),
    });
  }

  async process(
    job: DeliveryJob,
    progressMessageId: string | null,
    storeProgressMessageId: (messageId: string) => Promise<boolean>,
  ): Promise<void> {
    const sourceMessageId = job.dedupeKey.startsWith(DEDUPE_PREFIX)
      ? job.dedupeKey.slice(DEDUPE_PREFIX.length)
      : "";
    if (job.kind !== "ANALYZE_ATTACHMENT" || !sourceMessageId) {
      throw new Error("Attachment job is invalid");
    }

    let progressId = progressMessageId;
    if (!progressId) {
      progressId = await this.#messenger.create(
        job.chatId,
        "PDF received. Preparing a bounded analysis…",
        job.id,
      );
      if (!(await storeProgressMessageId(progressId))) {
        throw new Error("Attachment progress lease was lost");
      }
    }

    try {
      await this.#messenger.update(progressId, "Downloading and verifying the PDF…");
      const file = await this.#attachmentClient.downloadPdf({
        messageId: sourceMessageId,
        chatId: job.chatId,
        requesterOpenId: this.#requesterOpenId,
        tenantKey: this.#tenantKey,
      });
      const pdf = await this.#extractPdf(file.bytes);
      await this.#messenger.update(progressId, "Analyzing the extracted text…");
      const analysis = await this.#nimClient.analyze({
        filename: file.filename,
        text: pdf.text,
      });
      await this.#messenger.update(
        progressId,
        formatPdfAnalysis(file.filename, pdf, analysis),
      );
    } catch (error) {
      const safeMessage = safeAnalysisFailureMessage(error);
      if (!safeMessage) {
        throw error;
      }
      await this.#messenger.update(progressId, safeMessage);
    }
  }
}
