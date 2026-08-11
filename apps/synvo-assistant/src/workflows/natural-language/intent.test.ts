import assert from "node:assert/strict";
import test from "node:test";

import { understandNaturalLanguage } from "./intent.js";

function classifier(
  intent:
    | "greeting"
    | "acknowledgement"
    | "help"
    | "current_workspace"
    | "ask_workspace"
    | "organize_folder"
    | "analyze_drive_file"
    | "unknown",
  calls: string[] = [],
  folderReference:
    | "active_workspace"
    | "named_or_other_folder"
    | "none" = "none",
) {
  return {
    async classifyIntent(input: { text: string }) {
      calls.push(input.text);
      return { intent, folder_reference: folderReference } as const;
    },
  };
}

for (const text of [
  "Hello",
  "hey there",
  "Hey, good morning!",
  "Greetings everyone",
]) {
  test(`handles an unambiguous social greeting locally: ${text}`, async () => {
    const calls: string[] = [];
    const result = await understandNaturalLanguage(
      { text },
      classifier("ask_workspace", calls),
    );

    assert.equal(result.intent, "greeting");
    assert.deepEqual(calls, []);
  });
}

test("uses semantic classification for a greeting outside the local safe case", async () => {
  const calls: string[] = [];
  const result = await understandNaturalLanguage(
    { text: "Are you online?" },
    classifier("greeting", calls),
  );

  assert.equal(result.intent, "greeting");
  assert.deepEqual(calls, ["Are you online?"]);
});

test("gives an actionable organize request precedence over its greeting", async () => {
  const calls: string[] = [];
  const result = await understandNaturalLanguage(
    { text: "Hello, could you organize my messy folder?" },
    classifier("organize_folder", calls, "active_workspace"),
  );

  assert.equal(result.intent, "organize_folder");
  assert.equal(result.folder_reference, "active_workspace");
  assert.deepEqual(calls, ["Hello, could you organize my messy folder?"]);
});

test("routes help and common actionable requests semantically", async () => {
  const calls: string[] = [];
  assert.equal(
    (
      await understandNaturalLanguage(
        { text: "What can you help me with?" },
        classifier("help", calls),
      )
    ).intent,
    "help",
  );
  assert.equal(
    (
      await understandNaturalLanguage(
        { text: "Please summarize this PDF" },
        classifier("analyze_drive_file", calls),
      )
    ).intent,
    "analyze_drive_file",
  );
  assert.deepEqual(calls, [
    "What can you help me with?",
    "Please summarize this PDF",
  ]);
});

for (const text of [
  "Could you tidy my files?",
  "This folder is cluttered",
  "Please clean up my folder",
]) {
  test(`recognizes a natural folder request: ${text}`, async () => {
    const result = await understandNaturalLanguage(
      { text },
      classifier("organize_folder", [], "active_workspace"),
    );
    assert.equal(result.intent, "organize_folder");
    assert.equal(result.folder_reference, "active_workspace");
  });
}

for (const text of [
  "What do our files say about PDF chunking?",
  "Compare the recommendations in the workspace documents",
  "According to our knowledge, how should retrieval work?",
  "How soon after an expense must I submit my claim?",
  "Which receipts do I need for reimbursement?",
]) {
  test(`recognizes a semantic workspace knowledge question: ${text}`, async () => {
    const result = await understandNaturalLanguage(
      { text },
      classifier("ask_workspace"),
    );
    assert.equal(result.intent, "ask_workspace");
    assert.equal(result.sanitizedText, text);
  });
}

for (const text of [
  "Could you review this document?",
  "Help me understand this PDF",
  "Summarize this file",
]) {
  test(`recognizes a natural Drive-file request: ${text}`, async () => {
    assert.equal(
      (
        await understandNaturalLanguage(
          { text },
          classifier("analyze_drive_file"),
        )
      ).intent,
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
    classifier("organize_folder", calls, "active_workspace"),
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

for (const text of ["Thanks!", "Okay, got it", "That sounds good"]) {
  test(`understands a friendly acknowledgement: ${text}`, async () => {
    const calls: string[] = [];
    const result = await understandNaturalLanguage(
      { text },
      classifier("acknowledgement", calls),
    );

    assert.equal(result.intent, "acknowledgement");
    assert.deepEqual(calls, [text]);
  });
}

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
    folder_reference: "none",
    links: [],
    sanitizedText: "Could you make some sense of this for me?",
  });
});

test("uses the bounded semantic folder reference instead of phrase matching", async () => {
  const named = await understandNaturalLanguage(
    { text: "Please organize the Finance folder" },
    classifier("organize_folder", [], "named_or_other_folder"),
  );
  const generic = await understandNaturalLanguage(
    { text: "Please straighten out the workspace we are using" },
    classifier("organize_folder", [], "active_workspace"),
  );

  assert.equal(named.intent, "organize_folder");
  assert.equal(named.folder_reference, "named_or_other_folder");
  assert.equal(generic.folder_reference, "active_workspace");
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
