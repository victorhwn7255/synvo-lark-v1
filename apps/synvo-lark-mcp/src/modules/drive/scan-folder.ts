import { randomUUID } from "node:crypto";

import type {
  DriveInventory,
  DriveInventoryFolder,
  DriveInventoryItem,
} from "@synvo/contracts";

import type {
  DriveReader,
  NativeDriveItem,
  NativeDriveMetadata,
} from "./client.js";
import {
  larkBatchMetadataDocumentLimit,
  listFolderCompletely,
} from "./client.js";
import { driveToolError, normalizeDriveError } from "./errors.js";

const expectedRootName = "Test_Synvo_AI_Assistant";
const expectedDestinationNames = ["Product", "Research"] as const;
const expectedRootFiles = [
  "[research] - Agentic Context Engineering Research.pdf",
  "[research] - Anthropic Agentic Engineering.pdf",
  "[product] - Local_Cocoa_PDF_Chunking_Technical_Guide.pdf",
  "[product] - Local_Cocoa_Technical_Onboarding_Guide.pdf",
] as const;
const metadataTypes = new Set([
  "doc",
  "sheet",
  "bitable",
  "mindnote",
  "file",
  "docx",
  "folder",
  "slides",
]);

export type DriveScanContext = {
  runId: string;
  requesterOpenId: string;
  rootToken: string;
  accessToken: string;
  recoverAccessToken(rejectedAccessToken: string): Promise<string>;
  markAccessTokenRejected(rejectedAccessToken: string): Promise<void>;
};

function withAccessTokenRecovery(
  reader: DriveReader,
  context: DriveScanContext,
): DriveReader {
  let accessToken = context.accessToken;

  const read = async <Result>(
    operation: (currentAccessToken: string) => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await operation(accessToken);
    } catch (error) {
      const normalized = normalizeDriveError(error);
      if (normalized.metadata.authFailure !== "ACCESS_TOKEN_REJECTED") {
        throw normalized;
      }
    }

    accessToken = await context.recoverAccessToken(accessToken);
    try {
      return await operation(accessToken);
    } catch (error) {
      const normalized = normalizeDriveError(error);
      if (normalized.metadata.authFailure === "ACCESS_TOKEN_REJECTED") {
        await context.markAccessTokenRejected(accessToken);
        throw driveToolError(
          "OAUTH_REVOKED",
          "The Lark authorization is no longer usable.",
        );
      }
      throw normalized;
    }
  };

  return {
    listFolderPage: (input) =>
      read((currentAccessToken) =>
        reader.listFolderPage({
          ...input,
          accessToken: currentAccessToken,
        }),
      ),
    getMetadata: (input) =>
      read((currentAccessToken) =>
        reader.getMetadata({
          ...input,
          accessToken: currentAccessToken,
        }),
      ),
  };
}

function byNameThenToken(left: NativeDriveItem, right: NativeDriveItem): number {
  return left.name.localeCompare(right.name) || left.token.localeCompare(right.token);
}

function ownerVerification(
  ownerId: string | undefined,
  requesterOpenId: string,
): "matched" | "missing" | "mismatched" {
  if (!ownerId) {
    return "missing";
  }
  return ownerId === requesterOpenId ? "matched" : "mismatched";
}

function metadataByToken(
  metadata: readonly NativeDriveMetadata[],
): Map<string, NativeDriveMetadata> {
  return new Map(metadata.map((item) => [item.token, item]));
}

function itemOwner(
  item: NativeDriveItem,
  metadata: Map<string, NativeDriveMetadata>,
): string | undefined {
  return metadata.get(item.token)?.ownerId ?? item.ownerId;
}

function sameRootIdentitySnapshot(
  before: readonly NativeDriveItem[],
  after: readonly NativeDriveItem[],
): boolean {
  if (before.length !== after.length) {
    return false;
  }
  const afterByToken = new Map(after.map((item) => [item.token, item]));
  return before.every((item) => {
    const current = afterByToken.get(item.token);
    return (
      current !== undefined &&
      current.name === item.name &&
      current.type === item.type &&
      current.parentToken === item.parentToken
    );
  });
}

function sameDirectChildSnapshot(
  before: readonly NativeDriveItem[],
  after: readonly NativeDriveItem[],
): boolean {
  if (before.length !== after.length) {
    return false;
  }
  const afterByToken = new Map(after.map((item) => [item.token, item]));
  return before.every((item) => {
    const current = afterByToken.get(item.token);
    return (
      current !== undefined &&
      current.name === item.name &&
      current.type === item.type &&
      current.parentToken === item.parentToken &&
      current.createdTime === item.createdTime &&
      current.modifiedTime === item.modifiedTime &&
      current.ownerId === item.ownerId
    );
  });
}

export async function scanAllowlistedFolder(
  reader: DriveReader,
  context: DriveScanContext,
): Promise<DriveInventory> {
  const authenticatedReader = withAccessTokenRecovery(reader, context);
  const rootItems = await listFolderCompletely(authenticatedReader, {
    accessToken: context.accessToken,
    folderToken: context.rootToken,
    maxItems: larkBatchMetadataDocumentLimit - 1,
  });
  const rootFolders = rootItems
    .filter((item) => item.type === "folder")
    .sort(byNameThenToken);
  const rootFiles = rootItems
    .filter((item) => item.type === "file")
    .sort(byNameThenToken);
  const unsupportedItems = rootItems
    .filter((item) => item.type !== "folder" && item.type !== "file")
    .sort(byNameThenToken);

  const destinationItems = expectedDestinationNames.map((name) => ({
    name,
    matches: rootFolders.filter((folder) => folder.name === name),
  }));
  const exactDestinations = destinationItems.flatMap(({ matches }) =>
    matches.length === 1 ? matches : [],
  );

  const metadataDocuments = [
    { token: context.rootToken, type: "folder" },
    ...rootItems
      .filter((item) => metadataTypes.has(item.type))
      .map((item) => ({ token: item.token, type: item.type })),
  ];
  const metadata = await authenticatedReader.getMetadata({
    accessToken: context.accessToken,
    documents: metadataDocuments,
  });
  const metadataMap = metadataByToken(metadata);
  const rootMetadata = metadataMap.get(context.rootToken);
  if (!rootMetadata) {
    throw driveToolError(
      "MALFORMED_RESPONSE",
      "Lark did not return metadata for the allowlisted root.",
    );
  }

  const destinationChildren = new Map<string, NativeDriveItem[]>();
  for (const destination of exactDestinations) {
    const children = await listFolderCompletely(authenticatedReader, {
      accessToken: context.accessToken,
      folderToken: destination.token,
    });
    destinationChildren.set(destination.token, children);
  }
  const reconciledRootItems = await listFolderCompletely(authenticatedReader, {
    accessToken: context.accessToken,
    folderToken: context.rootToken,
    maxItems: larkBatchMetadataDocumentLimit - 1,
  });
  const reconciledDestinationChildren = new Map<string, NativeDriveItem[]>();
  for (const destination of exactDestinations) {
    const children = await listFolderCompletely(authenticatedReader, {
      accessToken: context.accessToken,
      folderToken: destination.token,
    });
    reconciledDestinationChildren.set(destination.token, children);
  }

  const destinationRefByToken = new Map<string, string>();
  const destinations: DriveInventoryFolder[] = exactDestinations
    .sort(byNameThenToken)
    .map((destination, index) => {
      const ref = `d${String(index + 1).padStart(3, "0")}`;
      destinationRefByToken.set(destination.token, ref);
      return {
        ref,
        name: destination.name,
        parent_ref: "root",
        owner_verification: ownerVerification(
          itemOwner(destination, metadataMap),
          context.requesterOpenId,
        ),
        child_count: destinationChildren.get(destination.token)?.length ?? 0,
      };
    });

  const files: DriveInventoryItem[] = rootFiles.map((item, index) => ({
    ref: `f${String(index + 1).padStart(3, "0")}`,
    name: item.name,
    type: item.type,
    parent_ref: "root",
    modified_time: metadataMap.get(item.token)?.modifiedTime ?? item.modifiedTime,
    owner_verification: ownerVerification(
      itemOwner(item, metadataMap),
      context.requesterOpenId,
    ),
  }));
  const skipped: DriveInventoryItem[] = unsupportedItems.map((item, index) => ({
    ref: `s${String(index + 1).padStart(3, "0")}`,
    name: item.name,
    type: item.type,
    parent_ref: "root",
    modified_time: metadataMap.get(item.token)?.modifiedTime ?? item.modifiedTime,
    owner_verification: ownerVerification(
      itemOwner(item, metadataMap),
      context.requesterOpenId,
    ),
  }));

  const issues: string[] = [];
  if (rootMetadata.title !== expectedRootName) {
    issues.push("The allowlisted root title differs from the pilot baseline.");
  }
  const metadataTitleMismatchCount = rootItems.filter((item) => {
    const itemMetadata = metadataMap.get(item.token);
    return itemMetadata !== undefined && itemMetadata.title !== item.name;
  }).length;
  if (metadataTitleMismatchCount > 0) {
    issues.push(
      `${metadataTitleMismatchCount} root item title(s) changed between Lark reads.`,
    );
  }
  if (!sameRootIdentitySnapshot(rootItems, reconciledRootItems)) {
    issues.push("The root folder contents changed during the read-only scan.");
  }
  const changedDestinationCount = exactDestinations.filter((destination) => {
    const reconciled = reconciledRootItems.find(
      (item) => item.token === destination.token,
    );
    return (
      reconciled === undefined ||
      reconciled.type !== "folder" ||
      reconciled.name !== destination.name ||
      reconciled.parentToken !== context.rootToken
    );
  }).length;
  if (changedDestinationCount > 0) {
    issues.push(
      `${changedDestinationCount} approved destination folder(s) moved or changed identity during the scan.`,
    );
  }
  const changedDestinationContentsCount = exactDestinations.filter(
    (destination) =>
      !sameDirectChildSnapshot(
        destinationChildren.get(destination.token) ?? [],
        reconciledDestinationChildren.get(destination.token) ?? [],
      ),
  ).length;
  if (changedDestinationContentsCount > 0) {
    issues.push(
      `${changedDestinationContentsCount} approved destination folder(s) changed contents during the scan.`,
    );
  }
  for (const destination of destinationItems) {
    if (destination.matches.length !== 1) {
      issues.push(
        `Expected exactly one ${destination.name} destination folder, found ${destination.matches.length}.`,
      );
    }
  }
  const unexpectedFolderCount = rootFolders.filter(
    (folder) =>
      !expectedDestinationNames.includes(
        folder.name as (typeof expectedDestinationNames)[number],
      ),
  ).length;
  if (unexpectedFolderCount > 0) {
    issues.push(`Found ${unexpectedFolderCount} unexpected root folder(s).`);
  }
  if (rootFiles.length !== 4) {
    issues.push(`Expected four root files, found ${rootFiles.length}.`);
  }
  const expectedFileNames = new Set<string>(expectedRootFiles);
  const actualFileNames = new Set(rootFiles.map((file) => file.name));
  const hasExactPilotFiles =
    actualFileNames.size === expectedFileNames.size &&
    [...expectedFileNames].every((name) => actualFileNames.has(name));
  if (!hasExactPilotFiles) {
    issues.push("The root file names or types differ from the pilot baseline.");
  }
  if (unsupportedItems.length > 0) {
    issues.push(`Found ${unsupportedItems.length} unsupported root item(s).`);
  }
  const nonemptyDestinationCount = destinations.filter(
    (destination) => destination.child_count > 0,
  ).length;
  if (nonemptyDestinationCount > 0) {
    issues.push(`${nonemptyDestinationCount} destination folder(s) are not empty.`);
  }

  const rootOwnerVerification = ownerVerification(
    rootMetadata.ownerId,
    context.requesterOpenId,
  );
  const allOwnerVerifications = [
    rootOwnerVerification,
    ...destinations.map((destination) => destination.owner_verification),
    ...files.map((file) => file.owner_verification),
    ...skipped.map((item) => item.owner_verification),
  ];
  const missingOwnerCount = allOwnerVerifications.filter(
    (status) => status === "missing",
  ).length;
  const mismatchedOwnerCount = allOwnerVerifications.filter(
    (status) => status === "mismatched",
  ).length;
  if (missingOwnerCount > 0) {
    issues.push(`Lark omitted ${missingOwnerCount} required owner signal(s).`);
  }
  if (mismatchedOwnerCount > 0) {
    issues.push(`${mismatchedOwnerCount} item(s) are not owned by the requester.`);
  }

  return {
    run_id: context.runId,
    scan_id: randomUUID(),
    complete: true,
    baseline_matches: issues.length === 0,
    root: {
      ref: "root",
      name: rootMetadata.title,
      parent_ref: null,
      owner_verification: rootOwnerVerification,
      child_count: rootItems.length,
    },
    destinations,
    files,
    skipped,
    issues,
    summary: {
      root_folder_count: rootFolders.length,
      root_file_count: rootFiles.length,
      root_skipped_count: unsupportedItems.length,
      destination_child_count: [...destinationChildren.values()].reduce(
        (total, children) => total + children.length,
        0,
      ),
    },
  };
}
