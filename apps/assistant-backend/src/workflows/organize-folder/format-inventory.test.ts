import assert from "node:assert/strict";
import test from "node:test";

import type { DriveInventory } from "@synvo/contracts";

import { formatDriveInventory } from "./format-inventory.js";

function inventory(overrides: {
  rootName?: string;
  destinationName?: string;
  fileName?: string;
  skippedName?: string;
  skippedType?: string;
} = {}): DriveInventory {
  return {
    run_id: "4d872758-1f71-4ed8-b141-a2d193ceea91",
    scan_id: "4e41b888-b1b9-46cf-aac8-3e0f35e0d266",
    complete: true,
    baseline_matches: false,
    root: {
      ref: "root",
      name: overrides.rootName ?? "Test_Synvo_AI_Assistant",
      parent_ref: null,
      owner_verification: "matched",
      child_count: 3,
    },
    destinations: [
      {
        ref: "d001",
        name: overrides.destinationName ?? "Research",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
    ],
    files: [
      {
        ref: "f001",
        name:
          overrides.fileName ??
          "[research] - Agentic Context Engineering Research.pdf",
        type: "pdf",
        parent_ref: "root",
        owner_verification: "matched",
      },
    ],
    skipped: [
      {
        ref: "s001",
        name: overrides.skippedName ?? "Unsupported item",
        type: overrides.skippedType ?? "shortcut",
        parent_ref: "root",
        owner_verification: "matched",
      },
    ],
    issues: [],
    summary: {
      root_folder_count: 1,
      root_file_count: 1,
      root_skipped_count: 1,
      destination_child_count: 0,
    },
  };
}

test("keeps ordinary fixture names readable", () => {
  const output = formatDriveInventory(inventory());

  assert.match(output, /Root: Test_Synvo_AI_Assistant/u);
  assert.match(
    output,
    /\[research\] - Agentic Context Engineering Research\.pdf/u,
  );
});

test("renders the exact bounded pilot inventory without internal references", () => {
  const pilot = inventory();
  pilot.baseline_matches = true;
  pilot.root.child_count = 6;
  pilot.destinations = [
    {
      ref: "private-product-ref",
      name: "Product",
      parent_ref: "root",
      owner_verification: "matched",
      child_count: 0,
    },
    {
      ref: "private-research-ref",
      name: "Research",
      parent_ref: "root",
      owner_verification: "matched",
      child_count: 0,
    },
  ];
  pilot.files = [
    "[research] - Agentic Context Engineering Research.pdf",
    "[research] - Anthropic Agentic Engineering.pdf",
    "[product] - Local_Cocoa_PDF_Chunking_Technical_Guide.pdf",
    "[product] - Local_Cocoa_Technical_Onboarding_Guide.pdf",
  ].map((name, index) => ({
    ref: `private-file-ref-${index}`,
    name,
    type: "file",
    parent_ref: "root",
    owner_verification: "matched" as const,
  }));
  pilot.skipped = [];
  pilot.summary = {
    root_folder_count: 2,
    root_file_count: 4,
    root_skipped_count: 0,
    destination_child_count: 0,
  };

  const output = formatDriveInventory(pilot);

  assert.match(output, /Root folders: 2/u);
  assert.match(output, /Root files: 4/u);
  assert.match(output, /  - Product: empty/u);
  assert.match(output, /  - Research: empty/u);
  assert.match(output, /Baseline verified: two empty folders and four files/u);
  assert.equal(output.includes("private-"), false);
  assert.equal(output.includes(pilot.run_id), false);
  assert.equal(output.includes(pilot.scan_id), false);
});

test("collapses line, tab, control, and bidi characters in display values", () => {
  const output = formatDriveInventory(
    inventory({
      rootName: "Root\r\n\t\u0000\u202eevil",
      skippedType: "short\u2066cut\u2069",
    }),
  );

  assert.match(output, /Root: Root evil/u);
  assert.match(output, /\(short cut\)/u);
  assert.doesNotMatch(output, /[\u0000\r\t\u202e\u2066\u2069]/u);
});

test("neutralizes Lark mention markup in display values", () => {
  const output = formatDriveInventory(
    inventory({
      destinationName: '<at user_id="all">Everyone</at>',
    }),
  );

  assert.doesNotMatch(output, /<\/?at\b/iu);
  assert.match(output, /\u2039at user_id="all"\u203aEveryone\u2039\/at\u203a/u);
});

test("removes explicit and bare URL autolink candidates", () => {
  const output = formatDriveInventory(
    inventory({
      fileName: "Review https://evil.example/path and evil.example now.pdf",
    }),
  );

  assert.doesNotMatch(output, /https?:\/\//iu);
  assert.doesNotMatch(output, /evil\.example/iu);
  assert.match(output, /Review \[link removed\] and \[link removed\] now\.pdf/u);
});

test("caps each rendered display value without splitting Unicode code points", () => {
  const output = formatDriveInventory(
    inventory({
      skippedName: `${"x".repeat(158)}\ud83d\ude80overflow`,
      skippedType: "t".repeat(200),
    }),
  );
  const skippedLine = output
    .split("\n")
    .find((line) => line.startsWith("  - xxx"));

  assert.ok(skippedLine);
  const match = /^  - (.+) \((.+)\)$/u.exec(skippedLine);
  assert.ok(match);
  assert.equal(Array.from(match[1] ?? "").length, 160);
  assert.equal(Array.from(match[2] ?? "").length, 160);
  assert.match(match[1] ?? "", /\ud83d\ude80\u2026$/u);
  assert.match(match[2] ?? "", /\u2026$/u);
  assert.equal((match[1] ?? "").includes("overflow"), false);
});
