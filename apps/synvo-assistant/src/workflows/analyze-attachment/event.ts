export type AttachmentEvent = {
  senderType?: string;
  chatType?: string;
  messageType?: string;
  messageId?: string;
  chatId?: string;
  requesterOpenId?: string;
  tenantKey?: string;
};

type AcceptedAttachmentEvent = {
  messageId: string;
  chatId: string;
};

export function acceptAttachmentEvent(
  event: AttachmentEvent,
  expected: { openId: string; tenantKey: string },
): AcceptedAttachmentEvent | null {
  if (
    event.senderType !== "user" ||
    event.chatType !== "p2p" ||
    event.messageType !== "file" ||
    !event.messageId ||
    !event.chatId ||
    event.requesterOpenId !== expected.openId ||
    event.tenantKey !== expected.tenantKey
  ) {
    return null;
  }
  return { messageId: event.messageId, chatId: event.chatId };
}
