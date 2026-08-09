import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  LarkAttachmentClient,
  LarkAttachmentError,
  type LarkAttachmentTransport,
} from "./attachment.js";

const messageId = "om_source";
const chatId = "oc_pilot";
const requesterOpenId = "ou_victor";
const tenantKey = "tenant_synvo";
const fileKey = "file_private_key";

function message(overrides: Record<string, unknown> = {}) {
  return {
    code: 0,
    data: {
      items: [{
        message_id: messageId,
        msg_type: "file",
        chat_id: chatId,
        sender: {
          id: requesterOpenId,
          id_type: "open_id",
          sender_type: "user",
          tenant_key: tenantKey,
        },
        body: {
          content: JSON.stringify({ file_key: fileKey, file_name: "pilot.pdf" }),
        },
        ...overrides,
      }],
    },
  };
}

function transport(options: {
  rawMessage?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
  failDownloads?: number;
} = {}): LarkAttachmentTransport & { resourceCalls: number } {
  let remainingFailures = options.failDownloads ?? 0;
  return {
    resourceCalls: 0,
    async getMessage() { return options.rawMessage ?? message(); },
    async getMessageResource(observedMessageId, observedFileKey) {
      this.resourceCalls += 1;
      assert.equal(observedMessageId, messageId);
      assert.equal(observedFileKey, fileKey);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("private network detail");
      }
      return {
        headers: options.headers ?? { "content-type": "application/pdf" },
        getReadableStream: () => Readable.from(options.bytes ?? Buffer.from("%PDF-test")),
      };
    },
  };
}

const input = { messageId, chatId, requesterOpenId, tenantKey };

test("binds and downloads only the exact triggering file message", async () => {
  const client = new LarkAttachmentClient(transport());
  const result = await client.downloadPdf(input);
  assert.equal(result.filename, "pilot.pdf");
  assert.equal(result.bytes.toString(), "%PDF-test");
});

for (const [name, rawMessage] of [
  ["wrong message", message({ message_id: "om_other" })],
  ["wrong chat", message({ chat_id: "oc_other" })],
  ["wrong user", message({ sender: { id: "ou_other", id_type: "open_id", sender_type: "user", tenant_key: tenantKey } })],
  ["wrong tenant", message({ sender: { id: requesterOpenId, id_type: "open_id", sender_type: "user", tenant_key: "tenant_other" } })],
  ["unsupported message", message({ msg_type: "audio" })],
  ["missing resource", message({ body: { content: "{}" } })],
] as const) {
  test(`rejects ${name} before resource download`, async () => {
    const fake = transport({ rawMessage });
    await assert.rejects(
      new LarkAttachmentClient(fake).downloadPdf(input),
      (error: unknown) =>
        error instanceof LarkAttachmentError && error.code === "INVALID_MESSAGE",
    );
    assert.equal(fake.resourceCalls, 0);
  });
}

test("rejects unsupported extension and MIME type", async () => {
  await assert.rejects(
    new LarkAttachmentClient(
      transport({
        rawMessage: message({
          body: { content: JSON.stringify({ file_key: fileKey, file_name: "pilot.txt" }) },
        }),
      }),
    ).downloadPdf(input),
    (error: unknown) =>
      error instanceof LarkAttachmentError && error.code === "UNSUPPORTED_FILE",
  );
  await assert.rejects(
    new LarkAttachmentClient(
      transport({ headers: { "content-type": "text/plain" } }),
    ).downloadPdf(input),
    (error: unknown) =>
      error instanceof LarkAttachmentError && error.code === "UNSUPPORTED_FILE",
  );
});

test("rejects declared and streamed oversized files", async () => {
  await assert.rejects(
    new LarkAttachmentClient(
      transport({ headers: { "content-length": String(10 * 1024 * 1024 + 1) } }),
    ).downloadPdf(input),
    (error: unknown) =>
      error instanceof LarkAttachmentError && error.code === "TOO_LARGE",
  );
  await assert.rejects(
    new LarkAttachmentClient(
      transport({ bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }),
    ).downloadPdf(input),
    (error: unknown) =>
      error instanceof LarkAttachmentError && error.code === "TOO_LARGE",
  );
});

test("retries one temporary download failure without leaking it", async () => {
  const fake = transport({ failDownloads: 1 });
  const result = await new LarkAttachmentClient(fake).downloadPdf(input);
  assert.equal(result.filename, "pilot.pdf");
  assert.equal(fake.resourceCalls, 2);
});

test("maps a missing Lark message-read scope without retrying or leaking provider text", async () => {
  let calls = 0;
  const providerDetail = "private permission response";
  const denied: LarkAttachmentTransport = {
    async getMessage() {
      calls += 1;
      throw [{ message: "HTTP 400" }, { code: 99991672, msg: providerDetail }];
    },
    async getMessageResource() { throw new Error("must not download"); },
  };
  await assert.rejects(
    new LarkAttachmentClient(denied).downloadPdf(input),
    (error: unknown) => {
      assert.ok(error instanceof LarkAttachmentError);
      assert.equal(error.code, "PERMISSION_DENIED");
      assert.equal(error.message.includes(providerDetail), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("bounds message retrieval by the configured timeout", async () => {
  const stalled: LarkAttachmentTransport = {
    getMessage: async () => new Promise<never>(() => {}),
    async getMessageResource() { throw new Error("must not download"); },
  };
  await assert.rejects(
    new LarkAttachmentClient(stalled, 1).downloadPdf(input),
    (error: unknown) =>
      error instanceof LarkAttachmentError && error.code === "TIMEOUT",
  );
});
