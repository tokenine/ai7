import { randomBytes } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorCatalogItem,
  ConnectorEvent,
  ConnectorTool,
  ManagedConnectorProvider,
  SecretStore,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  combineSignals,
  redactConnectorPayload,
  sanitizeConnectorError,
} from "./connector-safety.js";
import { readBodyCapped } from "./web-ssrf.js";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** Read and write access to the user's repositories (public and private). */
const OAUTH_SCOPE = "repo";

/** Path the GitHub OAuth popup lands on; reachable via the web app's /api proxy. */
export const GITHUB_CALLBACK_PATH = "/api/integrations/github/callback";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

export interface GitHubConnectorConfig {
  clientId: string;
  clientSecret: string;
}

export interface GitHubConnectorDependencies {
  prisma: PrismaClient;
  secrets: Pick<SecretStore, "put" | "load">;
  fetch?: typeof fetch;
}

/** What a completed OAuth callback connected, for server-side follow-ups. */
export type GitHubCallbackResult = {
  slug: string;
  login: string;
  userId: string;
  spaceId: string;
};

export function isGitHubEnabled(config: Partial<GitHubConnectorConfig>): boolean {
  return Boolean(config.clientId && config.clientSecret);
}

type StoredGitHubTokens = {
  access_token: string;
  /** GitHub login of the authorized account. */
  login?: string;
  account_id?: number;
  scope?: string;
};

/** Stable callback redirect URI for a deployment; must match the GitHub OAuth app. */
export function githubRedirectUri(webOrigin: string): string {
  return `${webOrigin.replace(/\/$/, "")}${GITHUB_CALLBACK_PATH}`;
}

/** Split "owner/repo" (optionally with a trailing path or "#123") into its two parts. */
function splitRepo(value: unknown): { owner: string; repo: string } {
  const raw = typeof value === "string" ? value.trim() : "";
  const match = raw.match(/^([\w.-]+)\/([\w.-]+)/);
  if (!match) throw new Error(`Expected a repository as "owner/repo", got ${JSON.stringify(raw)}`);
  return { owner: match[1] ?? "", repo: match[2] ?? "" };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listLimit(value: unknown): number {
  const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;
}

export class GitHubConnector implements ManagedConnectorProvider {
  constructor(
    private readonly config: GitHubConnectorConfig,
    private readonly dependencies: GitHubConnectorDependencies,
  ) {}

  describe() {
    return {
      id: "github",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      // Tokens live in this deployment's encrypted secret store, not at a broker.
      capabilities: { discover: true, oauth: true, secretsBrokered: false },
    };
  }

  async catalog(context: AdapterContext, query?: string): Promise<ConnectorCatalogItem[]> {
    const connected = await this.listConnectedExternalIds(context);
    const item: ConnectorCatalogItem = {
      connectorId: "github",
      slug: "github",
      name: "GitHub",
      logo: null,
      connected: connected.includes("github"),
      noAuth: false,
    };
    if (!query) return [item];
    return item.slug.includes(query.toLowerCase()) ? [item] : [];
  }

  async warmDirectory(): Promise<void> {}

  async listConnectedExternalIds(context: AdapterContext): Promise<string[]> {
    const rows = await this.dependencies.prisma.connection.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        connectorId: "github",
        status: "connected",
      },
      select: { provider: true },
    });
    return [...new Set(rows.map((row) => row.provider))];
  }

  /** Ready = a pending/connected row already stores OAuth tokens. */
  async connectionReady(context: AdapterContext, externalId: string): Promise<boolean> {
    const row = await this.dependencies.prisma.connection.findFirst({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        connectorId: "github",
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
    if (request.provider !== "github") {
      throw new Error(`Unknown GitHub app: ${request.provider}`);
    }
    const state = randomBytes(24).toString("base64url");
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: githubRedirectUri(new URL(request.redirectUrl).origin),
      response_type: "code",
      scope: OAUTH_SCOPE,
      allow_signup: "true",
      state,
    });
    return { authorizationUrl: `${AUTHORIZE_URL}?${params}`, state };
  }

  /**
   * The popup never returns to the app with a code: GitHub posts the code to
   * GITHUB_CALLBACK_PATH (handled by handleCallback, which persists tokens onto
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
  }): Promise<GitHubCallbackResult> {
    const row = await this.dependencies.prisma.connection.findFirst({
      where: { connectorId: "github", providerRef: input.state, status: "pending" },
      select: { id: true, userId: true, spaceId: true, secretId: true },
    });
    if (!row) throw new Error("This GitHub authorization is no longer pending. Connect again.");
    const exchanged = await this.exchangeCode(
      input.code,
      githubRedirectUri(input.webOrigin),
      input.signal,
    );
    const recordId = row.secretId ?? `github-connection:${row.id}`;
    const stored = await this.dependencies.secrets.put(
      JSON.stringify(exchanged.tokens),
      {
        operationId: "github-connection",
        traceId: "github-connection",
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
      slug: "github",
      login: exchanged.tokens.login ?? "",
      userId: row.userId,
      spaceId: row.spaceId,
    };
  }

  async revoke(connectionRef: string, context: AdapterContext): Promise<void> {
    const row = await this.dependencies.prisma.connection.findFirst({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        connectorId: "github",
        providerRef: connectionRef,
      },
      select: { id: true, secretId: true },
    });
    if (!row?.secretId) return;
    const tokens = await this.loadTokens(row.secretId).catch(() => undefined);
    if (!tokens?.access_token) return;
    // Best effort: GitHub has no public revoke endpoint for OAuth apps other
    // than deleting the app's own tokens with the app credentials.
    await rawRequest(
      `${API_BASE}/applications/${this.config.clientId}/token`,
      {
        method: "DELETE",
        headers: {
          authorization: `Basic ${Buffer.from(
            `${this.config.clientId}:${this.config.clientSecret}`,
          ).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ access_token: tokens.access_token }),
      },
      this.dependencies,
      context.signal,
    ).catch(() => undefined);
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const connected = await this.listConnectedExternalIds(context);
    return connected.includes("github") ? githubTools() : [];
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const slug = call.route?.resourceId;
    if (slug !== "github") {
      yield { type: "error", message: "GitHub connection route is missing" };
      return;
    }
    try {
      const row = await this.dependencies.prisma.connection.findFirst({
        where: {
          spaceId: context.spaceId,
          userId: context.userId,
          connectorId: "github",
          provider: "github",
          status: "connected",
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: { secretId: true },
      });
      if (!row?.secretId) {
        yield { type: "error", message: "GitHub is not connected. Connect it again." };
        return;
      }
      const tokens = await this.loadTokens(row.secretId);
      const data = await executeGitHubTool(call, tokens, context, this.dependencies);
      yield {
        type: "result",
        data: redactConnectorPayload(
          data,
          [tokens.access_token, this.config.clientSecret].filter((value): value is string =>
            Boolean(value),
          ),
        ),
      };
    } catch (error) {
      yield {
        type: "error",
        message: sanitizeConnectorError(
          error,
          [this.config.clientSecret].filter((value): value is string => Boolean(value)),
        ),
      };
    }
  }

  /** GitHub OAuth app tokens do not refresh: they stay valid until revoked or expired by the app settings. */
  private async loadTokens(secretId: string): Promise<StoredGitHubTokens> {
    const row = await this.dependencies.prisma.secret.findUnique({
      where: { id: secretId },
      select: { ciphertext: true },
    });
    if (!row) throw new Error("GitHub connection tokens are missing. Reconnect this app.");
    const parsed = JSON.parse(
      await this.dependencies.secrets.load(row.ciphertext, {
        recordId: secretId,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
    ) as StoredGitHubTokens;
    if (!parsed.access_token) throw new Error("GitHub connection tokens are malformed.");
    return parsed;
  }

  /** Exchange the code, then name the authorized account for display. */
  private async exchangeCode(
    code: string,
    redirectUri: string,
    signal?: AbortSignal,
  ): Promise<{ tokens: StoredGitHubTokens }> {
    const response = await this.rawRequest(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          code,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          redirect_uri: redirectUri,
        }),
      },
      signal,
    );
    const parsed = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !parsed.access_token) {
      throw new Error(
        `GitHub authorization failed: ${parsed.error_description ?? parsed.error ?? response.status}`,
      );
    }
    const tokens: StoredGitHubTokens = {
      access_token: parsed.access_token,
      ...(parsed.scope ? { scope: parsed.scope } : {}),
    };
    // Best effort: identity only improves display names, never gates the connection.
    const me = (await apiJsonRequest(
      `${API_BASE}/user`,
      { method: "GET" },
      tokens,
      this.dependencies,
    ).catch(() => undefined)) as { login?: string; id?: number } | undefined;
    if (me?.login) tokens.login = me.login;
    if (typeof me?.id === "number") tokens.account_id = me.id;
    return { tokens };
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

async function rawRequest(
  url: string,
  init: RequestInit,
  deps: GitHubConnectorDependencies,
  signal?: AbortSignal,
): Promise<Response> {
  const requestAbort = combineSignals(signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  return (deps.fetch ?? globalThis.fetch)(url, { ...init, signal: requestAbort });
}

async function apiJsonRequest(
  url: string,
  init: RequestInit,
  tokens: StoredGitHubTokens,
  deps: GitHubConnectorDependencies,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await rawRequest(
    url,
    {
      ...init,
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": API_VERSION,
        "user-agent": "rakazo-github-connector",
        ...init.headers,
      },
    },
    deps,
    signal,
  );
  const bytes = await readBodyCapped(response, MAX_RESPONSE_BYTES, signal);
  const text = new TextDecoder().decode(bytes);
  const parsed = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const detail =
      typeof parsed === "object" && parsed && "message" in parsed
        ? String((parsed as { message?: string }).message ?? "")
        : "";
    const hint =
      response.status === 401
        ? " — GitHub authorization expired. Reconnect this app in Connectors."
        : "";
    throw new Error(`GitHub API returned ${response.status}${detail ? `: ${detail}` : ""}${hint}`);
  }
  return parsed;
}

async function executeGitHubTool(
  call: ConnectorCall,
  tokens: StoredGitHubTokens,
  context: AdapterContext,
  dependencies: GitHubConnectorDependencies,
): Promise<unknown> {
  const fetchApi = async (url: string, init: RequestInit = {}, signal?: AbortSignal) =>
    apiJsonRequest(url, init, tokens, dependencies, signal ?? context.signal);

  const args = call.args;
  switch (call.route?.toolName ?? call.tool) {
    case "github_search_repositories": {
      const query = asString(args.query) ?? "";
      if (!query) throw new Error("query is required");
      const params = new URLSearchParams({
        q: query,
        per_page: String(listLimit(args.max_results)),
      });
      const data = (await fetchApi(`${API_BASE}/search/repositories?${params}`)) as {
        total_count?: number;
        items?: Array<Record<string, unknown>>;
      };
      return {
        total_count: data.total_count ?? 0,
        repositories: (data.items ?? []).map((item) => ({
          full_name: item.full_name,
          description: item.description ?? null,
          private: item.private === true,
          html_url: item.html_url,
          default_branch: item.default_branch,
          stars: item.stargazers_count ?? 0,
          updated_at: item.updated_at,
        })),
      };
    }
    case "github_get_file": {
      const { owner, repo } = splitRepo(args.repo);
      const path = asString(args.path);
      if (!path) throw new Error("path is required");
      const ref = asString(args.ref);
      const params = new URLSearchParams({ ref: ref ?? "" });
      const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeFilePath(path)}${
        ref ? `?${params}` : ""
      }`;
      const response = await (dependencies.fetch ?? globalThis.fetch)(url, {
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          accept: "application/vnd.github.raw",
          "x-github-api-version": API_VERSION,
          "user-agent": "rakazo-github-connector",
        },
        signal: combineSignals(context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)),
      });
      if (response.status === 404)
        throw new Error(`File not found: ${path}${ref ? ` @ ${ref}` : ""}`);
      const bytes = await readBodyCapped(response, MAX_FILE_BYTES);
      if (!response.ok) {
        throw new Error(`GitHub API returned ${response.status} for ${path}`);
      }
      return {
        repo: `${owner}/${repo}`,
        path,
        ref: ref ?? null,
        content: new TextDecoder().decode(bytes),
      };
    }
    case "github_list_directory": {
      const { owner, repo } = splitRepo(args.repo);
      const path = asString(args.path) ?? "";
      const ref = asString(args.ref);
      const url = `${API_BASE}/repos/${owner}/${repo}/contents/${encodeFilePath(path)}${
        ref ? `?ref=${encodeURIComponent(ref)}` : ""
      }`;
      const data = (await fetchApi(url)) as Array<Record<string, unknown>>;
      if (!Array.isArray(data)) throw new Error(`${path || "/"} is not a directory`);
      return {
        repo: `${owner}/${repo}`,
        path,
        entries: data.map((entry) => ({
          name: entry.name,
          type: entry.type,
          size: entry.size,
        })),
      };
    }
    case "github_list_issues": {
      const { owner, repo } = splitRepo(args.repo);
      const state = asString(args.state) === "all" ? "all" : "open";
      const params = new URLSearchParams({
        state,
        per_page: String(listLimit(args.max_results)),
        sort: "updated",
      });
      const data = (await fetchApi(`${API_BASE}/repos/${owner}/${repo}/issues?${params}`)) as Array<
        Record<string, unknown>
      >;
      return {
        issues: data.filter((item) => !item.pull_request).map(issueSummary),
      };
    }
    case "github_get_issue": {
      const { owner, repo } = splitRepo(args.repo);
      const number = requireNumber(args.number, "number");
      const data = (await fetchApi(
        `${API_BASE}/repos/${owner}/${repo}/issues/${number}`,
      )) as Record<string, unknown>;
      return issueSummary(data);
    }
    case "github_get_issue_comments": {
      const { owner, repo } = splitRepo(args.repo);
      const number = requireNumber(args.number, "number");
      const params = new URLSearchParams({ per_page: String(listLimit(args.max_results)) });
      const data = (await fetchApi(
        `${API_BASE}/repos/${owner}/${repo}/issues/${number}/comments?${params}`,
      )) as Array<Record<string, unknown>>;
      return {
        comments: data.map((item) => ({
          user: (item.user as { login?: string } | undefined)?.login ?? null,
          body: item.body,
          created_at: item.created_at,
        })),
      };
    }
    case "github_create_issue": {
      const { owner, repo } = splitRepo(args.repo);
      const title = asString(args.title);
      if (!title) throw new Error("title is required");
      const data = (await fetchApi(`${API_BASE}/repos/${owner}/${repo}/issues`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          ...(asString(args.body) ? { body: asString(args.body) } : {}),
        }),
      })) as Record<string, unknown>;
      return issueSummary(data);
    }
    case "github_add_issue_comment": {
      const { owner, repo } = splitRepo(args.repo);
      const number = requireNumber(args.number, "number");
      const body = asString(args.body);
      if (!body) throw new Error("body is required");
      const data = (await fetchApi(`${API_BASE}/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      })) as Record<string, unknown>;
      return { id: data.id, html_url: data.html_url, created_at: data.created_at };
    }
    case "github_list_pull_requests": {
      const { owner, repo } = splitRepo(args.repo);
      const state = asString(args.state) === "all" ? "all" : "open";
      const params = new URLSearchParams({
        state,
        per_page: String(listLimit(args.max_results)),
        sort: "updated",
      });
      const data = (await fetchApi(`${API_BASE}/repos/${owner}/${repo}/pulls?${params}`)) as Array<
        Record<string, unknown>
      >;
      return { pull_requests: data.map(pullRequestSummary) };
    }
    case "github_get_pull_request": {
      const { owner, repo } = splitRepo(args.repo);
      const number = requireNumber(args.number, "number");
      const data = (await fetchApi(`${API_BASE}/repos/${owner}/${repo}/pulls/${number}`)) as Record<
        string,
        unknown
      >;
      return pullRequestSummary(data);
    }
    case "github_create_or_update_file": {
      const { owner, repo } = splitRepo(args.repo);
      const path = asString(args.path);
      const content = asString(args.content);
      const message = asString(args.message);
      if (!path || content === undefined || !message) {
        throw new Error("path, content and message are required");
      }
      const branch = asString(args.branch);
      // Updating an existing file needs its blob sha; a create needs none.
      let sha: string | undefined = asString(args.sha);
      if (!sha) {
        const existing = (await fetchApi(
          `${API_BASE}/repos/${owner}/${repo}/contents/${encodeFilePath(path)}${
            branch ? `?ref=${encodeURIComponent(branch)}` : ""
          }`,
          {},
        ).catch(() => undefined)) as { sha?: string } | undefined;
        sha = existing?.sha;
      }
      const data = (await fetchApi(
        `${API_BASE}/repos/${owner}/${repo}/contents/${encodeFilePath(path)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message,
            content: Buffer.from(content, "utf8").toString("base64"),
            ...(branch ? { branch } : {}),
            ...(sha ? { sha } : {}),
          }),
        },
      )) as Record<string, unknown>;
      const commit = data.commit as { sha?: string; html_url?: string } | undefined;
      return {
        path,
        branch: branch ?? null,
        commit_sha: commit?.sha ?? null,
        commit_url: commit?.html_url ?? null,
      };
    }
    default:
      throw new Error(`Unknown GitHub tool: ${call.route?.toolName ?? call.tool}`);
  }
}

function requireNumber(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) throw new Error(`${label} is required as a number`);
  return Math.floor(n);
}

/** Escape each path segment but keep the slashes that GitHub's contents API expects. */
function encodeFilePath(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function issueSummary(data: Record<string, unknown>) {
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    author: (data.user as { login?: string } | undefined)?.login ?? null,
    body: typeof data.body === "string" ? data.body.slice(0, 8_000) : data.body,
    labels: Array.isArray(data.labels)
      ? (data.labels as Array<{ name?: string }>).map((label) => label.name ?? "")
      : [],
    html_url: data.html_url,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

function pullRequestSummary(data: Record<string, unknown>) {
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    draft: data.draft === true,
    author: (data.user as { login?: string } | undefined)?.login ?? null,
    body: typeof data.body === "string" ? data.body.slice(0, 8_000) : data.body,
    head: (data.head as { ref?: string } | undefined)?.ref ?? null,
    base: (data.base as { ref?: string } | undefined)?.ref ?? null,
    additions: data.additions,
    deletions: data.deletions,
    mergeable_state: data.mergeable_state,
    html_url: data.html_url,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

function githubTools(): ConnectorTool[] {
  const route = { connectorId: "github", resourceId: "github" };
  const tool = (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    readOnly: boolean,
  ): ConnectorTool => ({
    name,
    description,
    inputSchema,
    readOnly,
    route: { ...route, toolName: name },
  });
  const repo = { type: "string", description: 'Repository as "owner/repo".' };
  const number = { type: "number", description: "Issue or pull request number." };
  return [
    tool(
      "github_search_repositories",
      "Search repositories the connected GitHub account can see. Returns names, descriptions and default branches.",
      {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "GitHub search syntax (user:, org:, language:, in:name, ...).",
          },
          max_results: { type: "number", description: "1-50. Default 20." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      true,
    ),
    tool(
      "github_get_file",
      "Read one file's raw text from a repository (512 KB cap).",
      {
        type: "object",
        properties: {
          repo,
          path: { type: "string", description: "File path inside the repository." },
          ref: {
            type: "string",
            description: "Branch, tag or sha. Defaults to the default branch.",
          },
        },
        required: ["repo", "path"],
        additionalProperties: false,
      },
      true,
    ),
    tool(
      "github_list_directory",
      "List one directory of a repository (names + types).",
      {
        type: "object",
        properties: {
          repo,
          path: { type: "string", description: "Directory path. Empty lists the repository root." },
          ref: { type: "string", description: "Branch, tag or sha." },
        },
        additionalProperties: false,
      },
      true,
    ),
    tool(
      "github_list_issues",
      "List issues of a repository (pull requests are excluded).",
      {
        type: "object",
        properties: {
          repo,
          state: { type: "string", enum: ["open", "all"], description: "Default open." },
          max_results: { type: "number", description: "1-50. Default 20." },
        },
        additionalProperties: false,
      },
      true,
    ),
    tool(
      "github_get_issue",
      "Read one issue by number.",
      {
        type: "object",
        properties: { repo, number },
        required: ["repo", "number"],
        additionalProperties: false,
      },
      true,
    ),
    tool(
      "github_get_issue_comments",
      "Read the comments of one issue (or pull request) by number.",
      {
        type: "object",
        properties: {
          repo,
          number,
          max_results: { type: "number", description: "1-50. Default 20." },
        },
        required: ["repo", "number"],
        additionalProperties: false,
      },
      true,
    ),
    tool(
      "github_create_issue",
      "Create an issue in a repository. The user sees the title and body before it is created.",
      {
        type: "object",
        properties: {
          repo,
          title: { type: "string" },
          body: { type: "string", description: "Markdown body." },
        },
        required: ["repo", "title"],
        additionalProperties: false,
      },
      false,
    ),
    tool(
      "github_add_issue_comment",
      "Comment on an issue or pull request. The user sees the comment before it is posted.",
      {
        type: "object",
        properties: { repo, number, body: { type: "string", description: "Markdown body." } },
        required: ["repo", "number", "body"],
        additionalProperties: false,
      },
      false,
    ),
    tool(
      "github_list_pull_requests",
      "List pull requests of a repository.",
      {
        type: "object",
        properties: {
          repo,
          state: { type: "string", enum: ["open", "all"], description: "Default open." },
          max_results: { type: "number", description: "1-50. Default 20." },
        },
        additionalProperties: false,
      },
      true,
    ),
    tool(
      "github_get_pull_request",
      "Read one pull request by number (state, branches, diff stats).",
      {
        type: "object",
        properties: { repo, number },
        required: ["repo", "number"],
        additionalProperties: false,
      },
      true,
    ),
    tool(
      "github_create_or_update_file",
      "Create or replace one file's text content in a repository with a commit message.",
      {
        type: "object",
        properties: {
          repo,
          path: { type: "string", description: "File path inside the repository." },
          content: { type: "string", description: "The full new text content of the file." },
          message: { type: "string", description: "Commit message." },
          branch: {
            type: "string",
            description: "Branch to commit to. Defaults to the default branch.",
          },
          sha: {
            type: "string",
            description:
              "Blob sha of the file being replaced (fetched automatically when omitted).",
          },
        },
        required: ["repo", "path", "content", "message"],
        additionalProperties: false,
      },
      false,
    ),
  ];
}
