export type BotCommand =
  | { type: "ping" }
  | { type: "organize-folder"; folderLink: string }
  | { type: "unknown" };

export function parseCommand(text: string): BotCommand {
  const normalized = text.trim();
  if (normalized.toLowerCase() === "/ping") {
    return { type: "ping" };
  }

  const match = normalized.match(/^\/organize-folder\s+(\S+)$/i);
  if (match?.[1]) {
    return { type: "organize-folder", folderLink: match[1] };
  }
  return { type: "unknown" };
}
