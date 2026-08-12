import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { runMigrations } from "../../../apps/synvo-assistant/src/db/migrate.js";
import { PostgresInboundMessageStore } from "../../../apps/synvo-assistant/src/lark/inbound-message.js";
import {
  KnowledgeRepository,
  type KnowledgeScope,
} from "../../../apps/synvo-assistant/src/workflows/knowledge/repository.js";
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from "../../../apps/synvo-assistant/src/workflows/knowledge/policy.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test(
  "Postgres claims one replayed Lark message exactly once",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, max: 3 });
    const store = new PostgresInboundMessageStore(pool);
    const tenantKey = `tenant_${randomUUID()}`;
    const messageId = `om_${randomUUID()}`;
    try {
      await runMigrations(pool);
      const claims = await Promise.all([
        store.claim(tenantKey, messageId),
        store.claim(tenantKey, messageId),
        store.claim(tenantKey, messageId),
      ]);
      assert.deepEqual(claims.sort(), [false, false, true]);
    } finally {
      await pool.query(
        "DELETE FROM lark_inbound_messages WHERE tenant_key = $1",
        [tenantKey],
      ).catch(() => undefined);
      await pool.end();
    }
  },
);

function vector(axis: number): number[] {
  return Array.from(
    { length: KNOWLEDGE_EMBEDDING_DIMENSIONS },
    (_, index) => index === axis ? 1 : 0,
  );
}

test(
  "knowledge replacement and search remain atomic and authorization scoped",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl });
    const repository = new KnowledgeRepository(pool);
    const suffix = randomUUID();
    const scope: KnowledgeScope = {
      tenantKey: `tenant_${suffix}`,
      userOpenId: `user_${suffix}`,
      workspaceFolderToken: `folder_${suffix}`,
    };
    const otherScope = { ...scope, userOpenId: `other_${suffix}` };
    try {
      await runMigrations(pool);
      assert.equal(
        await repository.replaceSource({
          scope,
          sourceKind: "chat_attachment",
          sourceKey: "message-one",
          sourceName: "guide.pdf",
          sourceVersionOrHash: "version-one",
          chunks: [
            {
              pageNumber: 1,
              heading: "Architecture",
              chunkIndex: 0,
              text: "Local Cocoa chunking architecture",
              embedding: vector(0),
            },
          ],
        }),
        "replaced",
      );
      assert.equal(
        await repository.replaceSource({
          scope,
          sourceKind: "chat_attachment",
          sourceKey: "message-one",
          sourceName: "guide.pdf",
          sourceVersionOrHash: "version-one",
          chunks: [
            {
              pageNumber: 1,
              heading: "Architecture",
              chunkIndex: 0,
              text: "Local Cocoa chunking architecture",
              embedding: vector(0),
            },
          ],
        }),
        "unchanged",
      );
      assert.deepEqual(
        (await repository.search({
          scope,
          embedding: vector(0),
          limit: 10,
          minimumSimilarity: 0.5,
        })).map((hit) => hit.sourceName),
        ["guide.pdf"],
      );
      assert.deepEqual(
        await repository.search({
          scope: otherScope,
          embedding: vector(0),
          limit: 10,
          minimumSimilarity: 0,
        }),
        [],
      );

      assert.equal(
        await repository.replaceSource({
          scope,
          sourceKind: "drive_file",
          sourceKey: "stable-drive-token",
          sourceName: "Archive / guide.pdf",
          sourceVersionOrHash: "drive-version-one",
          chunks: [{
            pageNumber: 4,
            heading: null,
            chunkIndex: 0,
            text: "Path metadata can move without replacing this chunk.",
            embedding: vector(2),
          }],
        }),
        "replaced",
      );
      assert.equal(
        await repository.updateSourceName({
          scope: otherScope,
          sourceKind: "drive_file",
          sourceKey: "stable-drive-token",
          sourceVersionOrHash: "drive-version-one",
          sourceName: "Research / guide.pdf",
        }),
        false,
      );
      assert.equal(
        await repository.updateSourceName({
          scope,
          sourceKind: "drive_file",
          sourceKey: "stable-drive-token",
          sourceVersionOrHash: "wrong-version",
          sourceName: "Research / guide.pdf",
        }),
        false,
      );
      assert.equal(
        await repository.updateSourceName({
          scope,
          sourceKind: "drive_file",
          sourceKey: "stable-drive-token",
          sourceVersionOrHash: "drive-version-one",
          sourceName: "Research / guide.pdf",
        }),
        true,
      );
      assert.equal(
        (await repository.listSources(scope)).find(
          (source) => source.sourceKey === "stable-drive-token",
        )?.sourceName,
        "Research / guide.pdf",
      );
      assert.deepEqual(
        (await repository.search({
          scope,
          embedding: vector(2),
          limit: 10,
          minimumSimilarity: 0.5,
        })).map((hit) => hit.sourceName),
        ["Research / guide.pdf"],
      );

      await assert.rejects(
        repository.replaceSource({
          scope,
          sourceKind: "chat_attachment",
          sourceKey: "message-one",
          sourceName: "guide.pdf",
          sourceVersionOrHash: "version-two",
          chunks: [
            {
              pageNumber: 2,
              heading: null,
              chunkIndex: 0,
              text: "replacement one",
              embedding: vector(1),
            },
            {
              pageNumber: 3,
              heading: null,
              chunkIndex: 0,
              text: "duplicate index forces rollback",
              embedding: vector(1),
            },
          ],
        }),
      );
      assert.equal((await repository.listSources(scope))[0]?.sourceVersionOrHash, "version-one");
      assert.equal(
        await repository.deleteSource(
          otherScope,
          "chat_attachment",
          "message-one",
        ),
        false,
      );
      assert.equal((await repository.listSources(scope)).length, 2);
      assert.equal(
        await repository.deleteSource(
          scope,
          "chat_attachment",
          "message-one",
        ),
        true,
      );
      assert.equal(
        await repository.deleteSource(
          scope,
          "drive_file",
          "stable-drive-token",
        ),
        true,
      );
      assert.deepEqual(
        await repository.search({
          scope,
          embedding: vector(2),
          limit: 10,
          minimumSimilarity: 0,
        }),
        [],
      );
    } finally {
      await pool.query(
        "DELETE FROM workspace_chunks WHERE tenant_key = $1",
        [scope.tenantKey],
      ).catch(() => undefined);
      await pool.end();
    }
  },
);
