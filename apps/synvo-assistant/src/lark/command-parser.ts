export type BotCommand =
  | { type: "ping" }
  | { type: "organize-workspace"; folderLink?: string }
  | { type: "analyze-file"; fileLink: string }
  | {
      type: "decide-workspace";
      proposalId: string;
      decision: "APPROVED" | "REJECTED";
    }
  | { type: "undo-workspace"; proposalId: string }
  | { type: "unknown" };

export function parseCommand(text: string): BotCommand {
  const normalized = text.trim();
  if (normalized.toLowerCase() === "/ping") return { type: "ping" };

  const organize = /^\/organize-workspace(?:\s+(\S+))?$/iu.exec(normalized);
  if (organize) {
    return organize[1]
      ? { type: "organize-workspace", folderLink: organize[1] }
      : { type: "organize-workspace" };
  }
  const analyze = /^\/analyze-file\s+(\S+)$/iu.exec(normalized);
  if (analyze?.[1]) return { type: "analyze-file", fileLink: analyze[1] };

  const decision = /^\/(approve|reject)-workspace\s+(\S+)$/iu.exec(normalized);
  if (decision?.[1] && decision[2]) {
    return {
      type: "decide-workspace",
      proposalId: decision[2],
      decision: decision[1].toLowerCase() === "approve" ? "APPROVED" : "REJECTED",
    };
  }
  const undo = /^\/undo-workspace\s+(\S+)$/iu.exec(normalized);
  return undo?.[1]
    ? { type: "undo-workspace", proposalId: undo[1] }
    : { type: "unknown" };
}
