import assert from "node:assert/strict";
import test from "node:test";

import { parseCommand } from "./command-parser.js";

test("recognizes /ping with harmless whitespace and casing", () => {
  assert.deepEqual(parseCommand("  /PING\n"), { type: "ping" });
});

test("parses one organize-folder link", () => {
  assert.deepEqual(
    parseCommand(
      "/organize-folder https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123",
    ),
    {
      type: "organize-folder",
      folderLink:
        "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123",
    },
  );
  assert.deepEqual(
    parseCommand(
      "organize this folder https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123",
    ),
    {
      type: "organize-folder",
      folderLink:
        "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123",
    },
  );
});

test("rejects missing or extra organize-folder arguments", () => {
  assert.deepEqual(parseCommand("/organize-folder"), { type: "unknown" });
  assert.deepEqual(parseCommand("/organize-folder one two"), {
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
  assert.deepEqual(
    parseCommand("analyze this file https://synvo-ai.larksuite.com/file/boxcnPdf123"),
    {
      type: "analyze-file",
      fileLink: "https://synvo-ai.larksuite.com/file/boxcnPdf123",
    },
  );
});

test("rejects missing or extra analyze-file arguments", () => {
  assert.deepEqual(parseCommand("/analyze-file"), { type: "unknown" });
  assert.deepEqual(parseCommand("/analyze-file one two"), {
    type: "unknown",
  });
});

test("parses approve and reject commands with one proposal ID", () => {
  assert.deepEqual(parseCommand("/approve-folder proposal-id"), {
    type: "decide-folder",
    proposalId: "proposal-id",
    decision: "APPROVED",
  });
  assert.deepEqual(parseCommand(" /REJECT-folder proposal-id "), {
    type: "decide-folder",
    proposalId: "proposal-id",
    decision: "REJECTED",
  });
});

test("rejects missing or extra proposal decision arguments", () => {
  assert.deepEqual(parseCommand("/approve-folder"), { type: "unknown" });
  assert.deepEqual(parseCommand("/reject-folder one two"), {
    type: "unknown",
  });
});

test("parses one separately confirmed undo command", () => {
  assert.deepEqual(parseCommand(" /UNDO-folder proposal-id "), {
    type: "undo-folder",
    proposalId: "proposal-id",
  });
  assert.deepEqual(parseCommand("/undo-folder"), { type: "unknown" });
  assert.deepEqual(parseCommand("/undo-folder one two"), {
    type: "unknown",
  });
});
