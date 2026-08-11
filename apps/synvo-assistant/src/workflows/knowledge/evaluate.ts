import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { PDFParse } from "pdf-parse";
import { z } from "zod";

const evidenceSchema = z.object({
  file: z.string().min(1),
  page: z.number().int().positive(),
}).strict();
const caseSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  answerability: z.enum(["answerable", "insufficient_evidence"]),
  minimumEvidenceMatches: z.number().int().positive().optional(),
  expectedEvidence: z.array(evidenceSchema),
  expectedAnswerFacts: z.array(z.string().min(1)),
}).strict();
const fixtureSchema = z.object({
  version: z.literal(1),
  purpose: z.string().min(1),
  corpusRoot: z.string().min(1),
  notes: z.array(z.string()),
  cases: z.array(caseSchema).length(24),
}).strict();

export type RetrievalEvaluationSummary = {
  cases: number;
  answerable: number;
  insufficientEvidence: number;
  referencedFiles: number;
};

export function validateRetrievalEvaluation(
  value: unknown,
  pageCounts: ReadonlyMap<string, number>,
): RetrievalEvaluationSummary {
  const fixture = fixtureSchema.parse(value);
  const ids = new Set<string>();
  const referencedFiles = new Set<string>();
  let answerable = 0;
  let insufficientEvidence = 0;

  for (const evaluationCase of fixture.cases) {
    if (ids.has(evaluationCase.id)) {
      throw new Error(`Duplicate evaluation case: ${evaluationCase.id}`);
    }
    ids.add(evaluationCase.id);
    if (evaluationCase.answerability === "answerable") {
      answerable += 1;
      if (
        evaluationCase.expectedEvidence.length === 0 ||
        evaluationCase.expectedAnswerFacts.length === 0
      ) {
        throw new Error(`Answerable case lacks evidence or facts: ${evaluationCase.id}`);
      }
    } else {
      insufficientEvidence += 1;
      if (
        evaluationCase.expectedEvidence.length !== 0 ||
        evaluationCase.expectedAnswerFacts.length !== 0
      ) {
        throw new Error(`Insufficient-evidence case contains expected evidence: ${evaluationCase.id}`);
      }
    }
    for (const evidence of evaluationCase.expectedEvidence) {
      const pages = pageCounts.get(evidence.file);
      if (!pages || evidence.page > pages) {
        throw new Error(
          `Invalid evidence page for ${evaluationCase.id}: ${evidence.file} page ${evidence.page}`,
        );
      }
      referencedFiles.add(evidence.file);
    }
  }

  return {
    cases: fixture.cases.length,
    answerable,
    insufficientEvidence,
    referencedFiles: referencedFiles.size,
  };
}

async function pdfPageCount(path: string): Promise<number> {
  const parser = new PDFParse({ data: await readFile(path) });
  try {
    return (await parser.getInfo()).total;
  } finally {
    await parser.destroy();
  }
}

async function main(): Promise<void> {
  const fixturePath = resolve(
    process.cwd(),
    "tests/fixtures/phase13-retrieval-evaluation.json",
  );
  const value: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
  const fixture = fixtureSchema.parse(value);
  const filenames = new Set(
    fixture.cases.flatMap((evaluationCase) =>
      evaluationCase.expectedEvidence.map((evidence) => evidence.file),
    ),
  );
  const pageCounts = new Map<string, number>();
  for (const filename of filenames) {
    pageCounts.set(
      filename,
      await pdfPageCount(resolve(process.cwd(), fixture.corpusRoot, filename)),
    );
  }
  const summary = validateRetrievalEvaluation(fixture, pageCounts);
  console.log(JSON.stringify({ status: "usable", ...summary }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
