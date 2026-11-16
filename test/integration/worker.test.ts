import { describe, expect, it } from "vitest";
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
import { processRelayerWorkerTick } from "../../src/relayer/worker.js";
import { OzRelayerRateLimitError } from "../../src/relayer/errors.js";
import { loadRegistry } from "../../src/config/registry.js";
import { clearMacroForwarderV1Abi } from "../../src/chain/clearMacroForwarderV1Abi.js";
import { buildPermit2Context } from "../../src/chain/permit2.js";
import { decodeFunctionData } from "viem";

function createExecutionInput(overrides?: Partial<NewRelayExecution>): NewRelayExecution {
  return {
    clientId: "anonymous",
    clientRequestId: null,
    requestBodyHash: "hash",
    digest: overrides?.digest ?? "0x" + "aa".repeat(32),
    domain: "test",
    kind: "clearMacroV1",
    chainId: 1,
    ozRelayerId: "relayer-main",
    forwarderAddress: "0x0000000000000000000000000000000000000001",
    macroAddress: "0x0000000000000000000000000000000000000002",
    signerAddress: "0x0000000000000000000000000000000000000003",
    nonce: "1",
    validAfter: "0",
    validBefore: "0",
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

const defaultPermit2Json = JSON.stringify({
  permit: {
    permitted: {
      token: "0x00000000000000000000000000000000000000cc",
      amount: "1000000",
    },
    nonce: "123",
    deadline: "4102444800",
  },
  spender: "0x0000000000000000000000000000000000000001",
  upgradeSuperToken: "0x0000000000000000000000000000000000000000",
  signature: "0xbeef",
});

function createPermit2ExecutionInput(overrides?: Partial<NewRelayExecution>): NewRelayExecution {
  return createExecutionInput({
    kind: "clearMacroPermit2V1",
    signature: "0xbeef",
    permit2Json: defaultPermit2Json,
    ...overrides,
  });
}

function stubRelayerClient(submit?: (tx: { data: string }) => unknown) {
  return {
    getRelayer: async () => ({
      address: "0x0000000000000000000000000000000000000010",
      paused: false,
      system_disabled: false,
    }),
    submitTransaction: async (_id: string, tx: { data: string }) => {
      submit?.(tx);
      return {
        id: "oz-tx-permit2",
        hash: "0x" + "cd".repeat(32),
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
        data: tx.data,
        max_fee_per_gas: null,
        max_priority_fee_per_gas: null,
        mined_at: null,
        receipt: null,
      };
    },
    getTransaction: async () => {
      throw new Error("not used");
    },
  };
}

function defaultResolvePermit2Context() {
  return async () =>
    buildPermit2Context({
      permit2: JSON.parse(defaultPermit2Json),
      owner: "0x0000000000000000000000000000000000000003",
      witness: `0x${"11".repeat(32)}`,
      witnessTypeString: "witness-type",
    });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "worker-test-"));
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

describe("relayer worker", () => {
  it("submits pending execution and transitions to submitted when hash exists", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());

    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => ({
        id: "oz-tx-1",
        hash: "0x" + "ab".repeat(32),
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
        throw new Error("not used");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });

    const updated = executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("submitted");
    expect(updated.ozTransactionId).toBe("oz-tx-1");
    expect(updated.currentTransactionHash).toBe("0x" + "ab".repeat(32));
    const relayer = relayerTransactions.getByExecutionId(created.id);
    expect(relayer?.status).toBe("submitted");
  });

  it("fails a non-zero value without submitting unless native value is enabled", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const blocked = executions.createPending(createExecutionInput({ value: "5", digest: "0x" + "b1".repeat(32) }));
    let submits = 0;
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: stubRelayerClient(() => {
        submits += 1;
      }) as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });
    expect(submits).toBe(0);
    const failed = executions.getByIdOrThrow(blocked.id);
    expect(failed.state).toBe("failed");
    expect(JSON.parse(failed.lastErrorJson ?? "{}").code).toBe("NATIVE_VALUE_NOT_ALLOWED");

    const allowed = executions.createPending(createExecutionInput({ value: "5", digest: "0x" + "b2".repeat(32) }));
    let submittedValue = "";
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: {
        ...stubRelayerClient(),
        submitTransaction: async (_id: string, tx: { value?: string }) => {
          submittedValue = tx.value ?? "";
          return {
            id: "oz-tx-value",
            hash: "0x" + "ee".repeat(32),
            status: "submitted",
            status_reason: null,
            created_at: new Date().toISOString(),
            sent_at: new Date().toISOString(),
            confirmed_at: null,
            gas_price: "1",
            gas_limit: 21000,
            nonce: 1,
            value: tx.value ?? "0",
            from: "0x0000000000000000000000000000000000000010",
            to: "0x0000000000000000000000000000000000000001",
            relayer_id: "relayer-main",
            data: "0x",
            max_fee_per_gas: null,
            max_priority_fee_per_gas: null,
            mined_at: null,
            receipt: null,
          };
        },
      } as never,
      registry,
      batchSize: 10,
      nativeValueEnabled: true,
      preflightSimulation: async () => "ok",
    });
    expect(submittedValue).toBe("5");
    expect(executions.getByIdOrThrow(allowed.id).state).toBe("submitted");
  });

  it("projects submitted execution to reverted on failed revert reason", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-1" });

    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => ({
        id: "oz-tx-1",
        hash: "0x" + "cd".repeat(32),
        status: "failed",
        status_reason: "execution reverted: test",
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
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });

    const updated = executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("reverted");
    expect(updated.terminal).toBe(1);
  });

  it("retries transient submit failures before failed", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("Relayer HTTP 503");
      },
      getTransaction: async () => {
        throw new Error("not used");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      submitRetryCount: 3,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("pending");

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      submitRetryCount: 3,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("pending");

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      submitRetryCount: 3,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("failed");

    const events = executionEvents.listByExecution(created.id);
    expect(events.some((e) => e.type === "relayer_submit_retry_scheduled")).toBe(true);
    expect(events.some((e) => e.type === "terminal_error_set")).toBe(true);
  });

  it("passes signer and calldata inputs to preflight simulation", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(
      createExecutionInput({
        signerAddress: "0x00000000000000000000000000000000000000aa",
        signature: "0xbeef",
        payload: "0x9999",
      }),
    );
    const preflightCalls: Array<{ signer: string; signature: string; encodedPayload: string }> = [];
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => ({
        id: "oz-tx-preflight",
        hash: "0x" + "12".repeat(32),
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
        throw new Error("not used");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async (input) => {
        preflightCalls.push({
          signer: input.signer,
          signature: input.signature,
          encodedPayload: input.encodedPayload,
        });
        return "ok";
      },
    });

    expect(preflightCalls).toHaveLength(1);
    expect(preflightCalls[0]).toEqual({
      signer: "0x00000000000000000000000000000000000000aa",
      signature: "0xbeef",
      encodedPayload: "0x9999",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("submitted");
  });

  it("keeps execution pending when preflight reports rpc_unavailable", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("should not submit");
      },
      getTransaction: async () => {
        throw new Error("not used");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "rpc_unavailable",
    });

    expect(executions.getByIdOrThrow(created.id).state).toBe("pending");
    expect(executionEvents.listByExecution(created.id).some((e) => e.type === "preflight_retry_scheduled")).toBe(true);
  });

  it("skips worker preflight when force-after-preflight flag is set", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    executions.createPending(createExecutionInput({ forceAfterPreflightRevert: 1 }));
    let preflightCalls = 0;
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => ({
        id: "oz-tx-force",
        hash: "0x" + "01".repeat(32),
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
        throw new Error("not used");
      },
    };

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => {
        preflightCalls += 1;
        return "deterministic_revert";
      },
    });

    expect(preflightCalls).toBe(0);
  });

  it("keeps submitted state for unknown non-terminal relayer statuses with hash", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-2" });
    executions.appendCurrentHashChange(created.id, `0x${"ef".repeat(32)}`);
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => ({
        id: "oz-tx-2",
        hash: "0x" + "ef".repeat(32),
        status: "replaced",
        status_reason: null,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        confirmed_at: null,
        gas_price: "1",
        gas_limit: 21000,
        nonce: 2,
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
    };
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("submitted");
  });

  it("records polling audit event when status lookup errors", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-3" });
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => {
        throw new Error("bad envelope");
      },
    };
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("submitted");
    expect(executionEvents.listByExecution(created.id).some((event) => event.type === "relayer_status_polled")).toBe(true);
  });

  it("projects mined success with pending confirmations to submitted", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput({ requiredConfirmations: 2 }));
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-4" });
    executions.appendCurrentHashChange(created.id, `0x${"11".repeat(32)}`);
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => ({
        id: "oz-tx-4",
        hash: "0x" + "11".repeat(32),
        status: "mined",
        status_reason: null,
        created_at: new Date().toISOString(),
        sent_at: new Date().toISOString(),
        mined_at: new Date().toISOString(),
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
        receipt: {
          transactionHash: "0x" + "11".repeat(32),
          blockNumber: "1",
          status: "0x1",
        },
      }),
    };
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("submitted");
  });

  it("rejects with terminal rejected when post-creation preflight deterministically reverts", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => {
        throw new Error("not used");
      },
    };
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "deterministic_revert",
    });
    expect(executions.getByIdOrThrow(created.id).state).toBe("rejected");
    expect(executions.getByIdOrThrow(created.id).terminal).toBe(1);
  });

  it("sets poll backoff and records relayer_poll_rate_limited when getTransaction hits 429", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput());
    executions.transitionState(created.id, "submitted", { ozTransactionId: "oz-tx-rl" });
    const ozPollBackoff = { until: 0 };
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("not used");
      },
      getTransaction: async () => {
        throw new OzRelayerRateLimitError("rl", 429, "/", 200);
      },
    };
    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
      ozPollBackoff,
    });
    expect(ozPollBackoff.until).toBeGreaterThan(0);
    expect(executionEvents.listByExecution(created.id).some((e) => e.type === "relayer_poll_rate_limited")).toBe(true);
  });

  it("submits clearMacroPermit2V1 execution as runPermit2AndMacro calldata", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    executions.createPending(createPermit2ExecutionInput());
    let submittedData = "";
    const relayerClient = stubRelayerClient((tx) => {
      submittedData = tx.data;
    });

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightPermit2Simulation: async () => "ok",
      resolvePermit2Context: defaultResolvePermit2Context(),
    });

    const decoded = decodeFunctionData({
      abi: clearMacroForwarderV1Abi,
      data: submittedData as `0x${string}`,
    });
    expect(decoded.functionName).toBe("runPermit2AndMacro");
  });

  it("rejects Permit2 execution when preflight deterministically reverts", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createPermit2ExecutionInput());
    let submitCalls = 0;
    const relayerClient = stubRelayerClient(() => {
      submitCalls += 1;
    });

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightPermit2Simulation: async () => "deterministic_revert",
      resolvePermit2Context: defaultResolvePermit2Context(),
    });

    expect(submitCalls).toBe(0);
    expect(executions.getByIdOrThrow(created.id).state).toBe("rejected");
    expect(executions.getByIdOrThrow(created.id).terminal).toBe(1);
  });

  it("keeps Permit2 execution pending when preflight reports rpc_unavailable", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createPermit2ExecutionInput());
    const relayerClient = stubRelayerClient();

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightPermit2Simulation: async () => "rpc_unavailable",
      resolvePermit2Context: defaultResolvePermit2Context(),
    });

    expect(executions.getByIdOrThrow(created.id).state).toBe("pending");
    expect(executionEvents.listByExecution(created.id).some((e) => e.type === "preflight_retry_scheduled")).toBe(true);
  });

  it("skips Permit2 worker preflight when force-after-preflight flag is set", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    executions.createPending(createPermit2ExecutionInput({ forceAfterPreflightRevert: 1 }));
    let preflightCalls = 0;
    const relayerClient = stubRelayerClient();

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightPermit2Simulation: async () => {
        preflightCalls += 1;
        return "deterministic_revert";
      },
      resolvePermit2Context: defaultResolvePermit2Context(),
    });

    expect(preflightCalls).toBe(0);
    expect(executions.listSubmittable(10)).toHaveLength(0);
  });

  it("fails Permit2 execution with INVALID_PERMIT2_STATE when permit2_json is missing", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createPermit2ExecutionInput({ permit2Json: null }));
    const relayerClient = stubRelayerClient();

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightPermit2Simulation: async () => "ok",
    });

    const updated = executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("failed");
    expect(updated.lastErrorJson).toContain("INVALID_PERMIT2_STATE");
  });

  it("fails Permit2 execution with INVALID_PERMIT2_STATE when permit2_json is malformed", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createPermit2ExecutionInput({ permit2Json: "{not-json" }));
    const relayerClient = stubRelayerClient();

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightPermit2Simulation: async () => "ok",
    });

    const updated = executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("failed");
    expect(updated.lastErrorJson).toContain("INVALID_PERMIT2_STATE");
  });

  it("keeps Permit2 execution pending when witness resolution throws", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createPermit2ExecutionInput());
    const relayerClient = stubRelayerClient();

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightPermit2Simulation: async () => "ok",
      resolvePermit2Context: async () => {
        throw new Error("RPC down");
      },
    });

    expect(executions.getByIdOrThrow(created.id).state).toBe("pending");
    expect(executionEvents.listByExecution(created.id).some((e) => e.type === "preflight_retry_scheduled")).toBe(true);
  });

  it("expires Permit2 execution before submission when validBefore elapsed", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(
      createPermit2ExecutionInput({
        validBefore: String(Math.floor(Date.now() / 1000) - 60),
      }),
    );
    const relayerClient = stubRelayerClient();

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: relayerClient as never,
      registry,
      batchSize: 10,
      preflightPermit2Simulation: async () => "ok",
      resolvePermit2Context: defaultResolvePermit2Context(),
    });

    expect(executions.getByIdOrThrow(created.id).state).toBe("expired");
  });

  it("retries transient Permit2 submit failures before failed", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createPermit2ExecutionInput());
    const relayerClient = {
      getRelayer: async () => ({
        address: "0x0000000000000000000000000000000000000010",
        paused: false,
        system_disabled: false,
      }),
      submitTransaction: async () => {
        throw new Error("Relayer HTTP 503");
      },
      getTransaction: async () => {
        throw new Error("not used");
      },
    };

    for (let i = 0; i < 3; i++) {
      await processRelayerWorkerTick({
        executions,
        executionEvents,
        relayerTransactions,
        relayerClient: relayerClient as never,
        registry,
        batchSize: 10,
        submitRetryCount: 3,
        preflightPermit2Simulation: async () => "ok",
        resolvePermit2Context: defaultResolvePermit2Context(),
      });
    }
    expect(executions.getByIdOrThrow(created.id).state).toBe("failed");
    expect(executionEvents.listByExecution(created.id).some((e) => e.type === "relayer_submit_retry_scheduled")).toBe(true);
  });

  it("fails clearMacroV1 pending rows that are missing a signature", async () => {
    const { executions, executionEvents, relayerTransactions, registry } = setup();
    const created = executions.createPending(createExecutionInput({ signature: null }));
    let submitted = false;

    await processRelayerWorkerTick({
      executions,
      executionEvents,
      relayerTransactions,
      relayerClient: {
        getRelayer: async () => ({
          address: "0x0000000000000000000000000000000000000010",
          paused: false,
          system_disabled: false,
        }),
        submitTransaction: async () => {
          submitted = true;
          throw new Error("should not submit");
        },
        getTransaction: async () => {
          throw new Error("not used");
        },
      } as never,
      registry,
      batchSize: 10,
      preflightSimulation: async () => "ok",
    });

    const updated = executions.getByIdOrThrow(created.id);
    expect(updated.state).toBe("failed");
    expect(submitted).toBe(false);
    expect(JSON.parse(updated.lastErrorJson ?? "{}")).toMatchObject({
      code: "INTERNAL_INVARIANT",
      category: "provider",
      retryable: false,
    });
    expect(
      executionEvents.listByExecution(created.id).some((e) => e.type === "terminal_error_set"),
    ).toBe(true);
  });
});
