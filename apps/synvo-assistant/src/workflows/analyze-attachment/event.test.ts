import assert from "node:assert/strict";
import test from "node:test";

import { acceptAttachmentEvent, type AttachmentEvent } from "./event.js";

const expected = { openId: "ou_victor", tenantKey: "tenant_synvo" };
const valid: AttachmentEvent = {
  senderType: "user",
  chatType: "p2p",
  messageType: "file",
  messageId: "om_source",
  chatId: "oc_pilot",
  requesterOpenId: expected.openId,
  tenantKey: expected.tenantKey,
};

test("accepts one direct file message from the configured pilot", () => {
  assert.deepEqual(acceptAttachmentEvent(valid, expected), {
    messageId: "om_source",
    chatId: "oc_pilot",
  });
});

for (const [name, override] of [
  ["bot sender", { senderType: "bot" }],
  ["group message", { chatType: "group" }],
  ["text message", { messageType: "text" }],
  ["missing message id", { messageId: undefined }],
  ["missing chat id", { chatId: undefined }],
  ["wrong user", { requesterOpenId: "ou_other" }],
  ["wrong tenant", { tenantKey: "tenant_other" }],
] as const) {
  test(`ignores ${name}`, () => {
    assert.equal(acceptAttachmentEvent({ ...valid, ...override }, expected), null);
  });
}
