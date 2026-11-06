/** UI preset only; saved connections use the OpenAI-compatible provider. */
import type { CompatibleEndpointPreset, ModelCatalogEntry } from "./model-connections.js";
import { BRAND_NAME } from "./brand.js";

export const OLLAMA_CLOUD_BASE_URL = "https://ollama.com/v1";

/** Every hosted service the catalog offers for compatible connections. */
export function compatibleEndpointPresets(
  catalog: readonly Pick<ModelCatalogEntry, "endpointPresets">[],
): CompatibleEndpointPreset[] {
  // Every compatible catalog entry carries the same presets: offer each address once.
  const presets = catalog.flatMap((entry) => entry.endpointPresets ?? []);
  return presets.filter(
    (preset, index) => presets.findIndex((other) => other.baseUrl === preset.baseUrl) === index,
  );
}

/** The offered hosted service at this address, if any. */
export function matchCompatibleEndpointPreset(
  presets: readonly CompatibleEndpointPreset[],
  baseUrl: string | undefined,
): CompatibleEndpointPreset | undefined {
  let normalized: string;
  try {
    normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl ?? "");
  } catch {
    return undefined;
  }
  return presets.find((preset) => preset.baseUrl === normalized);

/** The Ai7 model service: one endpoint, one model, keyed by the account's API key. */
export const AI7_BASE_URL = "https://api.ai7.work/v1";
export const AI7_MODEL_ID = "ocg/glm-5.3";
export const AI7_MAX_TOKENS = 20000;
export const AI7_CONTEXT_WINDOW = 1_000_000;

export function isOllamaCloudBaseUrl(baseUrl: string | undefined): boolean {
  try {
    return normalizeOpenAiCompatibleBaseUrl(baseUrl ?? "") === OLLAMA_CLOUD_BASE_URL;
  } catch {
    return false;
  }
}

export function isAi7BaseUrl(baseUrl: string | undefined): boolean {
  try {
    return normalizeOpenAiCompatibleBaseUrl(baseUrl ?? "") === AI7_BASE_URL;
  } catch {
    return false;
  }
}

export function compatibleConnectionName(baseUrl: string | undefined, fallback: string): string {
  if (isAi7BaseUrl(baseUrl)) return "Ai7";
  return isOllamaCloudBaseUrl(baseUrl) ? "Ollama Cloud" : fallback;
}

export const OPENAI_COMPATIBLE_BASE_URL_HINT = `Paste the OpenAI-compatible address from your server. ${BRAND_NAME} adds /v1 if needed.`;

/** Connect when base URL and model id are set, and a key when the endpoint needs one. */
export function openAiCompatibleConnectReady(input: {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  keyRequired?: boolean;
}): boolean {
  return Boolean(
    input.baseUrl.trim() && input.modelId.trim() && (!input.keyRequired || input.apiKey?.trim()),
  );
}

export function openAiCompatibleProbeSuccessMessage(modelCount: number): string {
  return modelCount
    ? `Found ${modelCount} model${modelCount === 1 ? "" : "s"}.`
    : "Server found. Enter a model name.";
}

/** The canonical endpoint the server stores: trailing slashes dropped, `/v1` added only when no
 * path segment is already a version (`v1`, `v4`, `v1beta`, ...), so gateways that route models by
 * path (`/v1/some-model`) keep their URL verbatim. */
export function normalizeOpenAiCompatibleBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Base URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Base URL must not contain credentials");
  }
  let path = url.pathname.replace(/\/+$/, "") || "";
  const VERSION_SEGMENT = /^v\d+[a-z]*$/;
  if (!path.split("/").some((segment) => VERSION_SEGMENT.test(segment))) {
    path = path ? `${path}/v1` : "/v1";
  }
  return `${url.origin}${path}`;
}

/** Self-hosted voice defaults: Kokoro and Whisper as mlx-audio names them. */
export const DEFAULT_COMPATIBLE_TTS_MODEL = "mlx-community/Kokoro-82M-bf16";
export const DEFAULT_COMPATIBLE_STT_MODEL = "mlx-community/whisper-large-v3-turbo-asr-fp16";

/** Preferred default, explicit enabled id (preferred first), then a list-less legacy fallback.
 * Candidates must be in stable credential order, newest first.
 */
export function selectCompatibleModelCredential<
  C extends {
    defaultModel?: string | null;
    enabledModelIds?: readonly string[] | null;
  },
>(preferred: C, candidates: readonly C[], modelId: string): C | undefined {
  if (preferred.defaultModel === modelId || preferred.enabledModelIds?.includes(modelId))
    return preferred;
  return (
    candidates.find((candidate) => candidate.enabledModelIds?.includes(modelId)) ??
    (preferred.enabledModelIds === undefined ? preferred : undefined)
  );
}

/** Match a typed endpoint to the canonical saved endpoint; incomplete input never matches. */
export function savedCompatibleEndpointMatches(
  baseUrl: string,
  savedBaseUrl: string | undefined,
): boolean {
  try {
    return Boolean(savedBaseUrl) && normalizeOpenAiCompatibleBaseUrl(baseUrl) === savedBaseUrl;
  } catch {
    return false;
  }
}
