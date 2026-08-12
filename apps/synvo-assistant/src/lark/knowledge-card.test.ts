import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKnowledgeAnswerCard,
  buildKnowledgeConsentCard,
  buildKnowledgeProgressCard,
  buildKnowledgeRefreshProposalCard,
  parseKnowledgeCardAction,
} from "./knowledge-card.js";

test("consent card exposes only the three explicit PDF choices", () => {
  const card = buildKnowledgeConsentCard({
    filename: "Quarterly Strategy.pdf",
    sourceMessageId: "om_source",
    workspaceName: "Test_Synvo_AI_Assistant",
  });
  const rendered = JSON.stringify(card);
  assert.match(rendered, /Add to knowledge/u);
  assert.match(rendered, /Analyze once/u);
  assert.match(rendered, /Not now/u);
  assert.match(rendered, /original PDF will not be copied, moved, or changed/u);
  assert.equal(rendered.includes("file_key"), false);
});

test("knowledge card actions accept only bounded exact values", () => {
  assert.deepEqual(
    parseKnowledgeCardAction({
      knowledge_action: "attachment_add",
      source_message_id: "om_source",
    }),
    { type: "attachment_add", sourceMessageId: "om_source" },
  );
  assert.deepEqual(
    parseKnowledgeCardAction({ knowledge_action: "attachment_not_now" }),
    { type: "attachment_not_now" },
  );
  assert.equal(
    parseKnowledgeCardAction({
      knowledge_action: "attachment_add",
      source_message_id: "https://external.example/file",
    }),
    null,
  );
  assert.equal(
    parseKnowledgeCardAction({ knowledge_action: "arbitrary_tool" }),
    null,
  );
  assert.deepEqual(
    parseKnowledgeCardAction({
      knowledge_action: "refresh_stop",
      job_id: "ca55f05b-f138-41a1-8a73-7cf609866d79",
    }),
    {
      type: "refresh_stop",
      jobId: "ca55f05b-f138-41a1-8a73-7cf609866d79",
    },
  );
});

test("refresh progress shows one stop button and a monotonic file and batch bar", () => {
  const card = buildKnowledgeProgressCard({
    stage: "refreshing",
    message: "Embedding chunks",
    jobId: "ca55f05b-f138-41a1-8a73-7cf609866d79",
    completedFiles: 2,
    totalFiles: 5,
    currentFile: "Guide.pdf",
    chunkCount: 12,
    completedBatches: 3,
    totalBatches: 4,
  });
  const rendered = JSON.stringify(card);
  assert.match(rendered, /2 of 5 files/u);
  assert.match(rendered, /Guide\.pdf/u);
  assert.match(rendered, /12 chunks created/u);
  assert.match(rendered, /3 of 4 batches/u);
  assert.match(rendered, /Stop update/u);
  assert.equal((rendered.match(/refresh_stop/gu) ?? []).length, 1);
});

test("stopping and stopped cards cannot request another cancellation", () => {
  const stopping = JSON.stringify(buildKnowledgeProgressCard({
    stage: "stopping",
    message: "Stopping safely.",
    jobId: "ca55f05b-f138-41a1-8a73-7cf609866d79",
  }));
  assert.equal(stopping.includes("refresh_stop"), false);
  assert.equal(stopping.includes("Resume update"), false);

  const stopped = JSON.stringify(buildKnowledgeProgressCard({
    stage: "stopped",
    message: "Stopped safely.",
    jobId: "ca55f05b-f138-41a1-8a73-7cf609866d79",
  }));
  assert.equal(stopped.includes("refresh_stop"), false);
  assert.match(stopped, /Resume update/u);
  assert.match(stopped, /refresh_propose/u);
});

test("completed ingestion offers confirmed removal without exposing source identity", () => {
  const card = buildKnowledgeProgressCard({
    stage: "complete",
    message: "Added.",
    sourceName: "Guide.pdf",
    sourceReference: "v1.opaque.ciphertext.tag",
  });
  const rendered = JSON.stringify(card);
  assert.match(rendered, /Remove from knowledge/u);
  assert.match(rendered, /v1\.opaque\.ciphertext\.tag/u);
  assert.equal(rendered.includes("om_source"), false);
});

test("an insufficient answer links to the workspace without proposing a refresh", () => {
  const card = buildKnowledgeAnswerCard(
    {
      supported: false,
      answer: "The vault does not contain enough evidence.",
      citations: [],
    },
    new URL("https://larksuite.com/drive/folder/approved-root"),
  );
  const rendered = JSON.stringify(card);
  assert.match(rendered, /You may want to:/u);
  assert.match(rendered, /Open workspace/u);
  assert.match(rendered, /approved-root/u);
  assert.equal(rendered.includes("Prepare workspace knowledge"), false);
  assert.equal(rendered.includes("refresh_propose"), false);
});

test("grounded answer separates subdued source citations from the answer", () => {
  const card = buildKnowledgeAnswerCard({
    supported: true,
    answer: "The comparison page has the highest legal risk.",
    citations: [
      { sourceName: "marketing-launch-brief-cocoa-2.pdf", pageNumber: 2 },
    ],
  });
  const elements = card.elements ?? [];
  assert.equal(elements[0]?.tag, "div");
  assert.equal(elements[1]?.tag, "hr");
  assert.equal(elements[2]?.tag, "note");
  assert.match(JSON.stringify(elements[2]), /Sources/u);
  assert.match(JSON.stringify(elements[2]), /marketing-launch-brief-cocoa-2\.pdf/u);
});

test("a current knowledge vault renders no empty Lark action row", () => {
  const card = buildKnowledgeRefreshProposalCard({
    files: [],
    pathUpdates: [],
    removedSources: [],
    hasChanges: false,
    snapshot: "unused",
  });
  const rendered = JSON.stringify(card);
  assert.equal(rendered.includes('"tag":"action"'), false);
  assert.equal(rendered.includes("Sources to remove from knowledge"), false);
});

test("knowledge refresh lists missing sources only when removal is proposed", () => {
  const card = buildKnowledgeRefreshProposalCard({
    files: [],
    pathUpdates: [],
    removedSources: [{ name: "Old policy.pdf" }, { name: "Legacy guide.pdf" }],
    hasChanges: true,
    snapshot: "approved-snapshot",
  });
  const rendered = JSON.stringify(card);
  assert.match(rendered, /Sources to remove from knowledge: 2/u);
  assert.match(rendered, /Old policy\.pdf/u);
  assert.match(rendered, /Legacy guide\.pdf/u);
});

test("knowledge refresh groups safe relative-path updates without native identifiers", () => {
  const card = buildKnowledgeRefreshProposalCard({
    files: [{ name: "Product / New Guide.pdf" }],
    pathUpdates: [{
      name: "Research / ACE.pdf",
      previousName: "Archive / ACE.pdf",
    }],
    removedSources: [{ name: "Old Research / Retired.pdf" }],
    hasChanges: true,
    snapshot: "opaque-approved-snapshot",
  });
  const rendered = JSON.stringify(card);
  assert.match(rendered, /PDFs to add or refresh/u);
  assert.match(rendered, /Product \/ New Guide\.pdf/u);
  assert.match(rendered, /Paths to update without reprocessing/u);
  assert.match(rendered, /Research \/ ACE\.pdf/u);
  assert.match(rendered, /Previously: Archive \/ ACE\.pdf/u);
  assert.match(rendered, /Sources to remove from knowledge: 1/u);
  assert.equal(rendered.includes("folder_token"), false);
  assert.equal(rendered.includes("file_token"), false);
  assert.equal(rendered.includes("https://"), false);
});
