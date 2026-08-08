export type BotCommand =
  | { type: "ping" }
  | { type: "organize-folder"; folderLink: string }
  | {
      type: "decide-folder";
      proposalId: string;
      decision: "APPROVED" | "REJECTED";
    }
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

  const decisionMatch = normalized.match(
    /^\/(approve|reject)-folder\s+(\S+)$/i,
  );
  if (decisionMatch?.[1] && decisionMatch[2]) {
    return {
      type: "decide-folder",
      proposalId: decisionMatch[2],
      decision:
        decisionMatch[1].toLowerCase() === "approve"
          ? "APPROVED"
          : "REJECTED",
    };
  }
  return { type: "unknown" };
}
