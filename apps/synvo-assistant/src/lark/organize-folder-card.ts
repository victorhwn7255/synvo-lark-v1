import type {
  InteractiveCard,
  InteractiveCardButtonActionItem,
} from "@larksuiteoapi/node-sdk";
import { z } from "zod";

export type OrganizeFolderCardAction =
  | { type: "start"; snapshotDigest: string; expiresAt: number }
  | { type: "cancel" }
  | { type: "page"; proposalId: string; page: number }
  | { type: "decision"; proposalId: string; decision: "APPROVED" | "REJECTED" }
  | { type: "undo"; proposalId: string };

const PROPOSAL_ID = z.uuid();
const LINES_PER_PAGE = 30;

function cardConfig(): InteractiveCard["config"] {
  return { enable_forward: false, update_multi: true, wide_screen_mode: true };
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\*_`\[\]~]/gu, "\\$&");
}

function loadingExtra(loadingImageKey?: string) {
  return loadingImageKey
    ? {
        tag: "img" as const,
        img_key: loadingImageKey,
        alt: { tag: "plain_text" as const, content: "Synvo AI is working" },
        preview: false,
      }
    : undefined;
}

export function buildOrganizeFolderConfirmationCard(input: {
  pdfPaths: string[];
  newOrChangedCount: number;
  snapshotDigest: string;
  expiresAt: number;
}): InteractiveCard {
  const visiblePaths = input.pdfPaths.slice(0, 20);
  const remaining = input.pdfPaths.length - visiblePaths.length;
  return {
    config: cardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Ready to organize this workspace?" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `I found **${input.pdfPaths.length} eligible ${input.pdfPaths.length === 1 ? "PDF" : "PDFs"}** in the active workspace.`,
            input.newOrChangedCount === 0
              ? "Existing searchable knowledge can be reused for every PDF."
              : `**${input.newOrChangedCount} ${input.newOrChangedCount === 1 ? "PDF is" : "PDFs are"} new or changed** and must be prepared with Voyage before NVIDIA can analyze the workspace.`,
            "",
            ...visiblePaths.map((path) => `• ${escapeMarkdown(path)}`),
            remaining > 0 ? `• …and ${remaining} more PDFs in this exact workspace snapshot` : "",
            "",
            "If you continue, I’ll send new or changed PDF text to **Voyage** for embeddings and bounded evidence from every PDF to **NVIDIA NIM** to propose 2–6 useful folders.",
            "",
            "**This step is read-only.** You’ll review one exact proposal before any folder is created or any file is moved.",
          ].filter(Boolean).join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "Analyze workspace" },
            value: {
              action: "start_organize_workspace",
              snapshot_digest: input.snapshotDigest,
              expires_at: input.expiresAt,
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Not now" },
            value: { action: "cancel_organize_workspace" },
          },
        ],
      },
    ],
  };
}

export function buildOrganizeFolderRequestAcceptedCard(): InteractiveCard {
  return {
    config: cardConfig(),
    header: {
      template: "green",
      title: { tag: "plain_text", content: "Workspace analysis requested" },
    },
    elements: [{
      tag: "div",
      text: {
        tag: "plain_text",
        content: "I’m preparing the organization proposal now. I’ll replace the progress card when it’s ready.",
      },
    }],
  };
}

export function buildOrganizeFolderLoadingCard(loadingImageKey?: string): InteractiveCard {
  return {
    config: cardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Analyzing your workspace…" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `${loadingImageKey ? "" : "⏳ "}**Building a practical organization plan**`,
            "",
            "Preparing workspace knowledge → understanding each PDF → proposing a compact folder structure",
          ].join("\n"),
        },
        extra: loadingExtra(loadingImageKey),
      },
      { tag: "note", elements: [{ tag: "plain_text", content: "No Drive files or folders are changed during analysis." }] },
    ],
  };
}

function pageButton(
  proposalId: string,
  page: number,
  label: string,
): InteractiveCardButtonActionItem {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    value: { action: "workspace_proposal_page", proposal_id: proposalId, page },
  };
}

function decisionButton(
  proposalId: string,
  decision: "approve_workspace" | "reject_workspace",
): InteractiveCardButtonActionItem {
  const approving = decision === "approve_workspace";
  return {
    tag: "button",
    type: approving ? "primary" : "danger",
    text: { tag: "plain_text", content: approving ? "Approve" : "Reject" },
    value: { action: decision, proposal_id: proposalId },
    confirm: {
      title: { tag: "plain_text", content: approving ? "Approve this exact plan?" : "Reject this plan?" },
      text: {
        tag: "plain_text",
        content: approving
          ? "Synvo AI will revalidate the full workspace before creating the approved folders and moving the approved files."
          : "The proposal will be rejected and nothing will change.",
      },
    },
  };
}

function proposalPage(message: string, page: number): {
  body: string;
  page: number;
  pageCount: number;
} {
  const lines = message
    .split("\n")
    .filter((line) => !/^(Workspace organization proposal|Approve:|Reject:)/u.test(line))
    .map((line) => {
      if (/^[^\s].+\(\d+ PDFs?(?: · .+)?\)$/u.test(line)) return `**${escapeMarkdown(line)}**`;
      if (line.startsWith("Purpose: ")) return `_${escapeMarkdown(line)}_`;
      if (line.startsWith("- ")) return `• **${escapeMarkdown(line.slice(2))}**`;
      if (line.startsWith("  ")) return `  ${escapeMarkdown(line.trim())}`;
      return escapeMarkdown(line);
    });
  const pageCount = Math.max(1, Math.ceil(lines.length / LINES_PER_PAGE));
  const boundedPage = Math.min(Math.max(0, page), pageCount - 1);
  return {
    body: lines
      .slice(boundedPage * LINES_PER_PAGE, (boundedPage + 1) * LINES_PER_PAGE)
      .join("\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim(),
    page: boundedPage,
    pageCount,
  };
}

export function buildOrganizeFolderResultCard(
  proposalId: string,
  message: string,
  requestedPage = 0,
): InteractiveCard {
  const actionable = message.includes(`Approve: /approve-workspace ${proposalId}`) &&
    message.includes(`Reject: /reject-workspace ${proposalId}`);
  const needsReview = message.includes("Resolve every Needs Review item");
  const page = proposalPage(message, requestedPage);
  const elements: NonNullable<InteractiveCard["elements"]> = [
    { tag: "div", text: { tag: "lark_md", content: page.body } },
  ];
  if (page.pageCount > 1) {
    const actions: InteractiveCardButtonActionItem[] = [];
    if (page.page > 0) actions.push(pageButton(proposalId, page.page - 1, "Previous"));
    if (page.page + 1 < page.pageCount) actions.push(pageButton(proposalId, page.page + 1, "Next"));
    elements.push({ tag: "action", actions });
  }
  elements.push({
    tag: "note",
    elements: [{
      tag: "plain_text",
      content: `Proposal ${proposalId} · Page ${page.page + 1} of ${page.pageCount} · No Drive changes yet.`,
    }],
  });
  if (actionable) {
    elements.push({
      tag: "action",
      layout: "bisected",
      actions: [
        decisionButton(proposalId, "approve_workspace"),
        decisionButton(proposalId, "reject_workspace"),
      ],
    });
  }
  return {
    config: cardConfig(),
    header: {
      template: actionable ? "blue" : needsReview ? "orange" : "red",
      title: {
        tag: "plain_text",
        content: actionable
          ? "Workspace organization proposal"
          : needsReview
            ? "Some PDFs need your review"
            : "Workspace analysis could not be completed",
      },
    },
    elements,
  };
}

export function buildOrganizeFolderDecisionCard(
  message: string,
  loadingImageKey?: string,
): InteractiveCard {
  const rejected = message.includes("rejected");
  const queued = message.includes("Execution is queued");
  const approved = message.includes("approved");
  const undoQueued = message.startsWith("Undo is queued");
  return {
    config: cardConfig(),
    header: {
      template: queued || undoQueued ? "blue" : approved ? "green" : rejected ? "grey" : "orange",
      title: {
        tag: "plain_text",
        content: queued
          ? "Approved — organizing the workspace…"
          : undoQueued
            ? "Restoring the original file locations…"
            : rejected
              ? "Proposal rejected"
              : approved
                ? "Proposal approved"
                : "Workspace update",
      },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "plain_text", content: message },
        extra: queued || undoQueued ? loadingExtra(loadingImageKey) : undefined,
      },
    ],
  };
}

function undoButton(proposalId: string): InteractiveCardButtonActionItem {
  return {
    tag: "button",
    type: "danger",
    text: { tag: "plain_text", content: "Undo file moves" },
    value: { action: "undo_workspace", proposal_id: proposalId },
    confirm: {
      title: { tag: "plain_text", content: "Restore the original file locations?" },
      text: { tag: "plain_text", content: "Created empty folders will remain. Every file restoration will be verified." },
    },
  };
}

export function buildOrganizeFolderOperationCard(
  message: string,
  rootFolderUrl: URL,
): InteractiveCard | null {
  const match = /^Workspace organization (completed|stopped) for proposal ([0-9a-f-]{36})\./iu.exec(message) ??
    /^Workspace undo (completed|stopped) for proposal ([0-9a-f-]{36})\./iu.exec(message);
  if (!match?.[1] || !match[2] || !PROPOSAL_ID.safeParse(match[2]).success) return null;
  const proposalId = match[2];
  const undo = message.startsWith("Workspace undo");
  const success = match[1].toLowerCase() === "completed";
  const displayMessage = message
    .split("\n")
    .filter((line) => !line.startsWith("Undo: /undo-workspace "))
    .join("\n")
    .trim();
  const elements: NonNullable<InteractiveCard["elements"]> = [
    { tag: "div", text: { tag: "plain_text", content: displayMessage } },
  ];
  if (success) {
    const actions: InteractiveCardButtonActionItem[] = [{
      tag: "button",
      type: "primary",
      text: { tag: "plain_text", content: "Open workspace" },
      url: rootFolderUrl.toString(),
    }];
    if (!undo && message.includes(`Undo: /undo-workspace ${proposalId}`)) {
      actions.push(undoButton(proposalId));
    }
    elements.push({ tag: "action", actions });
  }
  return {
    config: cardConfig(),
    header: {
      template: success ? "green" : "orange",
      title: {
        tag: "plain_text",
        content: success
          ? undo ? "Workspace restored" : "Workspace organized"
          : undo ? "Undo needs attention" : "Organization needs attention",
      },
    },
    elements,
  };
}

export function parseOrganizeFolderCardAction(value: unknown): OrganizeFolderCardAction | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.action === "cancel_organize_workspace" && Object.keys(record).length === 1) {
    return { type: "cancel" };
  }
  if (
    record.action === "start_organize_workspace" &&
    typeof record.snapshot_digest === "string" &&
    /^[0-9a-f]{64}$/u.test(record.snapshot_digest) &&
    Number.isSafeInteger(record.expires_at) &&
    Object.keys(record).length === 3
  ) {
    return {
      type: "start",
      snapshotDigest: record.snapshot_digest,
      expiresAt: Number(record.expires_at),
    };
  }
  const proposalId = record.proposal_id;
  if (typeof proposalId !== "string" || !PROPOSAL_ID.safeParse(proposalId).success) return null;
  if (record.action === "workspace_proposal_page" && Number.isInteger(record.page)) {
    return { type: "page", proposalId, page: Number(record.page) };
  }
  if (record.action === "approve_workspace") return { type: "decision", proposalId, decision: "APPROVED" };
  if (record.action === "reject_workspace") return { type: "decision", proposalId, decision: "REJECTED" };
  if (record.action === "undo_workspace") return { type: "undo", proposalId };
  return null;
}
