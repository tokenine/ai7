import type { IntegrationProviderSettings } from "@rakazo/adapters";
import { GOOGLE_CALLBACK_PATH, GoogleConnector } from "@rakazo/adapters";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import type { AppEnv } from "./env.js";

/**
 * Google redirects the connect popup here after consent. The code is exchanged
 * server-side and the tokens are attached to the pending Connection row keyed
 * by the begin state; the UI's existing connections.complete poll picks the
 * row up without any client-side handling.
 */
export function mountGoogleOAuthCallback(
  app: Hono,
  deps: {
    integrationSettings?: IntegrationProviderSettings;
    env: AppEnv;
  },
) {
  app.get(GOOGLE_CALLBACK_PATH, async (c) => {
    const url = new URL(c.req.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    // The OAuth popup redirect carries no session, so resolving persisted
    // provider credentials reads outside any tenant context.
    const provider = await runAsSystem("resolve the google connector for the oauth callback", () =>
      deps.integrationSettings?.resolve("google").catch(() => undefined),
    );
    if (!(provider instanceof GoogleConnector)) {
      return callbackPage("Google connector is not configured on this server.");
    }
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      return callbackPage(
        oauthError === "access_denied"
          ? "Google sign-in was cancelled. You can close this window and try again."
          : `Google sign-in failed (${oauthError}). You can close this window.`,
      );
    }
    if (!state || !code) {
      return callbackPage("Missing authorization details. Start the connection again in Rakazo.");
    }
    try {
      await provider.handleCallback({
        state,
        code,
        webOrigin: deps.env.webOrigin,
        signal: c.req.raw.signal,
      });
      return callbackPage("Google connected. You can close this window.", true);
    } catch (error) {
      getLogger().error("google oauth callback failed", error);
      return callbackPage(
        "Could not finish the Google connection. Start the connection again in Rakazo.",
      );
    }
  });
}

function callbackPage(message: string, close = false): Response {
  const script = close ? `<script>setTimeout(function(){window.close()},1200)</script>` : "";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Rakazo</title>` +
      `<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;color:#1f2937;background:#f9fafb}p{max-width:32rem;text-align:center;line-height:1.5}</style></head>` +
      `<body><p>${message.replace(/[<>&]/g, "")}</p>${script}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
