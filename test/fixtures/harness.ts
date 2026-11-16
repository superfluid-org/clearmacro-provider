import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type AppDeps } from "../../src/app.js";
import { loadRegistry } from "../../src/config/registry.js";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  CreateRequestAuditLogRepository,
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayerTransactionRepository,
} from "../../src/db/repositories.js";
import type { OzRelayerClient } from "../../src/relayer/client.js";
import type { AppEnv } from "../../src/config/env.js";
import { createMetrics, type AppMetrics } from "../../src/metrics/metrics.js";

export type HarnessOverrides = {
  apiAuthEnabled?: boolean;
  /** Required when `apiAuthEnabled` is true (unless you pass `env`). */
  apiClients?: AppEnv["apiClients"];
  env?: Pick<AppEnv, "apiAuthEnabled" | "apiClients">;
  providerName?: string;
  requestMaxMetadataKeys?: number;
  requestMaxMetadataValueLength?: number;
  nativeValueEnabled?: boolean;
  relayerClient?: OzRelayerClient;
  getChainReadiness?: AppDeps["getChainReadiness"];
  getReadyzChainReadiness?: AppDeps["getReadyzChainReadiness"];
  getForwarderDigest?: AppDeps["getForwarderDigest"];
  validateRelaySignature?: AppDeps["validateRelaySignature"];
  preflightRunMacro?: AppDeps["preflightRunMacro"];
  getPermit2WitnessStructHash?: AppDeps["getPermit2WitnessStructHash"];
  getPermit2WitnessTypeString?: AppDeps["getPermit2WitnessTypeString"];
  getPermit2DomainSeparator?: AppDeps["getPermit2DomainSeparator"];
  preflightRunPermit2AndMacro?: AppDeps["preflightRunPermit2AndMacro"];
  safeAuthorizationEnabled?: boolean;
  safeClient?: AppDeps["safeClient"];
  getSignerBytecode?: AppDeps["getSignerBytecode"];
  macroPolicyMode?: "allowlist" | "open";
  metrics?: AppMetrics;
};

const defaultPreflightOk: NonNullable<AppDeps["preflightRunMacro"]> = async () => "ok";
const defaultPermit2PreflightOk: NonNullable<AppDeps["preflightRunPermit2AndMacro"]> =
  async () => "ok";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function writeRegistryFixture(baseDir: string, mode: "allowlist" | "open" = "allowlist") {
  const registryPath = join(baseDir, "provider.json");
  const macroPolicy =
    mode === "open"
      ? ({ mode: "open" } as const)
      : ({
          mode: "allowlist",
          allowedMacros: [{ domain: "test", address: "0x0000000000000000000000000000000000000002" }],
        } as const);
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      chains: [
        {
          chainId: 1,
          forwarderAddress: "0x0000000000000000000000000000000000000001",
          rpcUrls: ["http://localhost:8545"],
          macroPolicy,
        },
      ],
    }),
  );
  return registryPath;
}

function createStubRelayerClient(): OzRelayerClient {
  return {
    ready: async () => true,
    listRelayerIds: async () => ["relayer-main"],
    getRelayer: async () => ({
      address: "0x00000000000000000000000000000000000000aa",
      paused: false,
      system_disabled: false,
      network_type: "evm",
      network: "1",
    }),
    getNetwork: async () => ({
      id: "eip155:1",
      network_type: "evm",
      required_confirmations: 1,
    }),
    submitTransaction: async () => {
      throw new Error("submitTransaction not stubbed for this test");
    },
    getTransaction: async () => {
      throw new Error("getTransaction not stubbed for this test");
    },
  } as unknown as OzRelayerClient;
}

export async function createTestHarness(overrides?: HarnessOverrides) {
  const dir = mkdtempSync(join(tmpdir(), "cm-harness-"));
  const registryPath = writeRegistryFixture(dir, overrides?.macroPolicyMode ?? "allowlist");
  const registry = loadRegistry(registryPath);
  registry.relayerIdByChainId.set(1, "relayer-main");
  registry.requiredConfirmationsByChainId.set(1, 1);
  const db = openDatabase(join(dir, "app.sqlite"));
  runMigrations(db);
  const executionEvents = new RelayExecutionEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);
  const createRequestAudit = new CreateRequestAuditLogRepository(db);

  const apiAuthEnabled = overrides?.env?.apiAuthEnabled ?? overrides?.apiAuthEnabled ?? false;
  const apiClients =
    overrides?.env?.apiClients ??
    overrides?.apiClients ??
    (apiAuthEnabled
      ? [{ id: "test-client", apiTokenHash: sha256Hex("test-token") }]
      : []);

  const getChainReadiness = overrides?.getChainReadiness ?? (async () => ({ ready: true }));
  const getReadyzChainReadiness = overrides?.getReadyzChainReadiness ?? getChainReadiness;
  const metrics = overrides?.metrics ?? createMetrics();
  const executions = new RelayExecutionRepository(db, metrics);

  const built = await createApp({
    registry,
    executions,
    executionEvents,
    relayerTransactions,
    createRequestAudit,
    providerName: overrides?.providerName ?? "macros.superfluid.eth",
    relayerClient: overrides?.relayerClient ?? createStubRelayerClient(),
    env: overrides?.env ?? { apiAuthEnabled, apiClients },
    requestMaxMetadataKeys: overrides?.requestMaxMetadataKeys ?? 20,
    requestMaxMetadataValueLength: overrides?.requestMaxMetadataValueLength ?? 256,
    nativeValueEnabled: overrides?.nativeValueEnabled === true,
    logLevel: "error",
    getChainReadiness,
    getReadyzChainReadiness,
    getForwarderDigest: overrides?.getForwarderDigest ?? (async () => `0x${"11".repeat(32)}`),
    validateRelaySignature: overrides?.validateRelaySignature ?? (async () => true),
    preflightRunMacro: overrides?.preflightRunMacro ?? defaultPreflightOk,
    getPermit2WitnessStructHash:
      overrides?.getPermit2WitnessStructHash ??
      (async () => `0x${"22".repeat(32)}`),
    getPermit2WitnessTypeString:
      overrides?.getPermit2WitnessTypeString ?? (async () => "witness-type"),
    getPermit2DomainSeparator:
      overrides?.getPermit2DomainSeparator ??
      (async () => `0x${"33".repeat(32)}`),
    preflightRunPermit2AndMacro:
      overrides?.preflightRunPermit2AndMacro ?? defaultPermit2PreflightOk,
    ...(overrides?.safeAuthorizationEnabled !== undefined
      ? { safeAuthorizationEnabled: overrides.safeAuthorizationEnabled }
      : {}),
    ...(overrides?.safeClient !== undefined ? { safeClient: overrides.safeClient } : {}),
    ...(overrides?.getSignerBytecode !== undefined
      ? { getSignerBytecode: overrides.getSignerBytecode }
      : {}),
    metrics,
  });
  return {
    dir,
    app: built.app,
    metrics: built.metrics,
    db,
    registry,
    executions,
    executionEvents,
    relayerTransactions,
    createRequestAudit,
    sha256Hex,
    randomHex32: () => `0x${randomBytes(32).toString("hex")}` as const,
  };
}
