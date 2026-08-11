import type { InteractiveCard } from "@larksuiteoapi/node-sdk";

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

export function buildAssistantOnlineCard(firstName?: string): InteractiveCard {
  const greeting = firstName
    ? `Welcome to Synvo AI, ${firstName} 👋`
    : "Welcome to Synvo AI 👋";
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
          content: [
            "**Your AI work assistant is connected and ready.**",
            "",
            "Here are a few things I can do for you:",
          ].join("\n"),
        },
      },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            "📄 **Analyze a File**",
            "🗂️ **Organize a Folder**",
          ].join("\n\n"),
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content:
              "You stay in control — I’ll always ask before moving or changing files.",
          },
        ],
      },
    ],
  };
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
      detail: "Synvo AI is summarizing the document and preparing a useful response.",
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

export function buildNoticeCard(message: string): InteractiveCard {
  return {
    config: cardConfig(),
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "A quick heads-up" },
    },
    elements: [
      {
        tag: "div",
        text: { tag: "plain_text", content: message },
      },
    ],
  };
}
