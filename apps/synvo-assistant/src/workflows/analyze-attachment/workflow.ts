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
        return "I couldn’t match this PDF to the Lark message that sent it. Please send the PDF directly in this chat one more time.";
      case "PERMISSION_DENIED":
        return "I don’t have permission to read this attachment yet. Please ask the Synvo AI app administrator to enable message access.";
      case "UNSUPPORTED_FILE":
        return "I can currently analyze one text-based PDF at a time when it’s sent directly in this chat.";
      case "TOO_LARGE":
        return "This PDF is larger than my current 10 MiB limit. Please send a smaller version.";
      case "TIMEOUT":
      case "UNAVAILABLE":
        return "I couldn’t retrieve this attachment from Lark right now. Please send it again in a moment.";
    }
  }
  if (error instanceof PdfInputError) {
    switch (error.code) {
      case "ENCRYPTED":
        return "This PDF is encrypted, so I can’t read it yet. Please send an unlocked copy.";
      case "TOO_MANY_PAGES":
        return "This PDF is longer than my current 50-page limit. Please send a shorter version.";
      case "NO_TEXT":
        return "I couldn’t find readable text in this PDF. Scanned and image-only PDFs aren’t supported yet.";
      case "TIMEOUT":
        return "Reading this PDF took too long, so I stopped safely. No document content was retained.";
      case "MALFORMED":
        return "I couldn’t safely read this PDF. Please try a valid text-based PDF.";
    }
  }
  if (error instanceof NimAnalysisError) {
    switch (error.code) {
      case "UNAUTHORIZED":
        return "Document analysis needs an administrator’s attention right now. Please try again after the model connection is restored.";
      case "RATE_LIMITED":
      case "TIMEOUT":
      case "UNAVAILABLE":
        return "The analysis service is busy right now. Please try again in a moment.";
      case "INVALID_RESPONSE":
        return "I didn’t receive a complete analysis this time. Please try again.";
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
