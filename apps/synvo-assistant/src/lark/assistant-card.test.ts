import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnalysisCard,
  buildAssistantHelpCard,
  buildAssistantOnlineCard,
  buildAuthorizationCard,
  isCheckConnectionAction,
} from "./assistant-card.js";

test("welcomes the authorized employee by first name", () => {
  const serialized = JSON.stringify(buildAssistantOnlineCard("Victor"));
  assert.match(serialized, /Welcome to Synvo AI, Victor/u);
  assert.match(serialized, /Understand a PDF/u);
  assert.match(serialized, /Organize a folder/u);
  assert.match(serialized, /always ask before moving or changing files/u);
});

test("help card uses natural instructions and an interactive connection check", () => {
  const serialized = JSON.stringify(buildAssistantHelpCard());
  assert.match(serialized, /organize this folder/u);
  assert.match(serialized, /analyze this file/u);
  assert.ok(serialized.includes('"action":"check_connection"'));
  assert.doesNotMatch(serialized, /\/organize-folder/u);
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

test("connection callback accepts only its exact action", () => {
  assert.equal(isCheckConnectionAction({ action: "check_connection" }), true);
  assert.equal(isCheckConnectionAction({ action: "approve_folder" }), false);
  assert.equal(isCheckConnectionAction(null), false);
});
