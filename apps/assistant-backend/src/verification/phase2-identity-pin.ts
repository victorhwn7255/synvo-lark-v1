import { constants } from "node:fs";
import {
  lstat,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

import { Pool } from "pg";

import { loadConfig, type AppConfig } from "../config.js";
import {
  configInvalidReport,
  databaseUnavailableReport,
  PostgresPhase2LiveReader,
  type Phase2LiveVerificationCode,
  type VerifiedPhase2Identity,
  verifyPhase2LiveForIdentityPin,
} from "./phase2-live.js";

const IDENTITY_KEYS = [
  "LARK_AUTHORIZED_OPEN_ID",
  "LARK_AUTHORIZED_TENANT_KEY",
] as const;

type IdentityKey = (typeof IDENTITY_KEYS)[number];

export type Phase2IdentityPinCode =
  | "PINNED"
  | "ALREADY_PINNED"
  | "NO_VERIFIED_RUN"
  | "LIVE_RUN_PENDING"
  | "LIVE_GATE_FAILED"
  | "IDENTITY_MISMATCH"
  | "ENV_FILE_INVALID"
  | "ENV_FILE_UNSAFE"
  | "ENV_UPDATE_FAILED"
  | "CONFIG_INVALID"
  | "DATABASE_UNAVAILABLE";

export type Phase2IdentityPinReport = {
  status: "pass" | "pending" | "fail";
  pin_code: Phase2IdentityPinCode;
  live_verification_code: Phase2LiveVerificationCode;
  live_gate_passed: boolean;
  env_updated: boolean;
  identity_pinned: boolean;
};

type EnvUpdatePlan =
  | { action: "update"; contents: string }
  | { action: "noop" };

class IdentityEnvError extends Error {
  constructor(
    readonly code:
      | "IDENTITY_MISMATCH"
      | "ENV_FILE_INVALID"
      | "ENV_FILE_UNSAFE"
      | "ENV_UPDATE_FAILED",
  ) {
    super(code);
    this.name = "IdentityEnvError";
  }
}

function identityLinePattern(key: IdentityKey): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
}

function canonicalIdentityLinePattern(key: IdentityKey): RegExp {
  return new RegExp(`^\\s*${key}\\s*=\\s*([A-Za-z0-9_-]+)\\s*$`);
}

function assertWritableIdentityValue(value: string): void {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new IdentityEnvError("ENV_FILE_INVALID");
  }
}

function matchingIdentityLines(
  lines: readonly string[],
  key: IdentityKey,
): string[] {
  const pattern = identityLinePattern(key);
  return lines.filter((line) => pattern.test(line));
}

export function planPhase2IdentityEnvUpdate(
  contents: string,
  identity: VerifiedPhase2Identity,
): EnvUpdatePlan {
  assertWritableIdentityValue(identity.openId);
  assertWritableIdentityValue(identity.tenantKey);

  const lines = contents.split(/\r?\n/);
  const openIdLines = matchingIdentityLines(lines, IDENTITY_KEYS[0]);
  const tenantKeyLines = matchingIdentityLines(lines, IDENTITY_KEYS[1]);

  if (openIdLines.length > 1 || tenantKeyLines.length > 1) {
    throw new IdentityEnvError("ENV_FILE_INVALID");
  }
  if (openIdLines.length !== tenantKeyLines.length) {
    throw new IdentityEnvError("ENV_FILE_INVALID");
  }

  if (openIdLines.length === 1) {
    const openIdMatch = canonicalIdentityLinePattern(IDENTITY_KEYS[0]).exec(
      openIdLines[0]!,
    );
    const tenantKeyMatch = canonicalIdentityLinePattern(IDENTITY_KEYS[1]).exec(
      tenantKeyLines[0]!,
    );
    if (!openIdMatch || !tenantKeyMatch) {
      throw new IdentityEnvError("ENV_FILE_INVALID");
    }
    if (
      openIdMatch[1] !== identity.openId ||
      tenantKeyMatch[1] !== identity.tenantKey
    ) {
      throw new IdentityEnvError("IDENTITY_MISMATCH");
    }
    return { action: "noop" };
  }

  const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
  return {
    action: "update",
    contents:
      `${contents}${separator}` +
      `LARK_AUTHORIZED_OPEN_ID=${identity.openId}\n` +
      `LARK_AUTHORIZED_TENANT_KEY=${identity.tenantKey}\n`,
  };
}

function sameFile(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

export async function pinPhase2IdentityEnvFile(
  envFilePath: string,
  identity: VerifiedPhase2Identity,
): Promise<"PINNED" | "ALREADY_PINNED"> {
  let initialStat;
  try {
    initialStat = await lstat(envFilePath);
  } catch {
    throw new IdentityEnvError("ENV_FILE_UNSAFE");
  }
  if (initialStat.isSymbolicLink() || !initialStat.isFile()) {
    throw new IdentityEnvError("ENV_FILE_UNSAFE");
  }

  let source;
  try {
    source = await open(envFilePath, constants.O_RDONLY | noFollowFlag());
  } catch {
    throw new IdentityEnvError("ENV_FILE_UNSAFE");
  }

  let temporaryPath: string | undefined;
  try {
    const openedStat = await source.stat();
    if (!openedStat.isFile() || !sameFile(initialStat, openedStat)) {
      throw new IdentityEnvError("ENV_FILE_UNSAFE");
    }
    const contents = await source.readFile({ encoding: "utf8" });
    const plan = planPhase2IdentityEnvUpdate(contents, identity);

    if (plan.action === "noop") {
      await source.chmod(0o600);
      return "ALREADY_PINNED";
    }

    temporaryPath = join(
      dirname(envFilePath),
      `.${basename(envFilePath)}.identity-pin-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
    );
    const temporary = await open(
      temporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        noFollowFlag(),
      0o600,
    );
    try {
      await temporary.writeFile(plan.contents, { encoding: "utf8" });
      await temporary.chmod(0o600);
      await temporary.sync();
    } finally {
      await temporary.close();
    }

    const currentStat = await lstat(envFilePath);
    if (
      currentStat.isSymbolicLink() ||
      !currentStat.isFile() ||
      !sameFile(initialStat, currentStat)
    ) {
      throw new IdentityEnvError("ENV_FILE_UNSAFE");
    }

    await rename(temporaryPath, envFilePath);
    temporaryPath = undefined;
    return "PINNED";
  } catch (error) {
    if (error instanceof IdentityEnvError) {
      throw error;
    }
    throw new IdentityEnvError("ENV_UPDATE_FAILED");
  } finally {
    await source.close().catch(() => undefined);
    if (temporaryPath) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function report(
  status: Phase2IdentityPinReport["status"],
  pinCode: Phase2IdentityPinCode,
  liveVerificationCode: Phase2LiveVerificationCode,
  options: {
    liveGatePassed?: boolean;
    envUpdated?: boolean;
    identityPinned?: boolean;
  } = {},
): Phase2IdentityPinReport {
  return {
    status,
    pin_code: pinCode,
    live_verification_code: liveVerificationCode,
    live_gate_passed: options.liveGatePassed ?? false,
    env_updated: options.envUpdated ?? false,
    identity_pinned: options.identityPinned ?? false,
  };
}

export async function runPhase2IdentityPin(options: {
  config: AppConfig;
  reader: Pick<PostgresPhase2LiveReader, "loadLatestRun">;
  envFilePath: string;
  now?: Date;
  writeIdentity?: typeof pinPhase2IdentityEnvFile;
}): Promise<Phase2IdentityPinReport> {
  const verification = await verifyPhase2LiveForIdentityPin({
    config: options.config,
    reader: options.reader,
    now: options.now,
  });

  if (verification.report.status === "pending") {
    return report(
      "pending",
      verification.report.verification_code === "NO_LIVE_RUN"
        ? "NO_VERIFIED_RUN"
        : "LIVE_RUN_PENDING",
      verification.report.verification_code,
    );
  }
  if (verification.report.status !== "pass" || !verification.identity) {
    return report(
      "fail",
      "LIVE_GATE_FAILED",
      verification.report.verification_code,
    );
  }

  if (
    (options.config.authorizedOpenId &&
      options.config.authorizedOpenId !== verification.identity.openId) ||
    (options.config.authorizedTenantKey &&
      options.config.authorizedTenantKey !== verification.identity.tenantKey)
  ) {
    return report("fail", "IDENTITY_MISMATCH", "NONE", {
      liveGatePassed: true,
    });
  }

  try {
    const result = await (options.writeIdentity ?? pinPhase2IdentityEnvFile)(
      options.envFilePath,
      verification.identity,
    );
    return report("pass", result, "NONE", {
      liveGatePassed: true,
      envUpdated: result === "PINNED",
      identityPinned: true,
    });
  } catch (error) {
    const code =
      error instanceof IdentityEnvError ? error.code : "ENV_UPDATE_FAILED";
    return report("fail", code, "NONE", { liveGatePassed: true });
  }
}

export function serializePhase2IdentityPinReport(
  value: Phase2IdentityPinReport,
): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function phase2IdentityPinExitCode(
  value: Phase2IdentityPinReport,
): number {
  if (value.status === "pass") {
    return 0;
  }
  return value.status === "pending" ? 2 : 1;
}

function configFailureReport(): Phase2IdentityPinReport {
  return report("fail", "CONFIG_INVALID", configInvalidReport().verification_code);
}

function databaseFailureReport(config: AppConfig): Phase2IdentityPinReport {
  return report(
    "fail",
    "DATABASE_UNAVAILABLE",
    databaseUnavailableReport(config).verification_code,
  );
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch {
    const result = configFailureReport();
    process.stdout.write(serializePhase2IdentityPinReport(result));
    process.exitCode = phase2IdentityPinExitCode(result);
    return;
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", () => undefined);

  let result: Phase2IdentityPinReport;
  try {
    result = await runPhase2IdentityPin({
      config,
      reader: new PostgresPhase2LiveReader(pool),
      envFilePath: fileURLToPath(new URL("../../.env", import.meta.url)),
    });
  } catch {
    result = databaseFailureReport(config);
  } finally {
    await pool.end().catch(() => undefined);
  }

  process.stdout.write(serializePhase2IdentityPinReport(result));
  process.exitCode = phase2IdentityPinExitCode(result);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
