import assert from "node:assert/strict";
import test from "node:test";

import { driveFolderInventoryResultAssociatedData } from "./contracts.js";

test("keeps the encrypted scan-result associated-data contract stable", () => {
  assert.equal(
    driveFolderInventoryResultAssociatedData("4d872758-1f71-4ed8-b141-a2d193ceea91"),
    "organize-workspace-run:4d872758-1f71-4ed8-b141-a2d193ceea91:snapshot:v2",
  );
});
