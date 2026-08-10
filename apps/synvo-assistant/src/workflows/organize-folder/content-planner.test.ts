import assert from "node:assert/strict";
import test from "node:test";

import { SynvoMcpClientError } from "../../mcp/client.js";
import { NimAnalysisError } from "../analyze-attachment/nim-client.js";
import type { DriveFolderInventoryResult } from "./contracts.js";
import { ContentAwareFolderPlanner } from "./content-planner.js";

const fileNames = [
  "document-01.pdf",
  "document-02.pdf",
  "document-03.pdf",
  "document-04.pdf",
];

function inventoryResult(): DriveFolderInventoryResult {
  return {
    ok: true,
    inventory: {
      run_id: "mcp-run",
      complete: true,
      baseline_matches: true,
      root: {
        ref: "root",
        identity_digest: "a".repeat(64),
        name: "Test_Synvo_AI_Assistant",
        parent_ref: null,
        owner_verification: "matched",
        child_count: 6,
      },
      destinations: [
        {
          ref: "d001",
          identity_digest: "b".repeat(64),
          name: "Product",
          parent_ref: "root",
          owner_verification: "matched",
          child_count: 0,
        },
        {
          ref: "d002",
          identity_digest: "c".repeat(64),
          name: "Research",
          parent_ref: "root",
          owner_verification: "matched",
          child_count: 0,
        },
      ],
      files: fileNames.map((name, index) => ({
        ref: `f00${index + 1}`,
        identity_digest: String(index + 1).repeat(64),
        name,
        type: "file",
        parent_ref: "root",
        owner_verification: "matched" as const,
      })),
      skipped: [],
      issues: [],
      summary: {
        root_folder_count: 2,
        root_file_count: 4,
        root_skipped_count: 0,
        destination_child_count: 0,
      },
    },
  };
}

function fixture(options: {
  inventory?: DriveFolderInventoryResult;
  analysisFailure?: string;
  analysisRetryable?: boolean;
  analysisName?: string;
  connectError?: Error;
  classifyError?: Error;
} = {}) {
  const calls = { connect: 0, close: 0, inventory: 0, analyze: [] as string[] };
  let classifierInput: unknown;
  const planner = new ContentAwareFolderPlanner({
    tools: {
      async connect() {
        calls.connect += 1;
        if (options.connectError) throw options.connectError;
      },
      async close() { calls.close += 1; },
      async inventory() {
        calls.inventory += 1;
        return options.inventory ?? inventoryResult();
      },
      async analyze(_folderUrl, fileName) {
        calls.analyze.push(fileName);
        if (options.analysisFailure) {
          return {
            ok: false as const,
            error: {
              message: options.analysisFailure,
              retryable: options.analysisRetryable ?? false,
            },
          };
        }
        return {
          ok: true as const,
          analysis: {
            filename: options.analysisName ?? fileName,
            text: `Analysis for ${fileName}`,
          },
        };
      },
    },
    classifier: {
      async classifyOrganization(input) {
        classifierInput = input;
        if (options.classifyError) throw options.classifyError;
        return fileNames.map((fileName, index) => ({
          file_name: fileName,
          destination: index < 2 ? "Research" as const : "Product" as const,
          rationale: `Evidence for ${fileName}`,
        }));
      },
    },
  });
  return { planner, calls, classifierInput: () => classifierInput };
}

test("inventories once, analyzes every exact filename, and classifies the bounded evidence", async () => {
  const testFixture = fixture();

  const result = await testFixture.planner.plan(
    "https://larksuite.com/drive/folder/fldcnRoot123",
  );

  assert.equal(result.kind, "ready");
  assert.deepEqual(testFixture.calls, {
    connect: 1,
    close: 1,
    inventory: 1,
    analyze: fileNames,
  });
  assert.deepEqual(testFixture.classifierInput(), {
    files: fileNames.map((fileName) => ({
      file_name: fileName,
      analysis: `Analysis for ${fileName}`,
    })),
  });
});

test("stops before analysis when inventory is not ready", async () => {
  const notReady = inventoryResult();
  assert.equal(notReady.ok, true);
  if (notReady.ok) notReady.inventory.baseline_matches = false;
  const testFixture = fixture({ inventory: notReady });

  const result = await testFixture.planner.plan("https://larksuite.com/folder");

  assert.equal(result.kind, "inventory_not_ready");
  assert.deepEqual(testFixture.calls.analyze, []);
  assert.equal(testFixture.classifierInput(), undefined);
  assert.equal(testFixture.calls.close, 1);
});

test("creates no plan after a tool failure or mismatched analyzed filename", async () => {
  const failed = fixture({ analysisFailure: "The PDF could not be analyzed." });
  assert.deepEqual(
    await failed.planner.plan("https://larksuite.com/folder"),
    {
      kind: "failed",
      message: "The PDF could not be analyzed.",
      retryable: false,
    },
  );

  const temporary = fixture({
    analysisFailure: "Lark Drive is temporarily unavailable.",
    analysisRetryable: true,
  });
  assert.deepEqual(
    await temporary.planner.plan("https://larksuite.com/folder"),
    {
      kind: "failed",
      message: "Lark Drive is temporarily unavailable.",
      retryable: true,
    },
  );

  const mismatch = fixture({ analysisName: "another.pdf" });
  assert.deepEqual(
    await mismatch.planner.plan("https://larksuite.com/folder"),
    {
      kind: "failed",
      message: "The analyzed file did not match the requested inventory item.",
      retryable: false,
    },
  );
});

test("maps bounded NVIDIA and MCP failures without exposing native errors", async () => {
  const modelFailure = fixture({
    classifyError: new NimAnalysisError(
      "RATE_LIMITED",
      "private provider body",
      true,
    ),
  });
  assert.deepEqual(
    await modelFailure.planner.plan("https://larksuite.com/folder"),
    {
      kind: "failed",
      message: "The analysis service is busy right now. Please try again in a moment.",
      retryable: true,
    },
  );

  const mcpFailure = fixture({
    connectError: new SynvoMcpClientError("private endpoint detail"),
  });
  assert.deepEqual(
    await mcpFailure.planner.plan("https://larksuite.com/folder"),
    {
      kind: "failed",
      message: "The read-only Synvo tools are temporarily unavailable.",
      retryable: true,
    },
  );
  assert.equal(mcpFailure.calls.close, 1);
});
