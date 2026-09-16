import type {
  RelayExecutionRepository,
  RelayExecutionEventRepository,
  RelayerTransactionRepository,
} from "../db/repositories.js";
import type { OzRelayerClient } from "./client.js";
import { OzRelayerHttpError, OzRelayerRateLimitError } from "./errors.js";
import { projectRelayerState } from "./mapper.js";
import { buildRunMacroCalldata, buildRunPermit2AndMacroCalldata } from "../tx/builder.js";
import type { LoadedRegistry } from "../config/registry.js";
import {
  preflightRunMacro,
  preflightRunPermit2AndMacro,
  resolvePermit2Context,
  withRpcFallback,
  type ClearMacroForwarderCall,
} from "../chain/readiness.js";
import type { RegistryChain } from "../config/schema.js";
import type { OzTransaction } from "./client.js";
import { parseStoredPermit2Json, type Permit2Context } from "../chain/permit2.js";
import type { RelayExecutionReceipt } from "../db/repositories.js";
import { normalizeOzReceipt, type RawOzReceipt } from "./receiptNormalize.js";
import {
  recordActionableFailure,
  recordOperationalRetry,
  type ActionableFailureMetrics,
  type OperationalRetryMetrics,
} from "../metrics/actionableFailures.js";
import type { AppMetrics } from "../metrics/metrics.js";
import { chainMetricLabels } from "../chain/protocolMetadata.js";

export type RelayerWorkerDeps = {
  executions: RelayExecutionRepository;
  executionEvents: RelayExecutionEventRepository;
  relayerTransactions: RelayerTransactionRepository;
  relayerClient: OzRelayerClient;
  registry: LoadedRegistry;
  batchSize: number;
  submitRetryCount?: number;
  /** When set, poll loop backs off across ticks after OZ HTTP 429. */
  ozPollBackoff?: { until: number };
  preflightSimulation?: (
    input: ClearMacroForwarderCall & {
      chain: LoadedRegistry["raw"]["chains"][number];
      relayerSigner: string;
      signature: string;
      msgValue: string;
    },
  ) => Promise<"ok" | "deterministic_revert" | "rpc_unavailable">;
  preflightPermit2Simulation?: (
    input: Parameters<typeof preflightRunPermit2AndMacro>[0],
  ) => Promise<"ok" | "deterministic_revert" | "rpc_unavailable">;
  resolvePermit2Context?: typeof resolvePermit2Context;
  metrics?: ActionableFailureMetrics &
    OperationalRetryMetrics &
    Pick<AppMetrics, "relayerSubmissionCounter" | "relayerPollLatency">;
};

function failPermit2State(
  deps: RelayerWorkerDeps,
  executionId: string,
  chainId: number,
  message: string,
): void {
  deps.executions.transitionState(executionId, "failed", {
    errorJson: JSON.stringify({
      code: "INVALID_PERMIT2_STATE",
      message,
      category: "provider",
      retryable: false,
    }),
  });
  recordActionableFailure(deps.metrics, {
    chainId,
    stage: "worker_submit",
    code: "INVALID_PERMIT2_STATE",
  });
}

/**
 * Pending clearMacroV1 rows must always carry a signature after
 * `createPending` / `promoteToPending`. Never substitute `"0x"`.
 */
function requireClearMacroSignature(
  deps: RelayerWorkerDeps,
  execution: { id: string; chainId: number; signature: string | null },
): string | null {
  if (execution.signature) {
    return execution.signature;
  }
  deps.executions.transitionState(execution.id, "failed", {
    errorJson: JSON.stringify({
      code: "INTERNAL_INVARIANT",
      message:
        "clearMacroV1 pending execution is missing signature; pending rows must have a signature after createPending/promoteToPending.",
      category: "provider",
      retryable: false,
    }),
  });
  recordActionableFailure(deps.metrics, {
    chainId: execution.chainId,
    stage: "worker_submit",
    code: "INTERNAL_INVARIANT",
  });
  deps.executionEvents.append({
    executionId: execution.id,
    type: "terminal_error_set",
    actor: "worker",
    reason: "Missing signature on pending clearMacroV1 execution",
    detailsJson: JSON.stringify({}),
  });
  return null;
}

async function loadPermit2Context(
  deps: RelayerWorkerDeps,
  execution: {
    id: string;
    chainId: number;
    permit2Json: string | null;
    forwarderAddress: string;
    macroAddress: string;
    payload: string;
    signerAddress: string;
  },
  chain: LoadedRegistry["raw"]["chains"][number],
): Promise<Permit2Context | "retry" | "failed"> {
  if (!execution.permit2Json) {
    failPermit2State(
      deps,
      execution.id,
      execution.chainId,
      "Permit2 execution is missing permit2_json.",
    );
    return "failed";
  }
  let permit2;
  try {
    permit2 = parseStoredPermit2Json(execution.permit2Json);
  } catch {
    failPermit2State(
      deps,
      execution.id,
      execution.chainId,
      "Permit2 execution has malformed permit2_json.",
    );
    return "failed";
  }
  const resolve = deps.resolvePermit2Context ?? resolvePermit2Context;
  try {
    return await resolve({
      chain,
      forwarder: execution.forwarderAddress,
      macro: execution.macroAddress,
      encodedPayload: execution.payload,
      owner: execution.signerAddress,
      permit2,
    });
  } catch {
    deps.executionEvents.append({
      executionId: execution.id,
      type: "preflight_retry_scheduled",
      actor: "worker",
      reason: "Permit2 witness derivation RPC unavailable; will retry",
      detailsJson: JSON.stringify({ retry: true }),
    });
    recordOperationalRetry(deps.metrics, {
      chainId: execution.chainId,
      stage: "worker_preflight",
      reason: "preflight_rpc_unavailable",
    });
    return "retry";
  }
}

function isTransientSubmitError(error: unknown): boolean {
  if (error instanceof OzRelayerRateLimitError) {
    return true;
  }
  if (error instanceof OzRelayerHttpError && error.status >= 500) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("429") ||
    /\b5\d\d\b/.test(message) ||
    message.includes("timeout") ||
    message.includes("eai_again") ||
    message.includes("econn") ||
    message.includes("network")
  );
}

function getSubmitAttemptsFromErrorJson(value: string | null): number {
  if (!value) {
    return 0;
  }
  try {
    const parsed = JSON.parse(value) as { submitAttempts?: unknown };
    if (
      typeof parsed.submitAttempts === "number" &&
      Number.isFinite(parsed.submitAttempts) &&
      parsed.submitAttempts >= 0
    ) {
      return parsed.submitAttempts;
    }
  } catch {
    // ignore parse errors and treat as no attempts
  }
  return 0;
}

function receiptFromOzPayload(
  receipt: NonNullable<OzTransaction["receipt"]>,
): RelayExecutionReceipt {
  const raw: RawOzReceipt = {
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
  };
  if (receipt.blockHash !== undefined) {
    raw.blockHash = receipt.blockHash;
  }
  if (receipt.gasUsed !== undefined) {
    raw.gasUsed = receipt.gasUsed;
  }
  return normalizeOzReceipt(raw);
}

async function resolveExecutionReceipt(
  chain: RegistryChain | undefined,
  tx: OzTransaction,
): Promise<RelayExecutionReceipt | null> {
  if (tx.receipt) {
    return receiptFromOzPayload(tx.receipt);
  }
  if (!chain || !tx.hash) {
    return null;
  }
  const status = tx.status.toLowerCase();
  if (status !== "confirmed" && status !== "mined") {
    return null;
  }
  try {
    return await withRpcFallback(chain, async (client) => {
      const onchain = await client.getTransactionReceipt({
        hash: tx.hash as `0x${string}`,
      });
      if (!onchain) {
        return null;
      }
      const raw: RawOzReceipt = {
        transactionHash: onchain.transactionHash,
        blockNumber: onchain.blockNumber,
        status: onchain.status,
      };
      if (onchain.blockHash) {
        raw.blockHash = onchain.blockHash;
      }
      if (onchain.gasUsed !== undefined) {
        raw.gasUsed = onchain.gasUsed;
      }
      return normalizeOzReceipt(raw);
    });
  } catch {
    return null;
  }
}

type PreflightResult = Awaited<ReturnType<typeof preflightRunMacro>>;

function applyPreflightResult(
  deps: RelayerWorkerDeps,
  executionId: string,
  chainId: number,
  preflight: PreflightResult,
): "ok" | "continue" {
  if (preflight === "deterministic_revert") {
    deps.executions.transitionState(executionId, "rejected", {
      errorJson: JSON.stringify({
        code: "PREFLIGHT_REVERTED",
        message:
          "Post-creation safety check predicted revert before submission.",
        category: "user",
        retryable: false,
      }),
    });
    deps.executionEvents.append({
      executionId,
      type: "terminal_error_set",
      actor: "worker",
      reason: "Deterministic preflight revert",
      detailsJson: JSON.stringify({}),
    });
    return "continue";
  }
  if (preflight === "rpc_unavailable") {
    deps.executionEvents.append({
      executionId,
      type: "preflight_retry_scheduled",
      actor: "worker",
      reason: "Preflight RPC unavailable; will retry",
      detailsJson: JSON.stringify({ retry: true }),
    });
    recordOperationalRetry(deps.metrics, {
      chainId,
      stage: "worker_preflight",
      reason: "preflight_rpc_unavailable",
    });
    return "continue";
  }
  return "ok";
}

export async function processRelayerWorkerTick(
  deps: RelayerWorkerDeps,
): Promise<void> {
  const submitRetryCount = deps.submitRetryCount ?? 3;
  const submittable = deps.executions.listSubmittable(deps.batchSize);
  for (const execution of submittable) {
    try {
      const chain = deps.registry.chainsById.get(execution.chainId);
      if (!chain) {
        deps.executions.transitionState(execution.id, "failed", {
          errorJson: JSON.stringify({
            code: "CHAIN_NOT_ALLOWED",
            message: "Chain missing from registry",
            category: "provider",
            retryable: false,
          }),
        });
        recordActionableFailure(deps.metrics, {
          chainId: execution.chainId,
          stage: "worker_submit",
          code: "CHAIN_NOT_ALLOWED",
        });
        continue;
      }
      const relayer = await deps.relayerClient.getRelayer(
        execution.ozRelayerId,
      );
      let permit2Context: Permit2Context | undefined;
      const skipPreflight = execution.forceAfterPreflightRevert === 1;
      if (!skipPreflight) {
        if (execution.kind === "clearMacroPermit2V1") {
          const loaded = await loadPermit2Context(deps, execution, chain);
          if (loaded === "failed" || loaded === "retry") {
            continue;
          }
          permit2Context = loaded;
          const preflightFn =
            deps.preflightPermit2Simulation ?? preflightRunPermit2AndMacro;
          const preflight = await preflightFn({
            chain,
            forwarder: execution.forwarderAddress,
            macro: execution.macroAddress,
            encodedPayload: execution.payload,
            relayerSigner: relayer.address,
            permit2Context,
            msgValue: execution.value,
          });
          if (
            applyPreflightResult(deps, execution.id, execution.chainId, preflight) === "continue"
          ) {
            continue;
          }
        } else {
          const signature = requireClearMacroSignature(deps, execution);
          if (!signature) {
            continue;
          }
          const preflightFn = deps.preflightSimulation ?? preflightRunMacro;
          const preflight = await preflightFn({
            chain,
            forwarder: execution.forwarderAddress,
            macro: execution.macroAddress,
            encodedPayload: execution.payload,
            signer: execution.signerAddress,
            relayerSigner: relayer.address,
            signature,
            msgValue: execution.value,
          });
          if (
            applyPreflightResult(deps, execution.id, execution.chainId, preflight) === "continue"
          ) {
            continue;
          }
        }
      }

      const now = BigInt(Math.floor(Date.now() / 1000));
      const validBefore = BigInt(execution.validBefore);
      if (validBefore !== 0n && validBefore <= now) {
        deps.executions.transitionState(execution.id, "expired", {
          errorJson: JSON.stringify({
            code: "CLEAR_MACRO_EXPIRED",
            message: "Validity window elapsed before submission.",
            category: "user",
            retryable: false,
          }),
        });
        deps.executionEvents.append({
          executionId: execution.id,
          type: "state_changed",
          actor: "worker",
          reason: "Expired before submission",
          detailsJson: JSON.stringify({}),
        });
        continue;
      }

      let txData: string;
      if (execution.kind === "clearMacroPermit2V1") {
        if (!permit2Context) {
          const loaded = await loadPermit2Context(deps, execution, chain);
          if (loaded === "failed" || loaded === "retry") {
            continue;
          }
          permit2Context = loaded;
        }
        txData = buildRunPermit2AndMacroCalldata({
          permit2Context,
          macro: execution.macroAddress,
          encodedPayload: execution.payload,
        });
      } else {
        const signature = requireClearMacroSignature(deps, execution);
        if (!signature) {
          continue;
        }
        txData = buildRunMacroCalldata({
          macro: execution.macroAddress,
          encodedPayload: execution.payload,
          signer: execution.signerAddress,
          signature,
        });
      }

      // Claim before the async OZ call so DELETE cannot cancel mid-submit.
      if (!deps.executions.claimForSubmission(execution.id)) {
        continue;
      }

      // Only OZ submit failures use RELAYER_SUBMIT_FAILED / submission outcome counters.
      // Pre-submit and post-accept persistence errors must not look like "relayer rejected".
      let tx;
      try {
        tx = await deps.relayerClient.submitTransaction(execution.ozRelayerId, {
          to: execution.forwarderAddress,
          value: execution.value,
          data: txData,
          speed: "fast",
        });
      } catch (error) {
        deps.executions.releaseSubmissionClaim(execution.id);
        const currentAttempts = getSubmitAttemptsFromErrorJson(execution.lastErrorJson);
        const nextAttempts = currentAttempts + 1;
        const errorPayload = JSON.stringify({
          code: "RELAYER_SUBMIT_ERROR",
          message: error instanceof Error ? error.message : "unknown",
          submitAttempts: nextAttempts,
        });
        const transient = isTransientSubmitError(error);
        if (transient && nextAttempts < submitRetryCount) {
          deps.metrics?.relayerSubmissionCounter?.inc({
            ...chainMetricLabels(execution.chainId),
            outcome: "retry",
          });
          deps.executions.updateLastError(execution.id, errorPayload);
          deps.executionEvents.append({
            executionId: execution.id,
            type: "relayer_submit_retry_scheduled",
            actor: "worker",
            reason: "Transient relayer submission failure",
            detailsJson: JSON.stringify({
              submitAttempts: nextAttempts,
              retryLimit: submitRetryCount,
            }),
          });
          continue;
        }
        deps.metrics?.relayerSubmissionCounter?.inc({
          ...chainMetricLabels(execution.chainId),
          outcome: "failed",
        });
        deps.executions.transitionState(execution.id, "failed", {
          errorJson: JSON.stringify({
            code: "RELAYER_SUBMIT_FAILED",
            message: "Relayer did not accept transaction intent after retries.",
            category: "relayer",
            retryable: false,
          }),
        });
        recordActionableFailure(deps.metrics, {
          chainId: execution.chainId,
          stage: "worker_submit",
          code: "RELAYER_SUBMIT_FAILED",
        });
        deps.executionEvents.append({
          executionId: execution.id,
          type: "terminal_error_set",
          actor: "worker",
          reason: "Relayer submission failed",
          detailsJson: JSON.stringify({
            message: error instanceof Error ? error.message : "unknown",
          }),
        });
        continue;
      }

      // Persist OZ id first so a later secondary-write failure cannot leave the row
      // submittable (which would resubmit an already-accepted intent).
      try {
        deps.executions.applySubmitAcknowledgement(
          execution.id,
          tx.id,
          tx.hash ? (tx.hash as `0x${string}`) : null,
        );
      } catch {
        recordActionableFailure(deps.metrics, {
          chainId: execution.chainId,
          stage: "worker_submit",
          code: "INTERNAL_INVARIANT",
        });
        deps.executionEvents.append({
          executionId: execution.id,
          type: "terminal_error_set",
          actor: "worker",
          reason: "Failed to persist OZ transaction id after acceptance",
          detailsJson: JSON.stringify({ ozTransactionId: tx.id }),
        });
        continue;
      }

      deps.metrics?.relayerSubmissionCounter?.inc({
        ...chainMetricLabels(execution.chainId),
        outcome: "accepted",
      });

      try {
        deps.relayerTransactions.upsert({
          ozTransactionId: tx.id,
          executionId: execution.id,
          ozRelayerId: execution.ozRelayerId,
          status: tx.status,
          statusReason: tx.status_reason,
          txHash: tx.hash,
          nonce: tx.nonce === null ? null : String(tx.nonce),
          gasLimit: tx.gas_limit === null ? null : String(tx.gas_limit),
          gasPrice: tx.gas_price,
          maxFeePerGas: tx.max_fee_per_gas,
          maxPriorityFeePerGas: tx.max_priority_fee_per_gas,
          rawJson: JSON.stringify(tx),
          submittedAt: tx.sent_at,
          includedAt: tx.mined_at ?? null,
          confirmedAt: tx.confirmed_at,
          receiptJson: tx.receipt ? JSON.stringify(tx.receipt) : null,
          lastPolledAt: new Date().toISOString(),
        });
        deps.executionEvents.append({
          executionId: execution.id,
          type: "relayer_submit_accepted",
          actor: "worker",
          reason: "Relayer accepted transaction intent",
          detailsJson: JSON.stringify({
            ozTransactionId: tx.id,
            status: tx.status,
          }),
        });
      } catch {
        // OZ id is durable on the execution; poll path / recovery can proceed.
        // Do not resubmit; page once as invariant.
        recordActionableFailure(deps.metrics, {
          chainId: execution.chainId,
          stage: "worker_submit",
          code: "INTERNAL_INVARIANT",
        });
        deps.executionEvents.append({
          executionId: execution.id,
          type: "terminal_error_set",
          actor: "worker",
          reason: "Failed to persist relayer transaction row after OZ acceptance",
          detailsJson: JSON.stringify({ ozTransactionId: tx.id }),
        });
        continue;
      }
    } catch (error) {
      // Pre-submit unexpected failures (relayer lookup/calldata) — not a submit reject.
      if (isTransientSubmitError(error)) {
        recordOperationalRetry(deps.metrics, {
          chainId: execution.chainId,
          stage: "worker_preflight",
          reason: "relayer_unavailable",
        });
        continue;
      }
      deps.executions.transitionState(execution.id, "failed", {
        errorJson: JSON.stringify({
          code: "INTERNAL_INVARIANT",
          message: "Unexpected error before relayer submission.",
          category: "provider",
          retryable: false,
        }),
      });
      recordActionableFailure(deps.metrics, {
        chainId: execution.chainId,
        stage: "worker_submit",
        code: "INTERNAL_INVARIANT",
      });
      deps.executionEvents.append({
        executionId: execution.id,
        type: "terminal_error_set",
        actor: "worker",
        reason: "Unexpected error before relayer submission",
        detailsJson: JSON.stringify({
          message: error instanceof Error ? error.message : "unknown",
        }),
      });
    }
  }

  const pollable = deps.executions.listPollable(deps.batchSize);
  const skipPollsUntil = deps.ozPollBackoff?.until ?? 0;
  if (Date.now() >= skipPollsUntil) {
    for (const execution of pollable) {
      if (deps.ozPollBackoff && Date.now() < deps.ozPollBackoff.until) {
        break;
      }
      if (!execution.ozTransactionId) {
        continue;
      }
      const chain = deps.registry.chainsById.get(execution.chainId);
      const pollStartedAt = performance.now();
      try {
        const tx = await deps.relayerClient.getTransaction(
          execution.ozRelayerId,
          execution.ozTransactionId,
        );
        const receipt = await resolveExecutionReceipt(chain, tx);
        deps.relayerTransactions.upsert({
          ozTransactionId: tx.id,
          executionId: execution.id,
          ozRelayerId: execution.ozRelayerId,
          status: tx.status,
          statusReason: tx.status_reason,
          txHash: tx.hash,
          nonce: tx.nonce === null ? null : String(tx.nonce),
          gasLimit: tx.gas_limit === null ? null : String(tx.gas_limit),
          gasPrice: tx.gas_price,
          maxFeePerGas: tx.max_fee_per_gas,
          maxPriorityFeePerGas: tx.max_priority_fee_per_gas,
          rawJson: JSON.stringify(tx),
          submittedAt: tx.sent_at,
          includedAt: tx.mined_at ?? null,
          confirmedAt: tx.confirmed_at,
          receiptJson: receipt ? JSON.stringify(receipt) : null,
          lastPolledAt: new Date().toISOString(),
        });
        if (tx.hash && tx.hash !== execution.currentTransactionHash) {
          deps.executions.appendCurrentHashChange(
            execution.id,
            tx.hash as `0x${string}`,
          );
          deps.executionEvents.append({
            executionId: execution.id,
            type: execution.currentTransactionHash
              ? "transaction_hash_replaced"
              : "transaction_hash_observed",
            actor: "worker",
            reason: execution.currentTransactionHash
              ? "Replacement hash observed"
              : "First hash observed",
            detailsJson: JSON.stringify({ hash: tx.hash }),
          });
          const refreshed = deps.executions.getByIdOrThrow(execution.id);
          if (
            refreshed.state === "pending" &&
            refreshed.currentTransactionHash
          ) {
            deps.executions.transitionState(refreshed.id, "submitted");
          }
        }

        const projected = projectRelayerState({
          status: tx.status,
          statusReason: tx.status_reason,
          hash: tx.hash,
          confirmedAt: tx.confirmed_at,
          receipt,
          requiredConfirmations: execution.requiredConfirmations,
        });

        const metadataUpdates: {
          receipt?: RelayExecutionReceipt;
          error?: {
            code: string;
            message: string;
            category: "user" | "provider" | "chain" | "relayer" | "unknown";
            retryable: boolean;
          };
        } = {};
        if (receipt) {
          metadataUpdates.receipt = receipt;
        }
        if (projected.error) {
          metadataUpdates.error = projected.error;
        }
        deps.executions.updateMetadata(execution.id, metadataUpdates);
        const latest = deps.executions.getByIdOrThrow(execution.id);
        if (latest.state !== projected.state) {
          deps.executions.transitionState(execution.id, projected.state);
          if (
            projected.state === "failed" &&
            projected.error &&
            projected.error.code === "RELAYER_FAILED"
          ) {
            recordActionableFailure(deps.metrics, {
              chainId: execution.chainId,
              stage: "worker_poll",
              code: "RELAYER_FAILED",
            });
          }
          deps.executionEvents.append({
            executionId: execution.id,
            type: "state_changed",
            actor: "worker",
            reason: `Projected state: ${projected.state}`,
            detailsJson: JSON.stringify({
              relayerStatus: tx.status,
              statusReason: tx.status_reason,
            }),
          });
        }
      } catch (error) {
        if (error instanceof OzRelayerRateLimitError) {
          if (deps.ozPollBackoff) {
            const base =
              error.retryAfterMs !== undefined && error.retryAfterMs > 0
                ? Math.min(5000, error.retryAfterMs)
                : 300;
            deps.ozPollBackoff.until =
              Date.now() + base + Math.floor(Math.random() * 400);
          }
          recordOperationalRetry(deps.metrics, {
            chainId: execution.chainId,
            stage: "worker_poll",
            reason: "relayer_poll_rate_limited",
          });
          deps.executionEvents.append({
            executionId: execution.id,
            type: "relayer_poll_rate_limited",
            actor: "worker",
            reason: "OpenZeppelin relayer rate limit during status poll",
            detailsJson: JSON.stringify({}),
          });
          break;
        }
        recordOperationalRetry(deps.metrics, {
          chainId: execution.chainId,
          stage: "worker_poll",
          reason: "relayer_poll_error",
        });
        deps.executionEvents.append({
          executionId: execution.id,
          type: "relayer_status_polled",
          actor: "worker",
          reason: "Relayer polling error",
          detailsJson: JSON.stringify({}),
        });
      } finally {
        deps.metrics?.relayerPollLatency?.observe(
          chainMetricLabels(execution.chainId),
          (performance.now() - pollStartedAt) / 1000,
        );
      }
    }
  }
}
