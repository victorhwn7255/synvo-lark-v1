export type AttachmentEvent = {
  senderType?: string;
  chatType?: string;
  messageType?: string;
  messageId?: string;
  chatId?: string;
  requesterOpenId?: string;
  tenantKey?: string;
  content?: string;
};

type AcceptedAttachmentEvent = {
  messageId: string;
  chatId: string;
  filename: string;
};

function readFilename(content: string | undefined): string | null {
  if (!content) {
    return null;
  }
  try {
    const value = JSON.parse(content) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      "file_name" in value &&
      typeof value.file_name === "string" &&
      value.file_name.length > 0 &&
      value.file_name.length <= 255 &&
      /\.pdf$/iu.test(value.file_name)
    ) {
      return value.file_name;
    }
  } catch {
    return null;
  }
  return null;
}

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
  const filename = readFilename(event.content);
  return filename
    ? { messageId: event.messageId, chatId: event.chatId, filename }
    : null;
}
