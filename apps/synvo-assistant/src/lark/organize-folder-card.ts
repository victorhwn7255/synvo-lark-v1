import type {
  InteractiveCard,
  InteractiveCardButtonActionItem,
} from "@larksuiteoapi/node-sdk";
import { z } from "zod";

export type OrganizeFolderCardAction =
  | { type: "start" }
  | {
      type: "decision";
      proposalId: string;
      decision: "APPROVED" | "REJECTED";
    }
  | { type: "undo"; proposalId: string };

const PROPOSAL_ID = z.uuid();

function cardConfig(): InteractiveCard["config"] {
  return {
    enable_forward: false,
    update_multi: true,
    wide_screen_mode: true,
  };
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\*_`\[\]~]/gu, "\\$&");
}

function proposalBody(message: string, proposalId: string): string {
  const title = `Organization proposal ${proposalId}`;
  const approve = `Approve: /approve-folder ${proposalId}`;
  const reject = `Reject: /reject-folder ${proposalId}`;

  return message
    .split("\n")
    .filter((line) => line !== title && line !== approve && line !== reject)
    .map((line) => {
      const section = /^(Product|Research|Needs review) \((.+)\):$/u.exec(line);
      if (section) {
        const icon = section[1] === "Product"
          ? "📦"
          : section[1] === "Research"
            ? "🔬"
            : "⚠️";
        return `**${icon} ${section[1]} · ${escapeMarkdown(section[2] ?? "")}**`;
      }
      if (line.startsWith("  - ")) {
        return `• **${escapeMarkdown(line.slice(4))}**`;
      }
      if (line.startsWith("    Why: ")) {
        return `  _Why:_ ${escapeMarkdown(line.slice(9))}`;
      }
      if (line === "No changes have been made.") {
        return "";
      }
      return escapeMarkdown(line);
    })
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decisionButton(
  proposalId: string,
  decision: "approve_folder" | "reject_folder",
): InteractiveCardButtonActionItem {
  const approving = decision === "approve_folder";
  return {
    tag: "button",
    type: approving ? "primary" : "danger",
    text: {
      tag: "plain_text",
      content: approving ? "Approve" : "Reject",
    },
    value: {
      action: decision,
      proposal_id: proposalId,
    },
    confirm: {
      title: {
        tag: "plain_text",
        content: approving ? "Approve this proposal?" : "Reject this proposal?",
      },
      text: {
        tag: "plain_text",
        content: approving
          ? "Approval records your decision. Files move only when the operator write switch is enabled."
          : "The proposal will be rejected and no files will move.",
      },
    },
  };
}

function loadingExtra(loadingImageKey?: string) {
  return loadingImageKey
    ? {
        tag: "img" as const,
        img_key: loadingImageKey,
        alt: {
          tag: "plain_text" as const,
          content: "Synvo AI is working",
        },
        preview: false,
      }
    : undefined;
}

export function buildOrganizeFolderConfirmationCard(): InteractiveCard {
  return {
    config: cardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Ready to organize your test folder?" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            "I can analyze the files in your approved pilot folder and prepare a clear organization proposal.",
            "",
            "**Nothing moves during this analysis.** You’ll review the proposal before any file can change.",
          ].join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "Start folder analysis" },
            value: { action: "start_organize_folder" },
          },
        ],
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "To use another folder, send me its Lark Drive link instead.",
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
      title: { tag: "plain_text", content: "Folder analysis requested" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content:
            "Got it — I’ll post a live progress card here, then replace it with your proposal when it’s ready.",
        },
      },
    ],
  };
}

export function buildOrganizeFolderLoadingCard(
  loadingImageKey?: string,
): InteractiveCard {
  return {
    config: cardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Analyzing your folder…" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `${loadingImageKey ? "" : "⏳ "}**Building your organization proposal**`,
            "",
            "Reading each file and choosing the most useful destination.",
          ].join("\n"),
        },
        extra: loadingExtra(loadingImageKey),
      },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "📄 **Read files**  →  🧠 **Classify content**  →  📋 **Prepare proposal**",
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content:
              "🔒 You’re in control — I won’t move anything until you review and approve the plan.",
          },
        ],
      },
    ],
  };
}

export function buildOrganizeFolderResultCard(
  proposalId: string,
  message: string,
): InteractiveCard {
  const approve = `Approve: /approve-folder ${proposalId}`;
  const reject = `Reject: /reject-folder ${proposalId}`;
  const actionable = message.includes(approve) && message.includes(reject);
  const needsReview = message.includes("cannot be approved");
  const elements: NonNullable<InteractiveCard["elements"]> = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: proposalBody(message, proposalId),
      },
    },
    { tag: "hr" },
    {
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: `Proposal ID: ${proposalId} · No files have been changed.`,
        },
      ],
    },
  ];

  if (actionable) {
    elements.push({
      tag: "action",
      layout: "bisected",
      actions: [
        decisionButton(proposalId, "approve_folder"),
        decisionButton(proposalId, "reject_folder"),
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
          ? "Organization proposal ready"
          : needsReview
            ? "Folder organization needs review"
            : "Folder analysis could not be completed",
      },
    },
    elements,
  };
}

export function buildOrganizeFolderDecisionCard(
  message: string,
  loadingImageKey?: string,
): InteractiveCard {
  const approved = message.includes("approved");
  const rejected = message.includes("rejected");
  const queued = message.includes("Execution is queued");
  const undoQueued = message.startsWith("Undo is queued");
  const undoComplete = /^Undo for proposal .+ is already completed\./u.test(message);
  const duplicate = message.includes("already approved");
  const body = undoQueued
    ? "I’m moving the verified files back to their original folder now."
    : undoComplete
      ? "These file moves were already undone, so there’s nothing else to do."
      : rejected
    ? "Got it — I’ll leave the folder exactly as it is."
    : queued
      ? "Thanks — your plan is approved. I’m moving the files now and will verify every result before I report back."
      : duplicate
        ? "This proposal was already approved, so I haven’t started a second execution."
        : approved
          ? "Your approval is saved. File moves are currently paused by the operator safety switch."
          : message;
  return {
    config: cardConfig(),
    header: {
      template:
        queued || undoQueued
          ? "blue"
          : approved || undoComplete
            ? "green"
            : rejected
              ? "grey"
              : "red",
      title: {
        tag: "plain_text",
        content: approved
          ? queued
            ? "Approved — organizing your files…"
            : "Proposal approved"
          : undoQueued
            ? "Restoring your files…"
            : undoComplete
              ? "Files already restored"
          : rejected
            ? "Proposal rejected"
            : "Proposal decision not recorded",
      },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "plain_text", content: body },
        extra:
          queued || undoQueued ? loadingExtra(loadingImageKey) : undefined,
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: queued || undoQueued
              ? "I’ll send a verified result when every move has been checked."
              : "No additional file change was made by this response.",
          },
        ],
      },
    ],
  };
}

function undoButton(proposalId: string): InteractiveCardButtonActionItem {
  return {
    tag: "button",
    type: "danger",
    text: { tag: "plain_text", content: "Undo file moves" },
    value: { action: "undo_folder", proposal_id: proposalId },
    confirm: {
      title: { tag: "plain_text", content: "Move the files back?" },
      text: {
        tag: "plain_text",
        content:
          "Synvo AI will restore the verified files to their original folder and verify every result.",
      },
    },
  };
}

function openUpdatedFolderButton(
  rootFolderUrl: URL,
): InteractiveCardButtonActionItem {
  return {
    tag: "button",
    type: "primary",
    text: { tag: "plain_text", content: "Open updated folder" },
    url: rootFolderUrl.toString(),
  };
}

export function buildOrganizeFolderOperationCard(
  message: string,
  rootFolderUrl: URL,
): InteractiveCard | null {
  const match = /^(Execution|Undo) (completed|partial|unknown|failed) for proposal ([0-9a-f-]{36})\./iu.exec(
    message,
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  const operation = match[1].toLowerCase() === "undo" ? "undo" : "execution";
  const status = match[2].toLowerCase();
  const proposalId = match[3];
  if (!PROPOSAL_ID.safeParse(proposalId).success) {
    return null;
  }
  const success = status === "completed";
  const fileLines = message
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => `✅ ${escapeMarkdown(line.slice(2).replace(/: verified$/u, ""))}`)
    .join("\n");
  const elements: NonNullable<InteractiveCard["elements"]> = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: success
          ? [
              operation === "undo"
                ? "**Everything is back where it started.**"
                : "**Everything is organized and verified.**",
              "",
              fileLines,
            ].join("\n")
          : "I stopped safely because I couldn’t verify every file. Please review the folder before trying again.",
      },
    },
    {
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content:
            success
              ? "Verified through Lark Drive. Open the folder below to load its latest contents."
              : `Proposal ID: ${proposalId}`,
        },
      ],
    },
  ];
  if (success) {
    const actions: InteractiveCardButtonActionItem[] = [
      openUpdatedFolderButton(rootFolderUrl),
    ];
    if (
      operation === "execution" &&
      message.includes(`Undo: /undo-folder ${proposalId}`)
    ) {
      actions.push(undoButton(proposalId));
    }
    elements.push({
      tag: "action",
      layout: actions.length === 2 ? "bisected" : undefined,
      actions,
    });
  }
  return {
    config: cardConfig(),
    header: {
      template: success ? "green" : "orange",
      title: {
        tag: "plain_text",
        content: success
          ? operation === "undo"
            ? "Undo complete"
            : "Folder organized successfully"
          : operation === "undo"
            ? "Undo needs attention"
            : "Folder organization needs attention",
      },
    },
    elements,
  };
}

export function parseOrganizeFolderCardAction(
  value: unknown,
): OrganizeFolderCardAction | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.action === "start_organize_folder" &&
    Object.keys(record).length === 1
  ) {
    return { type: "start" };
  }
  const proposalId = record.proposal_id;
  if (
    typeof proposalId !== "string" ||
    !PROPOSAL_ID.safeParse(proposalId).success
  ) {
    return null;
  }
  if (record.action === "approve_folder") {
    return { type: "decision", proposalId, decision: "APPROVED" };
  }
  if (record.action === "reject_folder") {
    return { type: "decision", proposalId, decision: "REJECTED" };
  }
  if (record.action === "undo_folder") {
    return { type: "undo", proposalId };
  }
  return null;
}
