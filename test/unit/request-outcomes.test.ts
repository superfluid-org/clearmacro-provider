import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors.js";
import {
  isValidationFailureCode,
  mapRequestResultFromApiError,
} from "../../src/metrics/requestOutcomes.js";

describe("request outcome mapping", () => {
  const resultCases: Array<{
    code: string;
    status: number;
    expected: ReturnType<typeof mapRequestResultFromApiError>;
  }> = [
    { code: "VALIDATION_ERROR", status: 400, expected: "rejected_client" },
    { code: "SIGNATURE_INVALID", status: 422, expected: "rejected_client" },
    { code: "DUPLICATE_EXECUTION", status: 409, expected: "rejected_client" },
    { code: "UNAUTHORIZED", status: 401, expected: "rejected_client" },
    { code: "CHAIN_NOT_ALLOWED", status: 403, expected: "rejected_client" },
    { code: "PROVIDER_NOT_READY", status: 503, expected: "rejected_provider" },
    { code: "RELAYER_UNAVAILABLE", status: 503, expected: "rejected_provider" },
    { code: "RELAYER_RATE_LIMITED", status: 503, expected: "rejected_provider" },
    { code: "CHAIN_UNAVAILABLE", status: 503, expected: "rejected_provider" },
    { code: "INTERNAL_ERROR", status: 500, expected: "error" },
    { code: "EXECUTION_NOT_FOUND", status: 404, expected: "error" },
  ];

  it.each(resultCases)("maps $code to $expected", ({ code, status, expected }) => {
    const error = new ApiError(status, code, "msg", "validation", false);
    expect(mapRequestResultFromApiError(error)).toBe(expected);
  });
});

describe("validation failure allowlist", () => {
  const allowed = [
    "VALIDATION_ERROR",
    "INVALID_CLEAR_MACRO_PAYLOAD",
    "PROVIDER_NOT_ALLOWED",
    "MACRO_NOT_ALLOWED",
    "CHAIN_NOT_ALLOWED",
    "NATIVE_VALUE_NOT_ALLOWED",
    "CLEAR_MACRO_EXPIRED",
    "CLEAR_MACRO_NOT_YET_VALID",
    "SIGNATURE_INVALID",
    "PREFLIGHT_REVERTED",
    "DUPLICATE_EXECUTION",
    "UNAUTHORIZED",
  ];

  it.each(allowed)("includes client code %s", (code) => {
    expect(isValidationFailureCode(code)).toBe(true);
  });

  const excluded = [
    "DUPLICATE_HIDDEN",
    "PROVIDER_NOT_READY",
    "RELAYER_UNAVAILABLE",
    "RELAYER_RATE_LIMITED",
    "CHAIN_UNAVAILABLE",
    "INTERNAL_ERROR",
  ];

  it.each(excluded)("excludes non-client code %s", (code) => {
    expect(isValidationFailureCode(code)).toBe(false);
  });
});
