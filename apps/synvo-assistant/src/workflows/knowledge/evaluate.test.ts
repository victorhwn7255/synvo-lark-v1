import assert from "node:assert/strict";
import test from "node:test";

import { validateRetrievalEvaluation } from "./evaluate.js";

function fixture() {
  return {
    version: 1,
    purpose: "test",
    corpusRoot: "docs/pdf",
    notes: [],
    cases: Array.from({ length: 24 }, (_, index) =>
      index < 22
        ? {
            id: `answerable-${index}`,
            question: "What is supported?",
            answerability: "answerable",
            expectedEvidence: [{ file: "source.pdf", page: 1 }],
            expectedAnswerFacts: ["supported fact"],
          }
        : {
            id: `unsupported-${index}`,
            question: "What is absent?",
            answerability: "insufficient_evidence",
            expectedEvidence: [],
            expectedAnswerFacts: [],
          },
    ),
  };
}

test("validates the fixed Phase 13 retrieval contract", () => {
  assert.deepEqual(
    validateRetrievalEvaluation(fixture(), new Map([["source.pdf", 2]])),
    {
      cases: 24,
      answerable: 22,
      insufficientEvidence: 2,
      referencedFiles: 1,
    },
  );
});

test("rejects evidence outside the verified PDF page range", () => {
  const value = fixture();
  value.cases[0]!.expectedEvidence[0]!.page = 3;
  assert.throws(
    () => validateRetrievalEvaluation(value, new Map([["source.pdf", 2]])),
    /Invalid evidence page/u,
  );
});
