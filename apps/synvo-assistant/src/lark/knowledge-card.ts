import type { InteractiveCard } from "@larksuiteoapi/node-sdk";

import { sanitizeDisplayValue } from "../workflows/organize-folder/inventory-message.js";
import type {
  KnowledgeAnswer,
  KnowledgeProgress,
  KnowledgeRefreshProposal,
} from "../workflows/knowledge/workflow.js";
import {
  KNOWLEDGE_MAX_RELATIVE_PATH_CODE_POINTS,
  KNOWLEDGE_REFRESH_SNAPSHOT_MAX_CODE_UNITS,
} from "../workflows/knowledge/policy.js";

function config(): InteractiveCard["config"] {
  return { enable_forward: false, update_multi: true, wide_screen_mode: true };
}

export type KnowledgeCardAction =
  | { type: "attachment_add"; sourceMessageId: string }
  | { type: "attachment_analyze"; sourceMessageId: string }
  | { type: "attachment_not_now" }
  | { type: "refresh_propose" }
  | { type: "refresh_confirm"; snapshot: string }
  | { type: "refresh_stop"; jobId: string }
  | { type: "remove_request"; sourceReference: string; sourceName: string }
  | { type: "remove_confirm"; sourceReference: string; sourceName: string }
  | { type: "delete_source_confirm"; sourceReference: string; sourceName: string };

function sanitizeKnowledgeSourceName(value: string, fallback = "PDF file"): string {
  return sanitizeDisplayValue(
    value,
    fallback,
    KNOWLEDGE_MAX_RELATIVE_PATH_CODE_POINTS,
  );
}

export function parseKnowledgeCardAction(value: unknown): KnowledgeCardAction | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = record.knowledge_action;
  if (type === "attachment_not_now" || type === "refresh_propose") {
    return { type };
  }
  if (
    (type === "attachment_add" || type === "attachment_analyze") &&
    typeof record.source_message_id === "string" &&
    /^om_[A-Za-z0-9_-]+$/u.test(record.source_message_id)
  ) {
    return { type, sourceMessageId: record.source_message_id };
  }
  if (
    type === "refresh_confirm" &&
    typeof record.snapshot === "string" &&
    record.snapshot.length <= KNOWLEDGE_REFRESH_SNAPSHOT_MAX_CODE_UNITS
  ) {
    return { type, snapshot: record.snapshot };
  }
  if (
    type === "refresh_stop" &&
    typeof record.job_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record.job_id,
    )
  ) {
    return { type, jobId: record.job_id };
  }
  if (
    (type === "remove_request" ||
      type === "remove_confirm" ||
      type === "delete_source_confirm") &&
    typeof record.source_reference === "string" &&
    record.source_reference.length <= 2_048 &&
    typeof record.source_name === "string" &&
    record.source_name.length <= 255
  ) {
    return {
      type,
      sourceReference: record.source_reference,
      sourceName: record.source_name,
    };
  }
  return null;
}

export function buildKnowledgeConsentCard(input: {
  filename: string;
  sourceMessageId: string;
  workspaceName: string;
}): InteractiveCard {
  const filename = sanitizeDisplayValue(input.filename, "PDF attachment");
  const workspace = sanitizeDisplayValue(input.workspaceName, "active workspace");
  return {
    config: config(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "What would you like me to do with this PDF?" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**${filename}**`,
            "",
            `I can add it to the searchable knowledge for **My Folders / ${workspace}**, or analyze it once without storing any knowledge chunks.`,
            "",
            "The original PDF will not be copied, moved, or changed.",
          ].join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "Add to knowledge" },
            value: {
              knowledge_action: "attachment_add",
              source_message_id: input.sourceMessageId,
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Analyze once" },
            value: {
              knowledge_action: "attachment_analyze",
              source_message_id: input.sourceMessageId,
            },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "Not now" },
            value: { knowledge_action: "attachment_not_now" },
          },
        ],
      },
    ],
  };
}

export function buildKnowledgeNotNowCard(): InteractiveCard {
  return {
    config: config(),
    header: {
      template: "grey",
      title: { tag: "plain_text", content: "No problem — I left it as is" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: "Nothing was extracted, sent to a model, or added to workspace knowledge.",
        },
      },
    ],
  };
}

export function buildKnowledgeProgressCard(
  progress: KnowledgeProgress,
  loadingImageKey?: string,
  workspaceUrl?: URL,
): InteractiveCard {
  if (progress.answer) {
    return buildKnowledgeAnswerCard(progress.answer, workspaceUrl);
  }
  const complete = progress.stage === "complete";
  const failed = progress.stage === "failed";
  const stopped = progress.stage === "stopped";
  const deleted = progress.stage === "deleted";
  const terminal = complete || failed || stopped || deleted;
  const title = progress.stage === "ingesting"
    ? "Adding this PDF to workspace knowledge…"
    : progress.stage === "refreshing"
      ? "Updating workspace knowledge…"
      : progress.stage === "stopping"
        ? "Stopping safely…"
        : progress.stage === "stopped"
          ? "Knowledge update stopped"
      : progress.stage === "answering"
        ? "Searching workspace knowledge…"
        : progress.stage === "deleting"
          ? "Deleting the approved file…"
          : progress.stage === "deleted"
            ? "File deleted"
        : complete
          ? "Workspace knowledge updated"
          : "I couldn’t update workspace knowledge";
  const progressDetails = buildRefreshProgressDetails(progress);
  const elements: NonNullable<InteractiveCard["elements"]> = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: progressDetails
          ? `${progress.message}\n\n${progressDetails}`
          : progress.message,
      },
      ...(loadingImageKey && !terminal
        ? {
            extra: {
              tag: "img" as const,
              img_key: loadingImageKey,
              alt: { tag: "plain_text" as const, content: "Synvo AI is working" },
              preview: false,
            },
          }
        : {}),
    },
  ];
  if (progress.stage === "refreshing" && progress.jobId) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          type: "danger",
          text: { tag: "plain_text", content: "Stop update" },
          value: {
            knowledge_action: "refresh_stop",
            job_id: progress.jobId,
          },
        },
      ],
    });
  }
  if (stopped) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          type: "primary",
          text: { tag: "plain_text", content: "Resume update" },
          value: { knowledge_action: "refresh_propose" },
        },
      ],
    });
  }
  if (complete && progress.sourceReference && progress.sourceName) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          type: "danger",
          text: { tag: "plain_text", content: "Remove from knowledge" },
          value: {
            knowledge_action: "remove_request",
            source_reference: progress.sourceReference,
            source_name: progress.sourceName,
          },
        },
      ],
    });
  }
  if (progress.stage !== "deleting" && progress.stage !== "deleted") {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: "The original Lark file remains unchanged.",
        },
      ],
    });
  }
  return {
    config: config(),
    header: {
      template: complete || deleted ? "green" : failed ? "red" : stopped ? "grey" : "blue",
      title: { tag: "plain_text", content: title },
    },
    elements,
  };
}

function buildRefreshProgressDetails(progress: KnowledgeProgress): string {
  if (
    progress.totalFiles === undefined ||
    progress.completedFiles === undefined ||
    progress.totalFiles < 1
  ) {
    return "";
  }
  const batchFraction =
    progress.currentFile &&
    progress.totalBatches &&
    progress.completedBatches !== undefined
      ? progress.completedBatches / progress.totalBatches
      : 0;
  const completed = Math.min(
    progress.totalFiles,
    progress.completedFiles + batchFraction,
  );
  const filled = Math.min(
    10,
    Math.floor((completed / progress.totalFiles) * 10),
  );
  const lines = [
    `**${"█".repeat(filled)}${"░".repeat(10 - filled)}  ${progress.completedFiles} of ${progress.totalFiles} files**`,
  ];
  if (progress.currentFile) {
    lines.push(
      "",
      "**Current file**",
      sanitizeKnowledgeSourceName(progress.currentFile),
    );
  }
  if (progress.chunkCount !== undefined) {
    lines.push("", `✓ ${progress.chunkCount} chunks created`);
  }
  if (
    progress.completedBatches !== undefined &&
    progress.totalBatches !== undefined &&
    progress.totalBatches > 0
  ) {
    const completedBatches = Math.min(
      progress.completedBatches,
      progress.totalBatches,
    );
    if (completedBatches < progress.totalBatches) {
      lines.push(
        `→ Embedding batch ${completedBatches + 1} of ${progress.totalBatches}…`,
      );
    } else {
      lines.push(
        `✓ Embeddings ready · ${completedBatches} of ${progress.totalBatches} ${progress.totalBatches === 1 ? "batch" : "batches"} complete`,
      );
    }
  }
  return lines.join("\n");
}

export function buildKnowledgeRefreshProposalCard(
  proposal: KnowledgeRefreshProposal,
): InteractiveCard {
  const sections: string[] = [];
  if (proposal.files.length > 0) {
    sections.push(
      "**PDFs to add or refresh**",
      ...proposal.files.map(
        (file) => `• ${sanitizeKnowledgeSourceName(file.name)}`,
      ),
    );
  }
  if (proposal.pathUpdates.length > 0) {
    if (sections.length > 0) {
      sections.push("");
    }
    sections.push(
      "**Paths to update without reprocessing**",
      ...proposal.pathUpdates.flatMap((file) => [
        `• ${sanitizeKnowledgeSourceName(file.name)}`,
        `  Previously: ${sanitizeKnowledgeSourceName(file.previousName)}`,
      ]),
    );
  }
  const removed = proposal.removedSources.length === 0
    ? []
    : [
        ...(sections.length > 0 ? [""] : []),
        `**Sources to remove from knowledge: ${proposal.removedSources.length}**`,
        ...proposal.removedSources.map(
          (source) => `• ${sanitizeKnowledgeSourceName(source.name)}`,
        ),
      ];
  sections.push(...removed);
  if (sections.length === 0) {
    sections.push(
      "**Workspace knowledge is current**",
      "No new, changed, moved, renamed, or removed PDFs.",
    );
  }
  const elements: NonNullable<InteractiveCard["elements"]> = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: [
          ...sections,
          "",
          "Updating knowledge stores searchable text and embeddings in Synvo PostgreSQL. It does not modify the Drive files.",
        ].join("\n"),
      },
    },
  ];
  if (proposal.hasChanges) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          type: "primary",
          text: { tag: "plain_text", content: "Update knowledge" },
          value: {
            knowledge_action: "refresh_confirm",
            snapshot: proposal.snapshot,
          },
        },
      ],
    });
  }
  return {
    config: config(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Review the workspace knowledge update" },
    },
    elements,
  };
}

export function buildKnowledgeRemovalConfirmationCard(input: {
  sourceReference: string;
  sourceName: string;
}): InteractiveCard {
  const name = sanitizeKnowledgeSourceName(input.sourceName, "this source");
  return {
    config: config(),
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "Remove this file from knowledge?" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `This removes the searchable chunks for **${name}**. The original file will remain unchanged.`,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "danger",
            text: { tag: "plain_text", content: "Confirm removal" },
            value: {
              knowledge_action: "remove_confirm",
              source_reference: input.sourceReference,
              source_name: input.sourceName,
            },
          },
        ],
      },
    ],
  };
}

export function buildKnowledgeRemovedCard(sourceName: string): InteractiveCard {
  return {
    config: config(),
    header: {
      template: "green",
      title: { tag: "plain_text", content: "Removed from workspace knowledge" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: `${sanitizeKnowledgeSourceName(sourceName, "The source")} is no longer searchable. The original file was not changed.`,
        },
      },
    ],
  };
}

export function buildDriveKnowledgeDeletionConfirmationCard(input: {
  sourceReference: string;
  sourceName: string;
}): InteractiveCard {
  const name = sanitizeKnowledgeSourceName(input.sourceName, "this file");
  return {
    config: config(),
    header: {
      template: "red",
      title: { tag: "plain_text", content: "Delete this file from Synvo_Wiki?" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `This will move **${name}** to Lark’s recycle bin and remove all of its searchable chunks and embeddings.`,
            "",
            "You can recover the original file manually from Lark’s recycle bin, but Synvo AI does not provide an automatic undo for this action.",
          ].join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "danger",
            text: { tag: "plain_text", content: "Delete file and knowledge" },
            value: {
              knowledge_action: "delete_source_confirm",
              source_reference: input.sourceReference,
              source_name: input.sourceName,
            },
          },
        ],
      },
    ],
  };
}

export function buildKnowledgeAnswerCard(
  answer: KnowledgeAnswer,
  workspaceUrl?: URL,
): InteractiveCard {
  const elements: NonNullable<InteractiveCard["elements"]> = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: answer.answer,
      },
    },
  ];
  if (answer.citations.length > 0) {
    elements.push(
      { tag: "hr" },
      {
        tag: "note",
        elements: [
          {
            tag: "lark_md",
            content: [
              "**Sources**",
              ...answer.citations.map(
                (citation) =>
                  `• ${sanitizeKnowledgeSourceName(citation.sourceName)}, page ${citation.pageNumber}`,
              ),
            ].join("\n"),
          },
        ],
      },
    );
  }
  if (!answer.supported && workspaceUrl) {
    elements.push(
      { tag: "hr" },
      {
        tag: "note",
        elements: [{ tag: "plain_text", content: "You may want to:" }],
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "Open workspace" },
            url: workspaceUrl.toString(),
          },
        ],
      },
    );
  }
  return {
    config: config(),
    header: {
      template: answer.supported ? "green" : "orange",
      title: {
        tag: "plain_text",
        content: answer.supported
          ? "Answer from workspace knowledge"
          : "I couldn’t find enough evidence",
      },
    },
    elements,
  };
}
