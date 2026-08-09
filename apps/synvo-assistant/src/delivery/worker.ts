import type { TokenCipher } from "../lark/auth/index.js";

import {
  decryptDeliveryMessage,
  encryptDeliveryMessage,
} from "./crypto.js";
import type {
  DeliveryJob,
  DeliveryJobKind,
  DeliveryQueue,
} from "./repository.js";

type DeliveryWorkerOptions = {
  queue: DeliveryQueue;
  cipher: TokenCipher;
  prepareMessage: (runId: string, kind: DeliveryJobKind) => Promise<string>;
  prepareExhaustedMessage: (
    runId: string,
    kind: DeliveryJobKind,
  ) => Promise<string>;
  sendText: (
    chatId: string,
    text: string,
    idempotencyKey: string,
  ) => Promise<void>;
  handleAnalyzeAttachment?: (
    job: DeliveryJob,
    progressMessageId: string | null,
    storeProgressMessageId: (messageId: string) => Promise<boolean>,
  ) => Promise<void>;
  handleAnalyzeDriveFile?: (
    job: DeliveryJob,
    payload: string | null,
    storePayload: (payload: string) => Promise<boolean>,
  ) => Promise<void>;
  now?: () => Date;
  leaseMs?: number;
  pollMs?: number;
  maxAttempts?: number;
};

class PermanentDeliveryError extends Error {}
class RetryablePreparationError extends Error {}

export class DeliveryWorker {
  readonly #queue: DeliveryQueue;
  readonly #cipher: TokenCipher;
  readonly #prepareMessage: (
    runId: string,
    kind: DeliveryJobKind,
  ) => Promise<string>;
  readonly #prepareExhaustedMessage: (
    runId: string,
    kind: DeliveryJobKind,
  ) => Promise<string>;
  readonly #sendText: (
    chatId: string,
    text: string,
    idempotencyKey: string,
  ) => Promise<void>;
  readonly #handleAnalyzeAttachment?: DeliveryWorkerOptions["handleAnalyzeAttachment"];
  readonly #handleAnalyzeDriveFile?: DeliveryWorkerOptions["handleAnalyzeDriveFile"];
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #pollMs: number;
  readonly #maxAttempts: number;
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #stopping = false;

  constructor(options: DeliveryWorkerOptions) {
    this.#queue = options.queue;
    this.#cipher = options.cipher;
    this.#prepareMessage = options.prepareMessage;
    this.#prepareExhaustedMessage = options.prepareExhaustedMessage;
    this.#sendText = options.sendText;
    this.#handleAnalyzeAttachment = options.handleAnalyzeAttachment;
    this.#handleAnalyzeDriveFile = options.handleAnalyzeDriveFile;
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = options.leaseMs ?? 120_000;
    this.#pollMs = options.pollMs ?? 500;
    this.#maxAttempts = options.maxAttempts ?? 10;
    if (!Number.isInteger(this.#leaseMs) || this.#leaseMs <= 0) {
      throw new Error("Delivery lease must be a positive integer");
    }
    if (!Number.isInteger(this.#pollMs) || this.#pollMs < 0) {
      throw new Error("Delivery poll interval must be a non-negative integer");
    }
    if (!Number.isInteger(this.#maxAttempts) || this.#maxAttempts <= 0) {
      throw new Error("Delivery max attempts must be a positive integer");
    }
  }

  start(): void {
    if (this.#timer || this.#inFlight) {
      return;
    }
    this.#stopping = false;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#inFlight;
  }

  async processOne(): Promise<boolean> {
    const job = await this.#queue.claimNext(this.#now(), this.#leaseMs);
    if (!job) {
      return false;
    }

    try {
      if (
        job.kind === "ANALYZE_ATTACHMENT" ||
        job.kind === "ANALYZE_DRIVE_FILE"
      ) {
        await this.#processAnalysis(job);
        return true;
      }
      let payloadCiphertext: string;
      try {
        payloadCiphertext = await this.#preparePayload(job);
      } catch (error) {
        if (this.#shouldFinalizeExhaustedJob(job, error)) {
          payloadCiphertext = await this.#prepareExhaustedJobPayload(job);
        } else {
          throw error;
        }
      }
      let message: string;
      try {
        message = decryptDeliveryMessage(
          this.#cipher,
          job.id,
          payloadCiphertext,
        );
      } catch {
        throw new PermanentDeliveryError("Delivery payload is invalid");
      }
      await this.#sendText(job.chatId, message, job.id);
      if (!(await this.#queue.complete(job))) {
        throw new Error("Delivery lease was lost before completion");
      }
    } catch (error) {
      const now = this.#now();
      if (error instanceof PermanentDeliveryError) {
        await this.#queue.fail(job, "DELIVERY_PAYLOAD_INVALID");
      } else if (job.expiresAt && job.expiresAt <= now) {
        await this.#queue.fail(job, "DELIVERY_EXPIRED");
      } else if (job.attemptCount >= this.#maxAttempts) {
        await this.#queue.fail(job, "DELIVERY_ATTEMPTS_EXHAUSTED");
      } else {
        const exponent = Math.min(job.attemptCount - 1, 6);
        const delayMs = Math.min(60_000, 1_000 * 2 ** exponent);
        await this.#queue.retry(
          job,
          new Date(now.getTime() + delayMs),
          "DELIVERY_RETRYABLE",
        );
      }
    }
    return true;
  }

  async #processAnalysis(job: DeliveryJob): Promise<void> {
    const handler =
      job.kind === "ANALYZE_ATTACHMENT"
        ? this.#handleAnalyzeAttachment
        : this.#handleAnalyzeDriveFile;
    if (!handler) {
      throw new PermanentDeliveryError("Document analysis is not configured");
    }
    let payload: string | null = null;
    if (job.payloadCiphertext) {
      try {
        payload = decryptDeliveryMessage(
          this.#cipher,
          job.id,
          job.payloadCiphertext,
        );
      } catch {
        throw new PermanentDeliveryError("Document analysis payload is invalid");
      }
    }
    await handler(
      job,
      payload,
      async (value) =>
        this.#queue.storePayload(
          job,
          encryptDeliveryMessage(this.#cipher, job.id, value),
        ),
    );
    if (!(await this.#queue.complete(job))) {
      throw new Error("Delivery lease was lost before completion");
    }
  }

  async #preparePayload(job: DeliveryJob): Promise<string> {
    if (job.payloadCiphertext) {
      return job.payloadCiphertext;
    }
    if (job.kind === "TEXT" || !job.runId) {
      throw new PermanentDeliveryError("Delivery job has no recoverable payload");
    }

    let message: string;
    try {
      message = await this.#prepareMessage(job.runId, job.kind);
    } catch {
      throw new RetryablePreparationError(
        "The workflow result could not be prepared",
      );
    }
    const payloadCiphertext = encryptDeliveryMessage(
      this.#cipher,
      job.id,
      message,
    );
    if (!(await this.#queue.storePayload(job, payloadCiphertext))) {
      throw new Error("Delivery lease was lost while storing the result");
    }
    return payloadCiphertext;
  }

  #shouldFinalizeExhaustedJob(job: DeliveryJob, error: unknown): boolean {
    return (
      error instanceof RetryablePreparationError &&
      job.kind !== "TEXT" &&
      job.runId !== null &&
      job.payloadCiphertext === null &&
      job.attemptCount >= this.#maxAttempts &&
      (!job.expiresAt || job.expiresAt > this.#now())
    );
  }

  async #prepareExhaustedJobPayload(job: DeliveryJob): Promise<string> {
    if (!job.runId) {
      throw new PermanentDeliveryError("Exhausted scan has no run");
    }
    const message = await this.#prepareExhaustedMessage(job.runId, job.kind);
    const payloadCiphertext = encryptDeliveryMessage(
      this.#cipher,
      job.id,
      message,
    );
    if (!(await this.#queue.storePayload(job, payloadCiphertext))) {
      throw new Error("Delivery lease was lost while finalizing the scan");
    }
    return payloadCiphertext;
  }

  #schedule(delayMs: number): void {
    if (this.#stopping) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#inFlight = this.processOne()
        .then((processed) => {
          this.#schedule(processed ? 0 : this.#pollMs);
        })
        .catch(() => {
          this.#schedule(this.#pollMs);
        })
        .finally(() => {
          this.#inFlight = null;
        });
    }, delayMs);
  }
}
