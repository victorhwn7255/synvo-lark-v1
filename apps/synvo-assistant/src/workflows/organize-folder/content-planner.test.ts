import assert from "node:assert/strict";
import test from "node:test";

import { NimAnalysisError } from "../analyze-attachment/nim-client.js";
import type { WorkspaceDriveInventory } from "../analyze-drive-file/authorized-reader.js";
import type { KnowledgeRepresentativeEvidence } from "../knowledge/repository.js";
import { ContentAwareFolderPlanner, snapshotWorkspaceInventory } from "./content-planner.js";

const RUN_ID = "93e2548b-8f12-45a2-be12-cd7009341b17";
const identity = { requesterOpenId: "ou_victor", tenantKey: "tenant_synvo" };

function workspace(count = 15): WorkspaceDriveInventory {
  return {
    rootToken: "root-token",
    folders: [
      { token: "folder-inbox", name: "Inbox", relativePath: "Inbox", parentToken: "root-token", depth: 1, ownedByRequester: true },
      { token: "folder-engineering", name: "Engineering", relativePath: "Engineering", parentToken: "root-token", depth: 1, ownedByRequester: true },
    ],
    files: Array.from({ length: count }, (_, index) => ({
      token: `file-${index + 1}`,
      name: `document-${index + 1}.pdf`,
      fileName: `document-${index + 1}.pdf`,
      relativePath: `Inbox / document-${index + 1}.pdf`,
      parentToken: "folder-inbox",
      parentPath: "Inbox",
      depth: 2,
      version: "1",
    })),
  };
}

function evidenceFor(observed: WorkspaceDriveInventory) {
  return observed.files.map((file) => ({
    file,
    chunks: [{
      sourceKey: file.token,
      sourceName: file.relativePath,
      sourceVersionOrHash: file.version,
      pageNumber: 1,
      text: `Evidence for ${file.fileName}`,
    } satisfies KnowledgeRepresentativeEvidence],
  }));
}

function fixture(options: {
  changedWorkspace?: WorkspaceDriveInventory;
  invalidProfileCoverage?: boolean;
  invalidDecisionCoverage?: boolean;
  classifierError?: Error;
  profileThemes?: (index: number) => string[];
  taxonomy?: Array<{ name: string; description: string }>;
} = {}) {
  const observed = workspace();
  const calls = { inspect: 0, prepare: 0, profile: 0, taxonomy: 0, classify: 0 };
  const order: string[] = [];
  const planner = new ContentAwareFolderPlanner({
    reader: {
      async inspectWorkspace() {
        calls.inspect += 1;
        return options.changedWorkspace ?? observed;
      },
    },
    knowledge: {
      async prepareWorkspaceOrganization(files) {
        calls.prepare += 1;
        order.push("knowledge");
        assert.equal(files.length, 15);
        return evidenceFor(observed);
      },
    },
    classifier: {
      async profileWorkspaceDocuments(input) {
        calls.profile += 1;
        order.push("profile");
        if (options.classifierError) throw options.classifierError;
        const documents = options.invalidProfileCoverage ? input.documents.slice(1) : input.documents;
        return documents.map((document, index) => ({
          document_id: document.document_id,
          summary: `Profile ${document.document_id}`,
          themes: options.profileThemes?.(index) ?? ["engineering"],
        }));
      },
      async proposeWorkspaceTaxonomy(input) {
        calls.taxonomy += 1;
        order.push("taxonomy");
        assert.ok(input.existing_folder_names.includes("Engineering"));
        return options.taxonomy ?? [
          { name: "Engineering", description: "Implementation and architecture." },
          { name: "Research", description: "Research and analysis." },
          { name: "Operations", description: "Operating policies and procedures." },
        ];
      },
      async classifyWorkspaceDocuments(input) {
        calls.classify += 1;
        order.push("classify");
        const profiles = options.invalidDecisionCoverage ? input.profiles.slice(1) : input.profiles;
        const destinations = options.taxonomy?.map((folder) => folder.name) ??
          ["Engineering", "Research", "Operations"];
        return profiles.map((profile, index) => ({
          document_id: profile.document_id,
          destination: destinations[index % destinations.length]!,
          rationale: "The evidence matches this destination.",
        }));
      },
    },
  });
  return { planner, observed, calls, order };
}

test("profiles and classifies every PDF in bounded batches", async () => {
  const testFixture = fixture();
  const result = await testFixture.planner.plan(
    RUN_ID,
    identity,
    snapshotWorkspaceInventory(RUN_ID, testFixture.observed),
  );
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.equal(result.decisions.length, 15);
  assert.equal(result.taxonomy.length, 3);
  assert.deepEqual(testFixture.calls, {
    inspect: 1,
    prepare: 1,
    profile: 2,
    taxonomy: 1,
    classify: 2,
  });
  assert.equal(testFixture.order[0], "knowledge");
  assert.equal(testFixture.order.indexOf("knowledge") < testFixture.order.indexOf("profile"), true);
});

test("stops before providers if the consented snapshot changed", async () => {
  const testFixture = fixture({ changedWorkspace: workspace(14) });
  const result = await testFixture.planner.plan(
    RUN_ID,
    identity,
    snapshotWorkspaceInventory(RUN_ID, workspace(15)),
  );
  assert.equal(result.kind, "inventory_not_ready");
  assert.deepEqual(testFixture.calls, { inspect: 1, prepare: 0, profile: 0, taxonomy: 0, classify: 0 });
});

test("rejects incomplete provider coverage", async (t) => {
  for (const key of ["invalidProfileCoverage", "invalidDecisionCoverage"] as const) {
    await t.test(key, async () => {
      const testFixture = fixture({ [key]: true });
      const result = await testFixture.planner.plan(
        RUN_ID,
        identity,
        snapshotWorkspaceInventory(RUN_ID, testFixture.observed),
      );
      assert.deepEqual(result, {
        kind: "failed",
        message: key === "invalidProfileCoverage"
          ? "NVIDIA returned incomplete workspace document profiles."
          : "NVIDIA returned incomplete workspace document decisions.",
        retryable: false,
      });
    });
  }
});

test("preserves bounded retryability from the NVIDIA boundary", async () => {
  const testFixture = fixture({
    classifierError: new NimAnalysisError("RATE_LIMITED", "NVIDIA is busy.", true),
  });
  assert.deepEqual(await testFixture.planner.plan(
    RUN_ID,
    identity,
    snapshotWorkspaceInventory(RUN_ID, testFixture.observed),
  ), { kind: "failed", message: "NVIDIA is busy.", retryable: true });
});

test("accepts one folder for a demonstrably homogeneous workspace", async () => {
  const testFixture = fixture({
    taxonomy: [{ name: "Engineering", description: "Engineering material." }],
  });
  const result = await testFixture.planner.plan(
    RUN_ID,
    identity,
    snapshotWorkspaceInventory(RUN_ID, testFixture.observed),
  );
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.equal(result.taxonomy.length, 1);
});

test("rejects one folder for a mixed workspace with three or more PDFs", async () => {
  const testFixture = fixture({
    profileThemes: (index) => [index % 2 === 0 ? "engineering" : "finance"],
    taxonomy: [{ name: "Company", description: "All company material." }],
  });
  const result = await testFixture.planner.plan(
    RUN_ID,
    identity,
    snapshotWorkspaceInventory(RUN_ID, testFixture.observed),
  );
  assert.deepEqual(result, {
    kind: "failed",
    message: "NVIDIA returned an invalid folder count.",
    retryable: false,
  });
});

test("accepts an existing folder name without asking NVIDIA to decide reuse", async () => {
  const testFixture = fixture({
    taxonomy: [{ name: "Engineering", description: "Engineering material." }],
  });
  const result = await testFixture.planner.plan(
    RUN_ID,
    identity,
    snapshotWorkspaceInventory(RUN_ID, testFixture.observed),
  );
  assert.equal(result.kind, "ready");
});
