import type { ExtractedPdf } from "../analyze-attachment/pdf.js";
import {
  KNOWLEDGE_CHUNK_MAX_CODE_POINTS,
  KNOWLEDGE_CHUNK_OVERLAP_CODE_POINTS,
  KNOWLEDGE_CHUNK_TARGET_CODE_POINTS,
  KNOWLEDGE_MAX_CHUNKS_PER_FILE,
  KNOWLEDGE_MAX_INDEXED_CODE_POINTS,
} from "./policy.js";

export type KnowledgeTextChunk = {
  pageNumber: number;
  heading: string | null;
  chunkIndex: number;
  text: string;
};

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function takeCodePoints(value: string, start: number, end?: number): string {
  return Array.from(value).slice(start, end).join("");
}

function normalizePage(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function looksLikeHeading(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 120 &&
    !/[.!?]$/u.test(trimmed) &&
    trimmed.split(/\s+/u).length <= 14
  );
}

function splitLongBlock(value: string): string[] {
  const result: string[] = [];
  let remaining = value.trim();
  while (codePointLength(remaining) > KNOWLEDGE_CHUNK_MAX_CODE_POINTS) {
    const candidate = takeCodePoints(
      remaining,
      0,
      KNOWLEDGE_CHUNK_MAX_CODE_POINTS,
    );
    const boundary = Math.max(
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf("; "),
      candidate.lastIndexOf(" "),
    );
    const cut = boundary >= KNOWLEDGE_CHUNK_TARGET_CODE_POINTS
      ? boundary + 1
      : KNOWLEDGE_CHUNK_MAX_CODE_POINTS;
    result.push(takeCodePoints(remaining, 0, cut).trim());
    remaining = takeCodePoints(remaining, cut).trim();
  }
  if (remaining) {
    result.push(remaining);
  }
  return result;
}

export function chunkPdfForKnowledge(pdf: ExtractedPdf): KnowledgeTextChunk[] {
  const chunks: KnowledgeTextChunk[] = [];
  let indexedCodePoints = 0;

  const addChunk = (
    pageNumber: number,
    heading: string | null,
    text: string,
  ): void => {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    const length = codePointLength(normalized);
    if (
      chunks.length >= KNOWLEDGE_MAX_CHUNKS_PER_FILE ||
      indexedCodePoints + length > KNOWLEDGE_MAX_INDEXED_CODE_POINTS
    ) {
      throw new Error("The PDF exceeds the knowledge indexing limit");
    }
    chunks.push({
      pageNumber,
      heading,
      chunkIndex: chunks.length,
      text: normalized,
    });
    indexedCodePoints += length;
  };

  for (const page of pdf.pages) {
    const normalized = normalizePage(page.text);
    if (!normalized) {
      continue;
    }
    const paragraphs = normalized
      .split(/\n{2,}/u)
      .map((paragraph) => paragraph.replace(/\s*\n\s*/gu, " ").trim())
      .filter(Boolean)
      .flatMap(splitLongBlock);
    let heading: string | null = null;
    let buffer = "";

    const flush = (): void => {
      if (!buffer) {
        return;
      }
      const emitted = buffer;
      addChunk(page.pageNumber, heading, emitted);
      buffer = codePointLength(emitted) > KNOWLEDGE_CHUNK_OVERLAP_CODE_POINTS
        ? takeCodePoints(
            emitted,
            codePointLength(emitted) - KNOWLEDGE_CHUNK_OVERLAP_CODE_POINTS,
          ).trim()
        : "";
    };

    for (const paragraph of paragraphs) {
      if (looksLikeHeading(paragraph)) {
        heading = paragraph;
      }
      const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (
        buffer &&
        codePointLength(candidate) > KNOWLEDGE_CHUNK_TARGET_CODE_POINTS
      ) {
        flush();
      }
      const next = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (codePointLength(next) > KNOWLEDGE_CHUNK_MAX_CODE_POINTS) {
        flush();
        addChunk(page.pageNumber, heading, paragraph);
        buffer = "";
      } else {
        buffer = next;
      }
    }
    flush();
  }

  if (chunks.length === 0) {
    throw new Error("The PDF has no indexable text");
  }
  return chunks;
}
