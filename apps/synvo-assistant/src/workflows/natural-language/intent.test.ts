import assert from "node:assert/strict";
import test from "node:test";

import { understandNaturalLanguage } from "./intent.js";

function classifier(
  intent:
    | "greeting"
    | "help"
    | "current_workspace"
    | "organize_folder"
    | "analyze_drive_file"
    | "unknown",
  calls: string[] = [],
) {
  return {
    async classifyIntent(input: { text: string }) {
      calls.push(input.text);
      return { intent } as const;
    },
  };
}

for (const text of ["Hello", "Good morning!", "Are you online?"]) {
  test(`handles the greeting locally: ${text}`, async () => {
    const calls: string[] = [];
    const result = await understandNaturalLanguage(
      { text },
      classifier("unknown", calls),
    );

    assert.equal(result.intent, "greeting");
    assert.deepEqual(calls, []);
  });
}

test("gives an actionable organize request precedence over its greeting", async () => {
  const calls: string[] = [];
  const result = await understandNaturalLanguage(
    { text: "Hello, could you organize my messy folder?" },
    classifier("greeting", calls),
  );

  assert.equal(result.intent, "organize_folder");
  assert.deepEqual(calls, []);
});

test("handles help and common actionable requests without NVIDIA", async () => {
  const calls: string[] = [];
  assert.equal(
    (
      await understandNaturalLanguage(
        { text: "What can you help me with?" },
        classifier("unknown", calls),
      )
    ).intent,
    "help",
  );
  assert.equal(
    (
      await understandNaturalLanguage(
        { text: "Please summarize this PDF" },
        classifier("unknown", calls),
      )
    ).intent,
    "analyze_drive_file",
  );
  assert.deepEqual(calls, []);
});

for (const text of [
  "Could you tidy my files?",
  "This folder is cluttered",
  "Please clean up my folder",
]) {
  test(`recognizes a natural folder request: ${text}`, async () => {
    assert.equal(
      (await understandNaturalLanguage({ text }, classifier("unknown"))).intent,
      "organize_folder",
    );
  });
}

for (const text of [
  "Could you review this document?",
  "Help me understand this PDF",
  "Summarize this file",
]) {
  test(`recognizes a natural Drive-file request: ${text}`, async () => {
    assert.equal(
      (await understandNaturalLanguage({ text }, classifier("unknown"))).intent,
      "analyze_drive_file",
    );
  });
}

test("removes links, mentions, controls, and Lark identifiers before NVIDIA", async () => {
  const calls: string[] = [];
  const folderLink =
    "https://synvo-ai.larksuite.com/drive/folder/fldcnApprovedRoot";
  const result = await understandNaturalLanguage(
    {
      text: `@_user_1 Could you handle this? ${folderLink}, om_privateNativeId XtyXfTy1vli5YYd3dIclpdMDg1f\u0000`,
      mentionKeys: ["@_user_1"],
    },
    classifier("organize_folder", calls),
  );

  assert.equal(result.intent, "organize_folder");
  assert.deepEqual(result.links, [folderLink]);
  assert.deepEqual(calls, ["Could you handle this?"]);
});

test("uses NVIDIA only for an unmatched bounded request", async () => {
  const calls: string[] = [];
  const result = await understandNaturalLanguage(
    { text: "Could you make some sense of this for me?" },
    classifier("help", calls),
  );

  assert.equal(result.intent, "help");
  assert.deepEqual(calls, ["Could you make some sense of this for me?"]);
});

for (const text of [
  "Which folder are we working at?",
  "Where are we doing our work right now?",
  "Remind me which workspace this is",
  "I forgot our current working directory",
]) {
  test(`uses semantic classification for a workspace question: ${text}`, async () => {
    const calls: string[] = [];
    const result = await understandNaturalLanguage(
      { text },
      classifier("current_workspace", calls),
    );

    assert.equal(result.intent, "current_workspace");
    assert.deepEqual(calls, [text]);
  });
}

test("keeps an unsupported request unknown", async () => {
  const result = await understandNaturalLanguage(
    { text: "Book me a flight for tomorrow" },
    classifier("unknown"),
  );

  assert.equal(result.intent, "unknown");
  assert.deepEqual(result.links, []);
});

test("fails safely when NVIDIA is unavailable", async () => {
  const result = await understandNaturalLanguage(
    { text: "Could you make some sense of this for me?" },
    {
      async classifyIntent() {
        throw new Error("private provider failure");
      },
    },
  );

  assert.deepEqual(result, {
    intent: "unknown",
    links: [],
    canConfirmApprovedRoot: false,
  });
});

test("requires a link for a named folder instead of assuming the pilot root", async () => {
  const named = await understandNaturalLanguage(
    { text: "Please organize the Finance folder" },
    classifier("organize_folder"),
  );
  const generic = await understandNaturalLanguage(
    { text: "My folder is messy. Could you organize it?" },
    classifier("organize_folder"),
  );

  assert.equal(named.intent, "organize_folder");
  assert.equal(named.canConfirmApprovedRoot, false);
  assert.equal(generic.canConfirmApprovedRoot, true);
});

test("does not call NVIDIA for an overlong request", async () => {
  const calls: string[] = [];
  const result = await understandNaturalLanguage(
    { text: "x".repeat(601) },
    classifier("organize_folder", calls),
  );

  assert.equal(result.intent, "unknown");
  assert.deepEqual(calls, []);
});
