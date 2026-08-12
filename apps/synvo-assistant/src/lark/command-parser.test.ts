import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand } from "./command-parser.js";

test("recognizes /ping with harmless whitespace and casing", () => {
  assert.deepEqual(parseCommand("  /PING\n"), { type: "ping" });
});

test("parses the workspace command with an optional exact link", () => {
  assert.deepEqual(
    parseCommand(
      "/organize-workspace https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123",
    ),
    {
      type: "organize-workspace",
      folderLink:
        "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123",
    },
  );
  assert.deepEqual(parseCommand("/organize-workspace"), {
    type: "organize-workspace",
  });
});

test("rejects obsolete or malformed workspace commands", () => {
  assert.deepEqual(parseCommand("/organize-folder"), { type: "unknown" });
  assert.deepEqual(parseCommand("/organize-workspace one two"), {
    type: "unknown",
  });
  assert.deepEqual(parseCommand("/organize-wiki"), { type: "unknown" });
});

test("parses one analyze-file link", () => {
  assert.deepEqual(
    parseCommand("/analyze-file https://synvo-ai.larksuite.com/file/boxcnPdf123"),
    {
      type: "analyze-file",
      fileLink: "https://synvo-ai.larksuite.com/file/boxcnPdf123",
    },
  );
});

test("leaves ordinary employee language for semantic routing", () => {
  assert.deepEqual(
    parseCommand(
      "organize this folder https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123",
    ),
    { type: "unknown" },
  );
  assert.deepEqual(
    parseCommand(
      "analyze this file https://synvo-ai.larksuite.com/file/boxcnPdf123",
    ),
    { type: "unknown" },
  );
});

test("rejects missing or extra analyze-file arguments", () => {
  assert.deepEqual(parseCommand("/analyze-file"), { type: "unknown" });
  assert.deepEqual(parseCommand("/analyze-file one two"), {
    type: "unknown",
  });
});

test("parses workspace approval decisions with one proposal ID", () => {
  assert.deepEqual(parseCommand("/approve-workspace proposal-id"), {
    type: "decide-workspace",
    proposalId: "proposal-id",
    decision: "APPROVED",
  });
  assert.deepEqual(parseCommand(" /REJECT-workspace proposal-id "), {
    type: "decide-workspace",
    proposalId: "proposal-id",
    decision: "REJECTED",
  });
});

test("rejects missing, extra, or obsolete proposal decision arguments", () => {
  assert.deepEqual(parseCommand("/approve-workspace"), { type: "unknown" });
  assert.deepEqual(parseCommand("/reject-workspace one two"), {
    type: "unknown",
  });
  assert.deepEqual(parseCommand("/approve-folder proposal-id"), { type: "unknown" });
});

test("parses one separately confirmed workspace undo command", () => {
  assert.deepEqual(parseCommand(" /UNDO-workspace proposal-id "), {
    type: "undo-workspace",
    proposalId: "proposal-id",
  });
  assert.deepEqual(parseCommand("/undo-workspace"), { type: "unknown" });
  assert.deepEqual(parseCommand("/undo-workspace one two"), {
    type: "unknown",
  });
  assert.deepEqual(parseCommand("/undo-folder proposal-id"), { type: "unknown" });
});
