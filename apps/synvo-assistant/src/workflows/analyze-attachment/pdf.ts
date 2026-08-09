import { PDFParse } from "pdf-parse";

import {
  ANALYZE_ATTACHMENT_MAX_PAGES,
  ANALYZE_ATTACHMENT_MAX_TEXT_CODE_POINTS,
  ANALYZE_ATTACHMENT_PDF_TIMEOUT_MS,
} from "./policy.js";

export class PdfInputError extends Error {
  readonly code: "MALFORMED" | "ENCRYPTED" | "TOO_MANY_PAGES" | "NO_TEXT" | "TIMEOUT";

  constructor(code: PdfInputError["code"], message: string) {
    super(message);
    this.name = "PdfInputError";
    this.code = code;
  }
}

export type ExtractedPdf = {
  text: string;
  pageCount: number;
  truncated: boolean;
};

export function withPdfTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PdfInputError("TIMEOUT", "PDF extraction timed out.")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function normalizeText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function boundExtractedPdfText(value: string): {
  text: string;
  truncated: boolean;
} {
  const normalized = normalizeText(value);
  const codePoints = Array.from(normalized);
  return {
    text: codePoints
      .slice(0, ANALYZE_ATTACHMENT_MAX_TEXT_CODE_POINTS)
      .join(""),
    truncated: codePoints.length > ANALYZE_ATTACHMENT_MAX_TEXT_CODE_POINTS,
  };
}

export function normalizePdfInputError(error: unknown): PdfInputError {
  if (error instanceof PdfInputError) {
    return error;
  }
  if (typeof error !== "object" || error === null) {
    return new PdfInputError("MALFORMED", "The PDF could not be read safely.");
  }
  const record = error as Record<string, unknown>;
  const encrypted =
    record.name === "PasswordException" ||
    (typeof record.message === "string" && /password|encrypted/iu.test(record.message));
  return encrypted
    ? new PdfInputError("ENCRYPTED", "Encrypted PDFs are not supported in the pilot.")
    : new PdfInputError("MALFORMED", "The PDF could not be read safely.");
}

export async function extractPdfText(bytes: Buffer): Promise<ExtractedPdf> {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new PdfInputError("MALFORMED", "The attachment is not a valid PDF.");
  }

  const parser = new PDFParse({
    data: bytes,
    isEvalSupported: false,
    stopAtErrors: true,
  });
  try {
    const info = await withPdfTimeout(
      parser.getInfo(),
      ANALYZE_ATTACHMENT_PDF_TIMEOUT_MS,
    );
    if (info.total < 1) {
      throw new PdfInputError("MALFORMED", "The PDF has no pages.");
    }
    if (info.total > ANALYZE_ATTACHMENT_MAX_PAGES) {
      throw new PdfInputError(
        "TOO_MANY_PAGES",
        `The PDF exceeds the ${ANALYZE_ATTACHMENT_MAX_PAGES}-page pilot limit.`,
      );
    }

    const result = await withPdfTimeout(
      parser.getText({ pageJoiner: "\n\n" }),
      ANALYZE_ATTACHMENT_PDF_TIMEOUT_MS,
    );
    const boundedText = boundExtractedPdfText(result.text);
    if (!boundedText.text) {
      throw new PdfInputError(
        "NO_TEXT",
        "The PDF does not contain extractable text.",
      );
    }

    return {
      text: boundedText.text,
      pageCount: info.total,
      truncated: boundedText.truncated,
    };
  } catch (error) {
    throw normalizePdfInputError(error);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
