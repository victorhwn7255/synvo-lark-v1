import assert from "node:assert/strict";
import test from "node:test";

import type {
  DeliveryJob,
  DeliveryQueue,
  InsertDeliveryJobInput,
} from "../../delivery/repository.js";
import { LarkAttachmentError } from "../../lark/attachment.js";
import type { AttachmentProgressMessenger } from "./workflow.js";
import { AnalyzeAttachmentWorkflow } from "./workflow.js";

class FakeQueue implements DeliveryQueue {
  readonly inputs: InsertDeliveryJobInput[] = [];
  readonly dedupe = new Set<string>();
  async enqueue(input: InsertDeliveryJobInput): Promise<boolean> {
    this.inputs.push(input);
    if (this.dedupe.has(input.dedupeKey)) return false;
    this.dedupe.add(input.dedupeKey);
    return true;
  }
  async claimNext(): Promise<DeliveryJob | null> { return null; }
  async extendLease(): Promise<boolean> { return true; }
  async storePayload(): Promise<boolean> { return true; }
  async complete(): Promise<boolean> { return true; }
  async retry(): Promise<boolean> { return true; }
  async fail(): Promise<boolean> { return true; }
}

class FakeMessenger implements AttachmentProgressMessenger {
  creates: Array<{ chatId: string; text: string; key: string }> = [];
  updates: Array<{ messageId: string; text: string }> = [];
  failUpdate = false;
  async create(chatId: string, text: string, key: string): Promise<string> {
    this.creates.push({ chatId, text, key });
    return "om_progress";
  }
  async update(messageId: string, text: string): Promise<void> {
    if (this.failUpdate) throw new Error("private Lark update failure");
    this.updates.push({ messageId, text });
  }
}

function attachmentJob(payloadCiphertext: string | null = null): DeliveryJob {
  return {
    id: "7d03d218-0b65-4c40-84c6-1f95e7c2aab5",
    dedupeKey: "analyze-attachment:om_source",
    runId: null,
    kind: "ANALYZE_ATTACHMENT",
    chatId: "oc_pilot",
    payloadCiphertext,
    attemptCount: 1,
    expiresAt: new Date("2026-08-09T01:10:00Z"),
  };
}

function createWorkflow(options: {
  queue?: FakeQueue;
  messenger?: FakeMessenger;
  downloadPdf?: () => Promise<{ filename: string; bytes: Buffer }>;
  analyze?: (input: { filename: string; text: string }) => Promise<{ text: string; truncated: boolean }>;
  extractPdf?: () => Promise<{ text: string; pageCount: number; truncated: boolean }>;
} = {}) {
  const queue = options.queue ?? new FakeQueue();
  const messenger = options.messenger ?? new FakeMessenger();
  return {
    queue,
    messenger,
    workflow: new AnalyzeAttachmentWorkflow({
      queue,
      messenger,
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
      now: () => new Date("2026-08-09T01:00:00Z"),
      attachmentClient: {
        downloadPdf: options.downloadPdf ?? (async () => ({
          filename: "pilot.pdf",
          bytes: Buffer.from("%PDF-test"),
        })),
      },
      extractPdf: options.extractPdf ?? (async () => ({
        text: "bounded extracted text",
        pageCount: 3,
        truncated: false,
      })),
      nimClient: {
        analyze: options.analyze ?? (async () => ({
          text: "Executive summary\nGrounded result",
          truncated: false,
        })),
      },
    }),
  };
}

test("enqueues one durable job per exact Lark message without resource data", async () => {
  const { workflow, queue } = createWorkflow();
  assert.equal(await workflow.enqueue({ messageId: "om_source", chatId: "oc_pilot" }), true);
  assert.equal(await workflow.enqueue({ messageId: "om_source", chatId: "oc_pilot" }), false);
  assert.equal(queue.inputs.length, 2);
  assert.equal(queue.inputs[0]?.kind, "ANALYZE_ATTACHMENT");
  assert.equal(queue.inputs[0]?.dedupeKey, "analyze-attachment:om_source");
  assert.equal(queue.inputs[0]?.payloadCiphertext, undefined);
  assert.equal(queue.inputs[0]?.runId, undefined);
  assert.equal(queue.inputs[0]?.expiresAt?.toISOString(), "2026-08-09T01:10:00.000Z");
});

test("creates one progress message and updates it with the grounded result", async () => {
  let storedProgress = "";
  let analyzedInput: { filename: string; text: string } | null = null;
  const { workflow, messenger } = createWorkflow({
    analyze: async (input) => {
      analyzedInput = input;
      return { text: "Executive summary\nGrounded result", truncated: false };
    },
  });
  await workflow.process(attachmentJob(), null, async (id) => {
    storedProgress = id;
    return true;
  });

  assert.equal(storedProgress, "om_progress");
  assert.equal(messenger.creates.length, 1);
  assert.equal(messenger.creates[0]?.key, attachmentJob().id);
  assert.deepEqual(analyzedInput, {
    filename: "pilot.pdf",
    text: "bounded extracted text",
  });
  assert.equal(messenger.updates.length, 3);
  assert.match(messenger.updates[2]?.text ?? "", /Analysis complete: pilot\.pdf/u);
  assert.match(messenger.updates[2]?.text ?? "", /Grounded result/u);
});

test("restart recovery reuses the stored progress message", async () => {
  const { workflow, messenger } = createWorkflow();
  await workflow.process(attachmentJob(), "om_existing", async () => {
    throw new Error("must not store twice");
  });
  assert.equal(messenger.creates.length, 0);
  assert.ok(messenger.updates.every((update) => update.messageId === "om_existing"));
});

test("reports extraction and model truncation as limitations", async () => {
  const { workflow, messenger } = createWorkflow({
    extractPdf: async () => ({ text: "text", pageCount: 2, truncated: true }),
    analyze: async () => ({ text: "result", truncated: true }),
  });
  await workflow.process(attachmentJob(), "om_existing", async () => true);
  const final = messenger.updates.at(-1)?.text ?? "";
  assert.match(final, /first 100,000 extracted characters/u);
  assert.match(final, /model response reached the configured output limit/u);
});

test("turns expected attachment failures into a safe update", async () => {
  const privateDetail = "private resource key file_secret";
  const { workflow, messenger } = createWorkflow({
    downloadPdf: async () => {
      throw new LarkAttachmentError("UNAVAILABLE", privateDetail);
    },
  });
  await workflow.process(attachmentJob(), "om_existing", async () => true);
  const final = messenger.updates.at(-1)?.text ?? "";
  assert.match(final, /couldn’t retrieve this attachment from Lark/u);
  assert.equal(final.includes(privateDetail), false);
});

test("reports a missing Lark message-read permission as an administrator action", async () => {
  const { workflow, messenger } = createWorkflow({
    downloadPdf: async () => {
      throw new LarkAttachmentError(
        "PERMISSION_DENIED",
        "private provider permission body",
      );
    },
  });
  await workflow.process(attachmentJob(), "om_existing", async () => true);
  const final = messenger.updates.at(-1)?.text ?? "";
  assert.match(final, /permission to read this attachment/u);
  assert.equal(final.includes("private provider permission body"), false);
});

test("propagates progress update failures so the durable worker can retry", async () => {
  const messenger = new FakeMessenger();
  messenger.failUpdate = true;
  const { workflow } = createWorkflow({ messenger });
  await assert.rejects(
    workflow.process(attachmentJob(), "om_existing", async () => true),
    /private Lark update failure/u,
  );
});
