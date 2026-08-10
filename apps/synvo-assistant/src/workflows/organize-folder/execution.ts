import type {
  DriveReader,
  NativeDriveItem,
} from "../../lark/drive/index.js";
import { listFolderCompletely } from "../../lark/drive/index.js";
import type { DriveInventory } from "./contracts.js";
import type { AllowlistedFolderObservation } from "../../lark/drive/index.js";
import type { OrganizeFolderProposal } from "./proposal.js";

export type ExecutionStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "UNKNOWN"
  | "STALE";

export type UndoStatus =
  | "REQUESTED"
  | "RUNNING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "UNKNOWN";

export type FileOperationStatus =
  | "PENDING"
  | "REQUESTING"
  | "VERIFIED"
  | "FAILED"
  | "UNKNOWN";

export type ObservedParent =
  | "ROOT"
  | "DESTINATION"
  | "OTHER_DESTINATION"
  | "MISSING"
  | "MULTIPLE";

export type ExecutionMove = {
  fileRef: string;
  fileName: string;
  fileToken: string;
  originalFolderToken: string;
  destinationRef: string;
  destinationName: "Product" | "Research";
  destinationFolderToken: string;
  status: FileOperationStatus;
  observedParent?: ObservedParent;
  attemptedAt?: string;
  verifiedAt?: string;
  errorCode?: string;
};

export type UndoMove = {
  fileRef: string;
  status: FileOperationStatus;
  observedParent?: ObservedParent;
  attemptedAt?: string;
  verifiedAt?: string;
  errorCode?: string;
};

export type OrganizeFolderExecutionRecord = {
  proposalId: string;
  startedAt: string;
  finishedAt?: string;
  errorCode?: string;
  moves: ExecutionMove[];
  undo?: {
    requestedByOpenId: string;
    requestedAt: string;
    startedAt?: string;
    finishedAt?: string;
    errorCode?: string;
    moves: UndoMove[];
  };
};

export function executionAssociatedData(runId: string): string {
  return `organize-folder-run:${runId}:execution:v1`;
}

function comparableInventory(inventory: DriveInventory): unknown {
  return {
    complete: inventory.complete,
    baseline_matches: inventory.baseline_matches,
    root: inventory.root,
    destinations: inventory.destinations,
    files: inventory.files,
    skipped: inventory.skipped,
    issues: inventory.issues,
    summary: inventory.summary,
  };
}

export function inventoryMatchesApprovedSnapshot(
  approved: DriveInventory,
  observed: DriveInventory,
): boolean {
  return (
    observed.baseline_matches &&
    JSON.stringify(comparableInventory(approved)) ===
      JSON.stringify(comparableInventory(observed))
  );
}

export function inventoryMatchesExecutionTarget(
  record: OrganizeFolderExecutionRecord,
  observed: DriveInventory,
): boolean {
  const expectedByDestination = new Map<string, number>();
  for (const move of record.moves) {
    expectedByDestination.set(
      move.destinationRef,
      (expectedByDestination.get(move.destinationRef) ?? 0) + 1,
    );
  }

  return (
    observed.complete &&
    observed.files.length === 0 &&
    observed.skipped.length === 0 &&
    observed.summary.root_file_count === 0 &&
    observed.summary.root_skipped_count === 0 &&
    observed.summary.root_folder_count === expectedByDestination.size &&
    observed.root.child_count === expectedByDestination.size &&
    observed.destinations.length === expectedByDestination.size &&
    observed.summary.destination_child_count === record.moves.length &&
    observed.destinations.every(
      (destination) =>
        expectedByDestination.get(destination.ref) === destination.child_count,
    )
  );
}

export function createExecutionRecord(
  proposal: OrganizeFolderProposal,
  observation: AllowlistedFolderObservation,
  now: Date,
): OrganizeFolderExecutionRecord {
  const files = new Map(observation.native.files.map((item) => [item.ref, item]));
  const destinations = new Map(
    observation.native.destinations.map((item) => [item.ref, item]),
  );
  const moves = proposal.moves.map((move): ExecutionMove => {
    const file = files.get(move.file_ref);
    const destination = destinations.get(move.destination_ref);
    const observedFile = observation.inventory.files.find(
      (item) => item.ref === move.file_ref,
    );
    const observedDestination = observation.inventory.destinations.find(
      (item) => item.ref === move.destination_ref,
    );
    if (
      !file ||
      !destination ||
      !observedFile ||
      !observedDestination ||
      file.name !== move.file_name ||
      destination.name !== move.destination_name ||
      observedFile.identity_digest !== move.file_identity_digest ||
      observedDestination.identity_digest !== move.destination_identity_digest
    ) {
      throw new Error("EXECUTION_PREFLIGHT_IDENTITY_MISMATCH");
    }
    return {
      fileRef: move.file_ref,
      fileName: move.file_name,
      fileToken: file.token,
      originalFolderToken: observation.native.rootToken,
      destinationRef: move.destination_ref,
      destinationName: move.destination_name,
      destinationFolderToken: destination.token,
      status: "PENDING",
    };
  });
  return {
    proposalId: proposal.proposal_id,
    startedAt: now.toISOString(),
    moves,
  };
}

function locationForFile(
  move: ExecutionMove,
  root: readonly NativeDriveItem[],
  destinations: ReadonlyMap<string, readonly NativeDriveItem[]>,
): ObservedParent {
  const locations: ObservedParent[] = [];
  if (root.some((item) => item.token === move.fileToken)) {
    locations.push("ROOT");
  }
  for (const [token, items] of destinations) {
    if (!items.some((item) => item.token === move.fileToken)) {
      continue;
    }
    locations.push(
      token === move.destinationFolderToken
        ? "DESTINATION"
        : "OTHER_DESTINATION",
    );
  }
  if (locations.length === 0) {
    return "MISSING";
  }
  return locations.length === 1 ? locations[0]! : "MULTIPLE";
}

export async function observeExecutionParents(
  reader: DriveReader,
  input: {
    accessToken: string;
    record: OrganizeFolderExecutionRecord;
  },
): Promise<Map<string, ObservedParent>> {
  const rootToken = input.record.moves[0]?.originalFolderToken;
  if (!rootToken) {
    throw new Error("EXECUTION_RECORD_EMPTY");
  }
  const destinationTokens = [
    ...new Set(input.record.moves.map((move) => move.destinationFolderToken)),
  ];
  const [rootItems, ...destinationItems] = await Promise.all([
    listFolderCompletely(reader, {
      accessToken: input.accessToken,
      folderToken: rootToken,
    }),
    ...destinationTokens.map((folderToken) =>
      listFolderCompletely(reader, {
        accessToken: input.accessToken,
        folderToken,
      }),
    ),
  ]);
  const destinations = new Map(
    destinationTokens.map((token, index) => [
      token,
      destinationItems[index] ?? [],
    ]),
  );
  return new Map(
    input.record.moves.map((move) => [
      move.fileRef,
      locationForFile(move, rootItems, destinations),
    ]),
  );
}

function operationCounts(moves: readonly { status: FileOperationStatus }[]): {
  verified: number;
  failed: number;
  unknown: number;
  pending: number;
} {
  return {
    verified: moves.filter((move) => move.status === "VERIFIED").length,
    failed: moves.filter((move) => move.status === "FAILED").length,
    unknown: moves.filter((move) => move.status === "UNKNOWN").length,
    pending: moves.filter((move) => move.status === "REQUESTING").length,
  };
}

export function finalExecutionStatus(
  record: OrganizeFolderExecutionRecord,
): Exclude<ExecutionStatus, "QUEUED" | "RUNNING" | "STALE"> {
  const counts = operationCounts(record.moves);
  if (record.errorCode) {
    return counts.verified > 0 ? "PARTIAL" : "UNKNOWN";
  }
  if (counts.verified === record.moves.length) {
    return "COMPLETED";
  }
  if (counts.verified > 0) {
    return "PARTIAL";
  }
  return counts.unknown > 0 || counts.pending > 0 ? "UNKNOWN" : "FAILED";
}

export function finalUndoStatus(
  record: OrganizeFolderExecutionRecord,
): Exclude<UndoStatus, "REQUESTED" | "RUNNING"> {
  const moves = record.undo?.moves ?? [];
  const counts = operationCounts(moves);
  if (record.undo?.errorCode) {
    return counts.verified > 0 ? "PARTIAL" : "UNKNOWN";
  }
  if (moves.length > 0 && counts.verified === moves.length) {
    return "COMPLETED";
  }
  if (counts.verified > 0) {
    return "PARTIAL";
  }
  return counts.unknown > 0 || counts.pending > 0 ? "UNKNOWN" : "FAILED";
}

export function formatExecutionResult(
  record: OrganizeFolderExecutionRecord,
  status: ExecutionStatus,
): string {
  const lines = [`Execution ${status.toLowerCase()} for proposal ${record.proposalId}.`, ""];
  for (const move of record.moves) {
    lines.push(
      `- ${move.fileName}: ${move.status === "PENDING" ? "untouched" : move.status.toLowerCase()}`,
    );
  }
  if (record.moves.some((move) => move.status === "VERIFIED")) {
    lines.push("", `Undo: /undo-folder ${record.proposalId}`);
  }
  return lines.join("\n");
}

export function formatUndoResult(
  record: OrganizeFolderExecutionRecord,
  status: UndoStatus,
): string {
  const undoByRef = new Map(
    (record.undo?.moves ?? []).map((move) => [move.fileRef, move]),
  );
  const lines = [`Undo ${status.toLowerCase()} for proposal ${record.proposalId}.`, ""];
  for (const move of record.moves.filter((item) => item.status === "VERIFIED")) {
    lines.push(
      `- ${move.fileName}: ${undoByRef.get(move.fileRef)?.status.toLowerCase() ?? "untouched"}`,
    );
  }
  return lines.join("\n");
}
