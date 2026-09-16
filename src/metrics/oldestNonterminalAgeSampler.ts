import type { FastifyBaseLogger } from "fastify";
import type { LoadedRegistry } from "../config/registry.js";
import { chainMetricLabels } from "../chain/protocolMetadata.js";
import type { RelayExecutionRepository } from "../db/repositories.js";
import type { RelayExecutionState } from "../tx/lifecycle.js";
import type { AppMetrics } from "./metrics.js";

export type OldestNonterminalAgeSamplerMetrics = Pick<
  AppMetrics,
  "oldestNonterminalExecutionAgeGauge"
>;

const NONTERMINAL_AGE_STATES: RelayExecutionState[] = [
  "awaiting_authorization",
  "pending",
  "submitted",
];

/** Sets oldest non-terminal execution age per registry chain × state (0 when empty). */
export async function sampleOldestNonterminalAgesOnce(input: {
  registry: LoadedRegistry;
  executions: RelayExecutionRepository;
  metrics: OldestNonterminalAgeSamplerMetrics;
}): Promise<void> {
  const nowMs = Date.now();
  for (const chain of input.registry.chainsById.values()) {
    const labels = chainMetricLabels(chain.chainId);
    for (const state of NONTERMINAL_AGE_STATES) {
      const oldestCreatedAt = input.executions.getOldestNonterminalCreatedAt(chain.chainId, state);
      const ageSeconds =
        oldestCreatedAt === null
          ? 0
          : Math.max(0, (nowMs - Date.parse(oldestCreatedAt)) / 1000);
      input.metrics.oldestNonterminalExecutionAgeGauge.set(
        { ...labels, state },
        ageSeconds,
      );
    }
  }
}

export function startOldestNonterminalAgeSampler(input: {
  registry: LoadedRegistry;
  executions: RelayExecutionRepository;
  metrics: OldestNonterminalAgeSamplerMetrics;
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
      await sampleOldestNonterminalAgesOnce({
        registry: input.registry,
        executions: input.executions,
        metrics: input.metrics,
      });
    } catch (error) {
      input.logger.warn({ err: error }, "oldest non-terminal age sample failed");
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
