import assert from "node:assert/strict";
import test from "node:test";

import type { ExtractedPdf } from "../analyze-attachment/pdf.js";
import { ANALYZE_ATTACHMENT_MAX_TEXT_CODE_POINTS } from "../analyze-attachment/policy.js";
import { chunkPdfForKnowledge } from "./chunking.js";
import {
  KNOWLEDGE_CHUNK_MAX_CODE_POINTS,
  KNOWLEDGE_CHUNK_OVERLAP_CODE_POINTS,
  KNOWLEDGE_MAX_INDEXED_CODE_POINTS,
} from "./policy.js";

function pdf(pages: Array<{ pageNumber: number; text: string }>): ExtractedPdf {
  return {
    pages,
    text: pages.map((page) => page.text).join("\n\n"),
    pageCount: pages.length,
    truncated: false,
  };
}

test("creates deterministic page-aware chunks without empty pages", () => {
  const input = pdf([
    { pageNumber: 1, text: "Architecture\n\n" + "First paragraph. ".repeat(180) },
    { pageNumber: 2, text: "" },
    { pageNumber: 3, text: "Operations\n\nA short operational note." },
  ]);
  const first = chunkPdfForKnowledge(input);
  const second = chunkPdfForKnowledge(input);

  assert.deepEqual(first, second);
  assert.ok(first.length >= 2);
  assert.deepEqual(new Set(first.map((chunk) => chunk.pageNumber)), new Set([1, 3]));
  assert.ok(first.every((chunk, index) => chunk.chunkIndex === index));
  assert.ok(
    first.every(
      (chunk) => Array.from(chunk.text).length <= KNOWLEDGE_CHUNK_MAX_CODE_POINTS,
    ),
  );
  assert.equal(first.at(-1)?.heading, "Operations");
});

test("keeps overlap bounded and never crosses pages", () => {
  const repeated = Array.from(
    { length: 10 },
    (_, index) => `Paragraph ${index}. ${"bounded evidence ".repeat(35)}`,
  ).join("\n\n");
  const chunks = chunkPdfForKnowledge(
    pdf([
      { pageNumber: 1, text: repeated },
      { pageNumber: 2, text: "Second page only." },
    ]),
  );
  const firstPage = chunks.filter((chunk) => chunk.pageNumber === 1);
  assert.ok(firstPage.length > 1);
  for (let index = 1; index < firstPage.length; index += 1) {
    const previous = firstPage[index - 1]?.text ?? "";
    const current = firstPage[index]?.text ?? "";
    const maximumOverlap = previous
      .slice(-KNOWLEDGE_CHUNK_OVERLAP_CODE_POINTS);
    assert.ok(current.startsWith(maximumOverlap) || maximumOverlap.length === 0);
  }
  assert.equal(chunks.at(-1)?.text, "Second page only.");
});

test("rejects PDFs without indexable text", () => {
  assert.throws(
    () => chunkPdfForKnowledge(pdf([{ pageNumber: 1, text: " \n\n " }])),
    /no indexable text/u,
  );
});

test("accepts the maximum extracted text budget after adding bounded overlap", () => {
  const source = Array.from("Evidence sentence. ".repeat(6_000))
    .slice(0, ANALYZE_ATTACHMENT_MAX_TEXT_CODE_POINTS)
    .join("");
  const chunks = chunkPdfForKnowledge(
    pdf([{ pageNumber: 1, text: source }]),
  );
  const storedCodePoints = chunks.reduce(
    (total, chunk) => total + Array.from(chunk.text).length,
    0,
  );

  assert.ok(storedCodePoints > Array.from(source).length);
  assert.ok(storedCodePoints <= KNOWLEDGE_MAX_INDEXED_CODE_POINTS);
});
