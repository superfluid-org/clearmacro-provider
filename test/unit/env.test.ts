import { beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

const ENV_KEYS = [
  "DATABASE_PATH",
  "OZ_RELAYER_URL",
  "OZ_RELAYER_API_KEY",
  "PROVIDER_NAME",
  "PORT",
  "API_AUTH_ENABLED",
  "API_CLIENTS_JSON",
  "RELAYER_SIGNER_BALANCE_SAMPLE_INTERVAL_MS",
  "RELAYER_SIGNER_BALANCE_PRICING_ENABLED",
  "TOKEN_PRICE_API_URL",
  "TOKEN_PRICE_REQUEST_TIMEOUT_MS",
  "SAFE_API_KEY",
  "SAFE_AUTHORIZATION_ENABLED",
] as const;

function clearEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

beforeEach(clearEnv);

function setRequiredEnv(): void {
  process.env.OZ_RELAYER_URL = "http://localhost:8080";
  process.env.OZ_RELAYER_API_KEY = "token";
  process.env.PROVIDER_NAME = "macros.superfluid.eth";
  process.env.API_AUTH_ENABLED = "false";
}

describe("loadEnv", () => {
  it("parses required and optional values", () => {
    process.env.DATABASE_PATH = ":memory:";
    process.env.OZ_RELAYER_URL = "http://localhost:8080";
    process.env.OZ_RELAYER_API_KEY = "token";
    process.env.PROVIDER_NAME = "macros.superfluid.eth";
    process.env.PORT = "3333";
    process.env.API_AUTH_ENABLED = "true";
    process.env.API_CLIENTS_JSON = JSON.stringify([{ id: "test", apiTokenHash: "abcd" }]);

    const env = loadEnv();
    expect(env.databasePath).toBe(":memory:");
    expect(env.port).toBe(3333);
    expect(env.apiAuthEnabled).toBe(true);
    expect(env.providerName).toBe("macros.superfluid.eth");
    expect(env.relayerSignerBalanceSampleIntervalMs).toBe(60 * 60 * 1000);
    expect(env.safeAuthorizationEnabled).toBe(false);
    expect(env.safeApiKey).toBeNull();
  });

  it("defaults relayer signer balance pricing to the Superfluid token-prices API", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    const env = loadEnv();
    expect(env.relayerSignerBalancePricingEnabled).toBe(true);
    expect(env.tokenPriceApiUrl).toBe("https://token-prices-api.superfluid.dev");
    expect(env.tokenPriceRequestTimeoutMs).toBe(10_000);
  });

  it("parses relayer signer balance pricing overrides", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.RELAYER_SIGNER_BALANCE_PRICING_ENABLED = "false";
    process.env.TOKEN_PRICE_API_URL = "http://prices.local:8080/";
    process.env.TOKEN_PRICE_REQUEST_TIMEOUT_MS = "2500";
    const env = loadEnv();
    expect(env.relayerSignerBalancePricingEnabled).toBe(false);
    expect(env.tokenPriceApiUrl).toBe("http://prices.local:8080");
    expect(env.tokenPriceRequestTimeoutMs).toBe(2500);
  });

  it("rejects an invalid TOKEN_PRICE_API_URL", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.TOKEN_PRICE_API_URL = "not a url";
    expect(() => loadEnv()).toThrow(/TOKEN_PRICE_API_URL/);
  });

  it("parses relayer signer balance sample interval", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.RELAYER_SIGNER_BALANCE_SAMPLE_INTERVAL_MS = "0";
    expect(loadEnv().relayerSignerBalanceSampleIntervalMs).toBe(0);
  });

  it("defaults database path when unset", () => {
    delete process.env.DATABASE_PATH;
    setRequiredEnv();
    expect(loadEnv().databasePath).toBe("./data/clearmacro-provider-dev.sqlite");
  });

  it("fails on missing required values", () => {
    process.env.DATABASE_PATH = ":memory:";
    delete process.env.OZ_RELAYER_URL;
    process.env.OZ_RELAYER_API_KEY = "token";
    process.env.PROVIDER_NAME = "macros.superfluid.eth";
    process.env.API_AUTH_ENABLED = "false";
    expect(() => loadEnv()).toThrow("OZ_RELAYER_URL");
  });

  it("enables Safe authorization when SAFE_API_KEY is set", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.SAFE_API_KEY = "safe-key";
    const env = loadEnv();
    expect(env.safeAuthorizationEnabled).toBe(true);
    expect(env.safeApiKey).toBe("safe-key");
  });

  it("keeps Safe authorization off when SAFE_API_KEY is blank", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.SAFE_API_KEY = "   ";
    const env = loadEnv();
    expect(env.safeAuthorizationEnabled).toBe(false);
    expect(env.safeApiKey).toBeNull();
  });

  it("forces Safe authorization off when SAFE_AUTHORIZATION_ENABLED=false", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.SAFE_API_KEY = "safe-key";
    process.env.SAFE_AUTHORIZATION_ENABLED = "false";
    expect(loadEnv().safeAuthorizationEnabled).toBe(false);
  });

  it("rejects SAFE_AUTHORIZATION_ENABLED=true without SAFE_API_KEY", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.SAFE_AUTHORIZATION_ENABLED = "true";
    expect(() => loadEnv()).toThrow("SAFE_AUTHORIZATION_ENABLED=true requires SAFE_API_KEY");
  });

  it("allows SAFE_AUTHORIZATION_ENABLED=true when SAFE_API_KEY is set", () => {
    process.env.DATABASE_PATH = ":memory:";
    setRequiredEnv();
    process.env.SAFE_API_KEY = "safe-key";
    process.env.SAFE_AUTHORIZATION_ENABLED = "true";
    expect(loadEnv().safeAuthorizationEnabled).toBe(true);
  });
});

