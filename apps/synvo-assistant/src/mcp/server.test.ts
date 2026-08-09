import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import type { DriveFolderInventoryResult } from "../workflows/organize-folder/contracts.js";
import {
  createSynvoMcpEndpoint,
  type SynvoMcpEndpoint,
} from "./server.js";

const authToken = "m".repeat(43);
const identityDigest = "a".repeat(64);
const folderUrl =
  "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123";
const inventoryResult: DriveFolderInventoryResult = {
  ok: true,
  inventory: {
    run_id: "4d872758-1f71-4ed8-b141-a2d193ceea91",
    scan_id: "597d9407-03d3-4a3f-9309-ca25f1dc8b91",
    complete: true,
    baseline_matches: true,
    root: {
      ref: "root",
      identity_digest: identityDigest,
      name: "Test_Synvo_AI_Assistant",
      parent_ref: null,
      owner_verification: "matched",
      child_count: 6,
    },
    destinations: [
      {
        ref: "d001",
        identity_digest: "b".repeat(64),
        name: "Product",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
      {
        ref: "d002",
        identity_digest: "c".repeat(64),
        name: "Research",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
    ],
    files: [],
    skipped: [],
    issues: [],
    summary: {
      root_folder_count: 2,
      root_file_count: 4,
      root_skipped_count: 0,
      destination_child_count: 0,
    },
  },
};

async function withEndpoint(
  endpoint: SynvoMcpEndpoint,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void endpoint.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await endpoint.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("rejects an MCP request without the configured bearer credential", async () => {
  const endpoint = createSynvoMcpEndpoint({
    authToken,
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    inventoryReader: {
      async readInventory() {
        throw new Error("must not be called");
      },
    },
  });

  await withEndpoint(endpoint, async (origin) => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer/);
  });
});

test("lists and calls the read-only inventory tool over Streamable HTTP", async () => {
  const calls: unknown[] = [];
  const endpoint = createSynvoMcpEndpoint({
    authToken,
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    inventoryReader: {
      async readInventory(request) {
        calls.push(request);
        return inventoryResult;
      },
    },
  });

  await withEndpoint(endpoint, async (origin) => {
    const client = new Client(
      { name: "synvo-mcp-test", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${origin}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${authToken}` },
        },
      },
    );

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        ["organize_folder_inventory"],
      );
      assert.equal(listed.tools[0]?.annotations?.readOnlyHint, true);
      assert.equal(listed.tools[0]?.inputSchema.additionalProperties, false);

      const result = await client.callTool({
        name: "organize_folder_inventory",
        arguments: { folder_url: folderUrl },
      });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent, inventoryResult);
      assert.deepEqual(calls, [
        {
          requesterOpenId: "ou_victor",
          tenantKey: "tenant_synvo",
          folderLink: folderUrl,
        },
      ]);

      const identityOverride = await client.callTool({
        name: "organize_folder_inventory",
        arguments: {
          folder_url: folderUrl,
          requester_open_id: "ou_other",
        },
      });
      assert.equal(identityOverride.isError, true);
      assert.equal(calls.length, 1);
    } finally {
      await client.close();
    }
  });
});
