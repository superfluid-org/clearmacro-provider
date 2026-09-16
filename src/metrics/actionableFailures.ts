import { chainMetricLabels } from "../chain/protocolMetadata.js";
import type { AppMetrics } from "./metrics.js";

export type ActionableFailureStage =
  | "admission"
  | "worker_submit"
  | "worker_poll"
  | "authorization"
  | "worker_tick";

export type OperationalRetryStage =
  | "worker_preflight"
  | "worker_poll"
  | "authorization";

export type OperationalRetryReason =
  | "preflight_rpc_unavailable"
  | "chain_rpc_unavailable"
  | "relayer_unavailable"
  | "relayer_poll_error"
  | "relayer_poll_rate_limited"
  | "safe_api_retryable"
  | "unknown";

const ADMISSION_ACTIONABLE = new Set([
  "PROVIDER_NOT_READY",
  "RELAYER_UNAVAILABLE",
  "CHAIN_UNAVAILABLE",
  "RELAYER_RATE_LIMITED",
]);

const WORKER_SUBMIT_ACTIONABLE = new Set([
  "RELAYER_SUBMIT_FAILED",
  "INTERNAL_INVARIANT",
  "INVALID_PERMIT2_STATE",
  "CHAIN_NOT_ALLOWED",
]);

const WORKER_POLL_ACTIONABLE = new Set([
  "RELAYER_FAILED",
  "INTERNAL_INVARIANT",
  "INVALID_PERMIT2_STATE",
]);

const AUTHORIZATION_ACTIONABLE = new Set([
  "INTERNAL_INVARIANT",
  "INVALID_AUTHORIZATION_STATE",
  "SAFE_API_UNAUTHORIZED",
  "SAFE_CHAIN_UNSUPPORTED",
]);

const WORKER_TICK_ACTIONABLE = new Set([
  "RELAYER_WORKER_TICK_FAILED",
  "AUTHORIZATION_WORKER_TICK_FAILED",
]);

export function isActionableFailure(stage: ActionableFailureStage, code: string): boolean {
  switch (stage) {
    case "admission":
      return ADMISSION_ACTIONABLE.has(code);
    case "worker_submit":
      return WORKER_SUBMIT_ACTIONABLE.has(code);
    case "worker_poll":
      return WORKER_POLL_ACTIONABLE.has(code);
    case "authorization":
      if (code === "SAFE_AUTHORIZATION_UNSUPPORTED") {
        return false;
      }
      // Any non-retryable Safe infra code that terminalizes should page (not only 401/403).
      if (code.startsWith("SAFE_API_") || code === "SAFE_CHAIN_UNSUPPORTED") {
        return true;
      }
      return AUTHORIZATION_ACTIONABLE.has(code);
    case "worker_tick":
      return WORKER_TICK_ACTIONABLE.has(code);
    default:
      return false;
  }
}

export type ActionableFailureMetrics = {
  actionableFailureCounter?: AppMetrics["actionableFailureCounter"];
};

export type OperationalRetryMetrics = {
  operationalRetryCounter?: AppMetrics["operationalRetryCounter"];
};

export function recordActionableFailure(
  metrics: ActionableFailureMetrics | undefined,
  input: { chainId: number | string; stage: ActionableFailureStage; code: string },
): void {
  if (!metrics?.actionableFailureCounter || !isActionableFailure(input.stage, input.code)) {
    return;
  }
  metrics.actionableFailureCounter.inc({
    ...chainMetricLabels(input.chainId),
    stage: input.stage,
    code: input.code,
  });
}

export function recordOperationalRetry(
  metrics: OperationalRetryMetrics | undefined,
  input: {
    chainId: number | string;
    stage: OperationalRetryStage;
    reason: OperationalRetryReason;
  },
): void {
  if (!metrics?.operationalRetryCounter) {
    return;
  }
  metrics.operationalRetryCounter.inc({
    ...chainMetricLabels(input.chainId),
    stage: input.stage,
    reason: input.reason,
  });
}
