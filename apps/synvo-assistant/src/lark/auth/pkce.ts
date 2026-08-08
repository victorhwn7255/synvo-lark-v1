import { createHash, randomBytes } from "node:crypto";

export function randomOpaqueValue(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function createPkce(): {
  verifier: string;
  challenge: string;
} {
  const verifier = randomOpaqueValue();
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export function digestOpaqueValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
