import { existsSync } from "node:fs";
import { config as dotenvConfig } from "dotenv";

// Local/dev: load `.env` when present. Compose already injects env into containers.
// `quiet` suppresses dotenv tip/marketing spam on every process start.
if (existsSync(".env")) {
  dotenvConfig({ path: ".env", quiet: true });
}

function requireString(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Invalid boolean env var ${name}: ${value}`);
}

/** `undefined` when unset or blank; otherwise strict true/false. */
function parseOptionalBoolean(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Invalid boolean env var ${name}: ${value}`);
}

/**
 * Safe message authorization is on when `SAFE_API_KEY` is set.
 * `SAFE_AUTHORIZATION_ENABLED=false` forces off (kill switch) even with a key.
 * `SAFE_AUTHORIZATION_ENABLED=true` without a key is a configuration error.
 */
function resolveSafeAuthorizationEnabled(safeApiKey: string | null): boolean {
  const flag = parseOptionalBoolean("SAFE_AUTHORIZATION_ENABLED");
  const hasKey = Boolean(safeApiKey);
  if (flag === true && !hasKey) {
    throw new Error("SAFE_AUTHORIZATION_ENABLED=true requires SAFE_API_KEY");
  }
  if (flag === false) {
    return false;
  }
  return hasKey;
}

function parseInteger(name: string, fallback: number, min = 0): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`Invalid integer env var ${name}: ${value}`);
  }
  return parsed;
}

export type ApiClientRecord = { id: string; apiTokenHash: string };

function parseApiClientsJson(): ApiClientRecord[] {
  const raw = process.env.API_CLIENTS_JSON;
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Invalid JSON in API_CLIENTS_JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("API_CLIENTS_JSON must be a non-empty JSON array when provided");
  }
  const out: ApiClientRecord[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      throw new Error("API_CLIENTS_JSON entries must be objects");
    }
    const id = (entry as { id?: unknown }).id;
    const apiTokenHash = (entry as { apiTokenHash?: unknown }).apiTokenHash;
    if (typeof id !== "string" || id.length === 0 || typeof apiTokenHash !== "string" || apiTokenHash.length === 0) {
      throw new Error("API_CLIENTS_JSON entries require string id and apiTokenHash");
    }
    out.push({ id, apiTokenHash: apiTokenHash.toLowerCase() });
  }
  return out;
}

export type AppEnv = ReturnType<typeof loadEnv>;

export function loadEnv() {
  const apiAuthEnabled = parseBoolean("API_AUTH_ENABLED", false);
  const apiClients = apiAuthEnabled ? parseApiClientsJson() : [];
  if (apiAuthEnabled && apiClients.length === 0) {
    throw new Error("API_AUTH_ENABLED requires non-empty API_CLIENTS_JSON");
  }
  const safeApiKey = process.env.SAFE_API_KEY?.trim() || null;
  const safeAuthorizationEnabled = resolveSafeAuthorizationEnabled(safeApiKey);
  const providerConfigPath = process.env.PROVIDER_CONFIG_PATH ?? "config/provider.json";
  return {
    databasePath: process.env.DATABASE_PATH ?? "./data/clearmacro-provider-dev.sqlite",
    ozRelayerUrl: requireString("OZ_RELAYER_URL"),
    ozRelayerApiKey: requireString("OZ_RELAYER_API_KEY"),
    registryPath: providerConfigPath,
    providerName: requireString("PROVIDER_NAME"),
    host: process.env.HOST ?? "0.0.0.0",
    port: parseInteger("PORT", 3000, 1),
    logLevel: (process.env.LOG_LEVEL ?? "info") as
      | "trace"
      | "debug"
      | "info"
      | "warn"
      | "error"
      | "fatal",
    runMigrationsOnStart: parseBoolean("RUN_MIGRATIONS_ON_START", true),
    relayerWorkerEnabled: parseBoolean("RELAYER_WORKER_ENABLED", true),
    relayerWorkerPollIntervalMs: parseInteger("RELAYER_WORKER_POLL_INTERVAL_MS", 2000, 1),
    relayerWorkerBatchSize: parseInteger("RELAYER_WORKER_BATCH_SIZE", 25, 1),
    apiAuthEnabled,
    apiClients,
    requestMaxMetadataKeys: parseInteger("REQUEST_MAX_METADATA_KEYS", 20, 0),
    requestMaxMetadataValueLength: parseInteger("REQUEST_MAX_METADATA_VALUE_LENGTH", 256, 1),
    relayerRequestTimeoutMs: parseInteger("RELAYER_REQUEST_TIMEOUT_MS", 10_000, 1),
    /** TTL for caching a successful per-chain readiness snapshot used only by `GET /readyz` (0 disables that cache). */
    readinessCacheSuccessTtlMs: parseInteger("READINESS_CACHE_SUCCESS_TTL_MS", 5000, 0),
    /** TTL for caching `RELAYER_RATE_LIMITED` readiness from `GET /readyz` (0 disables). */
    readinessCacheRateLimitedTtlMs: parseInteger("READINESS_CACHE_RATE_LIMITED_TTL_MS", 1500, 0),
    readinessOzRetryMaxAttempts: parseInteger("READINESS_OZ_RETRY_MAX_ATTEMPTS", 3, 1),
    readinessOzRetryBaseDelayMs: parseInteger("READINESS_OZ_RETRY_BASE_DELAY_MS", 100, 1),
    /** Background relayer signer balance sampler interval (0 disables). Default 60 minutes. */
    relayerSignerBalanceSampleIntervalMs: parseRelayerSignerBalanceSampleIntervalMs(),
    /** Value sampled relayer signer balances in USD via the token-prices API. */
    relayerSignerBalancePricingEnabled: parseBoolean("RELAYER_SIGNER_BALANCE_PRICING_ENABLED", true),
    tokenPriceApiUrl: parseTokenPriceApiUrl(),
    tokenPriceRequestTimeoutMs: parseInteger("TOKEN_PRICE_REQUEST_TIMEOUT_MS", 10_000, 1),
    /** Background readiness gauge sampler interval (0 disables). Default 30 seconds. */
    readinessMetricsIntervalMs: parseSamplerIntervalMs("READINESS_METRICS_INTERVAL_MS", 30_000),
    /** Background oldest non-terminal execution age sampler interval (0 disables). Default 30 seconds. */
    oldestNonterminalAgeIntervalMs: parseSamplerIntervalMs("OLDEST_NONTERMINAL_AGE_INTERVAL_MS", 30_000),
    safeAuthorizationEnabled,
    safeApiKey,
    safeApiRetryMaxAttempts: parseInteger("SAFE_API_RETRY_MAX_ATTEMPTS", 3, 1),
    safeApiRetryBaseDelayMs: parseInteger("SAFE_API_RETRY_BASE_DELAY_MS", 250, 1),
    safeAuthorizationPollBaseDelayMs: parseInteger("SAFE_AUTHORIZATION_POLL_BASE_DELAY_MS", 5000, 1),
    safeAuthorizationPollMaxDelayMs: parseInteger("SAFE_AUTHORIZATION_POLL_MAX_DELAY_MS", 60000, 1),
    /** Optional override for Safe Transaction Service base URL (e.g. stack E2E stub). */
    safeTxServiceUrl: process.env.SAFE_TX_SERVICE_URL?.trim() || null,
  };
}

const RELAYER_SIGNER_BALANCE_SAMPLE_INTERVAL_DEFAULT_MS = 60 * 60 * 1000;

function parseRelayerSignerBalanceSampleIntervalMs(): number {
  const value = process.env.RELAYER_SIGNER_BALANCE_SAMPLE_INTERVAL_MS;
  if (value === undefined) {
    return RELAYER_SIGNER_BALANCE_SAMPLE_INTERVAL_DEFAULT_MS;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid integer env var RELAYER_SIGNER_BALANCE_SAMPLE_INTERVAL_MS: ${value}`);
  }
  if (parsed > 0 && parsed < 5000) {
    throw new Error(
      `Invalid integer env var RELAYER_SIGNER_BALANCE_SAMPLE_INTERVAL_MS: ${value} (minimum 5000 when enabled)`,
    );
  }
  return parsed;
}

const TOKEN_PRICE_API_URL_DEFAULT = "https://token-prices-api.superfluid.dev";

function parseTokenPriceApiUrl(): string {
  const value = process.env.TOKEN_PRICE_API_URL?.trim();
  if (!value) {
    return TOKEN_PRICE_API_URL_DEFAULT;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(`Invalid URL env var TOKEN_PRICE_API_URL: ${value}`);
  }
  return value.replace(/\/+$/, "");
}

function parseSamplerIntervalMs(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid integer env var ${name}: ${value}`);
  }
  return parsed;
}
