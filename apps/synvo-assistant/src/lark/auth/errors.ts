export type LarkAuthErrorCode =
  | "OAUTH_REQUIRED"
  | "OAUTH_REVOKED"
  | "WRONG_SCOPE"
  | "WRONG_USER"
  | "WRONG_TENANT"
  | "OAUTH_REJECTED"
  | "OAUTH_RETRYABLE"
  | "OAUTH_MALFORMED";

export class LarkAuthError extends Error {
  readonly code: LarkAuthErrorCode;
  readonly retryable: boolean;
  readonly providerCode?: string;

  constructor(
    code: LarkAuthErrorCode,
    message: string,
    options: { retryable?: boolean; providerCode?: string } = {},
  ) {
    super(message);
    this.name = "LarkAuthError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.providerCode = options.providerCode;
  }
}
