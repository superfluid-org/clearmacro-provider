import type {
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayExecutionRow,
} from "../db/repositories.js";
import type { LoadedRegistry } from "../config/registry.js";
import {
  preflightRunMacro,
  type ClearMacroForwarderCall,
} from "../chain/readiness.js";
import type { RegistryChain } from "../config/schema.js";
import type { SafeClient } from "../safe/client.js";
import { SafeApiError, SafeMessageUnsupportedError } from "../safe/errors.js";
import { computeAuthorizationPollDelayMs } from "../safe/client.js";
import {
  recordActionableFailure,
  recordOperationalRetry,
  type ActionableFailureMetrics,
  type OperationalRetryMetrics,
} from "../metrics/actionableFailures.js";
import { chainMetricLabels } from "../chain/protocolMetadata.js";

type AuthorizationPollOutcome =
  | "promoted"
  | "waiting"
  | "retry"
  | "rejected"
  | "failed"
  | "expired";

type PromotionResult =
  | { outcome: "promoted" | "rejected" | "not_ready" }
  | { outcome: "retry"; lastErrorJson: string };

export type AuthorizationWorkerDeps = {
  executions: RelayExecutionRepository;
  executionEvents: RelayExecutionEventRepository;
  registry: LoadedRegistry;
  safeClient: SafeClient;
  batchSize: number;
  pollBaseDelayMs: number;
  pollMaxDelayMs: number;
  metrics: {
    safeAuthorizationPollCounter: {
      inc(labels: {
        chain_id: string;
        outcome: AuthorizationPollOutcome;
      }): void;
    };
  } & Partial<ActionableFailureMetrics & OperationalRetryMetrics>;
  validateRelaySignature: (input: {
    chainId: number;
    signer: string;
    digest: string;
    signature: string;
  }) => Promise<boolean>;
  preflightSimulation?: (
    input: ClearMacroForwarderCall & {
      chain: RegistryChain;
      relayerSigner: string;
      signature: string;
      msgValue: string;
    },
  ) => Promise<"ok" | "deterministic_revert" | "rpc_unavailable">;
  getRelayerSigner: (ozRelayerId: string) => Promise<string>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function scheduleNextPoll(
  deps: AuthorizationWorkerDeps,
  execution: RelayExecutionRow,
  lastErrorJson?: string,
): void {
  const delayMs = computeAuthorizationPollDelayMs(
    execution.authorizationPollAttempts + 1,
    deps.pollBaseDelayMs,
    deps.pollMaxDelayMs,
  );
  deps.executions.scheduleAuthorizationPoll(execution.id, {
    pollAt: new Date(Date.now() + delayMs).toISOString(),
    pollAttempts: execution.authorizationPollAttempts + 1,
    lastErrorJson: lastErrorJson ?? null,
  });
}

async function tryPromoteExecution(
  deps: AuthorizationWorkerDeps,
  execution: RelayExecutionRow,
  signature: string,
  signatureSource: string,
  chain: RegistryChain,
  relayerSigner: string,
): Promise<PromotionResult> {
  let validSignature: boolean;
  try {
    validSignature = await deps.validateRelaySignature({
      chainId: execution.chainId,
      signer: execution.signerAddress,
      digest: execution.digest,
      signature,
    });
  } catch {
    recordOperationalRetry(deps.metrics, {
      chainId: execution.chainId,
      stage: "authorization",
      reason: "chain_rpc_unavailable",
    });
    return {
      outcome: "retry",
      lastErrorJson: JSON.stringify({
        code: "CHAIN_UNAVAILABLE",
        message: "Unable to validate Safe authorization signature.",
        category: "chain",
        retryable: true,
      }),
    };
  }
  if (!validSignature) {
    return { outcome: "not_ready" };
  }

  const preflightFn = deps.preflightSimulation ?? preflightRunMacro;
  const preflight = await preflightFn({
    chain,
    forwarder: execution.forwarderAddress,
    macro: execution.macroAddress,
    encodedPayload: execution.payload,
    signer: execution.signerAddress,
    relayerSigner,
    signature,
    msgValue: execution.value,
  });
  if (preflight === "rpc_unavailable") {
    recordOperationalRetry(deps.metrics, {
      chainId: execution.chainId,
      stage: "authorization",
      reason: "preflight_rpc_unavailable",
    });
    return {
      outcome: "retry",
      lastErrorJson: JSON.stringify({
        code: "CHAIN_UNAVAILABLE",
        message:
          "Preflight RPC unavailable during Safe authorization promotion.",
        category: "chain",
        retryable: true,
      }),
    };
  }
  if (preflight === "deterministic_revert") {
    deps.executions.transitionState(execution.id, "rejected", {
      errorJson: JSON.stringify({
        code: "PREFLIGHT_REVERTED",
        message:
          "Preflight simulation predicted revert after Safe authorization.",
        category: "user",
        retryable: false,
      }),
    });
    deps.executionEvents.append({
      executionId: execution.id,
      type: "terminal_error_set",
      actor: "worker",
      reason: "Safe authorization preflight revert",
      detailsJson: JSON.stringify({}),
    });
    return { outcome: "rejected" };
  }

  deps.executions.promoteToPending(execution.id, {
    signature,
    signatureSource,
    forceAfterPreflightRevert: 0,
  });
  deps.executionEvents.append({
    executionId: execution.id,
    type: "state_changed",
    actor: "worker",
    reason: "Safe authorization complete; promoted to pending",
    detailsJson: JSON.stringify({ signatureSource }),
  });
  return { outcome: "promoted" };
}

async function processAuthorizationExecution(
  deps: AuthorizationWorkerDeps,
  execution: RelayExecutionRow,
): Promise<AuthorizationPollOutcome> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const validBefore = BigInt(execution.validBefore);
  if (validBefore !== 0n && validBefore <= now) {
    deps.executions.transitionState(execution.id, "expired", {
      errorJson: JSON.stringify({
        code: "CLEAR_MACRO_EXPIRED",
        message: "Validity window elapsed before Safe authorization completed.",
        category: "user",
        retryable: false,
      }),
    });
    deps.executionEvents.append({
      executionId: execution.id,
      type: "state_changed",
      actor: "worker",
      reason: "Expired before Safe authorization completed",
      detailsJson: JSON.stringify({}),
    });
    return "expired";
  }

  const chain = deps.registry.chainsById.get(execution.chainId);
  if (
    !chain ||
    execution.authorizationType !== "safeMessageV1" ||
    !execution.safeMessageHash
  ) {
    deps.executions.transitionState(execution.id, "failed", {
      errorJson: JSON.stringify({
        code: "INVALID_AUTHORIZATION_STATE",
        message: "Execution is missing Safe authorization metadata.",
        category: "provider",
        retryable: false,
      }),
    });
    recordActionableFailure(deps.metrics, {
      chainId: execution.chainId,
      stage: "authorization",
      code: "INVALID_AUTHORIZATION_STATE",
    });
    return "failed";
  }

  let relayerSigner: string;
  try {
    relayerSigner = await deps.getRelayerSigner(execution.ozRelayerId);
  } catch {
    recordOperationalRetry(deps.metrics, {
      chainId: execution.chainId,
      stage: "authorization",
      reason: "relayer_unavailable",
    });
    scheduleNextPoll(
      deps,
      execution,
      JSON.stringify({
        code: "RELAYER_UNAVAILABLE",
        message: "Unable to load relayer signer for Safe authorization.",
        category: "relayer",
        retryable: true,
      }),
    );
    return "retry";
  }

  const emptySignaturePromotion = await tryPromoteExecution(
    deps,
    execution,
    "0x",
    "onchain_safe_message",
    chain,
    relayerSigner,
  );
  if (
    emptySignaturePromotion.outcome === "promoted" ||
    emptySignaturePromotion.outcome === "rejected"
  ) {
    return emptySignaturePromotion.outcome;
  }
  if (emptySignaturePromotion.outcome === "retry") {
    scheduleNextPoll(deps, execution, emptySignaturePromotion.lastErrorJson);
    return "retry";
  }

  try {
    const message = await deps.safeClient.getMessage({
      chainId: execution.chainId,
      safeMessageHash: execution.safeMessageHash,
      expectedSafe: execution.signerAddress,
      expectedDigest: execution.digest,
    });
    if (message.preparedSignature) {
      const result = await tryPromoteExecution(
        deps,
        execution,
        message.preparedSignature,
        "safe_prepared_signature",
        chain,
        relayerSigner,
      );
      if (result.outcome === "retry") {
        scheduleNextPoll(deps, execution, result.lastErrorJson);
        return "retry";
      }
      if (result.outcome === "not_ready") {
        scheduleNextPoll(deps, execution);
        return "waiting";
      }
      return result.outcome;
    }
    scheduleNextPoll(deps, execution);
    return "waiting";
  } catch (error) {
    if (error instanceof SafeMessageUnsupportedError) {
      deps.executions.transitionState(execution.id, "rejected", {
        errorJson: JSON.stringify({
          code: "SAFE_AUTHORIZATION_UNSUPPORTED",
          message: error.message,
          category: "user",
          retryable: false,
        }),
      });
      deps.executionEvents.append({
        executionId: execution.id,
        type: "terminal_error_set",
        actor: "worker",
        reason: "Unsupported Safe authorization configuration",
        detailsJson: JSON.stringify({ message: error.message }),
      });
      return "rejected";
    }
    if (error instanceof SafeApiError) {
      const errorJson = JSON.stringify({
        code: error.code,
        message: error.message,
        category: "provider",
        retryable: error.retryable,
      });
      if (!error.retryable) {
        deps.executions.transitionState(execution.id, "failed", { errorJson });
        recordActionableFailure(deps.metrics, {
          chainId: execution.chainId,
          stage: "authorization",
          code: error.code,
        });
        deps.executionEvents.append({
          executionId: execution.id,
          type: "terminal_error_set",
          actor: "worker",
          reason: "Non-retryable Safe API error",
          detailsJson: JSON.stringify({
            code: error.code,
            status: error.statusCode,
            polledAt: nowIso(),
          }),
        });
        return "failed";
      }
      scheduleNextPoll(deps, execution, errorJson);
      recordOperationalRetry(deps.metrics, {
        chainId: execution.chainId,
        stage: "authorization",
        reason: "safe_api_retryable",
      });
      deps.executionEvents.append({
        executionId: execution.id,
        type: "authorization_poll_retry_scheduled",
        actor: "worker",
        reason: "Safe API poll retry scheduled",
        detailsJson: JSON.stringify({
          code: error.code,
          retryable: error.retryable,
          polledAt: nowIso(),
        }),
      });
      return "retry";
    }
    recordOperationalRetry(deps.metrics, {
      chainId: execution.chainId,
      stage: "authorization",
      reason: "unknown",
    });
    scheduleNextPoll(deps, execution);
    return "retry";
  }
}

export async function processAuthorizationWorkerTick(
  deps: AuthorizationWorkerDeps,
): Promise<void> {
  const awaiting = deps.executions.listAwaitingAuthorizationDue(deps.batchSize);
  for (const execution of awaiting) {
    const outcome = await processAuthorizationExecution(deps, execution);
    deps.metrics.safeAuthorizationPollCounter.inc({
      ...chainMetricLabels(execution.chainId),
      outcome,
    });
  }
}
