import type { Readable } from "node:stream";

import { z } from "zod";

import {
  ANALYZE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  ANALYZE_ATTACHMENT_MAX_BYTES,
} from "../workflows/analyze-attachment/policy.js";

const MAX_DOWNLOAD_ATTEMPTS = 2;

const messageResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    items: z.array(
      z.object({
        message_id: z.string().min(1),
        msg_type: z.string(),
        chat_id: z.string().min(1),
        sender: z.object({
          id: z.string().min(1),
          id_type: z.string(),
          sender_type: z.string(),
          tenant_key: z.string().min(1),
        }),
        body: z.object({ content: z.string() }),
      }),
    ),
  }),
});

const fileContentSchema = z.object({
  file_key: z.string().min(1).max(512),
  file_name: z.string().min(1).max(255),
});

export type LarkAttachmentTransport = {
  getMessage(messageId: string, tenantKey: string): Promise<unknown>;
  getMessageResource(
    messageId: string,
    fileKey: string,
    tenantKey: string,
  ): Promise<{ getReadableStream(): Readable; headers?: unknown }>;
};

export class LarkAttachmentError extends Error {
  readonly code:
    | "INVALID_MESSAGE"
    | "PERMISSION_DENIED"
    | "UNSUPPORTED_FILE"
    | "TOO_LARGE"
    | "TIMEOUT"
    | "UNAVAILABLE";
  readonly retryable: boolean;

  constructor(
    code: LarkAttachmentError["code"],
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = "LarkAttachmentError";
    this.code = code;
    this.retryable = retryable;
  }
}

type DownloadedLarkPdf = {
  filename: string;
  bytes: Buffer;
};

function withDownloadTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new LarkAttachmentError(
            "TIMEOUT",
            "The Lark attachment download timed out.",
            true,
          ),
        ),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function headerValue(headers: unknown, name: string): string | null {
  if (typeof headers !== "object" || headers === null) {
    return null;
  }
  const record = headers as Record<string, unknown>;
  if (typeof record.get === "function") {
    const value = (record.get as (key: string) => unknown)(name);
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
  }
  const value = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function validateResourceHeaders(headers: unknown): void {
  const declaredLength = Number(headerValue(headers, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > ANALYZE_ATTACHMENT_MAX_BYTES) {
    throw new LarkAttachmentError(
      "TOO_LARGE",
      "The PDF exceeds the 10 MiB pilot limit.",
    );
  }

  const contentType = headerValue(headers, "content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType &&
    contentType !== "application/pdf" &&
    contentType !== "application/octet-stream" &&
    contentType !== "binary/octet-stream"
  ) {
    throw new LarkAttachmentError(
      "UNSUPPORTED_FILE",
      "Only PDF attachments are supported in the pilot.",
    );
  }
}

async function readBoundedStream(stream: Readable, timeoutMs: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stream.destroy(new Error("attachment timeout"));
  }, timeoutMs);
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      size += chunk.byteLength;
      if (size > ANALYZE_ATTACHMENT_MAX_BYTES) {
        stream.destroy();
        throw new LarkAttachmentError(
          "TOO_LARGE",
          "The PDF exceeds the 10 MiB pilot limit.",
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof LarkAttachmentError) {
      throw error;
    }
    if (timedOut) {
      throw new LarkAttachmentError(
        "TIMEOUT",
        "The Lark attachment download timed out.",
        true,
      );
    }
    throw new LarkAttachmentError(
      "UNAVAILABLE",
      "The Lark attachment is temporarily unavailable.",
      true,
    );
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks, size);
}

function normalizeTransportError(error: unknown): LarkAttachmentError {
  if (error instanceof LarkAttachmentError) {
    return error;
  }
  const values = Array.isArray(error) ? error : [error];
  if (
    values.some(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "code" in value &&
        value.code === 99991672,
    )
  ) {
    return new LarkAttachmentError(
      "PERMISSION_DENIED",
      "The Lark message-read permission is not available.",
    );
  }
  return new LarkAttachmentError(
    "UNAVAILABLE",
    "The Lark attachment is temporarily unavailable.",
    true,
  );
}

export class LarkAttachmentClient {
  readonly #transport: LarkAttachmentTransport;
  readonly #timeoutMs: number;

  constructor(
    transport: LarkAttachmentTransport,
    timeoutMs = ANALYZE_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Attachment timeout must be a positive integer");
    }
    this.#transport = transport;
    this.#timeoutMs = timeoutMs;
  }

  async downloadPdf(input: {
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
  }): Promise<DownloadedLarkPdf> {
    let lastError: LarkAttachmentError | null = null;
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        return await this.#downloadOnce(input);
      } catch (error) {
        lastError = normalizeTransportError(error);
        if (!lastError.retryable || attempt === MAX_DOWNLOAD_ATTEMPTS) {
          throw lastError;
        }
      }
    }
    throw lastError ?? new LarkAttachmentError("UNAVAILABLE", "Lark download failed.");
  }

  async #downloadOnce(input: {
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
  }): Promise<DownloadedLarkPdf> {
    const rawMessage = await withDownloadTimeout(
      this.#transport.getMessage(input.messageId, input.tenantKey),
      this.#timeoutMs,
    );
    const parsed = messageResponseSchema.safeParse(rawMessage);
    const item = parsed.success && parsed.data.data.items.length === 1
      ? parsed.data.data.items[0]
      : undefined;
    if (
      !item ||
      item.message_id !== input.messageId ||
      item.chat_id !== input.chatId ||
      item.msg_type !== "file" ||
      item.sender.sender_type !== "user" ||
      item.sender.id_type !== "open_id" ||
      item.sender.id !== input.requesterOpenId ||
      item.sender.tenant_key !== input.tenantKey
    ) {
      throw new LarkAttachmentError(
        "INVALID_MESSAGE",
        "The attachment could not be bound to the triggering Lark message.",
      );
    }

    let content: unknown;
    try {
      content = JSON.parse(item.body.content);
    } catch {
      throw new LarkAttachmentError(
        "INVALID_MESSAGE",
        "The Lark file message is malformed.",
      );
    }
    const file = fileContentSchema.safeParse(content);
    if (!file.success) {
      throw new LarkAttachmentError(
        "INVALID_MESSAGE",
        "The Lark file message is malformed.",
      );
    }
    if (!/\.pdf$/iu.test(file.data.file_name)) {
      throw new LarkAttachmentError(
        "UNSUPPORTED_FILE",
        "Only PDF attachments are supported in the pilot.",
      );
    }

    const resource = await withDownloadTimeout(
      this.#transport.getMessageResource(
        input.messageId,
        file.data.file_key,
        input.tenantKey,
      ),
      this.#timeoutMs,
    );
    validateResourceHeaders(resource.headers);
    const bytes = await readBoundedStream(
      resource.getReadableStream(),
      this.#timeoutMs,
    );
    return { filename: file.data.file_name, bytes };
  }
}
