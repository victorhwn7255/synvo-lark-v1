import { randomUUID } from "node:crypto";

import type {
  DriveInventory,
  DriveInventoryFolder,
  DriveInventoryItem,
} from "../../workflows/organize-folder/contracts.js";
import { organizeFolderPilotPolicy } from "../../workflows/organize-folder/pilot-policy.js";

import type {
  DriveReader,
  NativeDriveItem,
} from "./read-client.js";
import { listFolderCompletely } from "./read-client.js";
import { driveToolError, normalizeDriveError } from "./errors.js";

export type DriveInventoryContext = {
  runId: string;
  requesterOpenId: string;
  rootToken: string;
  accessToken: string;
  recoverAccessToken(rejectedAccessToken: string): Promise<string>;
  markAccessTokenRejected(rejectedAccessToken: string): Promise<void>;
};

function withAccessTokenRecovery(
  reader: DriveReader,
  context: DriveInventoryContext,
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

export async function buildAllowlistedFolderInventory(
  reader: DriveReader,
  context: DriveInventoryContext,
): Promise<DriveInventory> {
  const authenticatedReader = withAccessTokenRecovery(reader, context);
  const rootItems = await listFolderCompletely(authenticatedReader, {
    accessToken: context.accessToken,
    folderToken: context.rootToken,
    maxItems: organizeFolderPilotPolicy.maxRootItems,
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

  const destinationItems = organizeFolderPilotPolicy.destinationNames.map((name) => ({
    name,
    matches: rootFolders.filter((folder) => folder.name === name),
  }));
  const exactDestinations = destinationItems.flatMap(({ matches }) =>
    matches.length === 1 ? matches : [],
  );

  const rootMetadata = await authenticatedReader.getMetadata({
    accessToken: context.accessToken,
    document: { token: context.rootToken, type: "folder" },
  });

  const destinationChildren = new Map<string, NativeDriveItem[]>();
  for (const destination of exactDestinations) {
    const children = await listFolderCompletely(authenticatedReader, {
      accessToken: context.accessToken,
      folderToken: destination.token,
    });
    destinationChildren.set(destination.token, children);
  }
  const destinations: DriveInventoryFolder[] = exactDestinations
    .sort(byNameThenToken)
    .map((destination, index) => {
      const ref = `d${String(index + 1).padStart(3, "0")}`;
      return {
        ref,
        name: destination.name,
        parent_ref: "root",
        owner_verification: ownerVerification(
          destination.ownerId,
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
    modified_time: item.modifiedTime,
    owner_verification: ownerVerification(item.ownerId, context.requesterOpenId),
  }));
  const skipped: DriveInventoryItem[] = unsupportedItems.map((item, index) => ({
    ref: `s${String(index + 1).padStart(3, "0")}`,
    name: item.name,
    type: item.type,
    parent_ref: "root",
    modified_time: item.modifiedTime,
    owner_verification: ownerVerification(item.ownerId, context.requesterOpenId),
  }));

  const issues: string[] = [];
  if (rootMetadata.title !== organizeFolderPilotPolicy.rootName) {
    issues.push("The allowlisted root title differs from the pilot baseline.");
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
      !organizeFolderPilotPolicy.destinationNames.includes(
        folder.name as (typeof organizeFolderPilotPolicy.destinationNames)[number],
      ),
  ).length;
  if (unexpectedFolderCount > 0) {
    issues.push(`Found ${unexpectedFolderCount} unexpected root folder(s).`);
  }
  if (rootFiles.length !== 4) {
    issues.push(`Expected four root files, found ${rootFiles.length}.`);
  }
  const expectedFileNames = new Set<string>(organizeFolderPilotPolicy.rootFileNames);
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
