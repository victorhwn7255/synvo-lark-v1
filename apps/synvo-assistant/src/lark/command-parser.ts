export type BotCommand =
  | { type: "ping" }
  | { type: "organize-folder"; folderLink: string }
  | { type: "analyze-file"; fileLink: string }
  | {
      type: "decide-folder";
      proposalId: string;
      decision: "APPROVED" | "REJECTED";
    }
  | { type: "undo-folder"; proposalId: string }
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

  const analyzeFileMatch = normalized.match(/^\/analyze-file\s+(\S+)$/i);
  if (analyzeFileMatch?.[1]) {
    return { type: "analyze-file", fileLink: analyzeFileMatch[1] };
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
  const undoMatch = normalized.match(/^\/undo-folder\s+(\S+)$/i);
  if (undoMatch?.[1]) {
    return { type: "undo-folder", proposalId: undoMatch[1] };
  }
  return { type: "unknown" };
}
