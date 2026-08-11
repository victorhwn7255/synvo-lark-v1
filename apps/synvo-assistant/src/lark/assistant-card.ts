import type { InteractiveCard } from "@larksuiteoapi/node-sdk";

import { sanitizeDisplayValue } from "../workflows/organize-folder/inventory-message.js";

const MAX_OTHER_WORKSPACES_DISPLAYED = 8;

export type WorkspaceCardContext = {
  activeWorkspaceName: string;
  otherFolderNames: string[];
  workspaceUrl: URL;
};

function cardConfig(): InteractiveCard["config"] {
  return {
    enable_forward: false,
    update_multi: true,
    wide_screen_mode: true,
  };
}

export function buildCardCallbackResponse(
  card: InteractiveCard,
  toast: {
    type: "success" | "info" | "warning" | "error";
    content: string;
  },
) {
  return {
    toast,
    card: {
      type: "raw" as const,
      data: card,
    },
  };
}

function loaderExtra(loadingImageKey?: string) {
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

export function buildAssistantHelpCard(): InteractiveCard {
  return {
    config: cardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Hi — I’m your Synvo AI Assistant 👋" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            "Here are two things I can help with:",
            "",
            "📄 **Analyze a File**",
            "🗂️ **Organize a Folder**",
            "",
            "Many more features to come...",
          ].join("\n"),
        },
      },
    ],
  };
}

export function buildAssistantAcknowledgementCard(): InteractiveCard {
  return buildNoticeCard(
    "You’re welcome — I’m here whenever you’re ready.",
    "Anytime 👋",
  );
}

export function buildAssistantWorkingCard(
  loadingImageKey?: string,
): InteractiveCard {
  return {
    config: cardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Working on your request…" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: "I’m understanding what you need and choosing the right next step.",
        },
        extra: loaderExtra(loadingImageKey),
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "I’ll update this card as soon as I’m ready.",
          },
        ],
      },
    ],
  };
}

export function buildAssistantClarificationCard(): InteractiveCard {
  return {
    config: cardConfig(),
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "What would you like to work on?",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            "I’m not certain which task you want me to start. Try one of these:",
            "",
            "📎 Attach a PDF for a summary and key insights.",
            "🔎 Share a Lark Drive file link and ask me to analyze it.",
            "🗂️ Share a Lark Drive folder link and ask me to organize it.",
          ].join("\n"),
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "No workflow was started from this message.",
          },
        ],
      },
    ],
  };
}

export function buildFolderLinkRequiredCard(): InteractiveCard {
  return {
    config: cardConfig(),
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: "Please share that folder’s link",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            "I understand that you want to organize a different folder. Send me its Lark Drive link so I can open the exact folder you mean.",
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "No analysis has started, and no files have been changed.",
          },
        ],
      },
    ],
  };
}

function workspaceElements(
  workspace: WorkspaceCardContext,
): NonNullable<InteractiveCard["elements"]> {
  const otherNames = workspace.otherFolderNames
    .slice(0, MAX_OTHER_WORKSPACES_DISPLAYED)
    .map((name) => sanitizeDisplayValue(name, "[unnamed folder]"));
  const hiddenCount = workspace.otherFolderNames.length - otherNames.length;
  const others =
    otherNames.length === 0
      ? "No other top-level folders found."
      : `${otherNames.join(" · ")}${hiddenCount ? ` · and ${hiddenCount} more` : ""}`;

  return [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**Current workspace:** 📁 My Folders / **${sanitizeDisplayValue(workspace.activeWorkspaceName, "[unnamed workspace]")}**.`,
      },
    },
    {
      tag: "action",
      actions: [
        {
          tag: "button",
          type: "primary",
          text: { tag: "plain_text", content: "Open workspace" },
          url: workspace.workspaceUrl.toString(),
        },
        {
          tag: "button",
          type: "primary",
          text: { tag: "plain_text", content: "Refresh workspace knowledge" },
          value: { knowledge_action: "refresh_propose" },
        },
      ],
    },
    {
      tag: "note",
      elements: [
        {
          tag: "lark_md",
          content: `Other folders in My Folders\n${others}`,
        },
      ],
    },
  ];
}

export function buildAssistantOnlineCard(
  firstName?: string,
  workspace?: WorkspaceCardContext,
): InteractiveCard {
  const greeting = firstName
    ? `Welcome to Synvo AI, ${firstName} 👋`
    : "Welcome to Synvo AI 👋";
  const [workspaceSummary, workspaceActions, otherFolders] = workspace
    ? workspaceElements(workspace)
    : [];
  return {
    config: cardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: greeting },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "**Your AI work assistant is connected and ready.**",
        },
      },
      ...(workspaceSummary && workspaceActions
        ? [{ tag: "hr" as const }, workspaceSummary, workspaceActions]
        : []),
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            "Here are a few things I can do for you:",
            "📄 **Analyze a File**",
            "🗂️ **Organize a Folder**",
          ].join("\n"),
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "lark_md",
            content:
              "**On the roadmap:** Nested-folder and multi-format knowledge · Lark Docs and Wiki · Engineering workflows",
          },
        ],
      },
      ...(otherFolders ? [{ tag: "hr" as const }, otherFolders] : []),
    ],
  };
}

export function buildCurrentWorkspaceCard(
  workspace?: WorkspaceCardContext,
): InteractiveCard {
  return buildNoticeCard(
    workspace
      ? `We’re currently working in My Folders / ${sanitizeDisplayValue(workspace.activeWorkspaceName, "[unnamed workspace]")}.`
      : "Your Lark Drive context isn’t available right now. Please try again shortly. No workflow was started and no files were changed.",
    workspace ? "Your current workspace" : "I couldn’t verify the current workspace",
  );
}

export function buildAuthorizationCard(message: string): InteractiveCard | null {
  const match = /^Lark Drive authorization is required\.[\s\S]*^Authorize this request: (https?:\/\/\S+)$/mu.exec(
    message,
  );
  if (!match?.[1]) {
    return null;
  }
  let authorizationUrl: URL;
  try {
    authorizationUrl = new URL(match[1]);
  } catch {
    return null;
  }
  if (
    authorizationUrl.pathname !== "/oauth/lark/start" ||
    !authorizationUrl.searchParams.has("request")
  ) {
    return null;
  }

  return {
    config: cardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Connect your Lark Drive" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            "**One quick permission check**",
            "",
            "Please authorize Synvo AI to read this folder and prepare an organization proposal.",
          ].join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "Authorize with Lark" },
            url: authorizationUrl.toString(),
          },
        ],
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content:
              "This link expires in 10 minutes. No file can move without a separate proposal approval.",
          },
        ],
      },
    ],
  };
}

const ANALYSIS_PROGRESS = new Map<string, { title: string; detail: string }>([
  [
    "PDF received. Preparing a bounded analysis…",
    {
      title: "Getting your PDF ready…",
      detail: "I’m checking the file before I begin reading it.",
    },
  ],
  [
    "Downloading and verifying the PDF…",
    {
      title: "Reading your PDF…",
      detail: "I’m securely downloading the file and extracting its text.",
    },
  ],
  [
    "Drive PDF received. Preparing a bounded analysis…",
    {
      title: "Getting the Drive file ready…",
      detail: "I’m checking that this PDF is inside the approved folder.",
    },
  ],
  [
    "Verifying the PDF in Lark Drive…",
    {
      title: "Reading the Drive file…",
      detail: "I’m verifying the file and extracting its text.",
    },
  ],
  [
    "Analyzing the extracted text…",
    {
      title: "Finding the key insights…",
      detail: "Just a minute, I am working hard to analyze the document and preparing a useful response.",
    },
  ],
]);

export function buildAnalysisCard(
  message: string,
  loadingImageKey?: string,
): InteractiveCard {
  const progress = ANALYSIS_PROGRESS.get(message);
  if (progress) {
    return {
      config: cardConfig(),
      header: {
        template: "blue",
        title: { tag: "plain_text", content: progress.title },
      },
      elements: [
        {
          tag: "div",
          text: { tag: "plain_text", content: progress.detail },
          extra: loaderExtra(loadingImageKey),
        },
        {
          tag: "note",
          elements: [
            {
              tag: "plain_text",
              content: "Your file remains unchanged while I work.",
            },
          ],
        },
      ],
    };
  }

  const complete = message.startsWith("Analysis complete:");
  const firstBreak = message.indexOf("\n");
  const firstLine = firstBreak === -1 ? message : message.slice(0, firstBreak);
  const body = firstBreak === -1 ? "" : message.slice(firstBreak + 1).trim();
  return {
    config: cardConfig(),
    header: {
      template: complete ? "green" : "orange",
      title: {
        tag: "plain_text",
        content: complete
          ? firstLine.replace("Analysis complete:", "Analysis ready ·").trim()
          : "I couldn’t finish that analysis",
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: complete ? body : message,
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: complete
              ? "The source file was read only and was not changed."
              : "No file was changed.",
          },
        ],
      },
    ],
  };
}

export function buildNoticeCard(
  message: string,
  title = "A quick heads-up",
): InteractiveCard {
  return {
    config: cardConfig(),
    header: {
      template: "orange",
      title: { tag: "plain_text", content: title },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "plain_text", content: message },
      },
    ],
  };
}
