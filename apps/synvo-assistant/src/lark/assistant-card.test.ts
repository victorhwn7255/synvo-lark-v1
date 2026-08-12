import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnalysisCard,
  buildAssistantAcknowledgementCard,
  buildAssistantClarificationCard,
  buildAssistantHelpCard,
  buildAssistantOnlineCard,
  buildAssistantWorkingCard,
  buildAuthorizationCard,
  buildCardCallbackResponse,
  buildCurrentWorkspaceCard,
  buildFolderLinkRequiredCard,
  buildWorkspaceConnectedCard,
} from "./assistant-card.js";

test("welcomes the authorized employee by first name", () => {
  const serialized = JSON.stringify(buildAssistantOnlineCard("Victor"));
  assert.match(serialized, /Welcome to Synvo AI, Victor/u);
  assert.match(serialized, /Here are a few things I can do for you/u);
  assert.match(serialized, /Analyze Files/u);
  assert.match(serialized, /Strategize Business/u);
  assert.match(serialized, /Organize Workspace/u);
  assert.match(serialized, /more to come/u);
  assert.doesNotMatch(serialized, /On the roadmap/u);
  assert.doesNotMatch(serialized, /Understand a PDF|Explore a Drive file/u);
  assert.doesNotMatch(serialized, /always ask before moving or changing files/u);
});

test("welcome card shows verified My Folders context and one workspace URL", () => {
  const card = buildAssistantOnlineCard("Victor", {
    activeWorkspaceName: "Test_Synvo_AI_Assistant",
    otherFolderNames: ["test_directory_2", "test_directory_3"],
    workspaceUrl: new URL(
      "https://larksuite.com/drive/folder/private-root-token?from=space",
    ),
  });
  const serialized = JSON.stringify(card);

  assert.match(serialized, /Current workspace/u);
  assert.match(serialized, /My Folders \/ \*\*Test_Synvo_AI_Assistant/u);
  assert.match(serialized, /test_directory_2 · test_directory_3/u);
  assert.match(serialized, /Open workspace/u);
  assert.equal(serialized.match(/"type":"primary"/gu)?.length, 2);
  assert.ok(
    serialized.indexOf("Current workspace") <
      serialized.indexOf("Here are a few things I can do for you"),
  );
  assert.ok(
    serialized.indexOf("Here are a few things I can do for you") <
      serialized.indexOf("Other folders in My Folders"),
  );
  assert.equal(card.elements?.at(-1)?.tag, "note");
  assert.equal(serialized.match(/private-root-token/gu)?.length, 1);
  assert.doesNotMatch(serialized, /"value"[^}]*private-root-token/u);
});

test("welcome card offers one secure Synvo_Wiki authorization when Drive is disconnected", () => {
  const authorizationUrl = new URL(
    "http://localhost:3000/oauth/lark/start?request=safe-inline-token",
  );
  const serialized = JSON.stringify(
    buildAssistantOnlineCard("Victor", undefined, authorizationUrl),
  );

  assert.match(serialized, /Connect the Synvo_Wiki workspace/u);
  assert.match(serialized, /Authorize Synvo_Wiki/u);
  assert.match(serialized, /safe-inline-token/u);
  assert.match(serialized, /expires in 10 minutes/u);
  assert.doesNotMatch(serialized, /Current workspace|Open workspace/u);
});

test("celebrates a verified Synvo_Wiki connection with useful next steps", () => {
  const serialized = JSON.stringify(
    buildWorkspaceConnectedCard("Victor", {
      activeWorkspaceName: "Synvo_Wiki",
      otherFolderNames: [],
      workspaceUrl: new URL(
        "https://larksuite.com/drive/folder/private-root-token?from=space",
      ),
    }),
  );

  assert.match(serialized, /Synvo_Wiki is connected/u);
  assert.match(serialized, /You’re all set, Victor/u);
  assert.match(serialized, /My Folders \/ \*\*Synvo_Wiki/u);
  assert.match(serialized, /Open Synvo_Wiki/u);
  assert.match(serialized, /Refresh workspace knowledge/u);
  assert.match(serialized, /Please organize my workspace/u);
  assert.match(serialized, /"template":"green"/u);
  assert.doesNotMatch(serialized, /quick heads-up|provider-consent/u);
});

test("workspace cards sanitize provider names and degrade safely", () => {
  const workspace = {
    activeWorkspaceName: '<at user_id="all">Everyone</at>',
    otherFolderNames: ["https://private.example/folder"],
    workspaceUrl: new URL(
      "https://larksuite.com/drive/folder/root-token?from=space",
    ),
  };
  const welcome = JSON.stringify(buildAssistantOnlineCard("Victor", workspace));
  const current = JSON.stringify(buildCurrentWorkspaceCard(workspace));
  const unavailable = JSON.stringify(buildCurrentWorkspaceCard());

  assert.doesNotMatch(welcome, /<\/?at\b/iu);
  assert.doesNotMatch(welcome, /private\.example/iu);
  assert.match(current, /currently working in/u);
  assert.match(unavailable, /couldn’t verify the current workspace/u);
  assert.match(unavailable, /No workflow was started/u);
});

test("welcome card bounds the number of visible folder names", () => {
  const serialized = JSON.stringify(
    buildAssistantOnlineCard("Victor", {
      activeWorkspaceName: "Pilot",
      otherFolderNames: Array.from({ length: 10 }, (_, index) => `folder-${index}`),
      workspaceUrl: new URL("https://larksuite.com/drive/folder/root-token"),
    }),
  );

  assert.match(serialized, /folder-7 · and 2 more/u);
  assert.doesNotMatch(serialized, /folder-8|folder-9/u);
});

test("help card shows the current employee-facing capabilities", () => {
  const serialized = JSON.stringify(buildAssistantHelpCard());
  assert.match(serialized, /Analyze Files/u);
  assert.match(serialized, /Strategize Business/u);
  assert.match(serialized, /Organize Workspace/u);
  assert.match(serialized, /more to come/u);
  assert.doesNotMatch(serialized, /Check connection|check_connection/u);
  assert.doesNotMatch(serialized, /Analyze a PDF|Analyze a Drive file/u);
  assert.doesNotMatch(serialized, /\/organize-folder/u);
});

test("responds naturally to a friendly acknowledgement", () => {
  const serialized = JSON.stringify(buildAssistantAcknowledgementCard());
  assert.match(serialized, /Anytime/u);
  assert.match(serialized, /You’re welcome/u);
});

test("shows one bounded working card while semantic routing is slow", () => {
  const serialized = JSON.stringify(buildAssistantWorkingCard("img_loader"));
  assert.match(serialized, /Working on your request/u);
  assert.match(serialized, /understanding what you need/u);
  assert.match(serialized, /img_loader/u);
  assert.match(serialized, /update this card/u);
});

test("clarification is friendly and confirms that no workflow started", () => {
  const normal = JSON.stringify(buildAssistantClarificationCard());
  assert.match(normal, /What would you like to work on/u);
  assert.match(normal, /No workflow was started/u);
  assert.doesNotMatch(normal, /\/organize-folder/u);
});

test("asks for an exact link when an employee names another folder", () => {
  const serialized = JSON.stringify(buildFolderLinkRequiredCard());
  assert.match(serialized, /understand that you want to organize/u);
  assert.match(serialized, /Lark Drive link/u);
  assert.match(serialized, /No analysis has started/u);
});

test("authorization card keeps the generated URL behind one button", () => {
  const card = buildAuthorizationCard(
    [
      "Lark Drive authorization is required.",
      "",
      "Authorize this request: http://localhost:3000/oauth/lark/start?request=safe-token",
      "",
      "The link expires in 10 minutes.",
    ].join("\n"),
  );
  assert.ok(card);
  const serialized = JSON.stringify(card);
  assert.match(serialized, /Authorize with Lark/u);
  assert.match(serialized, /safe-token/u);
});

test("analysis progress uses the optional loader and result becomes a success card", () => {
  const progress = JSON.stringify(
    buildAnalysisCard("Analyzing the extracted text…", "img_loading"),
  );
  assert.match(progress, /Finding the key insights/u);
  assert.match(progress, /img_loading/u);

  const result = JSON.stringify(
    buildAnalysisCard("Analysis complete: report.pdf\nPages: 2\n\nUseful summary"),
  );
  assert.match(result, /Analysis ready · report.pdf/u);
  assert.match(result, /Useful summary/u);
});

test("wraps a card in Lark's current callback response contract", () => {
  const card = buildAssistantOnlineCard("Victor");
  assert.deepEqual(
    buildCardCallbackResponse(card, {
      type: "success",
      content: "Choice saved.",
    }),
    {
      toast: { type: "success", content: "Choice saved." },
      card: { type: "raw", data: card },
    },
  );
});
