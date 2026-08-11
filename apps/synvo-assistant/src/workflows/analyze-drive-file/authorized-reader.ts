import {
  driveToolError,
  type DriveFileDownloader,
  type DriveReader,
  type NativeDriveItem,
  listFolderCompletely,
  withReadOnlyDriveTokenRecovery,
} from "../../lark/drive/index.js";
import { ANALYZE_ATTACHMENT_MAX_BYTES } from "../analyze-attachment/policy.js";
import { organizeFolderPilotPolicy } from "../organize-folder/pilot-policy.js";

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
  readonly #rootToken: string;
  readonly #requesterOpenId: string;
  readonly #tenantKey: string;

  constructor(options: {
    tokenBroker: AccessTokenProvider;
    driveReader: DriveReader;
    downloader: DriveFileDownloader;
    rootToken: string;
    requesterOpenId: string;
    tenantKey: string;
  }) {
    this.#tokenBroker = options.tokenBroker;
    this.#driveReader = options.driveReader;
    this.#downloader = options.downloader;
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
        maxItems: organizeFolderPilotPolicy.maxRootItems,
      }),
    );
  }

  async downloadRootPdf(input: PilotIdentity & { file: NativeDriveItem }): Promise<Buffer> {
    this.#requirePilotIdentity(input);
    this.#requireOwnedRootPdf(input.file);
    return this.#downloadFile(input.file.token);
  }

  async listKnowledgeFiles(input: PilotIdentity): Promise<KnowledgeDriveFile[]> {
    const items = await this.listRootItems(input);
    return items
      .filter(
        (item) =>
          this.#isOwnedRootPdf(item) &&
          typeof item.modifiedTime === "string",
      )
      .map((item) => ({
        token: item.token,
        name: item.name,
        version: item.modifiedTime!,
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name) || left.token.localeCompare(right.token),
      );
  }

  async readKnowledgeFile(input: PilotIdentity & {
    fileToken: string;
    expectedVersion: string;
  }): Promise<KnowledgeDrivePdf> {
    const before = await this.#findKnowledgeFile(
      input,
      input.fileToken,
      input.expectedVersion,
    );
    const bytes = await this.#downloadFile(before.token);
    const after = await this.#findKnowledgeFile(
      input,
      input.fileToken,
      input.expectedVersion,
    );
    if (after.name !== before.name) {
      throw driveToolError(
        "INCOMPLETE_SCAN",
        "The Drive PDF changed while it was being read.",
      );
    }
    return { ...after, bytes };
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

  #isOwnedRootPdf(file: NativeDriveItem): boolean {
    return (
      file.parentToken === this.#rootToken &&
      file.ownerId === this.#requesterOpenId &&
      file.type === "file" &&
      /\.pdf$/iu.test(file.name)
    );
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
  ): Promise<KnowledgeDriveFile> {
    const file = (await this.listKnowledgeFiles(identity)).find(
      (candidate) => candidate.token === fileToken,
    );
    if (!file || file.version !== expectedVersion) {
      throw driveToolError(
        "INCOMPLETE_SCAN",
        "The Drive PDF no longer matches the approved knowledge snapshot.",
      );
    }
    return file;
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
}
