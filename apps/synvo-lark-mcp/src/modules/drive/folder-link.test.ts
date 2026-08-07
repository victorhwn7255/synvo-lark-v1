import assert from "node:assert/strict";
import test from "node:test";

import { DriveToolError } from "./errors.js";
import {
  parseLarkDriveFolderLink,
  requireAllowlistedRoot,
} from "./folder-link.js";

for (const [label, link] of [
  [
    "an exact My Space path",
    "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123",
  ],
  [
    "a copied My Space link",
    "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123?from=space",
  ],
] as const) {
  test(`parses ${label}`, () => {
    assert.equal(parseLarkDriveFolderLink(link), "fldcnRoot123");
  });
}

for (const [label, link] of [
  ["an external link", "https://example.com/drive/folder/fldcnRoot123"],
  ["a My Space root link", "https://synvo-ai.larksuite.com/drive/home/"],
  ["a malformed link", "not-a-url"],
  ["a Wiki path", "https://synvo-ai.larksuite.com/wiki/folder/fldcnRoot123"],
  [
    "an unrelated Lark-host path",
    "https://synvo-ai.larksuite.com/anything/folder/fldcnRoot123",
  ],
  [
    "a nested Drive path",
    "https://synvo-ai.larksuite.com/drive/archive/folder/fldcnRoot123",
  ],
  [
    "a doubled path separator",
    "https://synvo-ai.larksuite.com/drive//folder/fldcnRoot123",
  ],
  [
    "a nested suffix",
    "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123/edit",
  ],
  [
    "an unsupported query",
    "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123?from=wiki",
  ],
  [
    "an additional query parameter",
    "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123?from=space&redirect=external",
  ],
  [
    "a duplicate query parameter",
    "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123?from=space&from=space",
  ],
  [
    "a fragment",
    "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123#secret",
  ],
] as const) {
  test(`rejects ${label}`, () => {
    assert.throws(
      () => parseLarkDriveFolderLink(link),
      (error: unknown) =>
        error instanceof DriveToolError &&
        error.safeError.code === "INVALID_FOLDER_LINK",
    );
  });
}

test("compares the parsed token to the exact allowlisted root", () => {
  assert.doesNotThrow(() =>
    requireAllowlistedRoot("fldcnRoot123", "fldcnRoot123"),
  );
  assert.throws(
    () => requireAllowlistedRoot("fldcnSibling", "fldcnRoot123"),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "ROOT_NOT_ALLOWLISTED" &&
      !error.message.includes("fldcnSibling"),
  );
});

for (const [label, candidateToken] of [
  ["Shared Folder", "fldcnShared123"],
  ["same-name folder with a different token", "fldcnDuplicateName123"],
] as const) {
  test(`rejects a ${label} before Drive listing`, () => {
    assert.throws(
      () => requireAllowlistedRoot(candidateToken, "fldcnRoot123"),
      (error: unknown) =>
        error instanceof DriveToolError &&
        error.safeError.code === "ROOT_NOT_ALLOWLISTED" &&
        !error.message.includes(candidateToken),
    );
  });
}
