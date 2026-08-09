import assert from "node:assert/strict";
import test from "node:test";

import {
  boundExtractedPdfText,
  extractPdfText,
  normalizePdfInputError,
  PdfInputError,
  withPdfTimeout,
} from "./pdf.js";

function escapePdfText(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function buildPdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const pageObjectIds = pageTexts.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pageTexts.forEach((text, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const stream = text
      ? `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`
      : "";
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body);
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

test("extracts text and page count from a valid PDF", async () => {
  const result = await extractPdfText(buildPdf(["Hello Synvo", "Second page"]));
  assert.equal(result.pageCount, 2);
  assert.match(result.text, /Hello Synvo/u);
  assert.match(result.text, /Second page/u);
  assert.equal(result.truncated, false);
});

test("rejects invalid and empty PDFs safely", async () => {
  await assert.rejects(
    extractPdfText(Buffer.from("not a PDF")),
    (error: unknown) => error instanceof PdfInputError && error.code === "MALFORMED",
  );
  await assert.rejects(
    extractPdfText(buildPdf([""])),
    (error: unknown) => error instanceof PdfInputError && error.code === "NO_TEXT",
  );
});

test("rejects PDFs over the page limit before text extraction", async () => {
  await assert.rejects(
    extractPdfText(buildPdf(Array.from({ length: 51 }, () => "page"))),
    (error: unknown) =>
      error instanceof PdfInputError && error.code === "TOO_MANY_PAGES",
  );
});

test("truncates extracted text deterministically by Unicode code point", () => {
  const result = boundExtractedPdfText("😀".repeat(100_100));
  assert.equal(Array.from(result.text).length, 100_000);
  assert.equal(result.truncated, true);
});

test("normalizes encrypted and parser failures without provider detail", () => {
  const encrypted = normalizePdfInputError({
    name: "PasswordException",
    message: "private parser diagnostics",
  });
  assert.equal(encrypted.code, "ENCRYPTED");
  assert.equal(encrypted.message.includes("private parser diagnostics"), false);

  const malformed = normalizePdfInputError(new Error("private malformed detail"));
  assert.equal(malformed.code, "MALFORMED");
  assert.equal(malformed.message.includes("private malformed detail"), false);
});

test("bounds an extraction stage with a timeout", async () => {
  await assert.rejects(
    withPdfTimeout(new Promise<never>(() => {}), 1),
    (error: unknown) => error instanceof PdfInputError && error.code === "TIMEOUT",
  );
});
