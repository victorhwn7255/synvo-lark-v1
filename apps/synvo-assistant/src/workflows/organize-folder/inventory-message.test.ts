import assert from "node:assert/strict";
import test from "node:test";

import type { DriveInventory } from "./contracts.js";
import type { OrganizeFolderProposal } from "./proposal.js";

import {
  formatDriveInventory,
  formatOrganizeFolderProposal,
  sanitizeDisplayValue,
} from "./inventory-message.js";

const IDENTITY_DIGEST = "a".repeat(64);

function inventory(overrides: {
  rootName?: string;
  destinationName?: string;
  fileName?: string;
  skippedName?: string;
  skippedType?: string;
} = {}): DriveInventory {
  return {
    run_id: "4d872758-1f71-4ed8-b141-a2d193ceea91",
    complete: true,
    baseline_matches: false,
    root: {
      ref: "root",
      identity_digest: IDENTITY_DIGEST,
      name: overrides.rootName ?? "Test_Synvo_AI_Assistant",
      parent_ref: null,
      owner_verification: "matched",
      child_count: 3,
    },
    destinations: [
      {
        ref: "d001",
        identity_digest: IDENTITY_DIGEST,
        name: overrides.destinationName ?? "Research",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
    ],
    files: [
      {
        ref: "f001",
        identity_digest: IDENTITY_DIGEST,
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
        identity_digest: IDENTITY_DIGEST,
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
      identity_digest: "b".repeat(64),
      name: "Product",
      parent_ref: "root",
      owner_verification: "matched",
      child_count: 0,
    },
    {
      ref: "private-research-ref",
      identity_digest: "c".repeat(64),
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
    identity_digest: "d".repeat(64),
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

test("allows an existing caller to select a larger bounded display budget", () => {
  const value = "x".repeat(300);
  assert.equal(sanitizeDisplayValue(value, "fallback", 512), value);
  assert.equal(
    Array.from(sanitizeDisplayValue("x".repeat(600), "fallback", 512)).length,
    512,
  );
});

test("renders a concise proposal without internal references or links", () => {
  const proposal: OrganizeFolderProposal = {
    proposal_id: "4d872758-1f71-4ed8-b141-a2d193ceea91",
    moves: [
      {
        file_ref: "f001-private",
        file_identity_digest: "d".repeat(64),
        file_name: "[product] - Product.pdf",
        destination_ref: "d001-private",
        destination_identity_digest: "b".repeat(64),
        destination_name: "Product",
        rationale: "The document is a product implementation guide.",
      },
      {
        file_ref: "f002-private",
        file_identity_digest: "e".repeat(64),
        file_name: "[research] - Research.pdf",
        destination_ref: "d002-private",
        destination_identity_digest: "c".repeat(64),
        destination_name: "Research",
        rationale: "The document presents external research findings.",
      },
    ],
  };

  const output = formatOrganizeFolderProposal(proposal);

  assert.match(output, /Organization proposal 4d872758/u);
  assert.match(output, /Product \(1 file\)/u);
  assert.match(output, /Research \(1 file\)/u);
  assert.match(output, /Needs review \(0 files\)/u);
  assert.match(output, /Why: The document is a product implementation guide/u);
  assert.match(output, /No changes have been made/u);
  assert.match(output, /\/approve-folder 4d872758/u);
  assert.match(output, /\/reject-folder 4d872758/u);
  assert.equal(output.includes("private"), false);
  assert.equal(output.includes("http"), false);
});
