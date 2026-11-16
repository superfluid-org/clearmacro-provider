import type { RegisterRoutesDeps } from "./deps.js";
import { ApiError } from "./errors.js";
import { hashCanonicalCreateBody, type CanonicalCreateBodyInput } from "./canonicalBody.js";
import { decodeClearMacroPayload } from "../validation/clearmacro.js";
import { assertMacroAllowed } from "../validation/registry.js";
import type { RelayExecutionRow } from "../db/repositories.js";
import { projectRelayerState } from "../relayer/mapper.js";
import { recordActionableFailure } from "../metrics/actionableFailures.js";
import { isTerminalState } from "../tx/lifecycle.js";
import {
  getPermit2DomainSeparator,
  getPermit2WitnessStructHash,
  getPermit2WitnessTypeString,
  preflightRunMacro,
  preflightRunPermit2AndMacro,
  type ClearMacroForwarderCall,
} from "../chain/readiness.js";
import {
  buildPermit2Context,
  computePermit2Digest,
  isImpliedUpgradeMode,
  normalizePermit2Request,
  type Permit2RequestInput,
  type StoredPermit2Json,
} from "../chain/permit2.js";
import type { RegistryChain } from "../config/schema.js";
import { isZeroNativeValue } from "../tx/nativeValue.js";

export type CreateRelayExecutionBody = CanonicalCreateBodyInput;

type AuditBase = {
  clientId: string;
  requestBodyHash: string;
  chainId: number | null;
  kind: string | null;
  forwarderAddress: string | null;
  domain: string | null;
  macroAddress: string;
  signerAddress: string;
  providerName: string;
  nonce: string | null;
  digest: string | null;
};

type SharedAdmissionContext = {
  clientId: string;
  body: CreateRelayExecutionBody;
  auditBase: AuditBase;
  chainConfig: RegistryChain;
  forwarderAddress: string;
  decoded: ReturnType<typeof decodeClearMacroPayload>;
  metadata: Record<string, string>;
  ozRelayerId: string;
  relayerSigner: string;
  requiredConfirmations: number;
};

type AdmitDeps = RegisterRoutesDeps & {
  preflightRunMacro: NonNullable<RegisterRoutesDeps["preflightRunMacro"]>;
};

type PreflightResult = "ok" | "deterministic_revert" | "rpc_unavailable";

type PreflightOutcome =
  | { metadata: Record<string, string>; forceAfterPreflightRevert: number }
  | { error: ApiError };
type SuccessfulPreflightOutcome = Exclude<
  PreflightOutcome,
  { error: ApiError }
>;

export type AdmitRelayExecutionResult =
  | { statusCode: 200 | 202; row: RelayExecutionRow }
  | { error: ApiError };

function isSqliteUniqueConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("SQLITE_CONSTRAINT") ||
    message.includes("UNIQUE constraint failed")
  );
}

function audit(
  deps: AdmitDeps,
  auditBase: AuditBase,
  outcomeCode: Parameters<AdmitDeps["createRequestAudit"]["append"]>[0]["outcomeCode"],
  executionId: string | null,
  digest: string | null = auditBase.digest,
): void {
  deps.createRequestAudit.append({
    ...auditBase,
    outcomeCode,
    executionId,
    digest,
  });
}

async function validateSharedAdmission(
  deps: AdmitDeps,
  body: CreateRelayExecutionBody,
  clientId: string,
): Promise<SharedAdmissionContext | { error: ApiError }> {
  const requestBodyHash = hashCanonicalCreateBody(body);
  const auditBase: AuditBase = {
    clientId,
    requestBodyHash,
    chainId: body.chainId,
    kind: body.kind,
    forwarderAddress: null,
    domain: null,
    macroAddress: body.macroAddress.toLowerCase(),
    signerAddress: body.signerAddress.toLowerCase(),
    providerName: deps.providerName,
    nonce: null,
    digest: null,
  };

  const chainConfig = deps.registry.chainsById.get(body.chainId);
  if (!chainConfig) {
    audit(deps, auditBase, "CHAIN_NOT_ALLOWED", null);
    return {
      error: new ApiError(
        403,
        "CHAIN_NOT_ALLOWED",
        "Unsupported chain.",
        "validation",
        false,
      ),
    };
  }
  const forwarderAddress = chainConfig.forwarderAddress;
  auditBase.forwarderAddress = forwarderAddress;

  const metadata = { ...(body.metadata ?? {}) };
  if (Object.keys(metadata).length > deps.requestMaxMetadataKeys) {
    audit(deps, auditBase, "VALIDATION_ERROR", null);
    return {
      error: new ApiError(
        400,
        "VALIDATION_ERROR",
        "Too many metadata keys.",
        "validation",
        false,
      ),
    };
  }
  for (const value of Object.values(metadata)) {
    if (value.length > deps.requestMaxMetadataValueLength) {
      audit(deps, auditBase, "VALIDATION_ERROR", null);
      return {
        error: new ApiError(
          400,
          "VALIDATION_ERROR",
          "Metadata value too long.",
          "validation",
          false,
        ),
      };
    }
  }

  if (deps.nativeValueEnabled !== true && !isZeroNativeValue(body.value)) {
    audit(deps, auditBase, "NATIVE_VALUE_NOT_ALLOWED", null);
    return {
      error: new ApiError(
        403,
        "NATIVE_VALUE_NOT_ALLOWED",
        "Relayer native value transfers are disabled.",
        "validation",
        false,
      ),
    };
  }

  let decoded;
  try {
    decoded = decodeClearMacroPayload(body.payload);
  } catch {
    audit(deps, auditBase, "INVALID_CLEAR_MACRO_PAYLOAD", null);
    return {
      error: new ApiError(
        422,
        "INVALID_CLEAR_MACRO_PAYLOAD",
        "Payload is not valid ABI-encoded clear macro payload.",
        "user",
        false,
      ),
    };
  }
  auditBase.domain = decoded.domain;
  auditBase.nonce = decoded.nonce.toString();
  if (decoded.macroContract !== body.macroAddress.toLowerCase()) {
    audit(deps, auditBase, "INVALID_CLEAR_MACRO_PAYLOAD", null);
    return {
      error: new ApiError(
        422,
        "INVALID_CLEAR_MACRO_PAYLOAD",
        "Macro mismatch in payload.",
        "user",
        false,
      ),
    };
  }
  if (decoded.provider !== deps.providerName) {
    audit(deps, auditBase, "PROVIDER_NOT_ALLOWED", null);
    return {
      error: new ApiError(
        403,
        "PROVIDER_NOT_ALLOWED",
        "Payload provider does not match deployment provider name.",
        "validation",
        false,
      ),
    };
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (decoded.validBefore !== 0n && decoded.validBefore <= now) {
    audit(deps, auditBase, "CLEAR_MACRO_EXPIRED", null);
    return {
      error: new ApiError(
        422,
        "CLEAR_MACRO_EXPIRED",
        "Request has expired.",
        "user",
        false,
      ),
    };
  }
  if (decoded.validAfter > now) {
    audit(deps, auditBase, "CLEAR_MACRO_NOT_YET_VALID", null);
    return {
      error: new ApiError(
        422,
        "CLEAR_MACRO_NOT_YET_VALID",
        "Request is not valid yet.",
        "user",
        true,
      ),
    };
  }

  const macroPolicy = assertMacroAllowed(deps.registry, {
    chainId: body.chainId,
    domain: decoded.domain,
    macroAddress: body.macroAddress,
  });
  if (!macroPolicy.ok) {
    audit(deps, auditBase, "MACRO_NOT_ALLOWED", null);
    return {
      error: new ApiError(
        403,
        macroPolicy.code,
        macroPolicy.message,
        "validation",
        false,
      ),
    };
  }

  const readiness = await deps.getChainReadiness(body.chainId);
  if (!readiness.ready) {
    audit(deps, auditBase, "READINESS_UNAVAILABLE", null);
    const category =
      readiness.reasonCode === "RELAYER_RATE_LIMITED" ? "relayer" : "provider";
    return {
      error: new ApiError(
        503,
        readiness.reasonCode ?? "PROVIDER_NOT_READY",
        "Requested chain is not ready.",
        category,
        true,
      ),
    };
  }

  const ozRelayerId = deps.registry.relayerIdByChainId.get(body.chainId);
  if (!ozRelayerId) {
    audit(deps, auditBase, "READINESS_UNAVAILABLE", null);
    return {
      error: new ApiError(
        503,
        "RELAYER_UNAVAILABLE",
        "Relayer is not bound for this chain.",
        "relayer",
        true,
      ),
    };
  }

  let relayerSigner: string;
  try {
    const relayerDetails = await deps.relayerClient.getRelayer(ozRelayerId);
    relayerSigner = relayerDetails.address;
  } catch {
    audit(deps, auditBase, "READINESS_UNAVAILABLE", null);
    return {
      error: new ApiError(
        503,
        "RELAYER_UNAVAILABLE",
        "Unable to load relayer signer for preflight.",
        "relayer",
        true,
      ),
    };
  }

  const requiredConfirmations =
    deps.registry.requiredConfirmationsByChainId.get(body.chainId);
  if (requiredConfirmations === undefined) {
    audit(deps, auditBase, "READINESS_UNAVAILABLE", null);
    return {
      error: new ApiError(
        503,
        "RELAYER_UNAVAILABLE",
        "Relayer finality policy is not bound for this chain.",
        "relayer",
        true,
      ),
    };
  }

  return {
    clientId,
    body,
    auditBase,
    chainConfig,
    forwarderAddress,
    decoded,
    metadata,
    ozRelayerId,
    relayerSigner,
    requiredConfirmations,
  };
}

async function persistExecution(
  deps: AdmitDeps,
  ctx: SharedAdmissionContext,
  digest: string,
  createRow: () => RelayExecutionRow,
): Promise<AdmitRelayExecutionResult> {
  try {
    const inserted = createRow();
    audit(deps, ctx.auditBase, "CREATED", inserted.id, digest);
    deps.executionEvents.append({
      executionId: inserted.id,
      type: "state_changed",
      actor: "api",
      reason:
        inserted.state === "awaiting_authorization"
          ? "Execution created awaiting Safe message authorization"
          : "Execution created after synchronous validation",
      detailsJson: JSON.stringify({
        chainId: inserted.chainId,
        kind: inserted.kind,
        state: inserted.state,
      }),
    });
    return { statusCode: 202, row: inserted };
  } catch (error) {
    if (isSqliteUniqueConstraint(error)) {
      const raced = deps.executions.findByDedupKey(
        ctx.body.chainId,
        ctx.forwarderAddress,
        ctx.body.signerAddress.toLowerCase(),
        digest,
      );
      if (raced) {
        if (raced.clientId === ctx.clientId) {
          audit(deps, ctx.auditBase, "DUPLICATE_REPLAYED", raced.id, digest);
          return { statusCode: 200, row: raced };
        }
        audit(deps, ctx.auditBase, "DUPLICATE_HIDDEN", null, digest);
        return {
          error: new ApiError(
            409,
            "DUPLICATE_EXECUTION",
            "A matching execution already exists for another caller.",
            "validation",
            false,
            null,
          ),
        };
      }
    }
    throw error;
  }
}

function replayOrConflict(
  deps: AdmitDeps,
  ctx: SharedAdmissionContext,
  digest: string,
  existing: RelayExecutionRow,
): AdmitRelayExecutionResult {
  if (existing.clientId === ctx.clientId) {
    audit(deps, ctx.auditBase, "DUPLICATE_REPLAYED", existing.id, digest);
    return { statusCode: 200, row: existing };
  }
  audit(deps, ctx.auditBase, "DUPLICATE_HIDDEN", null, digest);
  return {
    error: new ApiError(
      409,
      "DUPLICATE_EXECUTION",
      "A matching execution already exists for another caller.",
      "validation",
      false,
      null,
    ),
  };
}

function applyPreflightOutcome(
  deps: AdmitDeps,
  ctx: SharedAdmissionContext,
  digest: string,
  preflightResult: PreflightResult,
): PreflightOutcome {
  if (preflightResult === "rpc_unavailable") {
    audit(deps, ctx.auditBase, "CHAIN_UNAVAILABLE", null, digest);
    return {
      error: new ApiError(
        503,
        "CHAIN_UNAVAILABLE",
        "Unable to run preflight simulation on app RPCs.",
        "chain",
        true,
      ),
    };
  }
  const forceRequested = ctx.body.forceExecuteAfterPreflightRevert === true;
  if (preflightResult === "deterministic_revert" && !forceRequested) {
    audit(deps, ctx.auditBase, "PREFLIGHT_REVERTED", null, digest);
    return {
      error: new ApiError(
        422,
        "PREFLIGHT_REVERTED",
        "Preflight simulation predicts revert.",
        "user",
        false,
      ),
    };
  }
  const metadata = { ...ctx.metadata };
  if (preflightResult === "deterministic_revert" && forceRequested) {
    metadata.forceSubmittedAfterPreflightRevert = "true";
  }
  return {
    metadata,
    forceAfterPreflightRevert:
      preflightResult === "deterministic_revert" && forceRequested ? 1 : 0,
  };
}

async function validateDigestSignature(
  deps: AdmitDeps,
  ctx: SharedAdmissionContext,
  digest: string,
  signature: string,
  messages: {
    unavailable: string;
    invalid: string;
  },
): Promise<ApiError | null> {
  let validSignature: boolean;
  try {
    validSignature = await deps.validateRelaySignature({
      chainId: ctx.body.chainId,
      signer: ctx.body.signerAddress.toLowerCase(),
      digest,
      signature,
    });
  } catch {
    audit(deps, ctx.auditBase, "CHAIN_UNAVAILABLE", null, digest);
    return new ApiError(
      503,
      "CHAIN_UNAVAILABLE",
      messages.unavailable,
      "chain",
      true,
    );
  }
  if (!validSignature) {
    audit(deps, ctx.auditBase, "SIGNATURE_INVALID", null, digest);
    return new ApiError(
      422,
      "SIGNATURE_INVALID",
      messages.invalid,
      "user",
      false,
    );
  }
  return null;
}

function persistCreatedExecution(
  deps: AdmitDeps,
  ctx: SharedAdmissionContext,
  digest: string,
  input: {
    signature: string | null;
    permit2Json: string | null;
    preflightOutcome?: SuccessfulPreflightOutcome;
    authorization?: {
      type: "safeMessageV1";
      safeMessageHash: string;
    };
  },
): Promise<AdmitRelayExecutionResult> {
  if (input.authorization) {
    const authorization = input.authorization;
    return persistExecution(deps, ctx, digest, () =>
      deps.executions.createAwaitingAuthorization({
        clientId: ctx.clientId,
        clientRequestId: ctx.body.clientRequestId ?? null,
        requestBodyHash: ctx.auditBase.requestBodyHash,
        digest,
        domain: ctx.decoded.domain,
        kind: ctx.body.kind,
        chainId: ctx.body.chainId,
        ozRelayerId: ctx.ozRelayerId,
        forwarderAddress: ctx.forwarderAddress,
        macroAddress: ctx.body.macroAddress.toLowerCase(),
        signerAddress: ctx.body.signerAddress.toLowerCase(),
        nonce: ctx.decoded.nonce.toString(),
        validAfter: ctx.decoded.validAfter.toString(),
        validBefore: ctx.decoded.validBefore.toString(),
        value: ctx.body.value ?? "0",
        payload: ctx.body.payload,
        signature: input.signature,
        permit2Json: input.permit2Json,
        metadataJson: JSON.stringify(ctx.metadata),
        forceAfterPreflightRevert: 0,
        requiredConfirmations: ctx.requiredConfirmations,
        authorizationType: authorization.type,
        safeMessageHash: authorization.safeMessageHash,
      }),
    );
  }
  const preflightOutcome = input.preflightOutcome;
  if (!input.signature || !preflightOutcome) {
    throw new Error("persistCreatedExecution requires signature and preflight for pending rows");
  }
  return persistExecution(deps, ctx, digest, () =>
    deps.executions.createPending({
      clientId: ctx.clientId,
      clientRequestId: ctx.body.clientRequestId ?? null,
      requestBodyHash: ctx.auditBase.requestBodyHash,
      digest,
      domain: ctx.decoded.domain,
      kind: ctx.body.kind,
      chainId: ctx.body.chainId,
      ozRelayerId: ctx.ozRelayerId,
      forwarderAddress: ctx.forwarderAddress,
      macroAddress: ctx.body.macroAddress.toLowerCase(),
      signerAddress: ctx.body.signerAddress.toLowerCase(),
      nonce: ctx.decoded.nonce.toString(),
      validAfter: ctx.decoded.validAfter.toString(),
      validBefore: ctx.decoded.validBefore.toString(),
      value: ctx.body.value ?? "0",
      payload: ctx.body.payload,
      signature: input.signature,
      permit2Json: input.permit2Json,
      metadataJson: JSON.stringify(preflightOutcome.metadata),
      forceAfterPreflightRevert: preflightOutcome.forceAfterPreflightRevert,
      requiredConfirmations: ctx.requiredConfirmations,
    }),
  );
}

async function admitClearMacroV1(
  deps: AdmitDeps,
  ctx: SharedAdmissionContext,
): Promise<AdmitRelayExecutionResult> {
  let digest: string;
  try {
    digest = await deps.getForwarderDigest({
      chainId: ctx.body.chainId,
      forwarder: ctx.forwarderAddress,
      macro: ctx.body.macroAddress.toLowerCase(),
      encodedPayload: ctx.body.payload,
    });
  } catch {
    audit(deps, ctx.auditBase, "CHAIN_UNAVAILABLE", null);
    return {
      error: new ApiError(
        503,
        "CHAIN_UNAVAILABLE",
        "Unable to read ClearMacro digest from app RPCs.",
        "chain",
        true,
      ),
    };
  }
  ctx.auditBase.digest = digest;

  const existing = deps.executions.findByDedupKey(
    ctx.body.chainId,
    ctx.forwarderAddress,
    ctx.body.signerAddress.toLowerCase(),
    digest,
  );
  if (existing) {
    return replayOrConflict(deps, ctx, digest, existing);
  }

  if (ctx.body.kind !== "clearMacroV1") {
    throw new Error("unexpected kind");
  }

  if (ctx.body.authorization?.type === "safeMessageV1") {
    if (!deps.safeAuthorizationEnabled || !deps.safeClient) {
      audit(deps, ctx.auditBase, "VALIDATION_ERROR", null, digest);
      return {
        error: new ApiError(
          400,
          "VALIDATION_ERROR",
          "Safe message authorization is not enabled for this provider.",
          "validation",
          false,
        ),
      };
    }
    if (!deps.safeClient.isChainSupported(ctx.body.chainId)) {
      audit(deps, ctx.auditBase, "VALIDATION_ERROR", null, digest);
      return {
        error: new ApiError(
          403,
          "CHAIN_NOT_ALLOWED",
          "Safe message authorization is not supported on this chain.",
          "validation",
          false,
        ),
      };
    }
    let bytecode: string | null;
    try {
      bytecode = deps.getSignerBytecode
        ? await deps.getSignerBytecode({
            chainId: ctx.body.chainId,
            address: ctx.body.signerAddress.toLowerCase(),
          })
        : null;
    } catch {
      audit(deps, ctx.auditBase, "CHAIN_UNAVAILABLE", null, digest);
      return {
        error: new ApiError(
          503,
          "CHAIN_UNAVAILABLE",
          "Unable to verify signer contract code.",
          "chain",
          true,
        ),
      };
    }
    if (!bytecode || bytecode === "0x") {
      audit(deps, ctx.auditBase, "VALIDATION_ERROR", null, digest);
      return {
        error: new ApiError(
          422,
          "VALIDATION_ERROR",
          "Safe message authorization requires a contract signer.",
          "user",
          false,
        ),
      };
    }
    try {
      await deps.safeClient.assertEoaOwners(
        ctx.body.signerAddress.toLowerCase(),
        ctx.body.chainId,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Safe owner configuration is unsupported.";
      audit(deps, ctx.auditBase, "VALIDATION_ERROR", null, digest);
      return {
        error: new ApiError(422, "VALIDATION_ERROR", message, "user", false),
      };
    }
    return persistCreatedExecution(deps, ctx, digest, {
      signature: null,
      permit2Json: null,
      authorization: {
        type: "safeMessageV1",
        safeMessageHash: ctx.body.authorization.safeMessageHash,
      },
    });
  }

  const signature = ctx.body.signature;
  if (!signature) {
    audit(deps, ctx.auditBase, "VALIDATION_ERROR", null, digest);
    return {
      error: new ApiError(
        400,
        "VALIDATION_ERROR",
        "clearMacroV1 requests require signature or authorization.",
        "validation",
        false,
      ),
    };
  }

  const signatureError = await validateDigestSignature(
    deps,
    ctx,
    digest,
    signature,
    {
      unavailable: "Unable to validate signature with app RPCs.",
      invalid: "Signature validation failed for digest and signer.",
    },
  );
  if (signatureError) {
    return { error: signatureError };
  }

  const preflightInput: ClearMacroForwarderCall & {
    chain: RegistryChain;
    relayerSigner: string;
    signature: string;
    msgValue: string;
  } = {
    chain: ctx.chainConfig,
    forwarder: ctx.forwarderAddress,
    macro: ctx.body.macroAddress.toLowerCase(),
    encodedPayload: ctx.body.payload,
    signer: ctx.body.signerAddress.toLowerCase(),
    relayerSigner: ctx.relayerSigner,
    signature,
    msgValue: ctx.body.value ?? "0",
  };
  const preflightResult = await deps.preflightRunMacro(preflightInput);
  const preflightOutcome = applyPreflightOutcome(
    deps,
    ctx,
    digest,
    preflightResult,
  );
  if ("error" in preflightOutcome) {
    return preflightOutcome;
  }

  return persistCreatedExecution(deps, ctx, digest, {
    signature,
    permit2Json: null,
    preflightOutcome,
  });
}

function validatePermit2Spender(
  permit2: Permit2RequestInput,
  forwarderAddress: string,
): ApiError | null {
  if (
    isImpliedUpgradeMode(permit2.upgradeSuperToken) &&
    permit2.spender.toLowerCase() !== forwarderAddress.toLowerCase()
  ) {
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      "Implied-upgrade Permit2 requests must use the provider forwarder as spender.",
      "validation",
      false,
    );
  }
  return null;
}

async function admitClearMacroPermit2V1(
  deps: AdmitDeps,
  ctx: SharedAdmissionContext,
): Promise<AdmitRelayExecutionResult> {
  if (ctx.body.kind !== "clearMacroPermit2V1") {
    throw new Error("unexpected kind");
  }

  const spenderError = validatePermit2Spender(
    ctx.body.permit2,
    ctx.forwarderAddress,
  );
  if (spenderError) {
    audit(deps, ctx.auditBase, "VALIDATION_ERROR", null);
    return { error: spenderError };
  }

  const storedPermit2: StoredPermit2Json = normalizePermit2Request(
    ctx.body.permit2,
  );
  const witnessFn = deps.getPermit2WitnessStructHash ?? ((input) =>
    getPermit2WitnessStructHash({
      registry: deps.registry,
      chainId: ctx.body.chainId,
      forwarder: input.forwarder,
      macro: input.macro,
      encodedPayload: input.encodedPayload,
      upgradeSuperToken: input.upgradeSuperToken,
    }));
  const witnessTypeFn = deps.getPermit2WitnessTypeString ?? ((input) =>
    getPermit2WitnessTypeString({
      registry: deps.registry,
      chainId: ctx.body.chainId,
      forwarder: input.forwarder,
      macro: input.macro,
      encodedPayload: input.encodedPayload,
    }));
  const domainFn = deps.getPermit2DomainSeparator ?? getPermit2DomainSeparator;

  let witness: string;
  let witnessTypeString: string;
  let domainSeparator: string;
  try {
    [witness, witnessTypeString, domainSeparator] = await Promise.all([
      witnessFn({
        chainId: ctx.body.chainId,
        forwarder: ctx.forwarderAddress,
        macro: ctx.body.macroAddress.toLowerCase(),
        encodedPayload: ctx.body.payload,
        upgradeSuperToken: storedPermit2.upgradeSuperToken,
      }),
      witnessTypeFn({
        chainId: ctx.body.chainId,
        forwarder: ctx.forwarderAddress,
        macro: ctx.body.macroAddress.toLowerCase(),
        encodedPayload: ctx.body.payload,
      }),
      domainFn(ctx.chainConfig),
    ]);
  } catch {
    audit(deps, ctx.auditBase, "CHAIN_UNAVAILABLE", null);
    return {
      error: new ApiError(
        503,
        "CHAIN_UNAVAILABLE",
        "Unable to derive Permit2 witness fields from app RPCs.",
        "chain",
        true,
      ),
    };
  }

  const digest = computePermit2Digest({
    permit2: storedPermit2,
    owner: ctx.body.signerAddress.toLowerCase(),
    witness: witness as `0x${string}`,
    witnessTypeString,
    domainSeparator: domainSeparator as `0x${string}`,
  });
  ctx.auditBase.digest = digest;

  const existing = deps.executions.findByDedupKey(
    ctx.body.chainId,
    ctx.forwarderAddress,
    ctx.body.signerAddress.toLowerCase(),
    digest,
  );
  if (existing) {
    return replayOrConflict(deps, ctx, digest, existing);
  }

  const signatureError = await validateDigestSignature(
    deps,
    ctx,
    digest,
    storedPermit2.signature,
    {
      unavailable: "Unable to validate Permit2 signature with app RPCs.",
      invalid: "Signature validation failed for Permit2 digest and signer.",
    },
  );
  if (signatureError) {
    return { error: signatureError };
  }

  const permit2Context = buildPermit2Context({
    permit2: storedPermit2,
    owner: ctx.body.signerAddress.toLowerCase(),
    witness: witness as `0x${string}`,
    witnessTypeString,
  });

  const preflightFn = deps.preflightRunPermit2AndMacro ?? preflightRunPermit2AndMacro;
  const preflightResult = await preflightFn({
    chain: ctx.chainConfig,
    forwarder: ctx.forwarderAddress,
    macro: ctx.body.macroAddress.toLowerCase(),
    encodedPayload: ctx.body.payload,
    relayerSigner: ctx.relayerSigner,
    permit2Context,
    msgValue: ctx.body.value ?? "0",
  });
  const preflightOutcome = applyPreflightOutcome(
    deps,
    ctx,
    digest,
    preflightResult,
  );
  if ("error" in preflightOutcome) {
    return preflightOutcome;
  }

  return persistCreatedExecution(deps, ctx, digest, {
    signature: storedPermit2.signature,
    permit2Json: JSON.stringify(storedPermit2),
    preflightOutcome,
  });
}

export async function admitRelayExecution(
  deps: RegisterRoutesDeps,
  body: CreateRelayExecutionBody,
  clientId: string,
): Promise<AdmitRelayExecutionResult> {
  const admitDeps: AdmitDeps = {
    ...deps,
    preflightRunMacro: deps.preflightRunMacro ?? preflightRunMacro,
  };
  const shared = await validateSharedAdmission(admitDeps, body, clientId);
  if ("error" in shared) {
    recordActionableFailure(deps.metrics, {
      chainId: body.chainId,
      stage: "admission",
      code: shared.error.code,
    });
    return shared;
  }
  let result: AdmitRelayExecutionResult;
  if (body.kind === "clearMacroV1") {
    result = await admitClearMacroV1(admitDeps, shared);
  } else {
    result = await admitClearMacroPermit2V1(admitDeps, shared);
  }
  if ("error" in result) {
    recordActionableFailure(deps.metrics, {
      chainId: body.chainId,
      stage: "admission",
      code: result.error.code,
    });
  }
  return result;
}

export function finalizeCreatedExecution(
  deps: Pick<RegisterRoutesDeps, "executions" | "relayerTransactions" | "metrics">,
  row: RelayExecutionRow,
): RelayExecutionRow {
  const relayer = deps.relayerTransactions.getByExecutionId(row.id);
  if (!relayer) {
    return row;
  }
  // Re-read: worker may have terminalized between admit replay and finalization.
  const current = deps.executions.getByIdOrThrow(row.id);
  if (isTerminalState(current.state)) {
    return current;
  }
  const projection = projectRelayerState({
    status: relayer.status,
    statusReason: relayer.statusReason,
    hash: relayer.txHash,
    confirmedAt: relayer.confirmedAt,
    receipt: current.receiptJson ? JSON.parse(current.receiptJson) : null,
    requiredConfirmations: current.requiredConfirmations,
  });
  if (projection.state === current.state) {
    return current;
  }
  const updated = deps.executions.transitionState(
    current.id,
    projection.state,
    projection.error ? { errorJson: JSON.stringify(projection.error) } : undefined,
  );
  // Duplicate/recovery path can terminalize without the worker poll loop; page the same codes.
  if (projection.state === "failed" && projection.error?.code === "RELAYER_FAILED") {
    recordActionableFailure(deps.metrics, {
      chainId: current.chainId,
      stage: "worker_poll",
      code: "RELAYER_FAILED",
    });
  }
  return updated;
}
