import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { TokenCipher } from "@synvo/lark-auth";

import type {
  DriveListPage,
  DriveReader,
  NativeDriveItem,
  NativeDriveMetadata,
} from "../../src/modules/drive/read-client.js";
import {
  DriveMoveError,
  type DriveMover,
  type DriveMoveResult,
} from "../../src/modules/drive/move-client.js";
import { digestFolderToken } from "../../src/modules/drive/folder-link.js";
import {
  DriveMoveSpikeHarness,
  spikeProductName,
  spikeResearchName,
  spikeSourceName,
} from "./round-trip.js";
import type {
  MoveAttemptState,
  MutationBatchState,
  DriveMoveSpikeStore,
  DriveMoveSpikeRunContext,
  StoredMoveAttempt,
  StoredMutationBatch,
} from "./mutation-repository.js";

const rootToken = "root-token";
const researchToken = "research-token";
const productToken = "product-token";
const sourceToken = "source-token";
const actor = "actor-open-id";
const tenant = "tenant-key";

const names = [
  spikeSourceName,
  "[research] - Anthropic Agentic Engineering.pdf",
  "[product] - Local_Cocoa_PDF_Chunking_Technical_Guide.pdf",
  "[product] - Local_Cocoa_Technical_Onboarding_Guide.pdf",
];

type World = {
  sourceLocation: "ROOT" | "RESEARCH" | "PRODUCT" | "MISSING";
  researchExists: boolean;
};

function item(
  token: string,
  name: string,
  type: string,
  parentToken: string,
): NativeDriveItem {
  return { token, name, type, parentToken, ownerId: actor };
}

function rootItems(world: World): NativeDriveItem[] {
  const folders = [item(productToken, spikeProductName, "folder", rootToken)];
  if (world.researchExists) {
    folders.push(item(researchToken, spikeResearchName, "folder", rootToken));
  }
  const files = names.map((name, index) =>
    item(index === 0 ? sourceToken : `file-${index}`, name, "file", rootToken),
  );
  return [
    ...folders,
    ...files.filter(
      (candidate) => candidate.token !== sourceToken || world.sourceLocation === "ROOT",
    ),
  ];
}

class WorldReader implements DriveReader {
  constructor(readonly world: World) {}

  async listFolderPage(input: {
    folderToken: string;
  }): Promise<DriveListPage> {
    let items: NativeDriveItem[] = [];
    if (input.folderToken === rootToken) items = rootItems(this.world);
    if (input.folderToken === researchToken && this.world.sourceLocation === "RESEARCH") {
      items = [item(sourceToken, spikeSourceName, "file", researchToken)];
    }
    if (input.folderToken === productToken && this.world.sourceLocation === "PRODUCT") {
      items = [item(sourceToken, spikeSourceName, "file", productToken)];
    }
    return { items, hasMore: false };
  }

  async getMetadata(input: {
    documents: Array<{ token: string; type: string }>;
  }): Promise<NativeDriveMetadata[]> {
    const byToken = new Map(rootItems(this.world).map((value) => [value.token, value]));
    return input.documents.map((document) => {
      if (document.token === rootToken) {
        return {
          token: rootToken,
          type: "folder",
          title: "Test_Synvo_AI_Assistant",
          ownerId: actor,
          createdTime: "1",
          modifiedTime: "1",
        };
      }
      const value = byToken.get(document.token);
      if (!value) throw new Error("missing metadata");
      return {
        token: value.token,
        type: value.type,
        title: value.name,
        ownerId: actor,
        createdTime: "1",
        modifiedTime: "1",
      };
    });
  }
}

class MemoryStore implements DriveMoveSpikeStore {
  readonly context: DriveMoveSpikeRunContext = {
    runId: randomUUID(),
    grantId: randomUUID(),
    requesterOpenId: actor,
    tenantKey: tenant,
    rootTokenDigest: digestFolderToken(rootToken),
  };
  batch: StoredMutationBatch | null = null;
  attempts = new Map<string, StoredMoveAttempt>();
  crashAfterBeginOnce = false;

  async loadLatestCompletedRun(): Promise<DriveMoveSpikeRunContext | null> {
    return this.context;
  }
  async prepare(input: {
    id: string;
    operationKey: string;
    context: DriveMoveSpikeRunContext;
    manifestCiphertext: string;
    manifestDigest: string;
    baselineDigest: string;
  }): Promise<StoredMutationBatch> {
    if (!this.batch) {
      this.batch = {
        id: input.id,
        operationKey: input.operationKey,
        ...input.context,
        manifestCiphertext: input.manifestCiphertext,
        manifestDigest: input.manifestDigest,
        baselineDigest: input.baselineDigest,
        state: "PREPARED",
        confirmationDigest: null,
        confirmedAt: null,
        executionAttempt: 0,
      };
    }
    return this.batch;
  }
  async loadBatch(): Promise<StoredMutationBatch | null> {
    return this.batch;
  }
  async claimExecution(_batchId: string, confirmationDigest: string): Promise<StoredMutationBatch> {
    if (!this.batch) throw new Error("missing");
    if (this.batch.state === "RESTORED") return this.batch;
    if (this.batch.state !== "PREPARED" && this.batch.state !== "EXECUTING") {
      throw new Error("not executable");
    }
    this.batch = {
      ...this.batch,
      state: "EXECUTING",
      confirmationDigest,
      confirmedAt: new Date(),
      executionAttempt: this.batch.executionAttempt + 1,
    };
    return this.batch;
  }
  async ensureAttempt(input: {
    id: string;
    batchId: string;
    direction: "FORWARD" | "RESTORE";
    attemptKey: string;
    intentCiphertext: string;
  }): Promise<StoredMoveAttempt> {
    const previous = this.attempts.get(input.direction);
    if (previous) return previous;
    const created: StoredMoveAttempt = {
      ...input,
      state: "INTENT_RECORDED",
      requestCount: 0,
      responseCiphertext: null,
      observationCiphertext: null,
      lastErrorCode: null,
    };
    this.attempts.set(input.direction, created);
    return created;
  }
  async beginRequest(attemptId: string): Promise<StoredMoveAttempt> {
    const value = this.findAttempt(attemptId);
    if (value.state === "INTENT_RECORDED" && value.requestCount < 3) {
      Object.assign(value, { state: "REQUESTING", requestCount: value.requestCount + 1 });
    }
    if (this.crashAfterBeginOnce) {
      this.crashAfterBeginOnce = false;
      throw new Error("simulated worker crash");
    }
    return { ...value };
  }
  async allowReconciledRetry(attemptId: string): Promise<StoredMoveAttempt> {
    const value = this.findAttempt(attemptId);
    value.state = "INTENT_RECORDED";
    return { ...value };
  }
  async recordResponse(attemptId: string, responseCiphertext: string): Promise<void> {
    Object.assign(this.findAttempt(attemptId), {
      responseCiphertext,
      state: "RECONCILING",
    });
  }
  async recordObservation(input: {
    attemptId: string;
    state: MoveAttemptState;
    observationCiphertext: string;
    errorCode?: string;
  }): Promise<void> {
    Object.assign(this.findAttempt(input.attemptId), {
      state: input.state,
      observationCiphertext: input.observationCiphertext,
      lastErrorCode: input.errorCode ?? null,
    });
  }
  async finishBatch(_id: string, state: MutationBatchState): Promise<void> {
    if (!this.batch) throw new Error("missing");
    this.batch = { ...this.batch, state };
  }
  findAttempt(id: string): StoredMoveAttempt {
    const value = [...this.attempts.values()].find((attempt) => attempt.id === id);
    if (!value) throw new Error("missing attempt");
    return value;
  }
}

class WorldMover implements DriveMover {
  calls = 0;
  constructor(
    readonly world: World,
    readonly behavior: "apply" | "forbidden" | "timeout-before" | "timeout-after" | "rate-limit" | "temporary" | "success-without-apply" = "apply",
  ) {}
  async moveFile(input: { destinationFolderToken: string }): Promise<DriveMoveResult> {
    this.calls += 1;
    if (this.behavior === "forbidden") throw new DriveMoveError("FORBIDDEN", false);
    if (this.behavior === "timeout-before") throw new DriveMoveError("TIMEOUT", true);
    if (this.behavior === "rate-limit") throw new DriveMoveError("RATE_LIMITED", false);
    if (this.behavior === "temporary") throw new DriveMoveError("TEMPORARY", true);
    if (this.behavior !== "success-without-apply") {
      this.world.sourceLocation =
        input.destinationFolderToken === researchToken ? "RESEARCH" : "ROOT";
    }
    if (this.behavior === "timeout-after") throw new DriveMoveError("TIMEOUT", true);
    return { requestId: `request-${this.calls}` };
  }
}

function fixture(behavior?: ConstructorParameters<typeof WorldMover>[1]) {
  const world: World = { sourceLocation: "ROOT", researchExists: true };
  const store = new MemoryStore();
  const mover = new WorldMover(world, behavior);
  const cipher = new TokenCipher(Buffer.alloc(32, 7));
  const options = {
    store,
    tokenBroker: { getAccessToken: async () => "access" },
    cipher,
    reader: new WorldReader(world),
    mover,
    rootToken,
    authorizedOpenId: actor,
    authorizedTenantKey: tenant,
    settle: async () => {},
  };
  return {
    world,
    store,
    mover,
    prepareHarness: new DriveMoveSpikeHarness({ ...options, writesEnabled: false }),
    executeHarness: new DriveMoveSpikeHarness({ ...options, writesEnabled: true }),
  };
}

test("completes exactly one verified root-Research-root round trip", async () => {
  const value = fixture();
  const prepared = await value.prepareHarness.prepare();
  assert.deepEqual(prepared.operation, {
    source: spikeSourceName,
    forward: "root -> Research",
    restore: "Research -> root",
  });
  const result = await value.executeHarness.execute(prepared.batchId, true);
  assert.equal(result.state, "RESTORED");
  assert.equal(result.baselineRestored, true);
  assert.equal(value.world.sourceLocation, "ROOT");
  assert.equal(value.mover.calls, 2);
  assert.equal(value.store.attempts.get("FORWARD")?.requestCount, 1);
  assert.equal(value.store.attempts.get("RESTORE")?.requestCount, 1);
  assert.ok(value.store.batch);
  assert.doesNotMatch(value.store.batch.manifestCiphertext, /source-token|root-token/);
});

test("duplicate execution returns the restored batch without another move", async () => {
  const value = fixture();
  const prepared = await value.prepareHarness.prepare();
  await value.executeHarness.execute(prepared.batchId, true);
  await value.executeHarness.execute(prepared.batchId, true);
  assert.equal(value.mover.calls, 2);
});

test("requires the ephemeral write flag and explicit confirmation", async () => {
  const value = fixture();
  const prepared = await value.prepareHarness.prepare();
  await assert.rejects(
    value.prepareHarness.execute(prepared.batchId, true),
    /PHASE3_WRITE_SWITCH_DISABLED/,
  );
  await assert.rejects(
    value.executeHarness.execute(prepared.batchId, false),
    /PHASE3_EXPLICIT_CONFIRMATION_REQUIRED/,
  );
  assert.equal(value.mover.calls, 0);
});

test("fails before writing when the source moved manually after prepare", async () => {
  const value = fixture();
  const prepared = await value.prepareHarness.prepare();
  value.world.sourceLocation = "PRODUCT";
  await assert.rejects(
    value.executeHarness.execute(prepared.batchId, true),
    /PHASE3_PREFLIGHT_MISMATCH/,
  );
  assert.equal(value.mover.calls, 0);
  assert.equal(value.store.batch?.state, "NEEDS_ATTENTION");
});

test("fails preparation when the approved destination is missing", async () => {
  const value = fixture();
  value.world.researchExists = false;
  await assert.rejects(value.prepareHarness.prepare(), /PHASE3_BASELINE_MISMATCH/);
  assert.equal(value.mover.calls, 0);
});

test("reconciles permission, timeout-before, 429, and 5xx failures to the known root", async (t) => {
  for (const behavior of ["forbidden", "timeout-before", "rate-limit", "temporary"] as const) {
    await t.test(behavior, async () => {
      const value = fixture(behavior);
      const prepared = await value.prepareHarness.prepare();
      await assert.rejects(
        value.executeHarness.execute(prepared.batchId, true),
        /PHASE3_FORWARD_NOT_VERIFIED/,
      );
      assert.equal(value.world.sourceLocation, "ROOT");
      assert.equal(value.store.batch?.state, "FAILED_KNOWN_STATE");
      assert.equal(value.mover.calls, 1);
    });
  }
});

test("resumes a crash after durable request intent by reconciling before retry", async () => {
  const value = fixture();
  const prepared = await value.prepareHarness.prepare();
  value.store.crashAfterBeginOnce = true;
  await assert.rejects(
    value.executeHarness.execute(prepared.batchId, true),
    /simulated worker crash/,
  );
  assert.equal(value.store.attempts.get("FORWARD")?.state, "REQUESTING");
  assert.equal(value.world.sourceLocation, "ROOT");

  const result = await value.executeHarness.execute(prepared.batchId, true);
  assert.equal(result.state, "RESTORED");
  assert.equal(value.store.attempts.get("FORWARD")?.requestCount, 2);
  assert.equal(value.mover.calls, 2);
});

test("treats a lost response after Lark applies the move as verified", async () => {
  const value = fixture("timeout-after");
  const prepared = await value.prepareHarness.prepare();
  const result = await value.executeHarness.execute(prepared.batchId, true);
  assert.equal(result.state, "RESTORED");
  assert.equal(value.store.attempts.get("FORWARD")?.state, "VERIFIED");
  assert.equal(value.store.attempts.get("RESTORE")?.state, "VERIFIED");
  assert.equal(value.world.sourceLocation, "ROOT");
});

test("enters needs-attention when a success response disagrees with observation", async () => {
  const value = fixture("success-without-apply");
  const prepared = await value.prepareHarness.prepare();
  await assert.rejects(
    value.executeHarness.execute(prepared.batchId, true),
    /PHASE3_FORWARD_NOT_VERIFIED/,
  );
  assert.equal(value.store.batch?.state, "NEEDS_ATTENTION");
  assert.equal(value.world.sourceLocation, "ROOT");
});
