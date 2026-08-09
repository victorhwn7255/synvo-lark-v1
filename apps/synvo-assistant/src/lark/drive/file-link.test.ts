import assert from "node:assert/strict";
import test from "node:test";

import { DriveToolError } from "./errors.js";
import { parseLarkDriveFileLink } from "./file-link.js";

test("parses canonical and copied My Space file links", () => {
  assert.equal(
    parseLarkDriveFileLink("https://synvo-ai.larksuite.com/file/boxcnPdf123"),
    "boxcnPdf123",
  );
  assert.equal(
    parseLarkDriveFileLink(
      "https://synvo-ai.larksuite.com/drive/file/boxcnPdf123?from=space",
    ),
    "boxcnPdf123",
  );
});

for (const value of [
  "not-a-url",
  "http://synvo-ai.larksuite.com/file/boxcnPdf123",
  "https://example.com/file/boxcnPdf123",
  "https://synvo-ai.larksuite.com/drive/folder/boxcnPdf123",
  "https://synvo-ai.larksuite.com/docx/boxcnPdf123",
  "https://synvo-ai.larksuite.com/file/boxcnPdf123/child",
  "https://synvo-ai.larksuite.com/file/boxcnPdf123?download=1",
  "https://synvo-ai.larksuite.com/file/boxcnPdf123#fragment",
  `https://synvo-ai.larksuite.com/file/${"x".repeat(2_100)}`,
]) {
  test(`rejects unsupported file link: ${value}`, () => {
    assert.throws(
      () => parseLarkDriveFileLink(value),
      (error: unknown) =>
        error instanceof DriveToolError &&
        error.safeError.code === "INVALID_FILE_LINK",
    );
  });
}
