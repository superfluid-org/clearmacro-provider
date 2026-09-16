import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry } from "../../src/config/registry.js";
import {
  sampleRelayerSignerBalances,
  startRelayerSignerBalanceSampler,
} from "../../src/chain/relayerBalanceSampler.js";
import { createMetrics } from "../../src/metrics/metrics.js";
import { TokenPriceClient } from "../../src/chain/tokenPrice.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function makeRegistry(rpcUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "balance-sampler-"));
  const registryPath = join(dir, "provider.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      chains: [
        {
          chainId: 1,
          forwarderAddress: "0x0000000000000000000000000000000000000001",
          rpcUrls: [rpcUrl],
          macroPolicy: {
            mode: "allowlist",
            allowedMacros: [{ domain: "test", address: "0x0000000000000000000000000000000000000002" }],
          },
        },
      ],
    }),
  );
  const registry = loadRegistry(registryPath);
  registry.relayerIdByChainId.set(1, "relayer-main");
  return registry;
}

const PRICE_API_URL = "https://prices.test";

/** Stubs global fetch: JSON-RPC for the RPC URL, and (optionally) the token-prices API for PRICE_API_URL. */
function stubRpcFetch(result: string | "error", price?: number | "error"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).startsWith(PRICE_API_URL)) {
        if (price === undefined || price === "error") {
          return new Response(JSON.stringify({ error: "price down" }), { status: 503 });
        }
        return new Response(JSON.stringify({ price }), { status: 200 });
      }
      if (result === "error") {
        return new Response("rpc down", { status: 500 });
      }
      const payload = JSON.parse(String(init?.body)) as { id: number | string | null };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), { status: 200 });
    }),
  );
}

function makePriceClient(): TokenPriceClient {
  return new TokenPriceClient({ baseUrl: PRICE_API_URL });
}

function metricValue(metricsText: string, name: string, chainId: string): number | undefined {
  const line = metricsText
    .split("\n")
    .find((l) => l.startsWith(`${name}{chain_id="${chainId}"`));
  if (!line) {
    return undefined;
  }
  const value = Number(line.split(" ").at(-1));
  return Number.isFinite(value) ? value : undefined;
}

const relayerClient = {
  getRelayer: async () => ({
    address: "0x00000000000000000000000000000000000000aa",
    paused: false,
    system_disabled: false,
  }),
} as never;

describe("sampleRelayerSignerBalances", () => {
  it("sets native balance, probe success, and timestamp on successful sample", async () => {
    stubRpcFetch("0xde0b6b3a7640000");

    const metrics = createMetrics();
    const before = Math.floor(Date.now() / 1000);

    await sampleRelayerSignerBalances({
      registry: makeRegistry("http://rpc.test"),
      relayerClient,
      metrics,
    });

    const text = await metrics.registry.metrics();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_native", "1")).toBe(1);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_probe_success", "1")).toBe(1);
    const ts = metricValue(text, "clearmacro_relayer_signer_balance_last_update_timestamp_seconds", "1");
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it("sets probe failure without clearing last good balance on RPC error", async () => {
    const metrics = createMetrics();
    const registry = makeRegistry("http://rpc.test");

    stubRpcFetch("0xde0b6b3a7640000");
    await sampleRelayerSignerBalances({ registry, relayerClient, metrics });

    stubRpcFetch("error");
    await sampleRelayerSignerBalances({ registry, relayerClient, metrics });

    const text = await metrics.registry.metrics();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_native", "1")).toBe(1);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_probe_success", "1")).toBe(0);
  });

  it("marks probe failure when relayer is not bound", async () => {
    const metrics = createMetrics();
    const registry = makeRegistry("http://rpc.test");
    registry.relayerIdByChainId.delete(1);

    await sampleRelayerSignerBalances({
      registry,
      relayerClient: { getRelayer: async () => ({}) } as never,
      metrics,
    });

    const text = await metrics.registry.metrics();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_probe_success", "1")).toBe(0);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_native", "1")).toBeUndefined();
  });
});

describe("sampleRelayerSignerBalances pricing", () => {
  const ONE_ETH = "0xde0b6b3a7640000";

  it("does not emit USD gauges when no price client is given", async () => {
    stubRpcFetch(ONE_ETH, 2000);
    const metrics = createMetrics();

    await sampleRelayerSignerBalances({ registry: makeRegistry("http://rpc.test"), relayerClient, metrics });

    const text = await metrics.registry.metrics();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_native", "1")).toBe(1);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_usd", "1")).toBeUndefined();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_price_probe_success", "1")).toBeUndefined();
  });

  it("values the native balance in USD using the Superfluid network slug", async () => {
    stubRpcFetch(ONE_ETH, 2000);
    const metrics = createMetrics();

    await sampleRelayerSignerBalances({
      registry: makeRegistry("http://rpc.test"),
      relayerClient,
      metrics,
      priceClient: makePriceClient(),
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const priceCall = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith(PRICE_API_URL));
    expect(priceCall).toBe(`${PRICE_API_URL}/v1/eth-mainnet/0x0000000000000000000000000000000000000000`);

    const text = await metrics.registry.metrics();
    expect(metricValue(text, "clearmacro_relayer_signer_native_token_price_usd", "1")).toBe(2000);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_usd", "1")).toBe(2000);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_price_probe_success", "1")).toBe(1);
  });

  it("keeps the last USD and price gauges on a pricing outage and flags the price probe as failed", async () => {
    const metrics = createMetrics();
    const registry = makeRegistry("http://rpc.test");
    const priceClient = makePriceClient();

    stubRpcFetch(ONE_ETH, 2000);
    await sampleRelayerSignerBalances({ registry, relayerClient, metrics, priceClient });

    // Balance doubles, price API goes down: native updates, USD/price stay at last good values.
    stubRpcFetch("0x1bc16d674ec80000", "error");
    await sampleRelayerSignerBalances({ registry, relayerClient, metrics, priceClient });

    const text = await metrics.registry.metrics();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_native", "1")).toBe(2);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_usd", "1")).toBe(2000);
    expect(metricValue(text, "clearmacro_relayer_signer_native_token_price_usd", "1")).toBe(2000);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_price_probe_success", "1")).toBe(0);
  });

  it("marks the price probe failed and emits no USD gauge when no price was ever available", async () => {
    stubRpcFetch(ONE_ETH, "error");
    const metrics = createMetrics();

    await sampleRelayerSignerBalances({
      registry: makeRegistry("http://rpc.test"),
      relayerClient,
      metrics,
      priceClient: makePriceClient(),
    });

    const text = await metrics.registry.metrics();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_native", "1")).toBe(1);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_probe_success", "1")).toBe(1);
    expect(metricValue(text, "clearmacro_relayer_signer_balance_usd", "1")).toBeUndefined();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_price_probe_success", "1")).toBe(0);
  });

  it("skips pricing when the RPC balance sample fails", async () => {
    stubRpcFetch("error", 2000);
    const metrics = createMetrics();

    await sampleRelayerSignerBalances({
      registry: makeRegistry("http://rpc.test"),
      relayerClient,
      metrics,
      priceClient: makePriceClient(),
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith(PRICE_API_URL))).toBe(false);
    const text = await metrics.registry.metrics();
    expect(metricValue(text, "clearmacro_relayer_signer_balance_usd", "1")).toBeUndefined();
  });
});

describe("startRelayerSignerBalanceSampler", () => {
  it("skips overlapping sampleOnce while a sample is in flight", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let getRelayerCalls = 0;
    const gatedRelayerClient = {
      getRelayer: async () => {
        getRelayerCalls++;
        await gate;
        return {
          address: "0x00000000000000000000000000000000000000aa",
          paused: false,
          system_disabled: false,
        };
      },
    } as never;

    stubRpcFetch("0xde0b6b3a7640000");

    const metrics = createMetrics();
    const { sampleOnce, stop } = startRelayerSignerBalanceSampler({
      registry: makeRegistry("http://rpc.test"),
      relayerClient: gatedRelayerClient,
      metrics,
      intervalMs: 3_600_000,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    await vi.waitFor(() => expect(getRelayerCalls).toBe(1));

    await sampleOnce();
    await sampleOnce();
    expect(getRelayerCalls).toBe(1);

    releaseGate();
    await vi.waitFor(async () => {
      const text = await metrics.registry.metrics();
      return metricValue(text, "clearmacro_relayer_signer_balance_probe_success", "1") === 1;
    });
    // Let sampleOnce() finally clear tickInFlight (probe is set before finally runs).
    await new Promise((resolve) => setTimeout(resolve, 0));

    await sampleOnce();
    expect(getRelayerCalls).toBe(2);

    stop();
  });

  it("stop() prevents interval-driven samples", async () => {
    vi.useFakeTimers();
    stubRpcFetch("0xde0b6b3a7640000");

    let getRelayerCalls = 0;
    const relayerClient = {
      getRelayer: async () => {
        getRelayerCalls++;
        return {
          address: "0x00000000000000000000000000000000000000aa",
          paused: false,
          system_disabled: false,
        };
      },
    } as never;

    const { stop } = startRelayerSignerBalanceSampler({
      registry: makeRegistry("http://rpc.test"),
      relayerClient,
      metrics: createMetrics(),
      intervalMs: 1000,
      logger: { warn: vi.fn(), info: vi.fn() },
    });

    await vi.waitFor(() => expect(getRelayerCalls).toBe(1));

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(getRelayerCalls).toBe(1);
  });
});
