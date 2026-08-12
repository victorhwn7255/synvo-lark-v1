import {
  driveToolError,
  type DriveFileDownloader,
  type DriveReader,
  type NativeDriveItem,
  listFolderCompletely,
  withReadOnlyDriveTokenRecovery,
} from "../../lark/drive/index.js";
import type { DriveFileDeleter } from "../../lark/drive/move-client.js";
import { DriveMoveError } from "../../lark/drive/move-client.js";
import { ANALYZE_ATTACHMENT_MAX_BYTES } from "../analyze-attachment/policy.js";
import { sanitizeDisplayValue } from "../organize-folder/inventory-message.js";
import {
  KNOWLEDGE_MAX_DESCENDANT_DEPTH,
  KNOWLEDGE_MAX_RELATIVE_PATH_CODE_POINTS,
  KNOWLEDGE_MAX_VISITED_FOLDERS,
} from "../knowledge/policy.js";
import { workspaceOrganizationPolicy } from "../organize-folder/policy.js";

type AccessTokenProvider = {
  getAccessToken(openId: string, tenantKey: string): Promise<string>;
  recoverAccessToken(
    openId: string,
    tenantKey: string,
    rejectedAccessToken: string,
  ): Promise<string>;
  markAccessTokenRejected(
    openId: string,
    tenantKey: string,
    rejectedAccessToken: string,
  ): Promise<void>;
};

export type KnowledgeDriveFile = {
  token: string;
  name: string;
  version: string;
};

export type WorkspaceDriveFolder = {
  token: string;
  name: string;
  relativePath: string;
  parentToken: string;
  depth: number;
  ownedByRequester: boolean;
};

export type WorkspaceDriveFile = KnowledgeDriveFile & {
  fileName: string;
  relativePath: string;
  parentToken: string;
  parentPath: string;
  depth: number;
};

export type WorkspaceDriveInventory = {
  rootToken: string;
  folders: WorkspaceDriveFolder[];
  files: WorkspaceDriveFile[];
};

export type KnowledgeDrivePdf = KnowledgeDriveFile & {
  bytes: Buffer;
};

type PilotIdentity = {
  requesterOpenId: string;
  tenantKey: string;
};

export class AuthorizedDrivePdfReader {
  readonly #tokenBroker: AccessTokenProvider;
  readonly #driveReader: DriveReader;
  readonly #downloader: DriveFileDownloader;
  readonly #deleter: DriveFileDeleter;
  readonly #rootToken: string;
  readonly #requesterOpenId: string;
  readonly #tenantKey: string;

  constructor(options: {
    tokenBroker: AccessTokenProvider;
    driveReader: DriveReader;
    downloader: DriveFileDownloader;
    deleter: DriveFileDeleter;
    rootToken: string;
    requesterOpenId: string;
    tenantKey: string;
  }) {
    this.#tokenBroker = options.tokenBroker;
    this.#driveReader = options.driveReader;
    this.#downloader = options.downloader;
    this.#deleter = options.deleter;
    this.#rootToken = options.rootToken;
    this.#requesterOpenId = options.requesterOpenId;
    this.#tenantKey = options.tenantKey;
  }

  async verifyAccess(input: PilotIdentity): Promise<void> {
    this.#requirePilotIdentity(input);
    await this.#tokenBroker.getAccessToken(
      this.#requesterOpenId,
      this.#tenantKey,
    );
  }

  listRootItems(input: PilotIdentity): Promise<NativeDriveItem[]> {
    this.#requirePilotIdentity(input);
    return this.#withAccessToken((accessToken) =>
      listFolderCompletely(this.#driveReader, {
        accessToken,
        folderToken: this.#rootToken,
        maxItems: 200,
      }),
    );
  }

  async downloadRootPdf(input: PilotIdentity & { file: NativeDriveItem }): Promise<Buffer> {
    this.#requirePilotIdentity(input);
    this.#requireOwnedRootPdf(input.file);
    return this.#downloadFile(input.file.token);
  }

  async listKnowledgeFiles(input: PilotIdentity): Promise<KnowledgeDriveFile[]> {
    const inventory = await this.inspectWorkspace(input, {
      maxPdfs: 200,
    });
    return inventory.files.map(({ token, relativePath, version }) => ({
      token,
      name: relativePath,
      version,
    }));
  }

  async inspectWorkspace(
    input: PilotIdentity,
    options: { maxPdfs?: number } = {},
  ): Promise<WorkspaceDriveInventory> {
    this.#requirePilotIdentity(input);
    const maxPdfs = options.maxPdfs ?? workspaceOrganizationPolicy.maxEligiblePdfs;
    if (!Number.isSafeInteger(maxPdfs) || maxPdfs < 1) {
      throw driveToolError("LIMIT_EXCEEDED", "The workspace PDF limit is invalid.");
    }
    return this.#withAccessToken(async (accessToken) => {
      const folders = [{ token: this.#rootToken, path: [] as string[], depth: 0 }];
      const seenFolders = new Set([this.#rootToken]);
      const seenItems = new Set<string>();
      const discoveredFolders: WorkspaceDriveFolder[] = [];
      const files: WorkspaceDriveFile[] = [];

      for (let index = 0; index < folders.length; index += 1) {
        const folder = folders[index]!;
        const items = await listFolderCompletely(this.#driveReader, {
          accessToken,
          folderToken: folder.token,
          maxItems: 200,
        });
        items.sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.token.localeCompare(right.token),
        );

        for (const item of items) {
          if (item.parentToken !== folder.token) {
            throw driveToolError(
              "INCOMPLETE_SCAN",
              "Lark returned a Drive item outside the folder being scanned.",
            );
          }
          if (seenItems.has(item.token)) {
            throw driveToolError(
              "INCOMPLETE_SCAN",
              "Lark returned a repeated Drive item while scanning the workspace.",
            );
          }
          seenItems.add(item.token);

          if (item.type === "folder") {
            const depth = folder.depth + 1;
            if (depth > KNOWLEDGE_MAX_DESCENDANT_DEPTH) {
              throw driveToolError(
                "LIMIT_EXCEEDED",
                "The workspace folder tree exceeds the supported depth.",
              );
            }
            if (
              seenFolders.has(item.token) ||
              seenFolders.size >= KNOWLEDGE_MAX_VISITED_FOLDERS
            ) {
              throw driveToolError(
                seenFolders.has(item.token) ? "INCOMPLETE_SCAN" : "LIMIT_EXCEEDED",
                seenFolders.has(item.token)
                  ? "Lark returned a repeated folder while scanning the workspace."
                  : "The workspace contains too many folders for one safe scan.",
              );
            }
            const path = [
              ...folder.path,
              sanitizeDisplayValue(
                item.name,
                "[unnamed]",
                KNOWLEDGE_MAX_RELATIVE_PATH_CODE_POINTS,
              ),
            ];
            this.#safeRelativePath(path);
            seenFolders.add(item.token);
            discoveredFolders.push({
              token: item.token,
              name: path.at(-1)!,
              relativePath: this.#safeRelativePath(path),
              parentToken: folder.token,
              depth,
              ownedByRequester: item.ownerId === this.#requesterOpenId,
            });
            folders.push({
              token: item.token,
              path,
              depth,
            });
            continue;
          }

          if (
            item.type !== "file" ||
            item.ownerId !== this.#requesterOpenId ||
            typeof item.modifiedTime !== "string" ||
            !/\.pdf$/iu.test(item.name)
          ) {
            continue;
          }
          if (files.length >= maxPdfs) {
            throw driveToolError(
              "LIMIT_EXCEEDED",
              "The workspace contains too many PDFs for one safe scan.",
            );
          }
          const fileName = sanitizeDisplayValue(
            item.name,
            "[unnamed]",
            KNOWLEDGE_MAX_RELATIVE_PATH_CODE_POINTS,
          );
          const parentPath = folder.path.join(" / ");
          const relativePath = this.#safeRelativePath([
            ...folder.path,
            fileName,
          ]);
          files.push({
            token: item.token,
            name: relativePath,
            fileName,
            relativePath,
            parentToken: folder.token,
            parentPath,
            depth: folder.depth,
            version: item.modifiedTime,
          });
        }
      }

      files.sort(
        (left, right) =>
          left.relativePath.localeCompare(right.relativePath) ||
          left.token.localeCompare(right.token),
      );
      discoveredFolders.sort(
        (left, right) =>
          left.relativePath.localeCompare(right.relativePath) ||
          left.token.localeCompare(right.token),
      );
      return {
        rootToken: this.#rootToken,
        folders: discoveredFolders,
        files,
      };
    });
  }

  async readKnowledgeFile(input: PilotIdentity & {
    fileToken: string;
    expectedVersion: string;
    expectedName: string;
  }): Promise<KnowledgeDrivePdf> {
    const before = await this.#findKnowledgeFile(
      input,
      input.fileToken,
      input.expectedVersion,
      input.expectedName,
    );
    const bytes = await this.#downloadFile(before.token);
    const after = await this.#findKnowledgeFile(
      input,
      input.fileToken,
      input.expectedVersion,
      input.expectedName,
    );
    return { ...after, bytes };
  }

  async deleteKnowledgeFile(input: PilotIdentity & {
    fileToken: string;
    expectedVersion: string;
    expectedName: string;
  }): Promise<void> {
    this.#requirePilotIdentity(input);
    const before = (await this.listKnowledgeFiles(input)).find(
      (candidate) => candidate.token === input.fileToken,
    );
    if (!before) {
      throw driveToolError(
        "INCOMPLETE_SCAN",
        "The approved Drive PDF is no longer present in the workspace.",
      );
    }
    if (
      before.version !== input.expectedVersion ||
      before.name !== input.expectedName
    ) {
      throw driveToolError(
        "INCOMPLETE_SCAN",
        "The Drive PDF no longer matches the approved deletion snapshot.",
      );
    }

    try {
      await this.#withMutationAccessToken((accessToken) =>
        this.#deleter.deleteFile({ accessToken, fileToken: before.token }),
      );
    } catch (error) {
      if (
        !(
          error instanceof DriveMoveError &&
          (error.ambiguous || error.code === "NOT_FOUND")
        )
      ) {
        throw error;
      }
    }
    if (
      (await this.listKnowledgeFiles(input)).some(
        (candidate) => candidate.token === input.fileToken,
      )
    ) {
      throw driveToolError(
        "INCOMPLETE_SCAN",
        "The Drive PDF was still present after the deletion request.",
      );
    }
  }

  #requirePilotIdentity(input: PilotIdentity): void {
    if (
      input.requesterOpenId !== this.#requesterOpenId ||
      input.tenantKey !== this.#tenantKey
    ) {
      throw driveToolError(
        "UNAUTHORIZED",
        "Drive knowledge is not available for this account.",
      );
    }
  }

  #requireOwnedRootPdf(file: NativeDriveItem): void {
    if (
      file.parentToken !== this.#rootToken ||
      file.ownerId !== this.#requesterOpenId
    ) {
      throw driveToolError(
        "ROOT_NOT_ALLOWLISTED",
        "The Drive file is outside the approved pilot root.",
      );
    }
    if (file.type !== "file" || !/\.pdf$/iu.test(file.name)) {
      throw driveToolError(
        "INVALID_FILE_LINK",
        "Only ordinary PDF files are supported.",
      );
    }
  }

  #downloadFile(fileToken: string): Promise<Buffer> {
    return this.#withAccessToken((accessToken) =>
      this.#downloader.download({
        accessToken,
        fileToken,
        maxBytes: ANALYZE_ATTACHMENT_MAX_BYTES,
      }),
    );
  }

  async #findKnowledgeFile(
    identity: PilotIdentity,
    fileToken: string,
    expectedVersion: string,
    expectedName: string,
  ): Promise<KnowledgeDriveFile> {
    const file = (await this.listKnowledgeFiles(identity)).find(
      (candidate) => candidate.token === fileToken,
    );
    if (
      !file ||
      file.version !== expectedVersion ||
      file.name !== expectedName
    ) {
      throw driveToolError(
        "INCOMPLETE_SCAN",
        "The Drive PDF no longer matches the approved knowledge snapshot.",
      );
    }
    return file;
  }

  #safeRelativePath(segments: string[]): string {
    const path = segments.join(" / ");
    if (
      !path ||
      Array.from(path).length > KNOWLEDGE_MAX_RELATIVE_PATH_CODE_POINTS
    ) {
      throw driveToolError(
        "LIMIT_EXCEEDED",
        "A workspace PDF path exceeds the safe display limit.",
      );
    }
    return path;
  }

  async #withAccessToken<Result>(
    operation: (accessToken: string) => Promise<Result>,
  ): Promise<Result> {
    const accessToken = await this.#tokenBroker.getAccessToken(
      this.#requesterOpenId,
      this.#tenantKey,
    );
    const recovered = await withReadOnlyDriveTokenRecovery(
      {
        accessToken,
        recoverAccessToken: (rejectedAccessToken) =>
          this.#tokenBroker.recoverAccessToken(
            this.#requesterOpenId,
            this.#tenantKey,
            rejectedAccessToken,
          ),
        markAccessTokenRejected: (rejectedAccessToken) =>
          this.#tokenBroker.markAccessTokenRejected(
            this.#requesterOpenId,
            this.#tenantKey,
            rejectedAccessToken,
          ),
      },
      operation,
    );
    return recovered.result;
  }

  async #withMutationAccessToken<Result>(
    operation: (accessToken: string) => Promise<Result>,
  ): Promise<Result> {
    let accessToken = await this.#tokenBroker.getAccessToken(
      this.#requesterOpenId,
      this.#tenantKey,
    );
    try {
      return await operation(accessToken);
    } catch (error) {
      if (!(error instanceof DriveMoveError && error.code === "UNAUTHORIZED")) {
        throw error;
      }
      await this.#tokenBroker.markAccessTokenRejected(
        this.#requesterOpenId,
        this.#tenantKey,
        accessToken,
      );
      accessToken = await this.#tokenBroker.recoverAccessToken(
        this.#requesterOpenId,
        this.#tenantKey,
        accessToken,
      );
      return operation(accessToken);
    }
  }
}
