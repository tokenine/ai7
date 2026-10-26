import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { CloudflareEmailProvider, ResendEmailProvider, SmtpEmailProvider } from "@rakazo/adapters";
import type { AppEnv } from "./env.js";

export function configuredEmailProvider(
  env: Pick<
    AppEnv,
    | "emailProvider"
    | "emailApiKey"
    | "emailFrom"
    | "smtpUrl"
    | "cloudflareEmailApiToken"
    | "cloudflareAccountId"
  >,
): TransactionalEmailProvider | undefined {
  // Ai7: Cloudflare Email Sending wins when its token+account are configured.
  // Preserve existing SMTP deployments when no provider is selected explicitly.
  const provider =
    env.emailProvider ??
    (env.cloudflareEmailApiToken && env.cloudflareAccountId
      ? "cloudflare"
      : env.smtpUrl
        ? "smtp"
        : "none");
  switch (provider) {
    case "none":
      return undefined;
    case "smtp":
      return new SmtpEmailProvider({ url: env.smtpUrl ?? "", from: env.emailFrom ?? "" });
    case "resend":
      return new ResendEmailProvider({ apiKey: env.emailApiKey ?? "", from: env.emailFrom ?? "" });
    case "cloudflare":
      return new CloudflareEmailProvider({
        accountId: env.cloudflareAccountId ?? "",
        apiToken: env.cloudflareEmailApiToken ?? "",
        from: env.emailFrom ?? "",
      });
    default:
      throw new Error("EMAIL_PROVIDER must be none, smtp, resend, or cloudflare");
  }
}
