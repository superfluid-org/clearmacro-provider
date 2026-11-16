import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReadyzReadinessCache } from "../../src/chain/readinessCache.js";
import { createTestHarness } from "../fixtures/harness.js";
import { buildClearMacroParams, buildPermit2RelayPayload, buildPermit2Request, buildRelayPayload } from "../fixtures/relay-fixtures.js";

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe("API integration", () => {
  it("accepts valid relay execution and returns pending execution resource", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const created = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(created.statusCode).toBe(202);
    const createdBody = created.json<{ id: string; state: string; transaction?: { hash: string } }>();
    expect(createdBody.state).toBe("pending");
    expect(createdBody.transaction).toBeUndefined();
    const status = await app.inject({ method: "GET", url: `/v1/relay-executions/${createdBody.id}` });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json<{ id: string; state: string; transaction?: unknown }>();
    expect(statusBody.id).toBe(createdBody.id);
    expect(statusBody.state).toBe("pending");
  });

  it("rejects a non-zero native value unless the provider enables it", async () => {
    const denied = await createTestHarness();
    const rejected = await denied.app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({ value: "1" }),
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json<{ error: { code: string } }>().error.code).toBe("NATIVE_VALUE_NOT_ALLOWED");

    const zero = await denied.app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({ value: "0" }),
    });
    expect(zero.statusCode).toBe(202);

    const allowed = await createTestHarness({ nativeValueEnabled: true });
    const accepted = await allowed.app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({ value: "1" }),
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json<{ value: string }>().value).toBe("1");
  });

  it("replays identical signed intent with 200 for same anonymous caller", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const first = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    const second = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);
  });

  it("returns 409 DUPLICATE_EXECUTION without leaking id across authenticated clients", async () => {
    const tokA = "token-a";
    const tokB = "token-b";
    const app = (
      await createTestHarness({
        env: {
          apiAuthEnabled: true,
          apiClients: [
            { id: "client-a", apiTokenHash: createHash("sha256").update(tokA).digest("hex").toLowerCase() },
            { id: "client-b", apiTokenHash: createHash("sha256").update(tokB).digest("hex").toLowerCase() },
          ],
        },
      })
    ).app;
    const payload = await buildRelayPayload();
    const first = await app.inject({ method: "POST", url: "/v1/relay-executions", payload, headers: bearer(tokA) });
    expect(first.statusCode).toBe(202);
    const dup = await app.inject({ method: "POST", url: "/v1/relay-executions", payload, headers: bearer(tokB) });
    expect(dup.statusCode).toBe(409);
    const err = dup.json<{ error: { code: string; executionId: string | null } }>().error;
    expect(err.code).toBe("DUPLICATE_EXECUTION");
    expect(err.executionId).toBeNull();
  });

  it("allows different payloads that share a nonce when digests differ", async () => {
    const { app } = await createTestHarness({
      getForwarderDigest: async (input) =>
        `0x${createHash("sha256").update(input.encodedPayload).digest("hex")}`,
    });
    const first = await buildRelayPayload();
    const second = await buildRelayPayload({
      signature: "0x1234",
      payload: buildClearMacroParams({ nonce: 1n, actionParams: "0x9999" }) as `0x${string}`,
    });
    const a = await app.inject({ method: "POST", url: "/v1/relay-executions", payload: first });
    const b = await app.inject({ method: "POST", url: "/v1/relay-executions", payload: second });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
  });

  it("rejects invalid signature", async () => {
    const { app } = await createTestHarness({ validateRelaySignature: async () => false });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);
  });

  it("returns 503 readiness when any chain is not ready", async () => {
    const { app } = await createTestHarness({
      getChainReadiness: async () => ({ ready: false, reasonCode: "PROVIDER_NOT_READY" }),
    });
    const readyz = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyz.statusCode).toBe(503);
    expect(readyz.json<{ ready: boolean }>().ready).toBe(false);
  });

  it("GET /readyz uses cached readiness while POST uses uncached readiness", async () => {
    let readyzInnerCalls = 0;
    let relayReadinessCalls = 0;
    const inner = async () => {
      readyzInnerCalls += 1;
      return { ready: true as const };
    };
    const cached = createReadyzReadinessCache(inner, { successTtlMs: 60_000, rateLimitedTtlMs: 1000 });
    const { app } = await createTestHarness({
      getReadyzChainReadiness: cached,
      getChainReadiness: async () => {
        relayReadinessCalls += 1;
        return { ready: true };
      },
    });
    await app.inject({ method: "GET", url: "/readyz" });
    await app.inject({ method: "GET", url: "/readyz" });
    const payload = await buildRelayPayload();
    await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(readyzInnerCalls).toBe(1);
    expect(relayReadinessCalls).toBeGreaterThanOrEqual(1);
  });

  it("returns 503 RELAYER_RATE_LIMITED with relayer category when readiness reports rate limit", async () => {
    const { app } = await createTestHarness({
      getChainReadiness: async () => ({ ready: false, reasonCode: "RELAYER_RATE_LIMITED" }),
    });
    const payload = await buildRelayPayload();
    const res = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(res.statusCode).toBe(503);
    const err = res.json<{ error: { code: string; category: string } }>().error;
    expect(err.code).toBe("RELAYER_RATE_LIMITED");
    expect(err.category).toBe("relayer");
  });

  it("returns 422 when preflight reverts and force is false", async () => {
    const { app } = await createTestHarness({
      preflightRunMacro: async () => "deterministic_revert",
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("PREFLIGHT_REVERTED");
  });

  it("returns 202 pending when preflight reverts and force is true", async () => {
    const { app } = await createTestHarness({
      preflightRunMacro: async () => "deterministic_revert",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({ forceExecuteAfterPreflightRevert: true }),
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ state: string; metadata: Record<string, string> }>();
    expect(body.state).toBe("pending");
    expect(body.metadata.forceSubmittedAfterPreflightRevert).toBe("true");
  });

  it("does not bypass policy when force is true", async () => {
    const { app } = await createTestHarness({
      preflightRunMacro: async () => "deterministic_revert",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: {
        ...(await buildRelayPayload({ payload: buildClearMacroParams({ provider: "wrong.provider.eth" }) as `0x${string}` })),
        forceExecuteAfterPreflightRevert: true,
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("open mode accepts macro not present in allowlist", async () => {
    const { app } = await createTestHarness({ macroPolicyMode: "open" });
    const macroAddress = "0x0000000000000000000000000000000000000003" as const;
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({
        macroAddress,
        payload: buildClearMacroParams({ domain: "any.domain", macroContract: macroAddress }) as `0x${string}`,
      }),
    });
    expect(response.statusCode).toBe(202);
  });

  it("open mode still rejects macro mismatch between request and payload", async () => {
    const { app } = await createTestHarness({ macroPolicyMode: "open" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({
        macroAddress: "0x0000000000000000000000000000000000000003",
        payload: buildClearMacroParams({
          domain: "any.domain",
          macroContract: "0x0000000000000000000000000000000000000002",
        }) as `0x${string}`,
      }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("INVALID_CLEAR_MACRO_PAYLOAD");
  });

  it("open mode still rejects provider mismatch and invalid signature", async () => {
    const providerMismatch = await createTestHarness({ macroPolicyMode: "open" });
    const providerResponse = await providerMismatch.app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({
        macroAddress: "0x0000000000000000000000000000000000000003",
        payload: buildClearMacroParams({
          domain: "any.domain",
          provider: "wrong.provider.eth",
          macroContract: "0x0000000000000000000000000000000000000003",
        }) as `0x${string}`,
      }),
    });
    expect(providerResponse.statusCode).toBe(403);
    expect(providerResponse.json<{ error: { code: string } }>().error.code).toBe("PROVIDER_NOT_ALLOWED");

    const signatureInvalid = await createTestHarness({ macroPolicyMode: "open", validateRelaySignature: async () => false });
    const signatureResponse = await signatureInvalid.app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload({
        macroAddress: "0x0000000000000000000000000000000000000003",
        payload: buildClearMacroParams({
          domain: "any.domain",
          macroContract: "0x0000000000000000000000000000000000000003",
        }) as `0x${string}`,
      }),
    });
    expect(signatureResponse.statusCode).toBe(422);
    expect(signatureResponse.json<{ error: { code: string } }>().error.code).toBe("SIGNATURE_INVALID");
  });

  it("maps schema and malformed body failures to 400 validation error", async () => {
    const { app } = await createTestHarness();
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: { kind: "clearMacroV1", chainId: 1 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("maps metadata guard failures to 400 validation error", async () => {
    const { app } = await createTestHarness({ requestMaxMetadataKeys: 1, requestMaxMetadataValueLength: 2 });
    const payload = await buildRelayPayload();
    const tooManyKeys = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: { ...payload, metadata: { a: "1", b: "2" } },
    });
    expect(tooManyKeys.statusCode).toBe(400);
    expect(tooManyKeys.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");

    const tooLongValue = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: { ...payload, metadata: { a: "123" } },
    });
    expect(tooLongValue.statusCode).toBe(400);
    expect(tooLongValue.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("accepts ERC-1271 signer path when signature validator allows it", async () => {
    const { app } = await createTestHarness({
      validateRelaySignature: async ({ signer }) => signer === "0x00000000000000000000000000000000000000aa",
    });
    const payload = await buildRelayPayload({
      signerAddress: "0x00000000000000000000000000000000000000aa",
      signature: "0x123456",
    });
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(202);
  });

  it("maps digest RPC failures to 503 chain unavailable", async () => {
    const { app } = await createTestHarness({
      getForwarderDigest: async () => {
        throw new Error("RPC down");
      },
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CHAIN_UNAVAILABLE");
  });

  it("maps signature validation RPC failures to 503 chain unavailable", async () => {
    const { app } = await createTestHarness({
      validateRelaySignature: async () => {
        throw new Error("RPC down");
      },
    });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CHAIN_UNAVAILABLE");
  });

  it("returns events when include=events is requested", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const create = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    const id = create.json<{ id: string }>().id;
    const response = await app.inject({ method: "GET", url: `/v1/relay-executions/${id}?include=events` });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json<{ events?: unknown[] }>().events)).toBe(true);
  });

  it("returns 404 for missing execution id", async () => {
    const { app } = await createTestHarness();
    const response = await app.inject({ method: "GET", url: "/v1/relay-executions/missing-id" });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("EXECUTION_NOT_FOUND");
  });

  it("returns capabilities for dapps", async () => {
    const { app } = await createTestHarness();
    const response = await app.inject({ method: "GET", url: "/v1/capabilities" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      providerName: string;
      chains: Array<{
        chainId: number;
        forwarderAddress: string;
        macroPolicy: { mode: "allowlist"; allowedMacros: Array<{ domain: string; address: string }> };
        supportedKinds: string[];
        supportedAuthorizationMethods: string[];
      }>;
    }>();
    expect(body.providerName).toBe("macros.superfluid.eth");
    expect(body.chains[0]?.chainId).toBe(1);
    expect(body.chains[0]?.forwarderAddress).toMatch(/^0x[0-9a-f]{40}$/);
    expect(body.chains[0]?.macroPolicy).toEqual({
      mode: "allowlist",
      allowedMacros: [{ domain: "test", address: "0x0000000000000000000000000000000000000002" }],
    });
    expect(body.chains[0]?.supportedKinds).toEqual([
      "clearMacroV1",
      "clearMacroPermit2V1",
    ]);
    expect(body.chains[0]?.supportedAuthorizationMethods).toEqual(["signature"]);
  });

  it("enforces auth token when auth is enabled", async () => {
    const { app } = await createTestHarness({ apiAuthEnabled: true });
    const payload = await buildRelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("UNAUTHORIZED");
  });

  it("returns 422 for not-yet-valid payload", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload({
      payload: buildClearMacroParams({ validAfter: BigInt(Math.floor(Date.now() / 1000) + 3600) }) as `0x${string}`,
    });
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CLEAR_MACRO_NOT_YET_VALID");
  });

  it("returns 422 for expired payload", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload({
      payload: buildClearMacroParams({ validBefore: BigInt(Math.floor(Date.now() / 1000) - 1) }) as `0x${string}`,
    });
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CLEAR_MACRO_EXPIRED");
  });

  it("canonicalizes addresses into digest dedup key", async () => {
    const { app } = await createTestHarness();
    const payload = await buildRelayPayload();
    const first = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: {
        ...payload,
        macroAddress: `0x${payload.macroAddress.slice(2).toUpperCase()}`,
        signerAddress: `0x${payload.signerAddress.slice(2).toUpperCase()}`,
      },
    });
    const second = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);
  });

  it("records audit rows for failed creates", async () => {
    const { app, db } = await createTestHarness({ validateRelaySignature: async () => false });
    const payload = await buildRelayPayload();
    await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    const row = db.db.prepare("SELECT outcome_code FROM create_request_audit_log ORDER BY created_at DESC LIMIT 1").get() as {
      outcome_code: string;
    };
    expect(row.outcome_code).toBe("SIGNATURE_INVALID");
  });

  it("accepts valid clearMacroPermit2V1 request and returns pending execution", async () => {
    const { app } = await createTestHarness();
    const payload = await buildPermit2RelayPayload();
    const created = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(created.statusCode).toBe(202);
    const body = created.json<{ kind: string; state: string }>();
    expect(body.kind).toBe("clearMacroPermit2V1");
    expect(body.state).toBe("pending");
    expect(JSON.stringify(body)).not.toContain(payload.permit2.signature);
  });

  it("replays identical Permit2 signed intent with 200 for same caller", async () => {
    const { app } = await createTestHarness();
    const payload = await buildPermit2RelayPayload();
    const first = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    const second = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);
  });

  it("rejects invalid Permit2 signature", async () => {
    const { app } = await createTestHarness({ validateRelaySignature: async () => false });
    const payload = await buildPermit2RelayPayload();
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("SIGNATURE_INVALID");
  });

  it("rejects implied-upgrade Permit2 when spender is not the forwarder", async () => {
    const { app } = await createTestHarness();
    const payload = await buildPermit2RelayPayload({
      permit2: buildPermit2Request({
        spender: "0x0000000000000000000000000000000000000099",
        upgradeSuperToken: "0x00000000000000000000000000000000000000aa",
      }),
    });
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_ERROR");
  });

  it("allows two Permit2 requests with the same payload when Permit2 nonce differs", async () => {
    const { app } = await createTestHarness({
      getPermit2WitnessStructHash: async (input) =>
        `0x${createHash("sha256").update(input.upgradeSuperToken).digest("hex").slice(0, 64)}`,
    });
    const first = await buildPermit2RelayPayload();
    const second = await buildPermit2RelayPayload({
      permit2: {
        ...first.permit2,
        permit: { ...first.permit2.permit, nonce: "124" },
        signature: "0x5678",
      },
    });
    const a = await app.inject({ method: "POST", url: "/v1/relay-executions", payload: first });
    const b = await app.inject({ method: "POST", url: "/v1/relay-executions", payload: second });
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(a.json<{ id: string }>().id).not.toBe(b.json<{ id: string }>().id);
  });

  it("returns 409 DUPLICATE_EXECUTION for Permit2 digest across authenticated clients", async () => {
    const tokA = "permit2-token-a";
    const tokB = "permit2-token-b";
    const app = (
      await createTestHarness({
        env: {
          apiAuthEnabled: true,
          apiClients: [
            { id: "client-a", apiTokenHash: createHash("sha256").update(tokA).digest("hex").toLowerCase() },
            { id: "client-b", apiTokenHash: createHash("sha256").update(tokB).digest("hex").toLowerCase() },
          ],
        },
      })
    ).app;
    const payload = await buildPermit2RelayPayload();
    const first = await app.inject({ method: "POST", url: "/v1/relay-executions", payload, headers: bearer(tokA) });
    expect(first.statusCode).toBe(202);
    const dup = await app.inject({ method: "POST", url: "/v1/relay-executions", payload, headers: bearer(tokB) });
    expect(dup.statusCode).toBe(409);
    const err = dup.json<{ error: { code: string; executionId: string | null } }>().error;
    expect(err.code).toBe("DUPLICATE_EXECUTION");
    expect(err.executionId).toBeNull();
  });

  it("maps Permit2 witness derivation RPC failures to 503 chain unavailable", async () => {
    const witnessFail = await createTestHarness({
      getPermit2WitnessStructHash: async () => {
        throw new Error("RPC down");
      },
    });
    const witnessResponse = await witnessFail.app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload(),
    });
    expect(witnessResponse.statusCode).toBe(503);
    expect(witnessResponse.json<{ error: { code: string } }>().error.code).toBe("CHAIN_UNAVAILABLE");

    const typeFail = await createTestHarness({
      getPermit2WitnessTypeString: async () => {
        throw new Error("RPC down");
      },
    });
    const typeResponse = await typeFail.app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload(),
    });
    expect(typeResponse.statusCode).toBe(503);
    expect(typeResponse.json<{ error: { code: string } }>().error.code).toBe("CHAIN_UNAVAILABLE");
  });

  it("maps Permit2 domain separator RPC failures to 503 chain unavailable", async () => {
    const { app } = await createTestHarness({
      getPermit2DomainSeparator: async () => {
        throw new Error("RPC down");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CHAIN_UNAVAILABLE");
  });

  it("maps Permit2 signature validation RPC failures to 503 chain unavailable", async () => {
    const { app } = await createTestHarness({
      validateRelaySignature: async () => {
        throw new Error("RPC down");
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CHAIN_UNAVAILABLE");
  });

  it("does not bypass Permit2 signature validation when force is true", async () => {
    const { app } = await createTestHarness({
      preflightRunPermit2AndMacro: async () => "deterministic_revert",
      validateRelaySignature: async () => false,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload({ forceExecuteAfterPreflightRevert: true }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("SIGNATURE_INVALID");
  });

  it("returns 202 pending when Permit2 preflight reverts and force is true", async () => {
    const { app } = await createTestHarness({
      preflightRunPermit2AndMacro: async () => "deterministic_revert",
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload({ forceExecuteAfterPreflightRevert: true }),
    });
    expect(response.statusCode).toBe(202);
    const body = response.json<{ state: string; metadata: Record<string, string> }>();
    expect(body.state).toBe("pending");
    expect(body.metadata.forceSubmittedAfterPreflightRevert).toBe("true");
  });

  it("witness-only Permit2 accepts arbitrary spender when upgradeSuperToken is zero", async () => {
    const { app } = await createTestHarness();
    const payload = await buildPermit2RelayPayload({
      permit2: buildPermit2Request({
        spender: "0x0000000000000000000000000000000000009999",
        upgradeSuperToken: "0x0000000000000000000000000000000000000000",
      }),
    });
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(202);
  });

  it("open mode accepts Permit2 request for non-allowlisted macro", async () => {
    const { app } = await createTestHarness({ macroPolicyMode: "open" });
    const macroAddress = "0x0000000000000000000000000000000000000003" as const;
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload({
        macroAddress,
        payload: buildClearMacroParams({ domain: "any.domain", macroContract: macroAddress }) as `0x${string}`,
      }),
    });
    expect(response.statusCode).toBe(202);
  });

  it("open mode still rejects Permit2 macro mismatch between request and payload", async () => {
    const { app } = await createTestHarness({ macroPolicyMode: "open" });
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload({
        macroAddress: "0x0000000000000000000000000000000000000003",
        payload: buildClearMacroParams({
          domain: "any.domain",
          macroContract: "0x0000000000000000000000000000000000000002",
        }) as `0x${string}`,
      }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("INVALID_CLEAR_MACRO_PAYLOAD");
  });

  it("rejects clearMacroPermit2V1 schema violations", async () => {
    const { app } = await createTestHarness();
    const base = await buildPermit2RelayPayload();

    const withTopLevelSignature = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: { ...base, signature: "0x1234" },
    });
    expect(withTopLevelSignature.statusCode).toBe(400);

    const missingPermit2 = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: { kind: "clearMacroPermit2V1", chainId: base.chainId, macroAddress: base.macroAddress, signerAddress: base.signerAddress, payload: base.payload },
    });
    expect(missingPermit2.statusCode).toBe(400);

    const clearMacroWithPermit2 = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: { ...(await buildRelayPayload()), permit2: base.permit2 },
    });
    expect(clearMacroWithPermit2.statusCode).toBe(400);

    const badAddress = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload({
        permit2: buildPermit2Request({ token: "0xnot-an-address" as `0x${string}` }),
      }),
    });
    expect(badAddress.statusCode).toBe(400);

    const badAmount = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload({
        permit2: buildPermit2Request({ amount: "1.5" }),
      }),
    });
    expect(badAmount.statusCode).toBe(400);

    const badSignature = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildPermit2RelayPayload({
        permit2: buildPermit2Request({ signature: "not-hex" as `0x${string}` }),
      }),
    });
    expect(badSignature.statusCode).toBe(400);
  });

  it("accepts safeMessageV1 authorization and returns awaiting_authorization", async () => {
    const safeClient = {
      isChainSupported: () => true,
      assertEoaOwners: async () => {},
      getMessage: async () => ({
        safe: "0x00000000000000000000000000000000000000bb",
        messageHash: `0x${"aa".repeat(32)}`,
        preparedSignature: null,
        messageDigest: `0x${"11".repeat(32)}`,
      }),
    };
    const { app } = await createTestHarness({
      safeAuthorizationEnabled: true,
      safeClient,
      getSignerBytecode: async () => "0x1234",
    });
    const base = await buildRelayPayload({
      signerAddress: "0x00000000000000000000000000000000000000bb",
    });
    const { signature: _signature, ...withoutSignature } = base;
    const payload = {
      ...withoutSignature,
      authorization: {
        type: "safeMessageV1" as const,
        safeMessageHash: `0x${"aa".repeat(32)}`,
      },
    };
    const created = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(created.statusCode).toBe(202);
    const body = created.json<{
      state: string;
      authorization?: { type: string; safeMessageHash: string; messageLink?: string };
    }>();
    expect(body.state).toBe("awaiting_authorization");
    expect(body.authorization?.type).toBe("safeMessageV1");
    expect(body.authorization?.messageLink).toContain("app.safe.global");
  });

  it("rejects clearMacroV1 requests with both signature and authorization", async () => {
    const { app } = await createTestHarness({ safeAuthorizationEnabled: true });
    const payload = {
      ...(await buildRelayPayload()),
      authorization: {
        type: "safeMessageV1" as const,
        safeMessageHash: `0x${"aa".repeat(32)}`,
      },
    };
    const response = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(response.statusCode).toBe(400);
  });

  it("replays identical safeMessageV1 authorization with 200 for same anonymous caller", async () => {
    const safeClient = {
      isChainSupported: () => true,
      assertEoaOwners: async () => {},
      getMessage: async () => ({
        safe: "0x00000000000000000000000000000000000000bb",
        messageHash: `0x${"aa".repeat(32)}`,
        preparedSignature: null,
        messageDigest: `0x${"11".repeat(32)}`,
      }),
    };
    const { app } = await createTestHarness({
      safeAuthorizationEnabled: true,
      safeClient,
      getSignerBytecode: async () => "0x1234",
    });
    const base = await buildRelayPayload({
      signerAddress: "0x00000000000000000000000000000000000000bb",
    });
    const { signature: _signature, ...withoutSignature } = base;
    const payload = {
      ...withoutSignature,
      authorization: {
        type: "safeMessageV1" as const,
        safeMessageHash: `0x${"aa".repeat(32)}`,
      },
    };
    const first = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    const second = await app.inject({ method: "POST", url: "/v1/relay-executions", payload });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);
  });

  it("returns 409 DUPLICATE_EXECUTION for safeMessageV1 across authenticated clients", async () => {
    const tokA = "token-safe-a";
    const tokB = "token-safe-b";
    const app = (
      await createTestHarness({
        safeAuthorizationEnabled: true,
        safeClient: {
          isChainSupported: () => true,
          assertEoaOwners: async () => {},
          getMessage: async () => ({
            safe: "0x00000000000000000000000000000000000000bb",
            messageHash: `0x${"aa".repeat(32)}`,
            preparedSignature: null,
            messageDigest: `0x${"11".repeat(32)}`,
          }),
        },
        getSignerBytecode: async () => "0x1234",
        env: {
          apiAuthEnabled: true,
          apiClients: [
            { id: "client-a", apiTokenHash: createHash("sha256").update(tokA).digest("hex").toLowerCase() },
            { id: "client-b", apiTokenHash: createHash("sha256").update(tokB).digest("hex").toLowerCase() },
          ],
        },
      })
    ).app;
    const base = await buildRelayPayload({
      signerAddress: "0x00000000000000000000000000000000000000bb",
    });
    const { signature: _signature, ...withoutSignature } = base;
    const payload = {
      ...withoutSignature,
      authorization: {
        type: "safeMessageV1" as const,
        safeMessageHash: `0x${"aa".repeat(32)}`,
      },
    };
    const first = await app.inject({ method: "POST", url: "/v1/relay-executions", payload, headers: bearer(tokA) });
    expect(first.statusCode).toBe(202);
    const dup = await app.inject({ method: "POST", url: "/v1/relay-executions", payload, headers: bearer(tokB) });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ error: { code: string; executionId: string | null } }>().error.executionId).toBeNull();
  });

  it("rejects safeMessageV1 when Safe authorization is disabled", async () => {
    const { app } = await createTestHarness({ safeAuthorizationEnabled: false });
    const base = await buildRelayPayload({
      signerAddress: "0x00000000000000000000000000000000000000bb",
    });
    const { signature: _signature, ...withoutSignature } = base;
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: {
        ...withoutSignature,
        authorization: { type: "safeMessageV1" as const, safeMessageHash: `0x${"aa".repeat(32)}` },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "not enabled",
    );
  });

  it("rejects safeMessageV1 on unsupported chains", async () => {
    const { app } = await createTestHarness({
      safeAuthorizationEnabled: true,
      safeClient: {
        isChainSupported: () => false,
        assertEoaOwners: async () => {},
        getMessage: async () => {
          throw new Error("not reached");
        },
      },
      getSignerBytecode: async () => "0x1234",
    });
    const base = await buildRelayPayload({
      signerAddress: "0x00000000000000000000000000000000000000bb",
    });
    const { signature: _signature, ...withoutSignature } = base;
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: {
        ...withoutSignature,
        authorization: { type: "safeMessageV1" as const, safeMessageHash: `0x${"aa".repeat(32)}` },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("CHAIN_NOT_ALLOWED");
  });

  it("rejects safeMessageV1 for EOA signers", async () => {
    const { app } = await createTestHarness({
      safeAuthorizationEnabled: true,
      safeClient: {
        isChainSupported: () => true,
        assertEoaOwners: async () => {},
        getMessage: async () => {
          throw new Error("not reached");
        },
      },
      getSignerBytecode: async () => "0x",
    });
    const base = await buildRelayPayload({
      signerAddress: "0x00000000000000000000000000000000000000bb",
    });
    const { signature: _signature, ...withoutSignature } = base;
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: {
        ...withoutSignature,
        authorization: { type: "safeMessageV1" as const, safeMessageHash: `0x${"aa".repeat(32)}` },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "contract signer",
    );
  });

  it("rejects safeMessageV1 when nested Safe owners are detected at admission", async () => {
    const { app } = await createTestHarness({
      safeAuthorizationEnabled: true,
      safeClient: {
        isChainSupported: () => true,
        assertEoaOwners: async () => {
          throw new Error("Nested or contract Safe owners are not supported in safeMessageV1.");
        },
        getMessage: async () => {
          throw new Error("not reached");
        },
      },
      getSignerBytecode: async () => "0x1234",
    });
    const base = await buildRelayPayload({
      signerAddress: "0x00000000000000000000000000000000000000bb",
    });
    const { signature: _signature, ...withoutSignature } = base;
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: {
        ...withoutSignature,
        authorization: { type: "safeMessageV1" as const, safeMessageHash: `0x${"aa".repeat(32)}` },
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "Nested or contract Safe owners",
    );
  });

  it("rejects safeMessageV1 with forceExecuteAfterPreflightRevert", async () => {
    const { app } = await createTestHarness({
      safeAuthorizationEnabled: true,
      safeClient: {
        isChainSupported: () => true,
        assertEoaOwners: async () => {},
        getMessage: async () => {
          throw new Error("not reached");
        },
      },
      getSignerBytecode: async () => "0x1234",
    });
    const base = await buildRelayPayload({
      signerAddress: "0x00000000000000000000000000000000000000bb",
      forceExecuteAfterPreflightRevert: true,
    });
    const { signature: _signature, ...withoutSignature } = base;
    const response = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: {
        ...withoutSignature,
        forceExecuteAfterPreflightRevert: true,
        authorization: { type: "safeMessageV1" as const, safeMessageHash: `0x${"aa".repeat(32)}` },
      },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("forceExecuteAfterPreflightRevert");
  });

  it("cancels awaiting_authorization and is idempotent", async () => {
    const { app } = await createTestHarness({
      safeAuthorizationEnabled: true,
      safeClient: {
        isChainSupported: () => true,
        assertEoaOwners: async () => {},
        getMessage: async () => ({
          safe: "0x00000000000000000000000000000000000000bb",
          messageHash: `0x${"aa".repeat(32)}`,
          preparedSignature: null,
          messageDigest: `0x${"11".repeat(32)}`,
        }),
      },
      getSignerBytecode: async () => "0x1234",
    });
    const base = await buildRelayPayload({
      signerAddress: "0x00000000000000000000000000000000000000bb",
    });
    const { signature: _signature, ...withoutSignature } = base;
    const created = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: {
        ...withoutSignature,
        authorization: {
          type: "safeMessageV1" as const,
          safeMessageHash: `0x${"aa".repeat(32)}`,
        },
      },
    });
    expect(created.statusCode).toBe(202);
    const id = created.json<{ id: string }>().id;

    const canceled = await app.inject({ method: "DELETE", url: `/v1/relay-executions/${id}` });
    expect(canceled.statusCode).toBe(200);
    const body = canceled.json<{
      state: string;
      terminal: boolean;
      error?: { code: string };
    }>();
    expect(body.state).toBe("canceled");
    expect(body.terminal).toBe(true);
    expect(body.error?.code).toBe("CANCELED_BY_CLIENT");

    const again = await app.inject({ method: "DELETE", url: `/v1/relay-executions/${id}` });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ state: string }>().state).toBe("canceled");
  });

  it("cancels pre-submit pending executions", async () => {
    const { app } = await createTestHarness();
    const created = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload(),
    });
    expect(created.statusCode).toBe(202);
    const id = created.json<{ id: string }>().id;

    const canceled = await app.inject({ method: "DELETE", url: `/v1/relay-executions/${id}` });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json<{ state: string }>().state).toBe("canceled");
  });

  it("rejects cancel after relayer submission acknowledgement", async () => {
    const { app, executions } = await createTestHarness();
    const created = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload(),
    });
    const id = created.json<{ id: string }>().id;
    executions.updateMetadata(id, { ozTransactionId: "oz-tx-1" });

    const response = await app.inject({ method: "DELETE", url: `/v1/relay-executions/${id}` });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("EXECUTION_NOT_CANCELABLE");
  });

  it("hides cancel of another client's execution when auth is enabled", async () => {
    const tokA = "token-cancel-a";
    const tokB = "token-cancel-b";
    const { app } = await createTestHarness({
      env: {
        apiAuthEnabled: true,
        apiClients: [
          { id: "client-a", apiTokenHash: createHash("sha256").update(tokA).digest("hex").toLowerCase() },
          { id: "client-b", apiTokenHash: createHash("sha256").update(tokB).digest("hex").toLowerCase() },
        ],
      },
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/relay-executions",
      payload: await buildRelayPayload(),
      headers: bearer(tokA),
    });
    const id = created.json<{ id: string }>().id;

    const hidden = await app.inject({
      method: "DELETE",
      url: `/v1/relay-executions/${id}`,
      headers: bearer(tokB),
    });
    expect(hidden.statusCode).toBe(404);

    const owned = await app.inject({
      method: "DELETE",
      url: `/v1/relay-executions/${id}`,
      headers: bearer(tokA),
    });
    expect(owned.statusCode).toBe(200);
    expect(owned.json<{ state: string }>().state).toBe("canceled");
  });
});
