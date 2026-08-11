import type { Pool, PoolClient } from "pg";

export type KnowledgeScope = {
  tenantKey: string;
  userOpenId: string;
  workspaceFolderToken: string;
};

export type KnowledgeSourceKind = "drive_file" | "chat_attachment";

export type KnowledgeSource = {
  sourceKind: KnowledgeSourceKind;
  sourceKey: string;
  sourceName: string;
  sourceVersionOrHash: string;
};

export type KnowledgeChunkInput = {
  pageNumber: number;
  heading: string | null;
  chunkIndex: number;
  text: string;
  embedding: number[];
};

export type KnowledgeSearchHit = {
  sourceName: string;
  pageNumber: number;
  text: string;
};

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export class KnowledgeRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async replaceSource(input: {
    scope: KnowledgeScope;
    sourceKind: KnowledgeSourceKind;
    sourceKey: string;
    sourceName: string;
    sourceVersionOrHash: string;
    chunks: KnowledgeChunkInput[];
  }): Promise<"replaced" | "unchanged"> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          [
            input.scope.tenantKey,
            input.scope.userOpenId,
            input.scope.workspaceFolderToken,
            input.sourceKind,
            input.sourceKey,
          ].join(":"),
        ],
      );
      const current = await client.query<{ source_version_or_hash: string; count: string }>(
        `SELECT source_version_or_hash, count(*)::text AS count
           FROM workspace_chunks
          WHERE tenant_key = $1
            AND user_open_id = $2
            AND workspace_folder_token = $3
            AND source_kind = $4
            AND source_key = $5
          GROUP BY source_version_or_hash`,
        [
          input.scope.tenantKey,
          input.scope.userOpenId,
          input.scope.workspaceFolderToken,
          input.sourceKind,
          input.sourceKey,
        ],
      );
      if (
        current.rows.length === 1 &&
        current.rows[0]?.source_version_or_hash === input.sourceVersionOrHash &&
        Number(current.rows[0].count) === input.chunks.length
      ) {
        await client.query("COMMIT");
        return "unchanged";
      }

      await this.#deleteSource(client, input.scope, input.sourceKind, input.sourceKey);
      for (const chunk of input.chunks) {
        await client.query(
          `INSERT INTO workspace_chunks (
              tenant_key, user_open_id, workspace_folder_token,
              source_kind, source_key, source_name, source_version_or_hash,
              page_number, heading, chunk_index, chunk_text, embedding
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector)`,
          [
            input.scope.tenantKey,
            input.scope.userOpenId,
            input.scope.workspaceFolderToken,
            input.sourceKind,
            input.sourceKey,
            input.sourceName,
            input.sourceVersionOrHash,
            chunk.pageNumber,
            chunk.heading,
            chunk.chunkIndex,
            chunk.text,
            vectorLiteral(chunk.embedding),
          ],
        );
      }
      await client.query("COMMIT");
      return "replaced";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listSources(scope: KnowledgeScope): Promise<KnowledgeSource[]> {
    const result = await this.#pool.query<{
      source_kind: KnowledgeSourceKind;
      source_key: string;
      source_name: string;
      source_version_or_hash: string;
    }>(
      `SELECT DISTINCT source_kind, source_key, source_name, source_version_or_hash
         FROM workspace_chunks
        WHERE tenant_key = $1
          AND user_open_id = $2
          AND workspace_folder_token = $3
        ORDER BY source_name, source_kind, source_key`,
      [scope.tenantKey, scope.userOpenId, scope.workspaceFolderToken],
    );
    return result.rows.map((row) => ({
      sourceKind: row.source_kind,
      sourceKey: row.source_key,
      sourceName: row.source_name,
      sourceVersionOrHash: row.source_version_or_hash,
    }));
  }

  async deleteSource(
    scope: KnowledgeScope,
    sourceKind: KnowledgeSourceKind,
    sourceKey: string,
  ): Promise<boolean> {
    const result = await this.#deleteSource(this.#pool, scope, sourceKind, sourceKey);
    return (result.rowCount ?? 0) > 0;
  }

  async search(input: {
    scope: KnowledgeScope;
    embedding: number[];
    limit: number;
    minimumSimilarity: number;
  }): Promise<KnowledgeSearchHit[]> {
    const vector = vectorLiteral(input.embedding);
    const result = await this.#pool.query<{
      source_name: string;
      page_number: number;
      chunk_text: string;
    }>(
      `SELECT source_name, page_number, chunk_text
         FROM workspace_chunks
        WHERE tenant_key = $1
          AND user_open_id = $2
          AND workspace_folder_token = $3
          AND 1 - (embedding <=> $4::vector) >= $5
        ORDER BY embedding <=> $4::vector, source_name, page_number, chunk_index
        LIMIT $6`,
      [
        input.scope.tenantKey,
        input.scope.userOpenId,
        input.scope.workspaceFolderToken,
        vector,
        input.minimumSimilarity,
        input.limit,
      ],
    );
    return result.rows.map((row) => ({
      sourceName: row.source_name,
      pageNumber: row.page_number,
      text: row.chunk_text,
    }));
  }

  #deleteSource(
    client: Pick<PoolClient, "query"> | Pool,
    scope: KnowledgeScope,
    sourceKind: KnowledgeSourceKind,
    sourceKey: string,
  ) {
    return client.query(
      `DELETE FROM workspace_chunks
        WHERE tenant_key = $1
          AND user_open_id = $2
          AND workspace_folder_token = $3
          AND source_kind = $4
          AND source_key = $5`,
      [
        scope.tenantKey,
        scope.userOpenId,
        scope.workspaceFolderToken,
        sourceKind,
        sourceKey,
      ],
    );
  }
}
