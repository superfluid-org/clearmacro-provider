import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  RelayExecutionEventRepository,
  RelayExecutionRepository,
  RelayerTransactionRepository,
  type NewRelayExecution,
} from "../../src/db/repositories.js";
import { processAuthorizationWorkerTick } from "../../src/relayer/authorizationWorker.js";
import { processRelayerWorkerTick } from "../../src/relayer/worker.js";
import { loadRegistry } from "../../src/config/registry.js";
import type { SafeClient } from "../../src/safe/client.js";
import { SafeApiError, SafeMessageUnsupportedError } from "../../src/safe/errors.js";

function createAwaitingInput(overrides?: Partial<NewRelayExecution>): NewRelayExecution {
  return {
    clientId: "anonymous",
    clientRequestId: null,
    requestBodyHash: "hash",
    digest: overrides?.digest ?? `0x${"aa".repeat(32)}`,
    domain: "test",
    kind: "clearMacroV1",
    chainId: 1,
    ozRelayerId: "relayer-main",
    forwarderAddress: "0x0000000000000000000000000000000000000001",
    macroAddress: "0x0000000000000000000000000000000000000002",
    signerAddress: "0x00000000000000000000000000000000000000bb",
    nonce: "1",
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 3600),
    value: "0",
    payload: "0x1234",
    signature: "0x1234",
    permit2Json: null,
    metadataJson: "{}",
    forceAfterPreflightRevert: 0,
    requiredConfirmations: 1,
    ...overrides,
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "safe-auth-worker-"));
  const db = openDatabase(join(dir, "app.sqlite"));
  runMigrations(db);
  const executions = new RelayExecutionRepository(db);
  const executionEvents = new RelayExecutionEventRepository(db);
  const relayerTransactions = new RelayerTransactionRepository(db);

  const registryPath = join(dir, "provider.json");
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      chains: [
        {
          chainId: 1,
          forwarderAddress: "0x0000000000000000000000000000000000000001",
          rpcUrls: ["http://localhost:8545"],
          macroPolicy: {
            mode: "allowlist",
            allowedMacros: [{ domain: "test", address: "0x0000000000000000000000000000000000000002" }],
          },
        },
      ],
    }),
  );
  const registry = loadRegistry(registryPath);
  registry.relayerIdByChainId.set(1, "relayer-main");
  registry.requiredConfirmationsByChainId.set(1, 1);

  return { executions, executionEvents, relayerTransactions, registry };
}

function stubSafeClient(overrides?: Partial<SafeClient>): SafeClient {
  return {
    isChainSupported: () => true,
    assertEoaOwners: async () => {},
    getMessage: async () => ({
      safe: "0x00000000000000000000000000000000000000bb",
      messageHash: `0x${"cc".repeat(32)}`,
      preparedSignature: null,
      messageDigest: `0x${"aa".repeat(32)}`,
    }),
    ...overrides,
  };
}

function authorizationDeps(
  setupResult: ReturnType<typeof setup>,
  input: {
    safeClient: SafeClient;
    validateRelaySignature?: (args: {
      chainId: number;
      signer: string;
      digest: string;
      signature: string;
    }) => Promise<boolean>;
    preflightSimulation?: () => Promise<"ok" | "deterministic_revert" | "rpc_unavailable">;
    metricsInc?: (labels: { chain_id: string; network: string; outcome: string }) => void;
  },
) {
  return {
    executions: setupResult.executions,
    executionEvents: setupResult.executionEvents,
    registry: setupResult.registry,
    safeClient: input.safeClient,
    batchSize: 10,
    pollBaseDelayMs: 100,
    pollMaxDelayMs: 1000,
    metrics: {
      safeAuthorizationPollCounter: {
        inc: input.metricsInc ?? vi.fn(),
      },
    },
    validateRelaySignature:
      input.validateRelaySignature ??
      (async ({ signature }) => signature === "0x" || signature === "0xprepared"),
    preflightSimulation: input.preflightSimulation ?? (async () => "ok" as const),
    getRelayerSigner: async () => "0x0000000000000000000000000000000000000010",
  };
}

describe("safe message authorization worker", () => {
  it("expires awaiting executions when validBefore has passed", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput({ validBefore: "1" }),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, { safeClient: stubSafeClient() }),
    );

    const updated = ctx.executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("expired");
    expect(updated.terminal).toBe(1);
  });

  it("promotes with onchain empty signature when ERC-1271 accepts 0x", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, {
        safeClient: stubSafeClient(),
        validateRelaySignature: async ({ signature }) => signature === "0x",
      }),
    );

    const updated = ctx.executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("pending");
    expect(updated.signature).toBe("0x");
    expect(updated.signatureSource).toBe("onchain_safe_message");
  });

  it("promotes with prepared signature from Safe service when valid", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, {
        safeClient: stubSafeClient({
          getMessage: async () => ({
            safe: "0x00000000000000000000000000000000000000bb",
            messageHash: `0x${"cc".repeat(32)}`,
            preparedSignature: "0xprepared",
            messageDigest: `0x${"aa".repeat(32)}`,
          }),
        }),
        validateRelaySignature: async ({ signature }) => signature === "0xprepared",
      }),
    );

    const updated = ctx.executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("pending");
    expect(updated.signature).toBe("0xprepared");
    expect(updated.signatureSource).toBe("safe_prepared_signature");
  });

  it("remains awaiting when prepared signature is not yet valid", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, {
        safeClient: stubSafeClient({
          getMessage: async () => ({
            safe: "0x00000000000000000000000000000000000000bb",
            messageHash: `0x${"cc".repeat(32)}`,
            preparedSignature: "0xprepared",
            messageDigest: `0x${"aa".repeat(32)}`,
          }),
        }),
        validateRelaySignature: async () => false,
      }),
    );

    const updated = ctx.executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("awaiting_authorization");
    expect(updated.signature).toBeNull();
    expect(updated.authorizationPollAttempts).toBe(1);
    expect(updated.authorizationPollAt).not.toBeNull();
  });

  it("schedules one poll after an invalid empty signature finds no prepared signature", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });
    const metricsInc = vi.fn();

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, {
        safeClient: stubSafeClient(),
        validateRelaySignature: async () => false,
        metricsInc,
      }),
    );

    const updated = ctx.executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("awaiting_authorization");
    expect(updated.authorizationPollAttempts).toBe(1);
    expect(metricsInc).toHaveBeenCalledTimes(1);
    expect(metricsInc).toHaveBeenCalledWith({
      chain_id: "1",
      network: "eth-mainnet",
      outcome: "waiting",
    });
  });

  it("schedules retry on Safe API 404 without terminal failure", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, {
        safeClient: stubSafeClient({
          getMessage: async () => {
            throw new SafeApiError("Safe message not found.", 404, true, "SAFE_MESSAGE_NOT_FOUND");
          },
        }),
        validateRelaySignature: async () => false,
      }),
    );

    const updated = ctx.executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("awaiting_authorization");
    expect(updated.authorizationPollAttempts).toBe(1);
    expect(
      ctx.executionEvents
        .listByExecution(created.id)
        .some((event) => event.type === "authorization_poll_retry_scheduled"),
    ).toBe(true);
  });

  it.each([401, 403])("fails terminally on non-retryable Safe API status %i", async (statusCode) => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, {
        safeClient: stubSafeClient({
          getMessage: async () => {
            throw new SafeApiError(
              "Safe API authentication failed.",
              statusCode,
              false,
              "SAFE_API_UNAUTHORIZED",
            );
          },
        }),
        validateRelaySignature: async () => false,
      }),
    );

    const updated = ctx.executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("failed");
    expect(updated.terminal).toBe(1);
    expect(updated.authorizationPollAttempts).toBe(0);
    expect(updated.lastErrorJson).toContain("SAFE_API_UNAUTHORIZED");
  });

  it("schedules retry on Safe API 429", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, {
        safeClient: stubSafeClient({
          getMessage: async () => {
            throw new SafeApiError("Safe API rate limited.", 429, true, "SAFE_API_RATE_LIMITED");
          },
        }),
        validateRelaySignature: async () => false,
      }),
    );

    const updated = ctx.executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("awaiting_authorization");
    expect(updated.authorizationLastErrorJson).toContain("SAFE_API_RATE_LIMITED");
  });

  it("schedules retry on Safe API 503", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, {
        safeClient: stubSafeClient({
          getMessage: async () => {
            throw new SafeApiError("Safe API unavailable.", 503, true, "SAFE_API_UNAVAILABLE");
          },
        }),
        validateRelaySignature: async () => false,
      }),
    );

    const updated = ctx.executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("awaiting_authorization");
    expect(updated.authorizationLastErrorJson).toContain("SAFE_API_UNAVAILABLE");
  });

  it("rejects unsupported Safe authorization configurations", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, {
        safeClient: stubSafeClient({
          getMessage: async () => {
            throw new SafeMessageUnsupportedError("Nested or contract Safe owners are not supported in safeMessageV1.");
          },
        }),
        validateRelaySignature: async () => false,
      }),
    );

    const updated = ctx.executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("rejected");
    expect(updated.lastErrorJson).toContain("SAFE_AUTHORIZATION_UNSUPPORTED");
  });

  it("rejects when preflight reverts after authorization", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, {
        safeClient: stubSafeClient(),
        validateRelaySignature: async ({ signature }) => signature === "0x",
        preflightSimulation: async () => "deterministic_revert",
      }),
    );

    const updated = ctx.executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("rejected");
    expect(updated.lastErrorJson).toContain("PREFLIGHT_REVERTED");
  });

  it("does not repoll executions after promotion", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });
    const deps = authorizationDeps(ctx, {
      safeClient: stubSafeClient(),
      validateRelaySignature: async ({ signature }) => signature === "0x",
    });

    await processAuthorizationWorkerTick(deps);
    const getMessage = vi.fn(async () => ({
      safe: "0x00000000000000000000000000000000000000bb",
      messageHash: `0x${"cc".repeat(32)}`,
      preparedSignature: "0xprepared",
      messageDigest: `0x${"aa".repeat(32)}`,
    }));
    deps.safeClient = stubSafeClient({ getMessage });

    await processAuthorizationWorkerTick(deps);

    expect(getMessage).not.toHaveBeenCalled();
    expect(ctx.executions.getByIdOrThrow(created.id).state).toBe("pending");
  });

  it("promotes then submits via relayer worker to terminal success", async () => {
    const ctx = setup();
    const created = ctx.executions.createAwaitingAuthorization({
      ...createAwaitingInput(),
      authorizationType: "safeMessageV1",
      safeMessageHash: `0x${"cc".repeat(32)}`,
    });

    await processAuthorizationWorkerTick(
      authorizationDeps(ctx, {
        safeClient: stubSafeClient(),
        validateRelaySignature: async ({ signature }) => signature === "0x",
      }),
    );
    expect(ctx.executions.getByIdOrThrow(created.id).state).toBe("pending");

    let pollCount = 0;
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => ({
        id: "oz-tx-safe",
        hash: `0x${"ef".repeat(32)}`,
        status: "submitted",
        status_reason: null,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        confirmed_at: null,
        gas_price: "1",
        gas_limit: 21000,
        nonce: 1,
        value: "0",
        from: "0x0000000000000000000000000000000000000010",
        to: "0x0000000000000000000000000000000000000001",
        relayer_id: "relayer-main",
        data: "0x",
        max_fee_per_gas: null,
        max_priority_fee_per_gas: null,
        mined_at: null,
        receipt: null,
      }),
      getTransaction: async () => {
        pollCount += 1;
        const confirmed = pollCount > 1;
        return {
          id: "oz-tx-safe",
          hash: `0x${"ef".repeat(32)}`,
          status: confirmed ? "confirmed" : "submitted",
          status_reason: null,
          created_at: new Date().toISOString(),
          sent_at: new Date().toISOString(),
          confirmed_at: confirmed ? new Date().toISOString() : null,
          gas_price: "1",
          gas_limit: 21000,
          nonce: 1,
          value: "0",
          from: "0x0000000000000000000000000000000000000010",
          to: "0x0000000000000000000000000000000000000001",
          relayer_id: "relayer-main",
          data: "0x",
          max_fee_per_gas: null,
          max_priority_fee_per_gas: null,
          mined_at: confirmed ? new Date().toISOString() : null,
          receipt: confirmed
            ? {
                transactionHash: `0x${"ef".repeat(32)}`,
                blockNumber: "1",
                status: "success",
              }
            : null,
        };
      },
    };

    await processRelayerWorkerTick({
      executions: ctx.executions,
      executionEvents: ctx.executionEvents,
      relayerTransactions: ctx.relayerTransactions,
      relayerClient: relayerClient as never,
      registry: ctx.registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });

    const submitted = ctx.executions.getByIdOrThrow(created.id);
    expect(submitted.state).toBe("submitted");
    expect(submitted.currentTransactionHash).toBe(`0x${"ef".repeat(32)}`);

    await processRelayerWorkerTick({
      executions: ctx.executions,
      executionEvents: ctx.executionEvents,
      relayerTransactions: ctx.relayerTransactions,
      relayerClient: relayerClient as never,
      registry: ctx.registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });

    const terminal = ctx.executions.getByIdOrThrow(created.id);
    expect(terminal.state).toBe("succeeded");
    expect(terminal.terminal).toBe(1);
  });
});
