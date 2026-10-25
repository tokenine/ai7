import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";

export interface CloudflareEmailConfig {
  accountId: string;
  apiToken: string;
  /** Must use a domain onboarded to Cloudflare Email Sending. */
  from: string;
}

interface CloudflareEmailDependencies {
  fetch?: typeof fetch;
  retryDelaysMs?: readonly number[];
  drainTimeoutMs?: number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

interface CloudflareSendResponse {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: {
    delivered?: string[];
    permanent_bounces?: string[];
    queued?: string[];
  };
}

/**
 * Transactional delivery through the Cloudflare Email Sending REST API
 * (`POST /accounts/{account_id}/email/sending/send`). The sending domain must
 * be onboarded first (`wrangler email sending enable <domain>` or Dashboard).
 */
export class CloudflareEmailProvider implements TransactionalEmailProvider {
  private readonly doFetch: typeof fetch;
  private readonly retryDelaysMs: readonly number[];
  private readonly drainTimeoutMs: number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  private accepting = true;

  constructor(
    private readonly config: CloudflareEmailConfig,
    dependencies: CloudflareEmailDependencies = {},
  ) {
    if (!config.accountId.trim()) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID is required for Cloudflare email delivery");
    }
    if (!config.apiToken.trim()) {
      throw new Error("CLOUDFLARE_EMAIL_API_TOKEN is required for Cloudflare email delivery");
    }
    if (!config.from.trim()) {
      throw new Error("EMAIL_FROM is required for Cloudflare email delivery");
    }
    this.doFetch = dependencies.fetch ?? fetch;
    this.retryDelaysMs = dependencies.retryDelaysMs ?? [250, 1_000];
    this.drainTimeoutMs = dependencies.drainTimeoutMs ?? 10_000;
    this.sleep = dependencies.sleep ?? wait;
  }

  describe() {
    return {
      id: "cloudflare-email",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { transactional: true },
    };
  }

  send(message: TransactionalEmail): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error("Cloudflare provider is shutting down"));
    const delivery = this.deliver(message);
    this.inFlight.add(delivery);
    void delivery.then(
      () => this.inFlight.delete(delivery),
      () => this.inFlight.delete(delivery),
    );
    return delivery;
  }

  async drain(): Promise<void> {
    this.accepting = false;
    const deadline = Date.now() + this.drainTimeoutMs;
    while (this.inFlight.size > 0) {
      const completed = await settlesWithin(this.inFlight, Math.max(0, deadline - Date.now()));
      if (completed) continue;
      this.shutdown.abort();
      this.inFlight.clear();
      return;
    }
  }

  private async deliver(message: TransactionalEmail): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.shutdown.signal.aborted) {
        throw new Error("Cloudflare delivery stopped during shutdown");
      }
      let response: Response;
      try {
        response = await this.doFetch(this.endpoint(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: this.config.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: message.html,
          }),
          signal: this.shutdown.signal,
        });
      } catch (error) {
        if (this.shutdown.signal.aborted) throw error;
        const retryDelay = this.retryDelaysMs[attempt];
        if (retryDelay === undefined) throw error;
        await this.sleep(retryDelay, this.shutdown.signal);
        continue;
      }
      if (response.ok) return;
      const body = (await safeJson(response)) as CloudflareSendResponse | undefined;
      const status = response.status;
      // Throttling and transient upstream failures retry; auth/schema errors
      // would fail identically forever, so surface them immediately.
      const throttled = status === 429;
      const transient = status >= 500;
      if (!throttled && !transient) {
        const detail = body?.errors?.map((error) => error.message ?? error.code).join("; ");
        throw new Error(`Cloudflare email send failed (${status}): ${detail ?? "unknown error"}`);
      }
      const retryDelay = this.retryDelaysMs[attempt];
      if (retryDelay === undefined) {
        const detail = body?.errors?.map((error) => error.message ?? error.code).join("; ");
        throw new Error(`Cloudflare email send failed (${status}): ${detail ?? "unknown error"}`);
      }
      await this.sleep(retryDelay, this.shutdown.signal);
    }
  }

  private endpoint(): string {
    return `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/email/sending/send`;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Cloudflare delivery stopped during shutdown"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Cloudflare delivery stopped during shutdown"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function settlesWithin(
  promises: Iterable<Promise<void>>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled([...promises]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
