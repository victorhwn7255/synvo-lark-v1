import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const version = "v1";

export class TokenCipher {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) {
      throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes");
    }

    this.#key = Buffer.from(key);
  }

  static fromEncodedKey(value: string | undefined): TokenCipher {
    const encoded = value?.trim();
    if (!encoded || /replace|example/i.test(encoded)) {
      throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY is missing from .env");
    }

    let key: Buffer;
    try {
      key = Buffer.from(encoded, "base64url");
    } catch {
      throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY must be base64 encoded");
    }

    return new TokenCipher(key);
  }

  encrypt(plaintext: string, associatedData: string): string {
    if (!plaintext) {
      throw new Error("Cannot encrypt an empty secret");
    }

    const initializationVector = randomBytes(12);
    const cipher = createCipheriv(algorithm, this.#key, initializationVector);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const authenticationTag = cipher.getAuthTag();

    return [
      version,
      initializationVector.toString("base64url"),
      encrypted.toString("base64url"),
      authenticationTag.toString("base64url"),
    ].join(".");
  }

  decrypt(ciphertext: string, associatedData: string): string {
    const parts = ciphertext.split(".");
    if (parts.length !== 4 || parts[0] !== version) {
      throw new Error("Encrypted secret has an unsupported format");
    }

    const [, encodedIv, encodedCiphertext, encodedTag] = parts;
    const decipher = createDecipheriv(
      algorithm,
      this.#key,
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]);

    return decrypted.toString("utf8");
  }
}

export function grantTokenAssociatedData(
  tenantKey: string,
  openId: string,
  tokenKind: "access" | "refresh",
  refreshVersion: number,
): string {
  return `lark-oauth-grant:${tenantKey}:${openId}:${tokenKind}:v${refreshVersion}`;
}

export type OAuthSessionAssociatedDataInput = {
  appId: string;
  requestTokenDigest: string;
  redirectUri: string;
  scopes: readonly string[];
};

export function oauthSessionAssociatedData(
  input: OAuthSessionAssociatedDataInput,
): string {
  return `lark-oauth-session:${JSON.stringify({
    schemaVersion: 2,
    appId: input.appId,
    requestTokenDigest: input.requestTokenDigest,
    redirectUri: input.redirectUri,
    scopes: [...new Set(input.scopes)].sort(),
    secretKind: "pkce-verifier",
  })}`;
}
