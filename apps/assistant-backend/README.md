# Synvo Lark Assistant backend

This service is the deterministic Lark-facing orchestrator for the Synvo AI Assistant pilot.

Phase 1 is verified live:

```text
/ping -> pong
```

Phase 2 passed its live Lark exit gate on 2026-08-07.
Released app version `0.1.1` is approved and restricted to Victor.
The pinned rerun reused the stored OAuth grant, returned the exact expected inventory, and passed `npm run verify:readonly-inventory` with exit code `0`.
Phase 3 passed its live one-file move-and-restore exit gate on 2026-08-07.
Victor reauthorized with the isolated exact four-scope Phase 3 grant, explicitly confirmed the prepared operation, and the operator harness verified `root -> Research -> root` with exact baseline restoration.
Both `npm run verify:drive-spike` and the post-restoration `npm run verify:readonly-inventory` passed with exit code `0`.
This runbook remains the reproducible setup and verification procedure for a fresh development environment.

The current command is:

```text
/organize-folder <Lark Drive folder link>
```

It may list only the allowlisted `Test_Synvo_AI_Assistant` root and its existing `Product` and `Research` child folders.
It does not open or download PDF bodies.
The normal MCP server has no Drive mutation tool.
The completed Phase 3 move harness is operator-only and unavailable through the production MCP tool surface.
GPT integration, interactive-card approval, multi-file execution, and user-facing undo remain unimplemented.

The current sandbox baseline is restricted to Victor.
`Product` and `Research` are confirmed empty, and the four root PDFs are confirmed disposable test copies.
Keep the exact root token only in ignored local secret configuration.

## Phase 2 safety boundary

The Phase 2 workflow OAuth request and stored grant must contain exactly these user scopes for the read-only inventory:

- `space:document:retrieve`.
- `drive:drive.metadata:readonly`.
- `offline_access`.

The narrow metadata scope is required because the scanner verifies the selected root folder's title and owner.
The folder-list scope returns child metadata but does not return the selected root as its own child.

App-level scope approval, a user's OAuth grant, the runtime tool surface, and the master write switch are independent authorization gates.
Released app version `0.1.1` has broader future-facing scopes approved, but the verified Phase 2 grant contains only the three scopes above and the MCP server exposes no write tool.

The Phase 2 workflow must not request or use any of the following:

- `space:document:move`.
- `drive:file:download`.
- `drive:file:readonly`.
- `drive:drive:readonly`.
- `drive:drive`.
- Any other file-content or Drive write scope.

Keep `ORGANIZE_FOLDER_WRITE_ENABLED=false`.
The backend fails startup if this value is `true` during Phase 2.
`space:document:move` was already approved at the app level; Phase 3 added it only to the isolated exact workflow profile and required Victor to reauthorize before the capability spike.
Every other broad app-approved scope must remain outside the Phase 3 OAuth request and runtime tool surface.

## Phase 3 capability-spike boundary

The isolated Phase 3 OAuth request and stored-grant profile contain exactly:

- `space:document:retrieve`.
- `drive:drive.metadata:readonly`.
- `offline_access`.
- `space:document:move`.

Only the operator harness can use the move scope.
It accepts one server-owned prepared batch, the known disposable research PDF, and the exact `root -> Research -> root` path.
It persists encrypted intent before each Lark call, serializes execution, reconciles ambiguous responses from observed Drive state, and verifies the exact baseline after restoration.

Persistent configuration must keep `ORGANIZE_FOLDER_WRITE_ENABLED=false`.
For an explicitly confirmed spike, pass `ORGANIZE_FOLDER_WRITE_ENABLED=true` only to the one operator process; process exit closes that write window even on failure.
Never expose the harness as a normal MCP tool or enable it for Phase 4.

## Prerequisites

- Node.js 20.6 or later.
- Docker Desktop or another Docker Compose-compatible runtime.
- Access to the `Synvo AI Assistant` custom app in the Lark Developer Console.
- The exact Lark Drive link for Victor's `Test_Synvo_AI_Assistant` folder.
- Permission to create and release a Victor-only app version, or help from a Synvo tenant administrator.

Docker Compose currently runs PostgreSQL only.
The assistant backend runs as a local Node.js process during this pilot.

## 1. Configure the Lark app

Open the `Synvo AI Assistant` custom app in the Lark Developer Console.

### Bot feature and messaging

1. Open **Add Features**.
2. Add the **Bot** feature if it is not already present.
3. Open **Permissions & Scopes**.
4. Confirm the minimum app or tenant scopes `im:message.p2p_msg:readonly` and `im:message:send_as_bot`.
5. Open **Events & Callbacks**, then **Event Configuration**.
6. Select persistent-connection event delivery.
7. Subscribe to `im.message.receive_v1`.

The persistent connection is outbound from the local backend to Lark.
It does not need an inbound webhook, a Synvo DNS record, or a tunnel for message events.

### User OAuth scopes

For a fresh app that must reproduce Phase 3, add these four user scopes in **Permissions & Scopes**:

1. `space:document:retrieve`.
2. `drive:drive.metadata:readonly`.
3. `offline_access`.
4. `space:document:move`.

The released Synvo app already has these and broader future-facing scopes approved.
The Phase 2 profile requests and accepts only the first three scopes.
The isolated Phase 3 profile requests and accepts exactly all four scopes.

### OAuth redirect

For the single-machine local pilot, open **Security Settings** and register this exact redirect URL:

```text
http://localhost:3000/oauth/lark/callback
```

This loopback flow must be completed from Lark Desktop or a browser on the same computer that runs the backend.
A link opened on a phone would send `localhost` to the phone instead of the development computer.

No Synvo-owned DNS name is required for this local flow.
A stable HTTPS tunnel is an alternative only when another device must reach the callback.

The exact staging redirect is reserved as:

```text
https://lark-assistant-staging.synvo.ai/oauth/lark/callback
```

Do not configure the staging value until that host routes HTTPS traffic to this service.
The environment value, OAuth request, and registered redirect must match character for character.

### Restricted release and approval

These steps are already complete for Synvo app version `0.1.1` and remain here for reproducing the setup with a fresh app or tenant.

1. Open **Version Management & Release**.
2. Create a new version containing the Bot capability, messaging scopes, event subscription, and the four Phase 3 user scopes.
3. Keep the availability range restricted to Victor.
4. Submit or publish the version.
5. Obtain any approval required by the Synvo tenant administrator.

Draft configuration does not affect the installed app until Lark publishes the required version.
Do not use **Test Companies & Users** because that isolated tenant cannot access Victor's real Synvo My Space.

## 2. Configure the local environment

An ignored `.env` may already contain the real App ID, App Secret, and root token from Phase 1.
Do not overwrite that file with `.env.example`.
Merge only the missing keys from `.env.example` and keep all secret values out of chat, screenshots, logs, and version control.

Set the following values:

- `LARK_APP_ID` and `LARK_APP_SECRET` from **Credentials & Basic Info**.
- `DATABASE_URL` from the local Docker Compose configuration.
- `HTTP_HOST=127.0.0.1` and `HTTP_PORT=3000`.
- `LARK_OAUTH_REDIRECT_URI=http://localhost:3000/oauth/lark/callback`.
- `OAUTH_TOKEN_ENCRYPTION_KEY` to a new 32-byte random key.
- `ORGANIZE_FOLDER_ROOT_TOKEN` to the token after `/drive/folder/` in the exact sandbox folder link.
- `ORGANIZE_FOLDER_WRITE_ENABLED=false`.

Generate the Base64URL token-encryption key locally:

```bash
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
```

Store the output as one `.env` value.
Do not rotate this local key while encrypted OAuth records still need to be read.

`LARK_AUTHORIZED_OPEN_ID` and `LARK_AUTHORIZED_TENANT_KEY` provide defense in depth.
They may remain unset during the first OAuth bootstrap, but the live Phase 2 exit verifier requires both.
After a successful bootstrap inventory is delivered in Lark, stop the backend and run:

```bash
npm run pin:pilot-identity
```

The command rechecks the full redacted live gate against the matching requester and OAuth grant, then writes both values atomically to the ignored backend `.env` with mode `0600`.
It never prints either identity value.
It exits with `2` while no verified bootstrap run exists, exits with `1` on a mismatch or unsafe environment file, and exits with `0` only after the matching pair is pinned or was already pinned.

The first bootstrap run is not final Phase 2 evidence because the static allowlist was not active when that request arrived.
After the identity-pinning command succeeds, restart the backend.
Send `/ping` and `/organize-folder <folder-link>` again after the restart.
Only that latest allowlist-pinned rerun may be used by the live exit verifier as final evidence.
Never query, paste, or log either identity value.

## 3. Start PostgreSQL and apply the migration

From the repository root, run:

```bash
docker compose up -d postgres
docker compose ps
npm run migrate
```

Wait until the PostgreSQL service is healthy before running the migration.
The migration command reads only `DATABASE_URL` from `apps/assistant-backend/.env`.
It applies both versioned Phase 2 migrations and the Phase 3 capability-spike migration, recording each checksum.

The backend checks for every required table and migration at startup and through `/health`.
It fails closed and asks for migrations if the schema is incomplete.

## 4. Verify the repository

From the repository root, run:

```bash
npm install
npm run typecheck
npm test
docker compose config
```

Type checking and all default unit and contract suites pass.

Five Phase 2 and one Phase 3 Docker-backed PostgreSQL integration tests also pass against the migrated local database.
Run both suites explicitly after the local database is healthy and migrated:

```bash
TEST_DATABASE_URL='<isolated PostgreSQL test URL>' npm run test:integration:workflow-state
TEST_DATABASE_URL='<isolated PostgreSQL test URL>' npm run test:integration:drive-mutations
```

Do not count a skipped integration test as a database verification.

## 5. Start the backend

From the repository root, run:

```bash
npm run dev --workspace @synvo/assistant-backend
```

Wait for both messages:

```text
[http] listening on 127.0.0.1:3000
[lark] persistent connection is ready
```

In another terminal, verify readiness:

```bash
curl http://127.0.0.1:3000/health
```

The expected response has `status` set to `ok`, `phase` set to `3`, and `drive_mode` set to `read_only_preflight`.

Keep the backend running for the live Lark flow.
Stop it with `Ctrl+C` only after the live checks are finished.

## 6. Verify the live Lark flow

Use a direct chat with the released `Synvo AI Assistant` bot.

1. Send `/ping` and confirm the bot replies `pong`.
2. Send `/organize-folder <exact sandbox folder link>`.
3. Confirm the bot returns a single-use authorization link that expires in ten minutes.
4. Open the link on the same computer that runs the backend.
5. Review the local confirmation page, then click **Continue with Lark**.
6. Review the Lark consent screen and confirm it requests only the exact four Phase 3 user scopes.
7. Authorize with the same Victor account that sent the bot message.
8. Return to Lark and wait for the inventory.
9. Confirm it reports one root, two empty approved destination folders, four PDF files, no unsupported item, and matching owner signals.
10. Reopen Lark Drive and confirm no folder or file changed.
11. Confirm the Phase 3 OAuth grant contains only the exact four scopes, the normal MCP server exposes no write tool, and the master write switch is disabled.
12. Visually confirm the inventory, then run the redacted live verifiers described below.

Never query, display, or log either OAuth token-ciphertext column during this inspection.
For a fresh environment, complete and verify the Phase 2 identity-pinning bootstrap before attempting a Phase 3 capability spike.
The read-only preflight alone must never be described as proof of a move.

## 7. Run the redacted live exit verifier

From the repository root, run both verifiers:

```bash
npm run verify:readonly-inventory
npm run verify:drive-spike
```

The command loads `apps/assistant-backend/.env` and performs read-only inspection of the latest organizer run and its joined OAuth grant.
It decrypts the cached scan result locally, validates it against the strict shared result schema, and checks the exact Phase 2 baseline.
It never prints identities, resource names, IDs, tokens, ciphertext, URLs, timestamps, or provider details.

The exit codes are:

- `0` for `pass`.
- `2` for `pending`, including when no live run exists yet.
- `1` for `fail`.

A Phase 2 `pass` confirms the configured write flag, root digest, static actor binding, read-only OAuth grant metadata, terminal run state, completed delivery record, and encrypted inventory result.
A Phase 3 `pass` additionally confirms the exact isolated four-scope grant, explicit operator confirmation, exactly two verified directions, restored durable batch state, and the current exact baseline.
It does not inspect the Lark Developer Console or prove what Victor saw in chat.
The released scopes and the visible Lark reply must still be confirmed manually.

## 8. Reproduce the operator-only Phase 3 spike

Do this only with the disposable fixture, a passing read-only preflight, and explicit operator confirmation.

1. Keep persistent `.env` configuration at `ORGANIZE_FOLDER_WRITE_ENABLED=false`.
2. Run `npm run drive-spike:prepare` and present its exact source, forward move, restoration, and safety checks to Victor.
3. Wait for Victor to explicitly confirm that exact operation.
4. Run the prepared server-owned batch in one ephemeral process:

   ```bash
   ORGANIZE_FOLDER_WRITE_ENABLED=true npm run drive-spike:execute -- <prepared-batch-id> --confirm-drive-round-trip
   ```

5. Require `RESTORED`, forward verification, restoration verification, and baseline restoration.
6. Run `npm run verify:drive-spike` and `npm run verify:readonly-inventory` immediately afterward.
7. Confirm `.env` still contains `ORGANIZE_FOLDER_WRITE_ENABLED=false`.

Never reuse a batch for another file, persist the write flag as true, or proceed when an observed parent is unknown.

## Current verification boundary

Phase 3 is verified live against Lark Drive:

- Victor's exact four-scope OAuth grant and actor binding passed.
- The known disposable research PDF completed a verified `root -> Research -> root` round trip.
- Durable intent, unique per-direction attempts, explicit confirmation, and reconciliation gates passed.
- The exact two-folder, four-root-file, empty-destination baseline was restored.
- The persistent write switch is disabled, and the normal MCP server still exposes only the bounded read-only inventory tool.

Phase 4 is next. It must build an immutable read-only snapshot and deterministic fixture-label proposal without opening file bodies or enabling any write path.
