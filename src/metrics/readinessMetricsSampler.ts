import type { FastifyBaseLogger } from "fastify";
import type { LoadedRegistry } from "../config/registry.js";
import type { ChainReadinessResult } from "../chain/readiness.js";
import { chainMetricLabels } from "../chain/protocolMetadata.js";
import type { AppMetrics } from "./metrics.js";

export type ReadinessMetricsSamplerMetrics = Pick<AppMetrics, "readinessGauge">;

const READINESS_REASONS = ["none", "PROVIDER_NOT_READY", "RELAYER_UNAVAILABLE", "RELAYER_RATE_LIMITED"] as const;

function setReadinessForChain(
  metrics: ReadinessMetricsSamplerMetrics,
  chainId: number,
  previousReason: string | undefined,
  result: ChainReadinessResult,
): string {
  const reason = result.ready ? "none" : (result.reasonCode ?? "PROVIDER_NOT_READY");
  const labels = chainMetricLabels(chainId);

  if (previousReason !== undefined && previousReason !== reason) {
    metrics.readinessGauge.remove({ ...labels, reason: previousReason });
  }
  for (const staleReason of READINESS_REASONS) {
    if (staleReason !== reason) {
      metrics.readinessGauge.remove({ ...labels, reason: staleReason });
    }
  }

  metrics.readinessGauge.set({ ...labels, reason }, result.ready ? 1 : 0);
  return reason;
}

/** Samples readiness gauge for each registry chain (sequential, reuses cached evaluator). */
export async function sampleReadinessMetricsOnce(input: {
  registry: LoadedRegistry;
  getChainReadiness: (chainId: number) => Promise<ChainReadinessResult>;
  metrics: ReadinessMetricsSamplerMetrics;
  previousReasonByChainId?: Map<number, string>;
  logger?: Pick<FastifyBaseLogger, "warn">;
}): Promise<Map<number, string>> {
  const previousReasonByChainId = input.previousReasonByChainId ?? new Map<number, string>();
  const nextReasonByChainId = new Map<number, string>();

  for (const chain of input.registry.chainsById.values()) {
    const chainId = chain.chainId;
    try {
      const result = await input.getChainReadiness(chainId);
      const reason = setReadinessForChain(
        input.metrics,
        chainId,
        previousReasonByChainId.get(chainId),
        result,
      );
      nextReasonByChainId.set(chainId, reason);
    } catch (error) {
      input.logger?.warn({ err: error, chainId }, "readiness metrics sample failed");
      const reason = setReadinessForChain(
        input.metrics,
        chainId,
        previousReasonByChainId.get(chainId),
        { ready: false, reasonCode: "PROVIDER_NOT_READY" },
      );
      nextReasonByChainId.set(chainId, reason);
    }
  }

  return nextReasonByChainId;
}

export function startReadinessMetricsSampler(input: {
  registry: LoadedRegistry;
  getChainReadiness: (chainId: number) => Promise<ChainReadinessResult>;
  metrics: ReadinessMetricsSamplerMetrics;
  intervalMs: number;
  logger: Pick<FastifyBaseLogger, "warn" | "info">;
}): { stop: () => void; sampleOnce: () => Promise<void> } {
  let stopped = false;
  let tickInFlight = false;
  let previousReasonByChainId = new Map<number, string>();

  const sampleOnce = async (): Promise<void> => {
    if (tickInFlight) {
      return;
    }
    tickInFlight = true;
    try {
      previousReasonByChainId = await sampleReadinessMetricsOnce({
        registry: input.registry,
        getChainReadiness: input.getChainReadiness,
        metrics: input.metrics,
        previousReasonByChainId,
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
