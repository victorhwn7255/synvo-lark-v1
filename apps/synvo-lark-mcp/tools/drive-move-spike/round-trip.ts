import { createHash, randomUUID } from "node:crypto";

import type { LarkTokenBroker, TokenCipher } from "@synvo/lark-auth";
import { z } from "zod";

import {
  listFolderCompletely,
  type DriveReader,
  type NativeDriveItem,
} from "../../src/modules/drive/read-client.js";
import {
  DriveMoveError,
  type DriveMover,
  type DriveMoveResult,
} from "../../src/modules/drive/move-client.js";
import { digestFolderToken } from "../../src/modules/drive/folder-link.js";
import type {
  MoveDirection,
  DriveMoveSpikeStore,
  StoredMoveAttempt,
  StoredMutationBatch,
} from "./mutation-repository.js";

export const spikeSourceName =
  "[research] - Agentic Context Engineering Research.pdf";
export const spikeResearchName = "Research";
export const spikeProductName = "Product";
export const driveMoveSpikeOperationKeyPrefix = "phase3:one-file-root-research-root:v1:";

export function driveMoveSpikeOperationKeyForRun(runId: string): string {
  return `${driveMoveSpikeOperationKeyPrefix}${runId}`;
}

const expectedRootName = "Test_Synvo_AI_Assistant";
const expectedFileNames = [
  "[product] - Local_Cocoa_PDF_Chunking_Technical_Guide.pdf",
  "[product] - Local_Cocoa_Technical_Onboarding_Guide.pdf",
  spikeSourceName,
  "[research] - Anthropic Agentic Engineering.pdf",
].sort();

const manifestItemSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  parentToken: z.string().min(1),
  ownerId: z.string().min(1),
});

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.uuid(),
  grantId: z.uuid(),
  requesterOpenId: z.string().min(1),
  tenantKey: z.string().min(1),
  rootToken: z.string().min(1),
  sourceToken: z.string().min(1),
  researchToken: z.string().min(1),
  productToken: z.string().min(1),
  baselineItems: z.array(manifestItemSchema),
});

type DriveMoveSpikeManifest = z.infer<typeof manifestSchema>;

const responseRecordSchema = z.object({
  kind: z.enum(["success", "error"]),
  ambiguous: z.boolean(),
  code: z.string().min(1),
  requestId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});

type ObservedLocation = "ROOT" | "RESEARCH" | "PRODUCT" | "MISSING" | "MULTIPLE";

type DriveMoveSpikeObservation = {
  location: ObservedLocation;
  rootItems: NativeDriveItem[];
  researchItems: NativeDriveItem[];
  productItems: NativeDriveItem[];
};

export type DriveMoveSpikePreparation = {
  batchId: string;
  state: StoredMutationBatch["state"];
  operation: {
    source: typeof spikeSourceName;
    forward: "root -> Research";
    restore: "Research -> root";
  };
  baselineVerified: boolean;
  confirmationRequired: true;
};

export type DriveMoveSpikeExecutionResult = {
  batchId: string;
  state: StoredMutationBatch["state"];
  forwardVerified: boolean;
  restoreVerified: boolean;
  baselineRestored: boolean;
  writeWindowDisabledByProcessExit: true;
};

export type DriveMoveSpikeHarnessOptions = {
  store: DriveMoveSpikeStore;
  tokenBroker: Pick<LarkTokenBroker, "getAccessToken">;
  cipher: TokenCipher;
  reader: DriveReader;
  mover: DriveMover;
  rootToken: string;
  authorizedOpenId: string;
  authorizedTenantKey: string;
  writesEnabled: boolean;
  settle?: () => Promise<void>;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalItems(items: readonly NativeDriveItem[]): Array<{
  token: string;
  name: string;
  type: string;
  parentToken: string;
  ownerId: string;
}> {
  return items
    .map((item) => {
      if (!item.ownerId) {
        throw new Error("PHASE3_OWNER_SIGNAL_MISSING");
      }
      return {
        token: item.token,
        name: item.name,
        type: item.type,
        parentToken: item.parentToken,
        ownerId: item.ownerId,
      };
    })
    .sort((left, right) => left.token.localeCompare(right.token));
}

function baselineDigest(items: DriveMoveSpikeManifest["baselineItems"]): string {
  return digest(JSON.stringify(items));
}

function manifestDigest(manifest: DriveMoveSpikeManifest): string {
  return digest(JSON.stringify(manifest));
}

function manifestAssociatedData(batchId: string): string {
  return `phase3-mutation-manifest:${batchId}:v1`;
}

function attemptAssociatedData(attemptId: string, kind: "intent" | "response" | "observation"): string {
  return `phase3-move-attempt:${attemptId}:${kind}:v1`;
}

function attemptKey(
  manifest: DriveMoveSpikeManifest,
  direction: MoveDirection,
): string {
  const source = direction === "FORWARD" ? manifest.rootToken : manifest.researchToken;
  const destination = direction === "FORWARD" ? manifest.researchToken : manifest.rootToken;
  return digest(
    JSON.stringify({
      schemaVersion: 1,
      fileToken: manifest.sourceToken,
      source,
      destination,
      direction,
    }),
  );
}

function confirmationDigest(batch: StoredMutationBatch): string {
  return digest(
    JSON.stringify({
      schemaVersion: 1,
      batchId: batch.id,
      manifestDigest: batch.manifestDigest,
      confirmation: "CONFIRM_PHASE3_ONE_FILE_ROOT_RESEARCH_ROOT",
    }),
  );
}

function sameBaseline(
  actual: readonly NativeDriveItem[],
  manifest: DriveMoveSpikeManifest,
): boolean {
  try {
    return baselineDigest(canonicalItems(actual)) === baselineDigest(manifest.baselineItems);
  } catch {
    return false;
  }
}

export class DriveMoveSpikeHarness {
  readonly #store: DriveMoveSpikeStore;
  readonly #tokenBroker: Pick<LarkTokenBroker, "getAccessToken">;
  readonly #cipher: TokenCipher;
  readonly #reader: DriveReader;
  readonly #mover: DriveMover;
  readonly #rootToken: string;
  readonly #rootTokenDigest: string;
  readonly #authorizedOpenId: string;
  readonly #authorizedTenantKey: string;
  readonly #writesEnabled: boolean;
  readonly #settle: () => Promise<void>;

  constructor(options: DriveMoveSpikeHarnessOptions) {
    this.#store = options.store;
    this.#tokenBroker = options.tokenBroker;
    this.#cipher = options.cipher;
    this.#reader = options.reader;
    this.#mover = options.mover;
    this.#rootToken = options.rootToken;
    this.#rootTokenDigest = digestFolderToken(options.rootToken);
    this.#authorizedOpenId = options.authorizedOpenId;
    this.#authorizedTenantKey = options.authorizedTenantKey;
    this.#writesEnabled = options.writesEnabled;
    this.#settle = options.settle ?? (() => new Promise((resolve) => setTimeout(resolve, 500)));
  }

  async prepare(): Promise<DriveMoveSpikePreparation> {
    const context = await this.#store.loadLatestCompletedRun();
    if (!context) {
      throw new Error("PHASE3_REAUTH_AND_INVENTORY_REQUIRED");
    }
    if (
      context.requesterOpenId !== this.#authorizedOpenId ||
      context.tenantKey !== this.#authorizedTenantKey
    ) {
      throw new Error("PHASE3_ACTOR_MISMATCH");
    }
    if (context.rootTokenDigest !== this.#rootTokenDigest) {
      throw new Error("PHASE3_ROOT_MISMATCH");
    }
    const accessToken = await this.#tokenBroker.getAccessToken(
      context.requesterOpenId,
      context.tenantKey,
    );
    const rootItems = await listFolderCompletely(this.#reader, {
      accessToken,
      folderToken: this.#rootToken,
    });
    const rootFolders = rootItems.filter((item) => item.type === "folder");
    const rootFiles = rootItems.filter((item) => item.type === "file");
    if (
      rootFolders.length !== 2 ||
      rootFiles.length !== 4 ||
      rootItems.length !== 6 ||
      rootFiles.map((item) => item.name).sort().join("\n") !== expectedFileNames.join("\n")
    ) {
      throw new Error("PHASE3_BASELINE_MISMATCH");
    }
    const exactlyOne = (name: string, type: string): NativeDriveItem => {
      const matches = rootItems.filter((item) => item.name === name && item.type === type);
      if (matches.length !== 1) {
        throw new Error("PHASE3_BASELINE_MISMATCH");
      }
      return matches[0]!;
    };
    const source = exactlyOne(spikeSourceName, "file");
    const research = exactlyOne(spikeResearchName, "folder");
    const product = exactlyOne(spikeProductName, "folder");
    const [researchChildren, productChildren, metadata] = await Promise.all([
      listFolderCompletely(this.#reader, {
        accessToken,
        folderToken: research.token,
      }),
      listFolderCompletely(this.#reader, {
        accessToken,
        folderToken: product.token,
      }),
      this.#reader.getMetadata({
        accessToken,
        documents: [
          { token: this.#rootToken, type: "folder" },
          ...rootItems.map((item) => ({ token: item.token, type: item.type })),
        ],
      }),
    ]);
    if (researchChildren.length !== 0 || productChildren.length !== 0) {
      throw new Error("PHASE3_DESTINATION_NOT_EMPTY");
    }
    const metadataByToken = new Map(metadata.map((item) => [item.token, item]));
    if (metadataByToken.get(this.#rootToken)?.title !== expectedRootName) {
      throw new Error("PHASE3_ROOT_MISMATCH");
    }
    if (
      metadata.length !== rootItems.length + 1 ||
      metadata.some((item) => item.ownerId !== context.requesterOpenId) ||
      rootItems.some(
        (item) =>
          item.parentToken !== this.#rootToken ||
          metadataByToken.get(item.token)?.ownerId !== context.requesterOpenId ||
          metadataByToken.get(item.token)?.title !== item.name,
      )
    ) {
      throw new Error("PHASE3_OWNERSHIP_OR_IDENTITY_MISMATCH");
    }
    const baselineItems = canonicalItems(
      rootItems.map((item) => ({
        ...item,
        ownerId: metadataByToken.get(item.token)?.ownerId,
      })),
    );
    const batchId = randomUUID();
    const manifest: DriveMoveSpikeManifest = {
      schemaVersion: 1,
      runId: context.runId,
      grantId: context.grantId,
      requesterOpenId: context.requesterOpenId,
      tenantKey: context.tenantKey,
      rootToken: this.#rootToken,
      sourceToken: source.token,
      researchToken: research.token,
      productToken: product.token,
      baselineItems,
    };
    const digestValue = manifestDigest(manifest);
    const prepared = await this.#store.prepare({
      id: batchId,
      operationKey: driveMoveSpikeOperationKeyForRun(context.runId),
      context,
      manifestCiphertext: this.#cipher.encrypt(
        JSON.stringify(manifest),
        manifestAssociatedData(batchId),
      ),
      manifestDigest: digestValue,
      baselineDigest: baselineDigest(baselineItems),
    });
    const storedManifest = this.#loadManifest(prepared);
    if (
      prepared.manifestDigest !== manifestDigest(storedManifest) ||
      prepared.baselineDigest !== baselineDigest(storedManifest.baselineItems)
    ) {
      throw new Error("PHASE3_EXISTING_BATCH_MISMATCH");
    }
    return {
      batchId: prepared.id,
      state: prepared.state,
      operation: {
        source: spikeSourceName,
        forward: "root -> Research",
        restore: "Research -> root",
      },
      baselineVerified: true,
      confirmationRequired: true,
    };
  }

  async execute(batchId: string, explicitlyConfirmed: boolean): Promise<DriveMoveSpikeExecutionResult> {
    if (!this.#writesEnabled) {
      throw new Error("PHASE3_WRITE_SWITCH_DISABLED");
    }
    if (!explicitlyConfirmed) {
      throw new Error("PHASE3_EXPLICIT_CONFIRMATION_REQUIRED");
    }
    const existing = await this.#store.loadBatch(batchId);
    if (!existing) {
      throw new Error("PHASE3_BATCH_NOT_FOUND");
    }
    const batch = await this.#store.claimExecution(
      batchId,
      confirmationDigest(existing),
    );
    const manifest = this.#loadManifest(batch);
    if (batch.state === "RESTORED") {
      return {
        batchId,
        state: "RESTORED",
        forwardVerified: true,
        restoreVerified: true,
        baselineRestored: true,
        writeWindowDisabledByProcessExit: true,
      };
    }
    this.#assertManifestBound(batch, manifest);
    const preflight = await this.#observe(manifest);
    if (preflight.location !== "ROOT" || !sameBaseline(preflight.rootItems, manifest)) {
      await this.#store.finishBatch(batchId, "NEEDS_ATTENTION", "PREFLIGHT_MISMATCH");
      throw new Error("PHASE3_PREFLIGHT_MISMATCH");
    }

    const forwardVerified = await this.#runDirection(batch, manifest, "FORWARD");
    if (!forwardVerified) {
      throw new Error("PHASE3_FORWARD_NOT_VERIFIED");
    }
    const restoreVerified = await this.#runDirection(batch, manifest, "RESTORE");
    if (!restoreVerified) {
      throw new Error("PHASE3_RESTORE_NOT_VERIFIED");
    }
    const final = await this.#observe(manifest);
    const restored =
      final.location === "ROOT" &&
      sameBaseline(final.rootItems, manifest) &&
      final.researchItems.length === 0 &&
      final.productItems.length === 0;
    if (!restored) {
      await this.#store.finishBatch(batchId, "NEEDS_ATTENTION", "BASELINE_NOT_RESTORED");
      throw new Error("PHASE3_BASELINE_NOT_RESTORED");
    }
    await this.#store.finishBatch(batchId, "RESTORED");
    return {
      batchId,
      state: "RESTORED",
      forwardVerified,
      restoreVerified,
      baselineRestored: true,
      writeWindowDisabledByProcessExit: true,
    };
  }

  #loadManifest(batch: StoredMutationBatch): DriveMoveSpikeManifest {
    const parsed = manifestSchema.parse(
      JSON.parse(
        this.#cipher.decrypt(
          batch.manifestCiphertext,
          manifestAssociatedData(batch.id),
        ),
      ),
    );
    return parsed;
  }

  #assertManifestBound(batch: StoredMutationBatch, manifest: DriveMoveSpikeManifest): void {
    if (
      batch.manifestDigest !== manifestDigest(manifest) ||
      batch.baselineDigest !== baselineDigest(manifest.baselineItems) ||
      batch.runId !== manifest.runId ||
      batch.grantId !== manifest.grantId ||
      batch.requesterOpenId !== manifest.requesterOpenId ||
      batch.tenantKey !== manifest.tenantKey ||
      batch.rootTokenDigest !== digestFolderToken(manifest.rootToken) ||
      manifest.rootToken !== this.#rootToken ||
      manifest.requesterOpenId !== this.#authorizedOpenId ||
      manifest.tenantKey !== this.#authorizedTenantKey
    ) {
      throw new Error("PHASE3_MANIFEST_BINDING_MISMATCH");
    }
  }

  async #observe(manifest: DriveMoveSpikeManifest): Promise<DriveMoveSpikeObservation> {
    const accessToken = await this.#tokenBroker.getAccessToken(
      manifest.requesterOpenId,
      manifest.tenantKey,
    );
    const [rootItems, researchItems, productItems] = await Promise.all([
      listFolderCompletely(this.#reader, {
        accessToken,
        folderToken: manifest.rootToken,
      }),
      listFolderCompletely(this.#reader, {
        accessToken,
        folderToken: manifest.researchToken,
      }),
      listFolderCompletely(this.#reader, {
        accessToken,
        folderToken: manifest.productToken,
      }),
    ]);
    const locations: ObservedLocation[] = [];
    if (rootItems.some((item) => item.token === manifest.sourceToken)) locations.push("ROOT");
    if (researchItems.some((item) => item.token === manifest.sourceToken)) locations.push("RESEARCH");
    if (productItems.some((item) => item.token === manifest.sourceToken)) locations.push("PRODUCT");
    return {
      location: locations.length === 0 ? "MISSING" : locations.length === 1 ? locations[0]! : "MULTIPLE",
      rootItems,
      researchItems,
      productItems,
    };
  }

  async #observeSettled(manifest: DriveMoveSpikeManifest): Promise<DriveMoveSpikeObservation> {
    let observation = await this.#observe(manifest);
    for (let index = 0; index < 3; index += 1) {
      await this.#settle();
      observation = await this.#observe(manifest);
    }
    return observation;
  }

  async #runDirection(
    batch: StoredMutationBatch,
    manifest: DriveMoveSpikeManifest,
    direction: MoveDirection,
  ): Promise<boolean> {
    const expectedSource: ObservedLocation = direction === "FORWARD" ? "ROOT" : "RESEARCH";
    const expectedDestination: ObservedLocation = direction === "FORWARD" ? "RESEARCH" : "ROOT";
    const destinationToken = direction === "FORWARD" ? manifest.researchToken : manifest.rootToken;
    const attemptId = randomUUID();
    const intent = {
      schemaVersion: 1,
      fileToken: manifest.sourceToken,
      expectedSource,
      destinationToken,
      direction,
    };
    let attempt = await this.#store.ensureAttempt({
      id: attemptId,
      batchId: batch.id,
      direction,
      attemptKey: attemptKey(manifest, direction),
      intentCiphertext: this.#cipher.encrypt(
        JSON.stringify(intent),
        attemptAssociatedData(attemptId, "intent"),
      ),
    });

    let observation = await this.#observeSettled(manifest);
    if (observation.location === expectedDestination) {
      await this.#recordObservation(attempt, observation.location, "VERIFIED");
      return true;
    }
    if (observation.location !== expectedSource) {
      await this.#recordObservation(attempt, observation.location, "NEEDS_ATTENTION", "UNEXPECTED_PARENT");
      await this.#store.finishBatch(batch.id, "NEEDS_ATTENTION", "UNEXPECTED_PARENT");
      return false;
    }

    if (attempt.requestCount > 0) {
      const previous = this.#loadResponse(attempt);
      if (previous?.kind === "success") {
        await this.#recordObservation(attempt, observation.location, "NEEDS_ATTENTION", "SUCCESS_OBSERVATION_DISAGREES");
        await this.#store.finishBatch(batch.id, "NEEDS_ATTENTION", "SUCCESS_OBSERVATION_DISAGREES");
        return false;
      }
      if (previous && !previous.ambiguous) {
        await this.#recordObservation(attempt, observation.location, "FAILED_KNOWN_STATE", previous.code);
        await this.#store.finishBatch(batch.id, "FAILED_KNOWN_STATE", previous.code);
        return false;
      }
      attempt = await this.#store.allowReconciledRetry(attempt.id);
    }

    attempt = await this.#store.beginRequest(attempt.id);
    if (attempt.state !== "REQUESTING") {
      throw new Error("PHASE3_ATTEMPT_NOT_REQUESTABLE");
    }
    const accessToken = await this.#tokenBroker.getAccessToken(
      manifest.requesterOpenId,
      manifest.tenantKey,
    );
    let responseRecord: z.infer<typeof responseRecordSchema>;
    try {
      const response: DriveMoveResult = await this.#mover.moveFile({
        accessToken,
        fileToken: manifest.sourceToken,
        destinationFolderToken: destinationToken,
      });
      responseRecord = {
        kind: "success",
        ambiguous: false,
        code: "OK",
        requestId: response.requestId,
        taskId: response.taskId,
      };
    } catch (error) {
      const normalized =
        error instanceof DriveMoveError
          ? error
          : new DriveMoveError("TEMPORARY", true);
      responseRecord = {
        kind: "error",
        ambiguous: normalized.ambiguous,
        code: normalized.code,
      };
    }
    const responseCiphertext = this.#cipher.encrypt(
      JSON.stringify(responseRecord),
      attemptAssociatedData(attempt.id, "response"),
    );
    await this.#store.recordResponse(
      attempt.id,
      responseCiphertext,
    );
    attempt = { ...attempt, state: "RECONCILING", responseCiphertext };
    observation = await this.#observeSettled(manifest);
    if (observation.location === expectedDestination) {
      await this.#recordObservation(attempt, observation.location, "VERIFIED");
      return true;
    }
    if (observation.location === expectedSource && responseRecord.kind === "error") {
      await this.#recordObservation(attempt, observation.location, "FAILED_KNOWN_STATE", responseRecord.code);
      await this.#store.finishBatch(batch.id, "FAILED_KNOWN_STATE", responseRecord.code);
      return false;
    }
    await this.#recordObservation(
      attempt,
      observation.location,
      "NEEDS_ATTENTION",
      responseRecord.kind === "success" ? "SUCCESS_OBSERVATION_DISAGREES" : "AMBIGUOUS_PARENT",
    );
    await this.#store.finishBatch(
      batch.id,
      "NEEDS_ATTENTION",
      responseRecord.kind === "success" ? "SUCCESS_OBSERVATION_DISAGREES" : "AMBIGUOUS_PARENT",
    );
    return false;
  }

  #loadResponse(attempt: StoredMoveAttempt): z.infer<typeof responseRecordSchema> | null {
    if (!attempt.responseCiphertext) return null;
    return responseRecordSchema.parse(
      JSON.parse(
        this.#cipher.decrypt(
          attempt.responseCiphertext,
          attemptAssociatedData(attempt.id, "response"),
        ),
      ),
    );
  }

  async #recordObservation(
    attempt: StoredMoveAttempt,
    location: ObservedLocation,
    state: "VERIFIED" | "FAILED_KNOWN_STATE" | "NEEDS_ATTENTION",
    errorCode?: string,
  ): Promise<void> {
    await this.#store.recordObservation({
      attemptId: attempt.id,
      state,
      observationCiphertext: this.#cipher.encrypt(
        JSON.stringify({ schemaVersion: 1, location }),
        attemptAssociatedData(attempt.id, "observation"),
      ),
      errorCode,
    });
  }
}
