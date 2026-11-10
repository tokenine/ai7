import { randomBytes } from "node:crypto";
import type {
  AdapterContext,
  ArtifactStore,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { filterCatalog } from "./connector-catalog.js";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import { readBodyCapped } from "./web-ssrf.js";

const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

/** Path the Google OAuth popup lands on; reachable via the web app's /api proxy. */
export const GOOGLE_CALLBACK_PATH = "/api/integrations/google/callback";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// Artifact uploads read from disk on the server side — the cap matches the
// attachment ingest ceiling, not the model-context one.
const MAX_ARTIFACT_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface GoogleConnectorConfig {
  clientId: string;
  clientSecret: string;
}

export interface GoogleConnectorDependencies {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load">;
  /** Artifact store when the deployment has one — enables artifact_id uploads. */
  artifacts?: Pick<ArtifactStore, "get">;
  fetch?: typeof fetch;
}

/** What a completed OAuth callback connected, for server-side follow-ups
 * (e.g. auto-installing the matching connector skills). */
export type GoogleCallbackResult = {
  slug: string;
  userId: string;
  spaceId: string;
};

/** Match a granted-scope string back to the app tile that was connected. */
function slugForGrantedScopes(scope: string | undefined): string {
  if (!scope) return "";
  for (const app of GOOGLE_APPS) {
    if (app.scopes.some((entry) => scope.includes(entry))) return app.slug;
  }
  return "";
}

type GoogleApp = {
  slug: string;
  name: string;
  scopes: readonly string[];
};

/** Slugs match FEATURED_CONNECTOR_IDS aliases so the Connectors tiles light up untouched. */
const GOOGLE_APPS: readonly GoogleApp[] = [
  {
    slug: "gmail",
    name: "Gmail",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  },
  {
    slug: "googlecalendar",
    name: "Google Calendar",
    scopes: [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly",
    ],
  },
  {
    slug: "googledrive",
    name: "Google Drive",
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  },
];

type StoredGoogleTokens = {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds the access token is considered expired at. */
  expires_at: number;
  email?: string;
  sub?: string;
};

export function isGoogleEnabled(config: Partial<GoogleConnectorConfig>): boolean {
  return Boolean(config.clientId && config.clientSecret);
}

function appBySlug(slug: string): GoogleApp | undefined {
  const normalized = slug.trim().toLowerCase();
  return GOOGLE_APPS.find((app) => app.slug === normalized);
}

/** Stable callback redirect URI for a deployment; must match the Google Cloud OAuth client. */
export function googleRedirectUri(webOrigin: string): string {
  return `${webOrigin.replace(/\/$/, "")}${GOOGLE_CALLBACK_PATH}`;
}

export class GoogleConnector implements ManagedConnectorProvider {
  constructor(
    private readonly config: GoogleConnectorConfig,
    private readonly dependencies: GoogleConnectorDependencies,
  ) {}

  describe() {
    return {
      id: "google",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      // Tokens live in this deployment's encrypted secret store, not at a broker.
      capabilities: { discover: true, oauth: true, secretsBrokered: false },
    };
  }

  async catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]> {
    const connected = new Set(await this.listConnectedExternalIds(context));
    return filterCatalog(
      GOOGLE_APPS.map((app) => ({
        connectorId: "google",
        slug: app.slug,
        name: app.name,
        logo: null,
        connected: connected.has(app.slug),
        noAuth: false,
      })),
      query ?? "",
    );
  }

  async warmDirectory(): Promise<void> {}

  async listConnectedExternalIds(context: AdapterContext): Promise<string[]> {
    const rows = await this.dependencies.prisma.connection.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        connectorId: "google",
        status: "connected",
      },
      select: { provider: true },
    });
    return [...new Set(rows.map((row) => row.provider))];
  }

  /** Ready = a pending/connected row for this slug already stores OAuth tokens. */
  async connectionReady(context: AdapterContext, externalId: string): Promise<boolean> {
    const row = await this.dependencies.prisma.connection.findFirst({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        connectorId: "google",
        provider: externalId,
        status: { in: ["pending", "connected"] },
        secretId: { not: null },
      },
      select: { id: true },
    });
    return Boolean(row);
  }

  async begin(
    request: { provider: string; redirectUrl: string },
    _context: AdapterContext,
  ): Promise<{ authorizationUrl: string | null; state: string }> {
    const app = appBySlug(request.provider);
    if (!app) throw new Error(`Unknown Google app: ${request.provider}`);
    const state = randomBytes(24).toString("base64url");
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: googleRedirectUri(new URL(request.redirectUrl).origin),
      response_type: "code",
      scope: app.scopes.join(" "),
      access_type: "offline",
      // consent + offline is what yields a refresh token on every authorization.
      prompt: "consent",
      include_granted_scopes: "false",
      state,
    });
    return { authorizationUrl: `${AUTH_BASE}?${params}`, state };
  }

  /**
   * The popup never returns to the app with a code: Google posts the code to
   * GOOGLE_CALLBACK_PATH (handled by handleCallback, which persists tokens onto
   * the pending row). By the time the UI's connection poll lands here, readiness
   * is a stored-secret check.
   */
  async complete(request: { state: string }): Promise<{ connectionRef: string }> {
    return { connectionRef: request.state };
  }

  /** Exchange an authorization code and attach the tokens to the pending connection row. */
  async handleCallback(input: {
    state: string;
    code: string;
    webOrigin: string;
    signal?: AbortSignal;
  }): Promise<GoogleCallbackResult> {
    // The connect popup's redirect carries no session: the pending row is the
    // only tenant hint, so the lookup (and everything it drives) runs as system
    // until the row resolves the Space and user it belongs to.
    return runAsSystem("persist google oauth tokens from the connect callback", async () => {
      const row = await this.dependencies.prisma.connection.findFirst({
        where: { connectorId: "google", providerRef: input.state, status: "pending" },
        select: { id: true, userId: true, spaceId: true, secretId: true },
      });
      if (!row) throw new Error("This Google authorization is no longer pending. Connect again.");
      return this.persistCallbackTokens(input, row);
    });
  }

  private async persistCallbackTokens(
    input: { state: string; code: string; webOrigin: string; signal?: AbortSignal },
    row: { id: string; userId: string; spaceId: string; secretId: string | null },
  ): Promise<GoogleCallbackResult> {
    const exchanged = await this.exchangeCode(
      input.code,
      googleRedirectUri(input.webOrigin),
      input.signal,
    );
    const previous = row.secretId
      ? await this.loadTokens(row.secretId).catch(() => undefined)
      : undefined;
    const tokens: StoredGoogleTokens = {
      // Re-consent flows may omit refresh_token; keep the still-valid one.
      refresh_token: exchanged.refresh_token ?? previous?.refresh_token,
      access_token: exchanged.access_token,
      expires_at: Date.now() + exchanged.expires_in * 1_000,
      ...(exchanged.email
        ? { email: exchanged.email }
        : previous?.email
          ? { email: previous.email }
          : {}),
      ...(exchanged.sub ? { sub: exchanged.sub } : previous?.sub ? { sub: previous.sub } : {}),
    };
    const recordId = row.secretId ?? `google-connection:${row.id}`;
    const stored = await this.dependencies.secrets.put(
      JSON.stringify(tokens),
      {
        operationId: "google-connection",
        traceId: "google-connection",
        spaceId: "",
        userId: "",
        signal: input.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      { recordId },
    );
    await this.dependencies.prisma.$transaction(async (tx) => {
      if (row.secretId) {
        await tx.secret.update({
          where: { id: row.secretId },
          data: { ciphertext: stored.ciphertext },
        });
      } else {
        await tx.secret.create({
          data: {
            id: recordId,
            userId: row.userId,
            spaceId: row.spaceId,
            kind: "connector",
            ciphertext: stored.ciphertext,
          },
        });
        await tx.connection.update({ where: { id: row.id }, data: { secretId: recordId } });
      }
    });
    return {
      slug: slugForGrantedScopes(exchanged.scope),
      userId: row.userId,
      spaceId: row.spaceId,
    };
  }

  async revoke(connectionRef: string, context: AdapterContext): Promise<void> {
    const row = await this.dependencies.prisma.connection.findFirst({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        connectorId: "google",
        providerRef: connectionRef,
      },
      select: { id: true, secretId: true },
    });
    if (!row?.secretId) return;
    const tokens = await this.loadTokens(row.secretId).catch(() => undefined);
    const token = tokens?.refresh_token ?? tokens?.access_token;
    if (!token) return;
    // Best effort: a failed remote revoke must not block deleting the local row.
    await this.rawRequest(
      REVOKE_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      },
      context.signal,
    ).catch(() => undefined);
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const slugs = await this.listConnectedExternalIds(context);
    const tools: ConnectorTool[] = [];
    for (const slug of slugs) {
      tools.push(...googleToolsFor(slug));
    }
    return tools;
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const slug = call.route?.resourceId;
    if (!slug || !appBySlug(slug)) {
      yield { type: "error", message: "Google connection route is missing" };
      return;
    }
    try {
      const row = await this.dependencies.prisma.connection.findFirst({
        where: {
          spaceId: context.spaceId,
          userId: context.userId,
          connectorId: "google",
          provider: slug,
          status: "connected",
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: { secretId: true },
      });
      if (!row?.secretId) {
        yield { type: "error", message: "This Google app is not connected. Connect it again." };
        return;
      }
      const tokens = await this.ensureFreshTokens(row.secretId, context);
      const data = await executeGoogleTool(slug, call, tokens, context, this.dependencies);
      yield {
        type: "result",
        data: redactConnectorPayload(
          data,
          [tokens.access_token, tokens.refresh_token, this.config.clientSecret].filter(
            (value): value is string => Boolean(value),
          ),
        ),
      };
    } catch (error) {
      const storedMaterial = await this.currentSecretValues(context, slug);
      yield {
        type: "error",
        message: sanitizeConnectorError(
          error,
          [this.config.clientSecret, storedMaterial].filter((value): value is string =>
            Boolean(value),
          ),
        ),
      };
    }
  }

  private async currentSecretValues(
    context: AdapterContext,
    slug: string,
  ): Promise<string | undefined> {
    try {
      const row = await this.dependencies.prisma.connection.findFirst({
        where: {
          spaceId: context.spaceId,
          userId: context.userId,
          connectorId: "google",
          provider: slug,
          status: "connected",
        },
        select: { secretId: true },
      });
      if (!row?.secretId) return undefined;
      const tokens = await this.loadTokens(row.secretId);
      return [tokens.access_token, tokens.refresh_token].filter(Boolean).join(" ");
    } catch {
      return undefined;
    }
  }

  /** Load tokens; refresh and persist when the access token is at or near expiry. */
  private async ensureFreshTokens(
    secretId: string,
    context: AdapterContext,
  ): Promise<StoredGoogleTokens> {
    const tokens = await this.loadTokens(secretId);
    if (tokens.expires_at - Date.now() > 60_000) return tokens;
    if (!tokens.refresh_token) {
      throw new Error("Google authorization expired. Reconnect this app in Connectors.");
    }
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    });
    const response = await this.rawRequest(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      context.signal,
    );
    const parsed = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };
    if (!response.ok || !parsed.access_token) {
      throw new Error(
        `Google token refresh failed (${response.status}). Reconnect this app in Connectors.`,
      );
    }
    const next: StoredGoogleTokens = {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token ?? tokens.refresh_token,
      expires_at: Date.now() + (parsed.expires_in ?? 3_600) * 1_000,
      ...(tokens.email ? { email: tokens.email } : {}),
      ...(tokens.sub ? { sub: tokens.sub } : {}),
    };
    const stored = await this.dependencies.secrets.put(JSON.stringify(next), context, {
      recordId: secretId,
    });
    await this.dependencies.prisma.secret
      .update({ where: { id: secretId }, data: { ciphertext: stored.ciphertext } })
      .catch(() => undefined);
    return next;
  }

  private async loadTokens(secretId: string): Promise<StoredGoogleTokens> {
    const row = await this.dependencies.prisma.secret.findUnique({
      where: { id: secretId },
      select: { ciphertext: true },
    });
    if (!row) throw new Error("Google connection tokens are missing. Reconnect this app.");
    const parsed = JSON.parse(
      await this.dependencies.secrets.load(row.ciphertext, {
        recordId: secretId,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    ) as StoredGoogleTokens;
    if (!parsed.access_token) throw new Error("Google connection tokens are malformed.");
    return parsed;
  }

  private async exchangeCode(
    code: string,
    redirectUri: string,
    signal?: AbortSignal,
  ): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
    email?: string;
    sub?: string;
  }> {
    const body = new URLSearchParams({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const response = await this.rawRequest(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
      signal,
    );
    const parsed = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
      scope?: string;
      error?: string;
    };
    if (!response.ok || !parsed.access_token) {
      throw new Error(`Google authorization failed: ${parsed.error ?? response.status}`);
    }
    const claims = parsed.id_token ? decodeIdTokenClaims(parsed.id_token) : undefined;
    return {
      access_token: parsed.access_token,
      ...(parsed.refresh_token ? { refresh_token: parsed.refresh_token } : {}),
      expires_in: parsed.expires_in ?? 3_600,
      ...(parsed.scope ? { scope: parsed.scope } : {}),
      ...(claims?.email ? { email: claims.email } : {}),
      ...(claims?.sub ? { sub: claims.sub } : {}),
    };
  }

  private async rawRequest(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const requestAbort = combineSignals(signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    return (this.dependencies.fetch ?? globalThis.fetch)(url, { ...init, signal: requestAbort });
  }
}

function decodeIdTokenClaims(idToken: string): { email?: string; sub?: string } | undefined {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return undefined;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
      sub?: string;
    };
    return { ...(json.email ? { email: json.email } : {}), ...(json.sub ? { sub: json.sub } : {}) };
  } catch {
    return undefined;
  }
}

async function readBoundedBody(response: Response, signal?: AbortSignal): Promise<string> {
  const bytes = await readBodyCapped(response, MAX_RESPONSE_BYTES, signal);
  return new TextDecoder().decode(bytes);
}

async function googleJsonFetch(
  url: string,
  init: RequestInit,
  tokens: StoredGoogleTokens,
  context: AdapterContext,
  fetchImpl?: typeof fetch,
): Promise<unknown> {
  const requestAbort = combineSignals(context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  const response = await (fetchImpl ?? globalThis.fetch)(url, {
    ...init,
    headers: { authorization: `Bearer ${tokens.access_token}`, ...init.headers },
    signal: requestAbort,
  });
  const text = await readBoundedBody(response, requestAbort);
  const parsed = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const detail =
      typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error?: { message?: string } }).error?.message ?? "")
        : "";
    throw new Error(`Google API returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

function googleToolsFor(slug: string): ConnectorTool[] {
  const route = { connectorId: "google", resourceId: slug };
  if (slug === "gmail") {
    return [
      {
        name: "gmail_search",
        description:
          "Search the connected Gmail account. Uses Gmail search syntax (from:, is:unread, newer_than:1d, ...). Returns message ids with snippets; read one with gmail_read.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Gmail search query. Empty lists recent mail." },
            max_results: { type: "number", description: "1-25. Default 10." },
          },
          additionalProperties: false,
        },
        readOnly: true,
        route: { ...route, toolName: "gmail_search" },
      },
      {
        name: "gmail_read",
        description: "Read one Gmail message by id (from gmail_search), including its text body.",
        inputSchema: {
          type: "object",
          properties: { message_id: { type: "string" } },
          required: ["message_id"],
          additionalProperties: false,
        },
        readOnly: true,
        route: { ...route, toolName: "gmail_read" },
      },
      {
        name: "gmail_send",
        description:
          "Send an email from the connected Gmail account. Recipients are visible to the user before sending.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient email address." },
            subject: { type: "string" },
            body: { type: "string", description: "Plain-text body." },
            cc: { type: "string" },
            bcc: { type: "string" },
            thread_id: { type: "string", description: "Optional Gmail thread id to reply within." },
          },
          required: ["to", "subject", "body"],
          additionalProperties: false,
        },
        readOnly: false,
        route: { ...route, toolName: "gmail_send" },
      },
    ];
  }
  if (slug === "googlecalendar") {
    return [
      {
        name: "gcal_list_events",
        description:
          "List Google Calendar events in a time range on the primary calendar. ISO datetimes, e.g. 2026-10-08T00:00:00+07:00.",
        inputSchema: {
          type: "object",
          properties: {
            time_min: { type: "string", description: "Range start (ISO 8601). Default: now." },
            time_max: { type: "string", description: "Range end (ISO 8601). Default: +7 days." },
            query: { type: "string", description: "Free-text filter." },
            max_results: { type: "number", description: "1-25. Default 25." },
          },
          additionalProperties: false,
        },
        readOnly: true,
        route: { ...route, toolName: "gcal_list_events" },
      },
      {
        name: "gcal_create_event",
        description: "Create a Google Calendar event on the primary calendar.",
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Event title." },
            start: {
              type: "string",
              description: "Start (ISO 8601 with offset, e.g. 2026-10-08T14:00:00+07:00).",
            },
            end: { type: "string", description: "End (ISO 8601 with offset)." },
            description: { type: "string" },
            location: { type: "string" },
            attendees: {
              type: "array",
              items: { type: "string", description: "Attendee email address." },
              description: "Optional attendee emails. Google decides whether to email invitations.",
            },
          },
          required: ["summary", "start", "end"],
          additionalProperties: false,
        },
        readOnly: false,
        route: { ...route, toolName: "gcal_create_event" },
      },
      {
        name: "gcal_update_event",
        description: "Update fields of an existing Google Calendar event (from gcal_list_events).",
        inputSchema: {
          type: "object",
          properties: {
            event_id: { type: "string" },
            summary: { type: "string" },
            start: { type: "string" },
            end: { type: "string" },
            description: { type: "string" },
            location: { type: "string" },
          },
          required: ["event_id"],
          additionalProperties: false,
        },
        readOnly: false,
        route: { ...route, toolName: "gcal_update_event" },
      },
    ];
  }
  if (slug === "googledrive") {
    return [
      {
        name: "gdrive_upload_file",
        description:
          "Upload a file to Google Drive. Preferred: artifact_id for any file attached to the conversation (no size gymnastics, up to 25MB). Otherwise text content or base64 for small binary data. The app only sees files it created.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                "File name with extension, e.g. report.md. Defaults to the artifact's name.",
            },
            artifact_id: {
              type: "string",
              description:
                "Artifact id from an attachment note (User attached …) or history. Uploads the stored file directly.",
            },
            content: { type: "string", description: "Text content (UTF-8)." },
            content_base64: {
              type: "string",
              description:
                "Base64 content for binary files. Use instead of content. Only for small (<1MB) data — prefer artifact_id for files.",
            },
            mime_type: {
              type: "string",
              description: "MIME type. Defaults to the artifact's or text/plain; charset=utf-8.",
            },
            folder_id: {
              type: "string",
              description:
                "Optional destination folder id from gdrive_create_folder (or gdrive_list_files with folders).",
            },
          },
          required: [],
          additionalProperties: false,
        },
        readOnly: false,
        route: { ...route, toolName: "gdrive_upload_file" },
      },
      {
        name: "gdrive_create_folder",
        description:
          "Create a folder in Google Drive. Upload into it with gdrive_upload_file's folder_id.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Folder name, e.g. ai7" },
            parent_id: {
              type: "string",
              description: "Optional parent folder id (omit to create at the Drive root).",
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        readOnly: false,
        route: { ...route, toolName: "gdrive_create_folder" },
      },
      {
        name: "gdrive_list_files",
        description:
          "List files and folders this app created in Google Drive (drive.file scope cannot list the rest of the drive).",
        inputSchema: {
          type: "object",
          properties: {
            name_contains: { type: "string", description: "Filter by file name substring." },
            folder_id: {
              type: "string",
              description: "Only list direct children of this folder id.",
            },
            page_size: { type: "number", description: "1-50. Default 20." },
          },
          additionalProperties: false,
        },
        readOnly: true,
        route: { ...route, toolName: "gdrive_list_files" },
      },
      {
        name: "gdrive_share_link",
        description: "Make an uploaded file viewable by anyone with the link and return the link.",
        inputSchema: {
          type: "object",
          properties: { file_id: { type: "string" } },
          required: ["file_id"],
          additionalProperties: false,
        },
        readOnly: false,
        route: { ...route, toolName: "gdrive_share_link" },
      },
    ];
  }
  return [];
}

async function executeGoogleTool(
  slug: string,
  call: ConnectorCall,
  tokens: StoredGoogleTokens,
  context: AdapterContext,
  dependencies: GoogleConnectorDependencies,
): Promise<unknown> {
  const toolName = call.route?.toolName ?? call.tool;
  const args = call.args ?? {};
  const fetchImpl = dependencies.fetch;
  const fetchJson = (url: string, init: RequestInit = {}) =>
    googleJsonFetch(url, init, tokens, context, fetchImpl);
  if (slug === "gmail") return gmailExecute(toolName, args, fetchJson);
  if (slug === "googlecalendar") return calendarExecute(toolName, args, fetchJson);
  return driveExecute(toolName, args, tokens, context, dependencies);
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

type FetchJson = (url: string, init?: RequestInit) => Promise<unknown>;

async function gmailExecute(toolName: string, args: Record<string, unknown>, fetchJson: FetchJson) {
  if (toolName === "gmail_search") {
    const max = clampNumber(args.max_results, 1, 25, 10);
    const params = new URLSearchParams({ maxResults: String(max) });
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query) params.set("q", query);
    const list = (await fetchJson(`${GMAIL_API}/messages?${params}`)) as {
      messages?: Array<{ id: string; threadId: string }>;
    };
    const ids = (list.messages ?? []).slice(0, max);
    const messages = await Promise.all(
      ids.map(async (entry) => {
        const full = (await fetchJson(
          `${GMAIL_API}/messages/${entry.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        )) as GmailMessage;
        return {
          id: entry.id,
          thread_id: entry.threadId,
          from: gmailHeader(full, "From"),
          subject: gmailHeader(full, "Subject") || "(no subject)",
          date: gmailHeader(full, "Date"),
          snippet: full.snippet ?? "",
        };
      }),
    );
    return { query: query || null, count: messages.length, messages };
  }
  if (toolName === "gmail_read") {
    const id = String(args.message_id ?? "").trim();
    if (!id) throw new Error("message_id is required");
    const full = (await fetchJson(`${GMAIL_API}/messages/${id}?format=full`)) as GmailMessage;
    return {
      id,
      thread_id: full.threadId,
      from: gmailHeader(full, "From"),
      to: gmailHeader(full, "To"),
      subject: gmailHeader(full, "Subject") || "(no subject)",
      date: gmailHeader(full, "Date"),
      attachments: gmailAttachmentNames(full),
      body: gmailBodyText(full),
    };
  }
  if (toolName === "gmail_send") {
    const to = String(args.to ?? "").trim();
    const subject = String(args.subject ?? "");
    const body = String(args.body ?? "");
    if (!to || !subject) throw new Error("to and subject are required");
    const lines = [`To: ${to}`];
    const cc = typeof args.cc === "string" ? args.cc.trim() : "";
    if (cc) lines.push(`Cc: ${cc}`);
    const bcc = typeof args.bcc === "string" ? args.bcc.trim() : "";
    if (bcc) lines.push(`Bcc: ${bcc}`);
    lines.push(`Subject: ${subject.replace(/[\r\n]+/g, " ")}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"', "", body);
    const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
    const payload: Record<string, unknown> = { raw };
    const threadId = typeof args.thread_id === "string" ? args.thread_id.trim() : "";
    if (threadId) payload.threadId = threadId;
    const sent = (await fetchJson(`${GMAIL_API}/messages/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })) as { id?: string; threadId?: string };
    return { sent: true, id: sent.id ?? null, thread_id: sent.threadId ?? (threadId || null) };
  }
  throw new Error(`Unknown Gmail tool: ${toolName}`);
}

type GmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  payload?: GmailPart;
};

type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
};

function gmailHeader(message: GmailMessage, name: string): string {
  const headers = message.payload?.headers ?? [];
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function gmailAttachmentNames(message: GmailMessage): string[] {
  const names: string[] = [];
  const walk = (part: GmailPart | undefined) => {
    if (!part) return;
    if (part.filename) names.push(part.filename);
    for (const child of part.parts ?? []) walk(child);
  };
  walk(message.payload);
  return names;
}

function gmailBodyText(message: GmailMessage): string {
  const walk = (part: GmailPart | undefined): string | undefined => {
    if (!part) return undefined;
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64url").toString("utf8");
    }
    for (const child of part.parts ?? []) {
      const found = walk(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const plain = walk(message.payload);
  if (plain !== undefined) return plain;
  // HTML-only mail: strip tags so the model still gets readable text.
  const html =
    (message.payload?.body?.data
      ? Buffer.from(message.payload.body.data, "base64url").toString("utf8")
      : "") ||
    message.snippet ||
    "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

async function calendarExecute(
  toolName: string,
  args: Record<string, unknown>,
  fetchJson: FetchJson,
) {
  const calendarId = encodeURIComponent("primary");
  if (toolName === "gcal_list_events") {
    const max = clampNumber(args.max_results, 1, 25, 25);
    const timeMin =
      typeof args.time_min === "string" && args.time_min.trim()
        ? args.time_min.trim()
        : new Date().toISOString();
    const timeMax =
      typeof args.time_max === "string" && args.time_max.trim()
        ? args.time_max.trim()
        : new Date(Date.now() + 7 * 24 * 3600 * 1_000).toISOString();
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      maxResults: String(max),
      singleEvents: "true",
      orderBy: "startTime",
    });
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query) params.set("q", query);
    const list = (await fetchJson(`${CALENDAR_API}/${calendarId}/events?${params}`)) as {
      items?: Array<Record<string, unknown>>;
    };
    return {
      count: list.items?.length ?? 0,
      events: (list.items ?? []).map((event) => ({
        id: event.id,
        summary: event.summary ?? "(no title)",
        start: event.start,
        end: event.end,
        location: event.location ?? null,
        description: event.description ?? null,
        attendees: (event.attendees as Array<{ email?: string }> | undefined)?.map(
          (attendee) => attendee.email,
        ),
      })),
    };
  }
  if (toolName === "gcal_create_event") {
    const body = calendarEventBody(args, true);
    const created = (await fetchJson(`${CALENDAR_API}/${calendarId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })) as { id?: string; htmlLink?: string };
    return { created: true, id: created.id ?? null, link: created.htmlLink ?? null };
  }
  if (toolName === "gcal_update_event") {
    const eventId = String(args.event_id ?? "").trim();
    if (!eventId) throw new Error("event_id is required");
    const body = calendarEventBody(args, false);
    const updated = (await fetchJson(
      `${CALENDAR_API}/${calendarId}/events/${encodeURIComponent(eventId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    )) as { id?: string; htmlLink?: string };
    return { updated: true, id: updated.id ?? eventId, link: updated.htmlLink ?? null };
  }
  throw new Error(`Unknown Calendar tool: ${toolName}`);
}

function calendarEventBody(
  args: Record<string, unknown>,
  requireTimes: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (summary) body.summary = summary;
  if (typeof args.description === "string" && args.description.trim())
    body.description = args.description;
  if (typeof args.location === "string" && args.location.trim()) body.location = args.location;
  if (Array.isArray(args.attendees)) {
    const attendees = args.attendees
      .map((email) => String(email).trim())
      .filter(Boolean)
      .map((email) => ({ email }));
    if (attendees.length > 0) body.attendees = attendees;
  }
  const start = typeof args.start === "string" ? args.start.trim() : "";
  const end = typeof args.end === "string" ? args.end.trim() : "";
  if (start) body.start = { dateTime: start };
  if (end) body.end = { dateTime: end };
  if (requireTimes && (!start || !end)) throw new Error("start and end are required");
  return body;
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

async function driveExecute(
  toolName: string,
  args: Record<string, unknown>,
  tokens: StoredGoogleTokens,
  context: AdapterContext,
  dependencies: GoogleConnectorDependencies,
) {
  const fetchJson: FetchJson = (url, init = {}) =>
    googleJsonFetch(url, init, tokens, context, dependencies.fetch);
  if (toolName === "gdrive_upload_file") {
    const folderId = typeof args.folder_id === "string" ? args.folder_id.trim() : "";
    const artifactId = typeof args.artifact_id === "string" ? args.artifact_id.trim() : "";
    let name = String(args.name ?? "").trim();
    let mime =
      typeof args.mime_type === "string" && args.mime_type.trim()
        ? args.mime_type.trim()
        : "text/plain; charset=utf-8";
    let content: Buffer;
    if (artifactId) {
      const row = await dependencies.prisma.artifact.findFirst({
        where: { id: artifactId, spaceId: context.spaceId },
        select: { name: true, mimeType: true, storageKey: true },
      });
      if (!row) {
        throw new Error(`Artifact ${artifactId} was not found in this space`);
      }
      if (!dependencies.artifacts) {
        throw new Error("Artifact uploads are not available on this server");
      }
      // The artifact store's get only reads context.spaceId.
      const bytes = await dependencies.artifacts.get(row.storageKey, {
        spaceId: context.spaceId,
      } as AdapterContext);
      content = Buffer.from(bytes);
      if (!name) name = row.name;
      if (typeof args.mime_type !== "string" || !args.mime_type.trim()) {
        mime = row.mimeType || mime;
      }
    } else if (typeof args.content_base64 === "string" && args.content_base64.trim()) {
      content = Buffer.from(args.content_base64, "base64");
    } else if (typeof args.content === "string") {
      content = Buffer.from(args.content, "utf8");
    } else {
      throw new Error("Provide artifact_id (for attached files), content, or content_base64");
    }
    if (content.byteLength === 0) throw new Error("File content is empty");
    const limit = artifactId ? MAX_ARTIFACT_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
    if (content.byteLength > limit) {
      throw new Error(`File is larger than the ${Math.round(limit / 1024 / 1024)}MB limit`);
    }
    const boundary = `rakazo-${randomBytes(12).toString("hex")}`;
    const metadata = JSON.stringify({
      name,
      ...(folderId ? { parents: [folderId] } : {}),
    });
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
          `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    let created: { id?: string; name?: string; webViewLink?: string };
    try {
      created = (await fetchJson(
        `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink`,
        {
          method: "POST",
          headers: { "content-type": `multipart/related; boundary=${boundary}` },
          body: new Uint8Array(body),
        },
      )) as { id?: string; name?: string; webViewLink?: string };
    } catch (error) {
      // drive.file: a parent the app cannot see (not app-created) surfaces as a 404.
      if (folderId && String((error as Error).message).includes("404")) {
        throw new Error(
          `folder_id ${folderId} is not visible to this app — drive.file only sees folders this app created (check gdrive_list_files)`,
        );
      }
      throw error;
    }
    return {
      uploaded: true,
      id: created.id ?? null,
      name: created.name ?? name,
      link: created.webViewLink ?? null,
      bytes: content.byteLength,
      ...(folderId ? { folder_id: folderId } : {}),
    };
  }
  if (toolName === "gdrive_create_folder") {
    const name = String(args.name ?? "").trim();
    if (!name) throw new Error("name is required");
    const parentId = typeof args.parent_id === "string" ? args.parent_id.trim() : "";
    const folder = (await fetchJson(`${DRIVE_API}/files?fields=id,name,webViewLink`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    })) as { id?: string; name?: string; webViewLink?: string };
    return {
      created: true,
      id: folder.id ?? null,
      name: folder.name ?? name,
      link: folder.webViewLink ?? null,
    };
  }
  if (toolName === "gdrive_list_files") {
    const pageSize = clampNumber(args.page_size, 1, 50, 20);
    const filters = ["trashed = false"];
    const contains = typeof args.name_contains === "string" ? args.name_contains.trim() : "";
    if (contains) {
      filters.push(`name contains '${contains.replace(/['\\]/g, "\\$&")}'`);
    }
    const folderId = typeof args.folder_id === "string" ? args.folder_id.trim() : "";
    if (folderId) {
      filters.push(`'${folderId.replace(/['\\]/g, "\\$&")}' in parents`);
    }
    const params = new URLSearchParams({
      q: filters.join(" and "),
      pageSize: String(pageSize),
      orderBy: "modifiedTime desc",
      fields: "files(id,name,mimeType,size,modifiedTime,webViewLink)",
    });
    const list = (await fetchJson(`${DRIVE_API}/files?${params}`)) as {
      files?: Array<Record<string, unknown>>;
    };
    return { count: list.files?.length ?? 0, files: list.files ?? [] };
  }
  if (toolName === "gdrive_share_link") {
    const fileId = String(args.file_id ?? "").trim();
    if (!fileId) throw new Error("file_id is required");
    await fetchJson(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    });
    const file = (await fetchJson(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,webViewLink,name`,
    )) as {
      id?: string;
      name?: string;
      webViewLink?: string;
    };
    return {
      shared: true,
      id: file.id ?? fileId,
      name: file.name ?? null,
      link: file.webViewLink ?? null,
    };
  }
  throw new Error(`Unknown Drive tool: ${toolName}`);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, parsed));
}
