import type { LoadedRegistry } from "../config/registry.js";
import type {
  CreateRequestAuditLogRepository,
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayerTransactionRepository,
} from "../db/repositories.js";
import type { OzRelayerClient } from "../relayer/client.js";
import {
  preflightRunMacro,
  preflightRunPermit2AndMacro,
  type ChainReadinessResult,
  type ClearMacroForwarderPayload,
} from "../chain/readiness.js";
import type { RegistryChain } from "../config/schema.js";
import type { AppMetrics } from "../metrics/metrics.js";

export type RegisterRoutesDeps = {
  registry: LoadedRegistry;
  executions: RelayExecutionRepository;
  executionEvents: RelayExecutionEventRepository;
  relayerTransactions: RelayerTransactionRepository;
  createRequestAudit: CreateRequestAuditLogRepository;
  providerName: string;
  relayerClient: OzRelayerClient;
  apiAuthEnabled: boolean;
  resolveClientIdFromBearer: (bearerToken: string) => string | null;
  requestMaxMetadataKeys: number;
  requestMaxMetadataValueLength: number;
  /** When false, a non-zero relay `value` is rejected. Defaults to false. */
  nativeValueEnabled?: boolean;
  getChainReadiness: (chainId: number) => Promise<ChainReadinessResult>;
  getReadyzChainReadiness: (chainId: number) => Promise<ChainReadinessResult>;
  getForwarderDigest: (
    input: ClearMacroForwarderPayload & { chainId: number },
  ) => Promise<string>;
  validateRelaySignature: (input: {
    chainId: number;
    signer: string;
    digest: string;
    signature: string;
  }) => Promise<boolean>;
  /** Test override hook; defaults to real `preflightRunMacro`. */
  preflightRunMacro?: (
    input: Parameters<typeof preflightRunMacro>[0],
  ) => Promise<"ok" | "deterministic_revert" | "rpc_unavailable">;
  getPermit2WitnessStructHash?: (
    input: ClearMacroForwarderPayload & {
      chainId: number;
      upgradeSuperToken: string;
    },
  ) => Promise<string>;
  getPermit2WitnessTypeString?: (
    input: ClearMacroForwarderPayload & { chainId: number },
  ) => Promise<string>;
  getPermit2DomainSeparator?: (chain: RegistryChain) => Promise<string>;
  preflightRunPermit2AndMacro?: typeof preflightRunPermit2AndMacro;
  safeAuthorizationEnabled?: boolean;
  safeClient?: import("../safe/client.js").SafeClient;
  getSignerBytecode?: (input: { chainId: number; address: string }) => Promise<string | null>;
  metrics?: AppMetrics;
};
