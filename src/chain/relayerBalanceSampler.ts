import type { FastifyBaseLogger } from "fastify";
import { formatEther } from "viem";
import type { LoadedRegistry } from "../config/registry.js";
import type { OzRelayerClient } from "../relayer/client.js";
import type { AppMetrics } from "../metrics/metrics.js";
import { withRpcFallback } from "./readiness.js";
import { chainMetricLabels, networkName } from "./protocolMetadata.js";
import type { TokenPriceClient } from "./tokenPrice.js";

export type RelayerBalanceSamplerMetrics = Pick<
  AppMetrics,
  | "relayerSignerBalanceNative"
  | "relayerSignerBalanceProbeSuccess"
  | "relayerSignerBalanceLastUpdateTimestampSeconds"
  | "relayerSignerNativeTokenPriceUsd"
  | "relayerSignerBalanceUsd"
  | "relayerSignerBalancePriceProbeSuccess"
>;

type SamplerLogger = Pick<FastifyBaseLogger, "warn">;

/**
 * Values a native balance in USD via the token-prices API (as observability-tools/balance-watcher does).
 * On a failed lookup the USD and price gauges are left untouched (they keep the last good value)
 * and the price probe is set to 0, mirroring the native balance probe semantics.
 */
async function samplePricing(input: {
  chainId: number;
  balanceNative: number;
  priceClient: TokenPriceClient;
  metrics: RelayerBalanceSamplerMetrics;
  logger?: SamplerLogger | undefined;
}): Promise<void> {
  const labels = chainMetricLabels(input.chainId);
  const network = networkName(input.chainId);
  if (network === String(input.chainId)) {
    // Not a Superfluid-listed network; the price API has no slug for it.
    input.metrics.relayerSignerBalancePriceProbeSuccess.set(labels, 0);
    input.logger?.warn({ chainId: input.chainId }, "balance sample: no Superfluid network slug for pricing");
    return;
  }

  const price = await input.priceClient.getNativePrice(network);
  if (price === null) {
    input.metrics.relayerSignerBalancePriceProbeSuccess.set(labels, 0);
    return;
  }

  input.metrics.relayerSignerNativeTokenPriceUsd.set(labels, price);
  input.metrics.relayerSignerBalanceUsd.set(labels, input.balanceNative * price);
  input.metrics.relayerSignerBalancePriceProbeSuccess.set(labels, 1);
}

/** Samples native balance (and, when a price client is given, USD value) for each registry chain's bound OZ relayer signer. */
export async function sampleRelayerSignerBalances(input: {
  registry: LoadedRegistry;
  relayerClient: OzRelayerClient;
  metrics: RelayerBalanceSamplerMetrics;
  /** Omit to disable USD pricing. */
  priceClient?: TokenPriceClient | undefined;
  logger?: SamplerLogger | undefined;
}): Promise<void> {
  for (const chain of input.registry.chainsById.values()) {
    const chainId = chain.chainId;
    const labels = chainMetricLabels(chainId);
    const relayerId = input.registry.relayerIdByChainId.get(chainId);
    if (!relayerId) {
      input.metrics.relayerSignerBalanceProbeSuccess.set(labels, 0);
      input.logger?.warn({ chainId }, "balance sample: no relayer binding");
      continue;
    }

    let address: `0x${string}`;
    try {
      const relayer = await input.relayerClient.getRelayer(relayerId);
      address = relayer.address as `0x${string}`;
    } catch (error) {
      input.metrics.relayerSignerBalanceProbeSuccess.set(labels, 0);
      input.logger?.warn({ err: error, chainId }, "balance sample: getRelayer failed");
      continue;
    }

    let balanceNative: number;
    try {
      const balance = await withRpcFallback(chain, (client) => client.getBalance({ address }));
      balanceNative = Number(formatEther(balance));
      input.metrics.relayerSignerBalanceNative.set(labels, balanceNative);
      input.metrics.relayerSignerBalanceProbeSuccess.set(labels, 1);
      input.metrics.relayerSignerBalanceLastUpdateTimestampSeconds.set(labels, Math.floor(Date.now() / 1000));
    } catch (error) {
      input.metrics.relayerSignerBalanceProbeSuccess.set(labels, 0);
      input.logger?.warn({ err: error, chainId }, "balance sample: getBalance failed");
      continue;
    }

    if (input.priceClient) {
      await samplePricing({
        chainId,
        balanceNative,
        priceClient: input.priceClient,
        metrics: input.metrics,
        logger: input.logger,
      });
    }
  }
}

export function startRelayerSignerBalanceSampler(input: {
  registry: LoadedRegistry;
  relayerClient: OzRelayerClient;
  metrics: RelayerBalanceSamplerMetrics;
  priceClient?: TokenPriceClient | undefined;
  intervalMs: number;
  logger: Pick<FastifyBaseLogger, "warn" | "info">;
}): { stop: () => void; sampleOnce: () => Promise<void> } {
  let stopped = false;
  let tickInFlight = false;

  const sampleOnce = async (): Promise<void> => {
    if (tickInFlight) {
      return;
    }
    tickInFlight = true;
    try {
      await sampleRelayerSignerBalances({
        registry: input.registry,
        relayerClient: input.relayerClient,
        metrics: input.metrics,
        priceClient: input.priceClient,
        logger: input.logger,
      });
    } finally {
      tickInFlight = false;
    }
  };

  void sampleOnce();

  const timer = setInterval(() => {
    if (!stopped) {
      void sampleOnce();
    }
  }, input.intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    sampleOnce,
  };
}
