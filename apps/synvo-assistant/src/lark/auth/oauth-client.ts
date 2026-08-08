import { LarkAuthError } from "./errors.js";

export const LARK_AUTHORIZE_URL =
  "https://accounts.larksuite.com/open-apis/authen/v1/authorize";
export const LARK_OAUTH_TOKEN_URL =
  "https://open.larksuite.com/open-apis/authen/v2/oauth/token";
export const LARK_USER_INFO_URL =
  "https://open.larksuite.com/open-apis/authen/v1/user_info";

export const DRIVE_INVENTORY_USER_SCOPES = [
  "drive:drive.metadata:readonly",
  "offline_access",
  "space:document:retrieve",
] as const;

export const DRIVE_INVENTORY_SCOPE_PROFILE = "phase2_readonly";

export type LarkTokenResponse = {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresIn: number;
  tokenType: string;
  scopes: string[];
};

export type LarkUserIdentity = {
  openId: string;
  tenantKey: string;
};

export type AuthorizationUrlInput = {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
};

export type ExchangeCodeInput = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: readonly string[];
  code: string;
  codeVerifier: string;
};

export type RefreshTokenInput = {
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  refreshToken: string;
};

export interface LarkOAuthClient {
  buildAuthorizationUrl(input: AuthorizationUrlInput): URL;
  exchangeCode(input: ExchangeCodeInput): Promise<LarkTokenResponse>;
  refresh(input: RefreshTokenInput): Promise<LarkTokenResponse>;
  getUserIdentity(accessToken: string): Promise<LarkUserIdentity>;
}

type FetchLike = typeof fetch;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function readString(record: UnknownRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveNumber(
  record: UnknownRecord,
  field: string,
): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function isSuccessfulProviderCode(value: unknown): boolean {
  return value === undefined || value === 0 || value === "0";
}

function splitScopes(scope: string): string[] {
  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort();
}

function providerError(response: UnknownRecord, httpStatus: number): LarkAuthError {
  const rawCode = response.code ?? response.error;
  const providerCode =
    typeof rawCode === "string" || typeof rawCode === "number"
      ? String(rawCode)
      : undefined;
  const terminalCodes = new Set(["20037", "20064", "20073", "20074"]);
  const retryable = httpStatus === 429 || httpStatus >= 500;

  if (
    providerCode &&
    (terminalCodes.has(providerCode) || providerCode === "invalid_grant")
  ) {
    return new LarkAuthError(
      "OAUTH_REVOKED",
      "The Lark authorization is no longer usable.",
      { providerCode },
    );
  }

  return new LarkAuthError(
    retryable ? "OAUTH_RETRYABLE" : "OAUTH_REJECTED",
    retryable
      ? "Lark authorization is temporarily unavailable."
      : "Lark rejected the authorization request.",
    { providerCode, retryable },
  );
}

export class LarkOAuthHttpClient implements LarkOAuthClient {
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: { fetch?: FetchLike; timeoutMs?: number } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  buildAuthorizationUrl(input: AuthorizationUrlInput): URL {
    const url = new URL(LARK_AUTHORIZE_URL);
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", [...input.scopes].sort().join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<LarkTokenResponse> {
    return this.#requestToken({
      grant_type: "authorization_code",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      scope: [...input.scopes].sort().join(" "),
    });
  }

  async refresh(input: RefreshTokenInput): Promise<LarkTokenResponse> {
    return this.#requestToken({
      grant_type: "refresh_token",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      scope: [...input.scopes].sort().join(" "),
    });
  }

  async getUserIdentity(accessToken: string): Promise<LarkUserIdentity> {
    const response = await this.#safeFetch(LARK_USER_INFO_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const body = await this.#readJson(response);
    if (!response.ok || !isSuccessfulProviderCode(body.code)) {
      throw providerError(body, response.status);
    }

    const data = body.data;
    if (!isRecord(data)) {
      throw new LarkAuthError(
        "OAUTH_MALFORMED",
        "Lark returned malformed user information.",
      );
    }

    const openId = readString(data, "open_id");
    const tenantKey = readString(data, "tenant_key");
    if (!openId || !tenantKey) {
      throw new LarkAuthError(
        "OAUTH_MALFORMED",
        "Lark user information did not include the required identity.",
      );
    }

    return { openId, tenantKey };
  }

  async #requestToken(payload: UnknownRecord): Promise<LarkTokenResponse> {
    const response = await this.#safeFetch(LARK_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    const body = await this.#readJson(response);
    if (!response.ok || !isSuccessfulProviderCode(body.code)) {
      throw providerError(body, response.status);
    }

    const accessToken = readString(body, "access_token");
    const refreshToken = readString(body, "refresh_token");
    const expiresIn = readPositiveNumber(body, "expires_in");
    const refreshTokenExpiresIn = readPositiveNumber(
      body,
      "refresh_token_expires_in",
    );
    const tokenType = readString(body, "token_type");
    const scope = readString(body, "scope");

    if (
      !accessToken ||
      !refreshToken ||
      !expiresIn ||
      !refreshTokenExpiresIn ||
      !tokenType ||
      !scope
    ) {
      throw new LarkAuthError(
        "OAUTH_MALFORMED",
        "Lark returned an incomplete token response.",
      );
    }
    if (tokenType.toLowerCase() !== "bearer") {
      throw new LarkAuthError(
        "OAUTH_MALFORMED",
        "Lark returned an unsupported token type.",
      );
    }

    return {
      accessToken,
      refreshToken,
      expiresIn,
      refreshTokenExpiresIn,
      tokenType,
      scopes: splitScopes(scope),
    };
  }

  async #safeFetch(input: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new LarkAuthError(
        "OAUTH_RETRYABLE",
        "Lark authorization is temporarily unavailable.",
        { retryable: true },
      );
    }
  }

  async #readJson(response: Response): Promise<UnknownRecord> {
    try {
      const body: unknown = await response.json();
      if (isRecord(body)) {
        return body;
      }
    } catch {
      // The normalized error below intentionally excludes the response body.
    }

    if (!response.ok) {
      throw providerError({}, response.status);
    }

    throw new LarkAuthError(
      "OAUTH_MALFORMED",
      "Lark returned a malformed authorization response.",
    );
  }
}

export function hasExactScopes(
  grantedScopes: readonly string[],
  expectedScopes: readonly string[] = DRIVE_INVENTORY_USER_SCOPES,
): boolean {
  const granted = new Set(grantedScopes);
  const expected = new Set(expectedScopes);
  return (
    granted.size === expected.size &&
    [...expected].every((scope) => granted.has(scope))
  );
}
