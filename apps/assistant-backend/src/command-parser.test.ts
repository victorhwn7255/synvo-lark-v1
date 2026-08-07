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
});

test("rejects missing or extra organize-folder arguments", () => {
  assert.deepEqual(parseCommand("/organize-folder"), { type: "unknown" });
  assert.deepEqual(parseCommand("/organize-folder one two"), {
    type: "unknown",
  });
  assert.deepEqual(parseCommand("/organize-wiki"), { type: "unknown" });
});
