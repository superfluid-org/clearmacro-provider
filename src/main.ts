import { loadEnv } from "./config/env.js";
import { loadRegistry } from "./config/registry.js";
import { bindRelayersToRegistry } from "./config/relayerDiscovery.js";
import { openDatabase } from "./db/client.js";
import { runMigrations } from "./db/migrations.js";
import {
  CreateRequestAuditLogRepository,
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayerTransactionRepository,
} from "./db/repositories.js";
import { OzRelayerClient } from "./relayer/client.js";
import { runRelayerAndAuthorizationTicks } from "./relayer/workerTicks.js";
import { processRelayerWorkerTick } from "./relayer/worker.js";
import { processAuthorizationWorkerTick } from "./relayer/authorizationWorker.js";
import { createApp } from "./app.js";
import { createReadyzReadinessCache } from "./chain/readinessCache.js";
import { startRelayerSignerBalanceSampler } from "./chain/relayerBalanceSampler.js";
import { TokenPriceClient } from "./chain/tokenPrice.js";
import {
  evaluateChainReadiness,
  getForwarderDigest,
  getPermit2DomainSeparator,
  getPermit2WitnessStructHash,
  getPermit2WitnessTypeString,
  validateRelaySignature,
  withRpcFallback,
} from "./chain/readiness.js";
import { createMetrics } from "./metrics/metrics.js";
import { createSafeClient } from "./safe/client.js";
import { startReadinessMetricsSampler } from "./metrics/readinessMetricsSampler.js";
import { startOldestNonterminalAgeSampler } from "./metrics/oldestNonterminalAgeSampler.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const registry = loadRegistry(env.registryPath);
  const db = openDatabase(env.databasePath);
  if (env.runMigrationsOnStart) {
    runMigrations(db);
  }

  const metrics = createMetrics();
  const executions = new RelayExecutionRepository(db, metrics);
  const executionEvents = new RelayExecutionEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);
  const createRequestAudit = new CreateRequestAuditLogRepository(db);
  const relayerClient = new OzRelayerClient(env.ozRelayerUrl, env.ozRelayerApiKey, env.relayerRequestTimeoutMs);

  await bindRelayersToRegistry(registry, relayerClient);

  const ozPollBackoff = { until: 0 };
  const ozRetry = {
    maxAttempts: env.readinessOzRetryMaxAttempts,
    baseDelayMs: env.readinessOzRetryBaseDelayMs,
  };
  const safeClient =
    env.safeAuthorizationEnabled && env.safeApiKey
      ? createSafeClient({
          apiKey: env.safeApiKey,
          registry,
          retryMaxAttempts: env.safeApiRetryMaxAttempts,
          retryBaseDelayMs: env.safeApiRetryBaseDelayMs,
          txServiceUrl: env.safeTxServiceUrl,
        })
      : undefined;

  const readinessBase = { registry, relayerClient, ozRetry };
  const evaluateChainReadinessUncached = (chainId: number) => evaluateChainReadiness({ ...readinessBase, chainId });
  const getReadyzChainReadiness =
    env.readinessCacheSuccessTtlMs > 0 || env.readinessCacheRateLimitedTtlMs > 0
      ? createReadyzReadinessCache(evaluateChainReadinessUncached, {
          successTtlMs: env.readinessCacheSuccessTtlMs,
          rateLimitedTtlMs: env.readinessCacheRateLimitedTtlMs,
        })
      : evaluateChainReadinessUncached;

  const { app } = await createApp({
    registry,
    executions,
    executionEvents,
    relayerTransactions,
    createRequestAudit,
    providerName: env.providerName,
    relayerClient,
    env: { apiAuthEnabled: env.apiAuthEnabled, apiClients: env.apiClients },
    requestMaxMetadataKeys: env.requestMaxMetadataKeys,
    requestMaxMetadataValueLength: env.requestMaxMetadataValueLength,
    logLevel: env.logLevel,
    metrics,
    getChainReadiness: evaluateChainReadinessUncached,
    getReadyzChainReadiness,
    getForwarderDigest: (input) =>
      getForwarderDigest({
        registry,
        chainId: input.chainId,
        forwarder: input.forwarder,
        macro: input.macro,
        encodedPayload: input.encodedPayload,
      }),
    validateRelaySignature: (input) =>
      validateRelaySignature({
        registry,
        chainId: input.chainId,
        signer: input.signer,
        digest: input.digest,
        signature: input.signature,
      }),
    getPermit2WitnessStructHash: (input) =>
      getPermit2WitnessStructHash({
        registry,
        chainId: input.chainId,
        forwarder: input.forwarder,
        macro: input.macro,
        encodedPayload: input.encodedPayload,
        upgradeSuperToken: input.upgradeSuperToken,
      }),
    getPermit2WitnessTypeString: (input) =>
      getPermit2WitnessTypeString({
        registry,
        chainId: input.chainId,
        forwarder: input.forwarder,
        macro: input.macro,
        encodedPayload: input.encodedPayload,
      }),
    getPermit2DomainSeparator: (chain) => getPermit2DomainSeparator(chain),
    safeAuthorizationEnabled: env.safeAuthorizationEnabled,
    safeClient,
    getSignerBytecode: async ({ chainId, address }) => {
      const chain = registry.chainsById.get(chainId);
      if (!chain) {
        return null;
      }
      const code = await withRpcFallback(chain, async (client) =>
        client.getBytecode({ address: address as `0x${string}` }),
      );
      return code ?? null;
    },
  });

  for (const chain of registry.chainsById.values()) {
    if (chain.macroPolicy.mode === "open") {
      app.log.info({ chainId: chain.chainId, macroPolicy: "open" }, "registry chain loaded");
      continue;
    }
    app.log.info(
      { chainId: chain.chainId, macroPolicy: "allowlist", macroCount: chain.macroPolicy.allowedMacros.length },
      "registry chain loaded",
    );
  }

  if (env.relayerSignerBalanceSampleIntervalMs > 0) {
    const priceClient = env.relayerSignerBalancePricingEnabled
      ? new TokenPriceClient({
          baseUrl: env.tokenPriceApiUrl,
          timeoutMs: env.tokenPriceRequestTimeoutMs,
          logger: app.log,
        })
      : undefined;
    startRelayerSignerBalanceSampler({
      registry,
      relayerClient,
      metrics,
      priceClient,
      intervalMs: env.relayerSignerBalanceSampleIntervalMs,
      logger: app.log,
    });
    app.log.info(
      {
        intervalMs: env.relayerSignerBalanceSampleIntervalMs,
        pricingEnabled: env.relayerSignerBalancePricingEnabled,
        tokenPriceApiUrl: env.relayerSignerBalancePricingEnabled ? env.tokenPriceApiUrl : null,
      },
      "relayer signer balance sampler started",
    );
  }

  if (env.readinessMetricsIntervalMs > 0) {
    startReadinessMetricsSampler({
      registry,
      getChainReadiness: getReadyzChainReadiness,
      metrics,
      intervalMs: env.readinessMetricsIntervalMs,
      logger: app.log,
    });
    app.log.info(
      { intervalMs: env.readinessMetricsIntervalMs },
      "readiness metrics sampler started",
    );
  }

  if (env.oldestNonterminalAgeIntervalMs > 0) {
    startOldestNonterminalAgeSampler({
      registry,
      executions,
      metrics,
      intervalMs: env.oldestNonterminalAgeIntervalMs,
      logger: app.log,
    });
    app.log.info(
      { intervalMs: env.oldestNonterminalAgeIntervalMs },
      "oldest non-terminal age sampler started",
    );
  }

  if (env.relayerWorkerEnabled) {
    let tickInFlight = false;
    setInterval(() => {
      if (tickInFlight) {
        return;
      }
      tickInFlight = true;
      void runRelayerAndAuthorizationTicks({
        processRelayerWorkerTick: () =>
          processRelayerWorkerTick({
            executions,
            executionEvents,
            relayerTransactions,
            relayerClient,
            registry,
            batchSize: env.relayerWorkerBatchSize,
            submitRetryCount: 3,
            ozPollBackoff,
            metrics,
          }),
        ...(env.safeAuthorizationEnabled && safeClient
          ? {
              processAuthorizationWorkerTick: () =>
                processAuthorizationWorkerTick({
                  executions,
                  executionEvents,
                  registry,
                  safeClient,
                  batchSize: env.relayerWorkerBatchSize,
                  pollBaseDelayMs: env.safeAuthorizationPollBaseDelayMs,
                  pollMaxDelayMs: env.safeAuthorizationPollMaxDelayMs,
                  metrics,
                  validateRelaySignature: (input) =>
                    validateRelaySignature({
                      registry,
                      chainId: input.chainId,
                      signer: input.signer,
                      digest: input.digest,
                      signature: input.signature,
                    }),
                  getRelayerSigner: async (ozRelayerId) => {
                    const relayer = await relayerClient.getRelayer(ozRelayerId);
                    return relayer.address;
                  },
                }),
            }
          : {}),
        metrics,
        log: app.log,
      }).finally(() => {
        tickInFlight = false;
      });
    }, env.relayerWorkerPollIntervalMs);
  }

  await app.listen({ host: env.host, port: env.port });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
