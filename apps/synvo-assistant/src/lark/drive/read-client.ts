import { z } from "zod";

import { driveToolError, normalizeDriveError } from "./errors.js";

const defaultApiOrigin = "https://open.larksuite.com";
const defaultRequestTimeoutMs = 10_000;

const nonemptyStringSchema = z.string().min(1);
const responseEnvelopeSchema = z.object({
  code: z.number().int(),
});
const nativeListItemFields = {
  token: nonemptyStringSchema,
  name: nonemptyStringSchema,
  type: nonemptyStringSchema,
  created_time: nonemptyStringSchema.optional(),
  modified_time: nonemptyStringSchema.optional(),
  owner_id: nonemptyStringSchema.optional(),
};
const nativeListItemSchema = z.object({
  ...nativeListItemFields,
  parent_token: nonemptyStringSchema,
});
const listResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    files: z.array(nativeListItemSchema),
    has_more: z.boolean(),
    next_page_token: nonemptyStringSchema.optional(),
  }),
});
const mySpaceRootListResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    files: z.array(
      z.object({
        ...nativeListItemFields,
        parent_token: nonemptyStringSchema.optional(),
      }),
    ),
    has_more: z.boolean(),
    next_page_token: nonemptyStringSchema.optional(),
  }),
});
const nativeMetadataSchema = z.object({
  doc_token: nonemptyStringSchema,
  doc_type: nonemptyStringSchema,
  title: nonemptyStringSchema,
  owner_id: nonemptyStringSchema,
  create_time: nonemptyStringSchema,
  latest_modify_time: nonemptyStringSchema,
});
const metadataResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    metas: z.array(nativeMetadataSchema),
    failed_list: z
      .array(
        z.object({
          token: nonemptyStringSchema,
          code: z.number().int(),
        }),
      )
      .optional(),
  }),
});

export type NativeDriveItem = {
  token: string;
  name: string;
  type: string;
  parentToken: string;
  createdTime?: string;
  modifiedTime?: string;
  ownerId?: string;
};

export type NativeDriveMetadata = {
  token: string;
  type: string;
  title: string;
  ownerId: string;
  createdTime: string;
  modifiedTime: string;
};

export type MySpaceRootItem = {
  token: string;
  name: string;
  type: string;
};

type PaginatedDrivePage<Item> = { items: Item[] } &
  (
    | { hasMore: true; nextPageToken: string }
    | { hasMore: false; nextPageToken?: never }
  );

export type DriveListPage = PaginatedDrivePage<NativeDriveItem>;
export type MySpaceRootListPage = PaginatedDrivePage<MySpaceRootItem>;

export interface DriveReader {
  listFolderPage(input: {
    accessToken: string;
    folderToken: string;
    pageSize: number;
    pageToken?: string;
  }): Promise<DriveListPage>;
  getMetadata(input: {
    accessToken: string;
    document: { token: string; type: string };
  }): Promise<NativeDriveMetadata>;
}

export interface MySpaceRootReader {
  listMySpaceRootPage(input: {
    accessToken: string;
    pageSize: number;
    pageToken?: string;
  }): Promise<MySpaceRootListPage>;
}

export type DriveFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

type LarkDriveReaderOptions = {
  fetcher?: DriveFetch;
  apiOrigin?: string;
  requestTimeoutMs?: number;
};

function malformedResponse(message: string): never {
  throw driveToolError("MALFORMED_RESPONSE", message);
}

function assertUniqueTokens(
  tokens: readonly string[],
  message: string,
): void {
  if (new Set(tokens).size !== tokens.length) {
    malformedResponse(message);
  }
}

function validateListPage(
  itemCount: number,
  pageSize: number,
  hasMore: boolean,
  nextPageToken: string | undefined,
): void {
  if (hasMore !== (nextPageToken !== undefined)) {
    malformedResponse("Lark returned inconsistent Drive pagination data.");
  }
  if (itemCount > pageSize) {
    malformedResponse("Lark returned more Drive items than requested.");
  }
}

function buildListPage<Item>(
  items: Item[],
  hasMore: boolean,
  nextPageToken: string | undefined,
): PaginatedDrivePage<Item> {
  return hasMore
    ? { items, hasMore: true, nextPageToken: nextPageToken! }
    : { items, hasMore: false };
}

export class LarkDriveReader implements DriveReader, MySpaceRootReader {
  readonly #fetcher: DriveFetch;
  readonly #apiOrigin: string;
  readonly #requestTimeoutMs: number;

  constructor(options: LarkDriveReaderOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
    this.#apiOrigin = options.apiOrigin ?? defaultApiOrigin;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? defaultRequestTimeoutMs;
    if (
      !Number.isInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs <= 0
    ) {
      throw new Error("Drive request timeout must be a positive integer.");
    }
  }

  async #requestJson(
    url: URL,
    init: Omit<RequestInit, "signal">,
  ): Promise<unknown> {
    try {
      const response = await this.#fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (!response.ok) {
          throw normalizeDriveError({ status: response.status });
        }
        malformedResponse("Lark returned malformed JSON for a Drive request.");
      }

      const envelope = responseEnvelopeSchema.safeParse(body);
      if (!response.ok) {
        throw normalizeDriveError({
          status: response.status,
          code: envelope.success ? envelope.data.code : undefined,
        });
      }
      if (!envelope.success) {
        malformedResponse("Lark returned a malformed Drive response envelope.");
      }
      if (envelope.data.code !== 0) {
        throw normalizeDriveError({ code: envelope.data.code });
      }
      return body;
    } catch (error) {
      throw normalizeDriveError(error);
    }
  }

  async listFolderPage(input: {
    accessToken: string;
    folderToken: string;
    pageSize: number;
    pageToken?: string;
  }): Promise<DriveListPage> {
    const body = await this.#requestListPage(input);
    const parsed = listResponseSchema.safeParse(body);
    if (!parsed.success) {
      malformedResponse("Lark returned a malformed Drive listing.");
    }

    const { files, has_more: hasMore, next_page_token: nextPageToken } =
      parsed.data.data;
    validateListPage(files.length, input.pageSize, hasMore, nextPageToken);
    assertUniqueTokens(
      files.map((item) => item.token),
      "Lark returned duplicate Drive item identifiers.",
    );
    if (files.some((item) => item.parent_token !== input.folderToken)) {
      malformedResponse("Lark returned a Drive item outside the requested folder.");
    }

    return buildListPage(
      files.map((item) => ({
        token: item.token,
        name: item.name,
        type: item.type,
        parentToken: item.parent_token,
        createdTime: item.created_time,
        modifiedTime: item.modified_time,
        ownerId: item.owner_id,
      })),
      hasMore,
      nextPageToken,
    );
  }

  async listMySpaceRootPage(input: {
    accessToken: string;
    pageSize: number;
    pageToken?: string;
  }): Promise<MySpaceRootListPage> {
    const body = await this.#requestListPage(input);
    const parsed = mySpaceRootListResponseSchema.safeParse(body);
    if (!parsed.success) {
      malformedResponse("Lark returned a malformed My Space listing.");
    }

    const { files, has_more: hasMore, next_page_token: nextPageToken } =
      parsed.data.data;
    validateListPage(files.length, input.pageSize, hasMore, nextPageToken);
    assertUniqueTokens(
      files.map((item) => item.token),
      "Lark returned duplicate Drive item identifiers.",
    );
    return buildListPage(
      files.map((item) => ({
        token: item.token,
        name: item.name,
        type: item.type,
      })),
      hasMore,
      nextPageToken,
    );
  }

  async #requestListPage(input: {
    accessToken: string;
    folderToken?: string;
    pageSize: number;
    pageToken?: string;
  }): Promise<unknown> {
    if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 200) {
      throw driveToolError(
        "LIMIT_EXCEEDED",
        "The Drive page size is outside the supported read-only limit.",
      );
    }

    const url = new URL("/open-apis/drive/v1/files", this.#apiOrigin);
    if (input.folderToken !== undefined) {
      url.searchParams.set("folder_token", input.folderToken);
    }
    url.searchParams.set("page_size", String(input.pageSize));
    url.searchParams.set("user_id_type", "open_id");
    if (input.pageToken) {
      url.searchParams.set("page_token", input.pageToken);
    }

    return this.#requestJson(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.accessToken}`,
      },
    });
  }

  async getMetadata(input: {
    accessToken: string;
    document: { token: string; type: string };
  }): Promise<NativeDriveMetadata> {
    if (input.document.token.length === 0 || input.document.type.length === 0) {
      malformedResponse("The Drive metadata request was malformed.");
    }

    const url = new URL(
      "/open-apis/drive/v1/metas/batch_query",
      this.#apiOrigin,
    );
    url.searchParams.set("user_id_type", "open_id");
    const body = await this.#requestJson(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request_docs: [
          {
            doc_token: input.document.token,
            doc_type: input.document.type,
          },
        ],
        with_url: false,
      }),
    });
    const parsed = metadataResponseSchema.safeParse(body);
    if (!parsed.success || (parsed.data.data.failed_list?.length ?? 0) > 0) {
      malformedResponse("Lark could not return the required Drive metadata.");
    }

    const [metadata] = parsed.data.data.metas;
    if (
      parsed.data.data.metas.length !== 1 ||
      !metadata ||
      metadata.doc_token !== input.document.token ||
      metadata.doc_type !== input.document.type
    ) {
      malformedResponse("Lark returned incomplete or unexpected Drive metadata.");
    }

    return {
      token: metadata.doc_token,
      type: metadata.doc_type,
      title: metadata.title,
      ownerId: metadata.owner_id,
      createdTime: metadata.create_time,
      modifiedTime: metadata.latest_modify_time,
    };
  }
}

async function listCompletely<Item extends { token: string }>(
  listPage: (
    pageSize: number,
    pageToken: string | undefined,
  ) => Promise<PaginatedDrivePage<Item>>,
  maxPages = 10,
  maxItems = 200,
): Promise<Item[]> {
  if (
    !Number.isInteger(maxPages) ||
    maxPages <= 0 ||
    !Number.isInteger(maxItems) ||
    maxItems <= 0
  ) {
    throw driveToolError(
      "LIMIT_EXCEEDED",
      "The Drive inventory limits are invalid.",
    );
  }

  const requestedPageTokens = new Set<string>();
  const seenItemTokens = new Set<string>();
  const items: Item[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    if (pageToken !== undefined) {
      requestedPageTokens.add(pageToken);
    }

    const pageSize = Math.min(200, maxItems - items.length);
    const result = await listPage(pageSize, pageToken);
    if (
      result.nextPageToken !== undefined &&
      requestedPageTokens.has(result.nextPageToken)
    ) {
      throw driveToolError(
        "INCOMPLETE_SCAN",
        "Lark returned a repeated Drive pagination cursor.",
      );
    }

    if (result.items.some((item) => seenItemTokens.has(item.token))) {
      throw driveToolError(
        "INCOMPLETE_SCAN",
        "Lark returned duplicate Drive item identifiers across pages.",
      );
    }
    result.items.forEach((item) => seenItemTokens.add(item.token));
    items.push(...result.items);
    if (!result.hasMore) {
      return items;
    }
    if (items.length === maxItems) {
      throw driveToolError(
        "LIMIT_EXCEEDED",
        "The Drive directory exceeds the read-only inventory limit.",
      );
    }
    pageToken = result.nextPageToken;
  }

  throw driveToolError(
    "LIMIT_EXCEEDED",
    "The Drive directory exceeds the pagination limit.",
  );
}

export function listFolderCompletely(
  reader: DriveReader,
  input: {
    accessToken: string;
    folderToken: string;
    maxPages?: number;
    maxItems?: number;
  },
): Promise<NativeDriveItem[]> {
  return listCompletely(
    (pageSize, pageToken) =>
      reader.listFolderPage({
        accessToken: input.accessToken,
        folderToken: input.folderToken,
        pageSize,
        pageToken,
      }),
    input.maxPages,
    input.maxItems,
  );
}

export function listMySpaceRootCompletely(
  reader: MySpaceRootReader,
  input: {
    accessToken: string;
    maxPages?: number;
    maxItems?: number;
  },
): Promise<MySpaceRootItem[]> {
  return listCompletely(
    (pageSize, pageToken) =>
      reader.listMySpaceRootPage({
        accessToken: input.accessToken,
        pageSize,
        pageToken,
      }),
    input.maxPages,
    input.maxItems,
  );
}
