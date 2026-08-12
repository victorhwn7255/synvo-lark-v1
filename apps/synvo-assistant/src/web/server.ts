import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { LarkAuthError } from "../lark/auth/index.js";
import type { SynvoMcpEndpoint } from "../mcp/server.js";

import type { LarkOAuthService } from "../workflows/organize-folder/authorization.js";

type OAuthFlow = Pick<
  LarkOAuthService,
  "beginAuthorization" | "completeAuthorization"
>;

type WebServerOptions = {
  host: string;
  port: number;
  oauthService: OAuthFlow;
  healthCheck: () => Promise<boolean>;
  mcpEndpoint?: Pick<SynvoMcpEndpoint, "handle">;
};

const LARK_AUTHORIZATION_ORIGIN = "https://accounts.larksuite.com";

function securityHeaders(
  contentType: string,
  options: { allowLarkAuthorization?: boolean } = {},
): Record<string, string> {
  const formAction = options.allowLarkAuthorization
    ? `form-action 'self' ${LARK_AUTHORIZATION_ORIGIN}`
    : "form-action 'self'";

  return {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(body));
}

function sendHtml(
  response: ServerResponse,
  status: number,
  title: string,
  message: string,
): void {
  response.writeHead(status, securityHeaders("text/html; charset=utf-8"));
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>body{font:16px system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1.5rem;color:#17202a}main{border:1px solid #dfe6e9;border-radius:12px;padding:2rem}h1{font-size:1.5rem}</style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>`);
}

function sendAuthorizationConfirmation(
  response: ServerResponse,
  requestToken: string,
): void {
  const action = `/oauth/lark/start?request=${encodeURIComponent(requestToken)}`;
  response.writeHead(
    200,
    securityHeaders("text/html; charset=utf-8", {
      allowLarkAuthorization: true,
    }),
  );
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Synvo AI Lark Drive access</title>
  <style>body{font:16px system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1.5rem;color:#17202a}main{border:1px solid #dfe6e9;border-radius:12px;padding:2rem}h1{font-size:1.5rem}button{font:inherit;padding:.7rem 1rem;border:0;border-radius:8px;background:#1456f0;color:white;cursor:pointer}</style>
</head>
<body><main><h1>Authorize Synvo AI Lark Drive access</h1><p>Continue only if you started this request in the Synvo AI Assistant conversation. The assistant can read workspace PDFs and perform only file changes that you explicitly approve in Lark.</p><form method="post" action="${action}"><button type="submit">Continue with Lark</button></form></main></body>
</html>`);
}

function logOAuthCallbackFailure(error: unknown): void {
  if (!(error instanceof LarkAuthError)) {
    console.warn("[oauth] callback failed category=INTERNAL");
    return;
  }

  const providerCode =
    error.providerCode && /^[A-Za-z0-9_-]{1,64}$/.test(error.providerCode)
      ? ` provider_code=${error.providerCode}`
      : "";
  console.warn(`[oauth] callback failed category=${error.code}${providerCode}`);
}

export function createAssistantWebHandler(
  options: Omit<WebServerOptions, "host" | "port">,
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/mcp") {
      if (!options.mcpEndpoint) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      await options.mcpEndpoint.handle(request, response);
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const healthy = await options.healthCheck().catch(() => false);
      sendJson(response, healthy ? 200 : 503, {
        status: healthy ? "ok" : "unavailable",
        drive_mode: "read_only",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/oauth/lark/start") {
      const requestToken = url.searchParams.get("request") ?? "";
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(requestToken)) {
        sendHtml(
          response,
          400,
          "Authorization link unavailable",
          "Return to Lark and ask Synvo AI to organize the workspace again.",
        );
        return;
      }
      sendAuthorizationConfirmation(response, requestToken);
      return;
    }

    if (request.method === "POST" && url.pathname === "/oauth/lark/start") {
      const requestToken = url.searchParams.get("request") ?? "";
      try {
        const authorizationUrl = await options.oauthService.beginAuthorization(
          requestToken,
        );
        response.writeHead(303, {
          ...securityHeaders("text/plain; charset=utf-8", {
            allowLarkAuthorization: true,
          }),
          Location: authorizationUrl.toString(),
        });
        response.end("Redirecting to Lark authorization.");
      } catch {
        sendHtml(
          response,
          400,
          "Authorization link unavailable",
          "Return to Lark and ask Synvo AI to organize the workspace again.",
        );
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/oauth/lark/callback") {
      try {
        await options.oauthService.completeAuthorization({
          state: url.searchParams.get("state") ?? undefined,
          code: url.searchParams.get("code") ?? undefined,
          providerError: url.searchParams.get("error") ?? undefined,
        });
        sendHtml(
          response,
          200,
          "Authorization complete",
          "Return to Lark. Your Synvo_Wiki workspace is connected and ready.",
        );
      } catch (error) {
        logOAuthCallbackFailure(error);
        const rejected = error instanceof LarkAuthError;
        sendHtml(
          response,
          rejected ? 400 : 500,
          "Authorization was not completed",
          rejected
            ? "Return to Lark and ask Synvo AI to organize the workspace again."
            : "A safe internal error occurred. Return to Lark and try again later.",
        );
      }
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  };
}

export async function startAssistantWebServer(options: WebServerOptions) {
  const server = createServer(
    createAssistantWebHandler({
      oauthService: options.oauthService,
      healthCheck: options.healthCheck,
      mcpEndpoint: options.mcpEndpoint,
    }),
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.info(`[web] listening on ${options.host}:${options.port}`);
  return server;
}
