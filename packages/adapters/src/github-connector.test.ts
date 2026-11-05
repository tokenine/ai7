import { describe, expect, it, vi } from "vitest";
import { GITHUB_CALLBACK_PATH, GitHubConnector, githubRedirectUri } from "./github-connector.js";

const CONTEXT = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space-1",
  userId: "user-1",
  signal: new AbortController().signal,
} as never;

function fakeSecrets() {
  return {
    put: vi.fn(async (plaintext: string, _context: unknown, recordId: string) => ({
      id: recordId,
      ciphertext: `enc:${plaintext}`,
    })),
    load: vi.fn((ciphertext: string, _recordId: string) => ciphertext.slice(4)),
  };
}

type ConnectionRow = {
  id: string;
  spaceId: string;
  userId: string;
  connectorId: string;
  provider: string;
  status: string;
  secretId: string | null;
  providerRef: string | null;
};

function fakePrisma(rows: ConnectionRow[]) {
  const store = {
    rows,
    secrets: new Map<string, string>(),
    secret: {
      create: vi.fn(async ({ data }: { data: { id: string; ciphertext: string } }) => {
        store.secrets.set(data.id, data.ciphertext);
        return data;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { ciphertext: string } }) => {
          store.secrets.set(where.id, data.ciphertext);
          return data;
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const ciphertext = store.secrets.get(where.id);
        return ciphertext ? { id: where.id, ciphertext } : null;
      }),
    },
    connection: {
      findMany: vi.fn(async ({ where }: { where: { status?: string } }) =>
        rows.filter((row) => !where.status || row.status === where.status),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const providerRef = (where as { providerRef?: string }).providerRef;
        const provider = (where as { provider?: string }).provider;
        const status = (where as { status?: string | { in: string[] } }).status;
        const statuses = typeof status === "string" ? [status] : status?.in;
        return (
          rows.find((row) => {
            if (providerRef !== undefined && row.providerRef !== providerRef) return false;
            if (provider !== undefined && row.provider !== provider) return false;
            if (statuses && !statuses.includes(row.status)) return false;
            return (
              row.spaceId === "space-1" && row.userId === "user-1" && row.connectorId === "github"
            );
          }) ?? null
        );
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<ConnectionRow> }) => {
          const row = rows.find((entry) => entry.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
      ),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(store)),
  };
  return store;
}

function connector(prisma: ReturnType<typeof fakePrisma>, fetchImpl: unknown) {
  return new GitHubConnector(
    { clientId: "client-id", clientSecret: "client-secret" },
    {
      prisma: prisma as never,
      secrets: fakeSecrets() as never,
      fetch: fetchImpl as typeof globalThis.fetch,
    },
  );
}

function row(overrides: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: "conn-1",
    spaceId: "space-1",
    userId: "user-1",
    connectorId: "github",
    provider: "github",
    status: "connected",
    secretId: null,
    providerRef: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function collect(events: AsyncGenerator<{ type: string; message?: string; data?: unknown }>) {
  const out: Array<{ type: string; message?: string; data?: unknown }> = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("github connector catalog and begin", () => {
  it("describes the github provider and lists the one featured app", async () => {
    const provider = connector(fakePrisma([]), vi.fn());
    expect(provider.describe().id).toBe("github");
    const catalog = await provider.catalog(CONTEXT);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ connectorId: "github", slug: "github", name: "GitHub" });
    expect(await provider.catalog(CONTEXT, "git")).toHaveLength(1);
    expect(await provider.catalog(CONTEXT, "slack")).toHaveLength(0);
  });

  it("marks the app connected from stored rows", async () => {
    const provider = connector(fakePrisma([row({ status: "connected" })]), vi.fn());
    const catalog = await provider.catalog(CONTEXT);
    expect(catalog[0]?.connected).toBe(true);
    expect(await provider.listConnectedExternalIds(CONTEXT)).toEqual(["github"]);
    expect(await provider.discoverTools(CONTEXT)).toHaveLength(11);
  });

  it("builds the GitHub auth URL with the repo scope and the deployment callback", async () => {
    const provider = connector(fakePrisma([]), vi.fn());
    const begun = await provider.begin(
      { provider: "github", redirectUrl: "https://app.example.com/settings" },
      CONTEXT,
    );
    const url = new URL(begun.authorizationUrl ?? "");
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("scope")).toBe("repo");
    expect(url.searchParams.get("redirect_uri")).toBe(githubRedirectUri("https://app.example.com"));
    expect(url.searchParams.get("state")).toBe(begun.state);
    expect(githubRedirectUri("https://app.example.com")).toBe(
      `https://app.example.com${GITHUB_CALLBACK_PATH}`,
    );
  });

  it("rejects unknown providers", async () => {
    const provider = connector(fakePrisma([]), vi.fn());
    await expect(
      provider.begin({ provider: "gitlab", redirectUrl: "https://x.example.com" }, CONTEXT),
    ).rejects.toThrow("Unknown GitHub app");
  });
});

describe("github oauth callback", () => {
  it("exchanges the code, names the account and attaches tokens to the pending connection", async () => {
    const prisma = fakePrisma([row({ status: "pending", providerRef: "state-1", secretId: null })]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "gho-token-1", token_type: "bearer", scope: "repo" }),
      )
      .mockResolvedValueOnce(jsonResponse({ login: "dome", id: 7 }));
    const provider = connector(prisma, fetch);
    const result = await provider.handleCallback({
      state: "state-1",
      code: "code-1",
      webOrigin: "https://app.example.com",
    });
    expect(result).toMatchObject({ slug: "github", login: "dome", userId: "user-1" });
    const tokenCall = fetch.mock.calls.find(([url]) => String(url).includes("/access_token"));
    expect(tokenCall).toBeTruthy();
    const body = JSON.parse(String(tokenCall?.[1]?.body));
    expect(body).toMatchObject({ code: "code-1", client_id: "client-id" });
    expect(tokenCall?.[1]?.headers).toMatchObject({ accept: "application/json" });
    expect(prisma.rows[0]?.secretId).toBe("github-connection:conn-1");
    const stored = JSON.parse((prisma.secrets.get("github-connection:conn-1") ?? "").slice(4));
    expect(stored).toMatchObject({ access_token: "gho-token-1", login: "dome", account_id: 7 });
  });

  it("fails readably when the state no longer matches a pending row", async () => {
    const provider = connector(fakePrisma([]), vi.fn());
    await expect(
      provider.handleCallback({
        state: "gone",
        code: "code-1",
        webOrigin: "https://app.example.com",
      }),
    ).rejects.toThrow("no longer pending");
  });
});

describe("github tool execution", () => {
  function connectedProvider(fetchImpl: unknown) {
    const prisma = fakePrisma([row({ status: "connected", secretId: "github-connection:conn-1" })]);
    prisma.secrets.set(
      "github-connection:conn-1",
      `enc:${JSON.stringify({ access_token: "gho-tok", login: "dome" })}`,
    );
    return connector(prisma, fetchImpl);
  }

  async function run(provider: GitHubConnector, toolName: string, args: Record<string, unknown>) {
    const events = await collect(
      provider.execute(
        {
          tool: toolName,
          args,
          executionId: "exec-1",
          route: { connectorId: "github", toolName, resourceId: "github" },
        },
        CONTEXT,
      ) as AsyncGenerator<{ type: string; message?: string; data?: unknown }>,
    );
    return events;
  }

  it("reads a file as raw text", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("# hello\nworld", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const provider = connectedProvider(fetch);
    const events = await run(provider, "github_get_file", {
      repo: "acme/widgets",
      path: "README.md",
    });
    const result = events.find((event) => event.type === "result");
    expect(result?.data).toMatchObject({
      repo: "acme/widgets",
      path: "README.md",
      content: "# hello\nworld",
    });
  });

  it("creates an issue through the REST API", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ number: 12, title: "Bug", state: "open", html_url: "https://x/12" }),
      );
    const provider = connectedProvider(fetch);
    const events = await run(provider, "github_create_issue", {
      repo: "acme/widgets",
      title: "Bug",
      body: "It breaks",
    });
    const call = fetch.mock.calls.find(([url]) => String(url).endsWith("/issues"));
    expect(call).toBeTruthy();
    expect((call![1] as RequestInit).method).toBe("POST");
    const events2 = events.find((event) => event.type === "result");
    expect(events2?.data).toMatchObject({ number: 12 });
  });

  it("surfaces a 401 as a reconnect hint", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ message: "Bad credentials" }, 401));
    const provider = connectedProvider(fetch);
    const events = await run(provider, "github_list_issues", { repo: "acme/widgets" });
    const error = events.find((event) => event.type === "error");
    expect(error?.message).toContain("Reconnect");
  });

  it("yields a readable error when nothing is connected", async () => {
    const provider = connector(fakePrisma([]), vi.fn());
    const events = await run(provider, "github_list_issues", { repo: "acme/widgets" });
    expect(events[0]?.type).toBe("error");
  });
});
