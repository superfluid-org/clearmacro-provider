import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export type AppMetrics = ReturnType<typeof createMetrics>;

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requestCounter = new Counter({
    name: "clearmacro_requests_total",
    help: "Total relay requests by chain, kind, and result",
    labelNames: ["chain_id", "network", "kind", "result"] as const,
    registers: [registry],
  });

  const validationFailureCounter = new Counter({
    name: "clearmacro_validation_failures_total",
    help: "Validation failures by error code",
    labelNames: ["chain_id", "network", "code"] as const,
    registers: [registry],
  });

  const relayerSubmissionCounter = new Counter({
    name: "clearmacro_relayer_submission_total",
    help: "Relayer submission outcomes",
    labelNames: ["chain_id", "network", "outcome"] as const,
    registers: [registry],
  });

  const relayerPollLatency = new Histogram({
    name: "clearmacro_relayer_poll_duration_seconds",
    help: "Relayer status poll latency",
    labelNames: ["chain_id", "network"] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [registry],
  });

  const readinessGauge = new Gauge({
    name: "clearmacro_readiness",
    help: "Readiness by chain and reason",
    labelNames: ["chain_id", "network", "reason"] as const,
    registers: [registry],
  });

  const executionsTerminalCounter = new Counter({
    name: "clearmacro_executions_terminal_total",
    help: "Terminal execution outcomes",
    labelNames: ["chain_id", "network", "state", "code"] as const,
    registers: [registry],
  });

  const oldestNonterminalExecutionAgeGauge = new Gauge({
    name: "clearmacro_oldest_nonterminal_execution_age_seconds",
    help: "Age in seconds of the oldest non-terminal execution per chain and state",
    labelNames: ["chain_id", "network", "state"] as const,
    registers: [registry],
  });

  const relayerSignerBalanceNative = new Gauge({
    name: "clearmacro_relayer_signer_balance_native",
    help: "Latest sampled native-token balance of the bound OpenZeppelin Relayer signer",
    labelNames: ["chain_id", "network"] as const,
    registers: [registry],
  });

  const relayerSignerBalanceProbeSuccess = new Gauge({
    name: "clearmacro_relayer_signer_balance_probe_success",
    help: "1 when the latest balance sample for this chain succeeded, 0 otherwise",
    labelNames: ["chain_id", "network"] as const,
    registers: [registry],
  });

  const relayerSignerBalanceLastUpdateTimestampSeconds = new Gauge({
    name: "clearmacro_relayer_signer_balance_last_update_timestamp_seconds",
    help: "Unix timestamp (seconds) of the last successful balance sample for this chain",
    labelNames: ["chain_id", "network"] as const,
    registers: [registry],
  });

  const relayerSignerNativeTokenPriceUsd = new Gauge({
    name: "clearmacro_relayer_signer_native_token_price_usd",
    help: "USD price of the chain's native gas token used to value the relayer signer balance",
    labelNames: ["chain_id", "network"] as const,
    registers: [registry],
  });

  const relayerSignerBalanceUsd = new Gauge({
    name: "clearmacro_relayer_signer_balance_usd",
    help: "Latest sampled native-token balance of the bound OpenZeppelin Relayer signer, valued in USD",
    labelNames: ["chain_id", "network"] as const,
    registers: [registry],
  });

  const relayerSignerBalancePriceProbeSuccess = new Gauge({
    name: "clearmacro_relayer_signer_balance_price_probe_success",
    help: "1 when the latest native-token price fetch for this chain succeeded, 0 otherwise",
    labelNames: ["chain_id", "network"] as const,
    registers: [registry],
  });

  const safeAuthorizationPollCounter = new Counter({
    name: "clearmacro_safe_authorization_poll_total",
    help: "Safe authorization poll outcomes",
    labelNames: ["chain_id", "network", "outcome"] as const,
    registers: [registry],
  });

  const actionableFailureCounter = new Counter({
    name: "clearmacro_actionable_failures_total",
    help: "Actionable or unexpected provider failures by chain, stage, and code",
    labelNames: ["chain_id", "network", "stage", "code"] as const,
    registers: [registry],
  });

  const operationalRetryCounter = new Counter({
    name: "clearmacro_operational_retries_total",
    help: "Non-terminal operational retries and stalls by chain, stage, and reason",
    labelNames: ["chain_id", "network", "stage", "reason"] as const,
    registers: [registry],
  });

  return {
    registry,
    requestCounter,
    validationFailureCounter,
    relayerSubmissionCounter,
    relayerPollLatency,
    readinessGauge,
    executionsTerminalCounter,
    oldestNonterminalExecutionAgeGauge,
    relayerSignerBalanceNative,
    relayerSignerBalanceProbeSuccess,
    relayerSignerBalanceLastUpdateTimestampSeconds,
    relayerSignerNativeTokenPriceUsd,
    relayerSignerBalanceUsd,
    relayerSignerBalancePriceProbeSuccess,
    safeAuthorizationPollCounter,
    actionableFailureCounter,
    operationalRetryCounter,
  };
}
