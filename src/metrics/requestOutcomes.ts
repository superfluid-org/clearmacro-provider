import type { ApiError } from "../api/errors.js";
import { chainMetricLabels } from "../chain/protocolMetadata.js";
import type { AppMetrics } from "./metrics.js";

export type RequestResult =
  | "created"
  | "duplicate"
  | "rejected_client"
  | "rejected_provider"
  | "error";

const VALIDATION_FAILURE_CODES = new Set([
  "VALIDATION_ERROR",
  "INVALID_CLEAR_MACRO_PAYLOAD",
  "PROVIDER_NOT_ALLOWED",
  "MACRO_NOT_ALLOWED",
  "CHAIN_NOT_ALLOWED",
  "CLEAR_MACRO_EXPIRED",
  "CLEAR_MACRO_NOT_YET_VALID",
  "SIGNATURE_INVALID",
  "PREFLIGHT_REVERTED",
  "DUPLICATE_EXECUTION",
  "UNAUTHORIZED",
]);

const REJECTED_PROVIDER_CODES = new Set([
  "PROVIDER_NOT_READY",
  "CHAIN_UNAVAILABLE",
  "RELAYER_UNAVAILABLE",
  "RELAYER_RATE_LIMITED",
]);

export function isValidationFailureCode(code: string): boolean {
  return VALIDATION_FAILURE_CODES.has(code);
}

export function mapRequestResultFromApiError(error: ApiError): RequestResult {
  if (error.code === "INTERNAL_ERROR") {
    return "error";
  }
  if (REJECTED_PROVIDER_CODES.has(error.code)) {
    return "rejected_provider";
  }
  if (VALIDATION_FAILURE_CODES.has(error.code)) {
    return "rejected_client";
  }
  return "error";
}

export function recordRequestOutcome(
  metrics: Pick<AppMetrics, "requestCounter"> | undefined,
  input: { chainId: number | string; kind: string; result: RequestResult },
): void {
  if (!metrics?.requestCounter) {
    return;
  }
  metrics.requestCounter.inc({
    ...chainMetricLabels(input.chainId),
    kind: input.kind,
    result: input.result,
  });
}

export function recordValidationFailureIfApplicable(
  metrics: Pick<AppMetrics, "validationFailureCounter"> | undefined,
  input: { chainId: number | string; code: string },
): void {
  if (!metrics?.validationFailureCounter || !isValidationFailureCode(input.code)) {
    return;
  }
  metrics.validationFailureCounter.inc({
    ...chainMetricLabels(input.chainId),
    code: input.code,
  });
}
