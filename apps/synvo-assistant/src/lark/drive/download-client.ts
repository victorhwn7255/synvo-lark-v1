import { driveToolError, normalizeDriveError } from "./errors.js";

const DEFAULT_API_ORIGIN = "https://open.larksuite.com";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface DriveFileDownloader {
  download(input: {
    accessToken: string;
    fileToken: string;
    maxBytes: number;
  }): Promise<Buffer>;
}

export class LarkDriveFileDownloader implements DriveFileDownloader {
  readonly #fetch: typeof fetch;
  readonly #apiOrigin: string;
  readonly #timeoutMs: number;

  constructor(options: {
    fetchImplementation?: typeof fetch;
    apiOrigin?: string;
    timeoutMs?: number;
  } = {}) {
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#apiOrigin = options.apiOrigin ?? DEFAULT_API_ORIGIN;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("Drive download timeout must be a positive integer");
    }
  }

  async download(input: {
    accessToken: string;
    fileToken: string;
    maxBytes: number;
  }): Promise<Buffer> {
    if (!input.fileToken || !Number.isInteger(input.maxBytes) || input.maxBytes <= 0) {
      throw driveToolError("INVALID_FILE_LINK", "The Drive file request is invalid.");
    }

    try {
      const url = new URL(
        `/open-apis/drive/v1/files/${encodeURIComponent(input.fileToken)}/download`,
        this.#apiOrigin,
      );
      const response = await this.#fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${input.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) {
        throw normalizeDriveError({ status: response.status });
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
        throw driveToolError(
          "LIMIT_EXCEEDED",
          "The Drive PDF exceeds the 10 MiB pilot limit.",
        );
      }
      if (!response.body) {
        throw driveToolError(
          "MALFORMED_RESPONSE",
          "Lark returned an empty Drive file response.",
        );
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          size += chunk.value.byteLength;
          if (size > input.maxBytes) {
            throw driveToolError(
              "LIMIT_EXCEEDED",
              "The Drive PDF exceeds the 10 MiB pilot limit.",
            );
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks, size);
    } catch (error) {
      throw normalizeDriveError(error);
    }
  }
}
