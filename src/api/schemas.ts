import { Type } from "@sinclair/typebox";

const Address = Type.String({
  pattern: "^0x[0-9a-fA-F]{40}$",
  description: "EVM address.",
});
const Bytes = Type.String({
  pattern: "^0x([0-9a-fA-F]{2})*$",
  description: "Hex-encoded bytes.",
});
const UintString = Type.String({
  pattern: "^[0-9]+$",
  description: "Unsigned integer encoded as a base-10 string.",
});
const Bytes32 = Type.String({
  pattern: "^0x[0-9a-fA-F]{64}$",
  description: "32-byte hex value.",
});

export const HealthzResponseSchema = Type.Object({
  ok: Type.Boolean({ description: "True when the HTTP process is running." }),
});

export const ReadyzResponseSchema = Type.Object({
  ready: Type.Boolean({
    description:
      "True when every configured chain is ready for relay execution creation.",
  }),
  chains: Type.Array(
    Type.Object({
      chainId: Type.Integer({
        minimum: 1,
        description: "Configured EVM chain ID.",
      }),
      ready: Type.Boolean({ description: "Whether this chain is ready." }),
      reasonCode: Type.Union(
        [
          Type.Literal("PROVIDER_NOT_READY"),
          Type.Literal("RELAYER_UNAVAILABLE"),
          Type.Literal("RELAYER_RATE_LIMITED"),
          Type.Null(),
        ],
        {
          description:
            "Machine-readable reason when this chain is not ready, or null when ready.",
        },
      ),
    }),
  ),
});

const SharedCreateRelayFields = {
  chainId: Type.Integer({
    minimum: 1,
    description:
      "EVM chain ID for the ClearMacro payload and configured provider forwarder.",
  }),
  macroAddress: Type.Unsafe<typeof Address>({
    ...Address,
    description:
      "ClearMacro contract address. Must match `payload.security.macroContract` after decoding.",
  }),
  signerAddress: Type.Unsafe<typeof Address>({
    ...Address,
    description:
      "Address that signed the relay authorization. EOAs and ERC-1271 contract signers are supported.",
  }),
  payload: Type.Unsafe<typeof Bytes>({
    ...Bytes,
    description:
      "ABI-encoded `IClearMacroForwarderV1.Payload` (`encodedPayload` onchain). The provider decodes it to validate macro contract, provider name, domain, nonce, and validity window.",
  }),
  value: Type.Optional(
    Type.Unsafe<typeof UintString>({
      ...UintString,
      description:
        "Native token value to pass to the forwarder call, as a base-10 string. Defaults to `0` when omitted. Non-zero values are rejected unless the provider sets `RELAYER_NATIVE_VALUE_ENABLED=true`.",
    }),
  ),
  forceExecuteAfterPreflightRevert: Type.Optional(
    Type.Boolean({
      description:
        "When true, a deterministic preflight revert can still create a pending execution. This does not bypass auth, policy, signature, validity, readiness, or payload validation.",
    }),
  ),
  clientRequestId: Type.Optional(
    Type.String({
      description:
        "Optional dapp correlation ID. It is echoed on the execution resource but is not used for deduplication.",
    }),
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Optional dapp-provided correlation data. Do not include secrets.",
    }),
  ),
};

const Permit2RequestSchema = Type.Object(
  {
    permit: Type.Object(
      {
        permitted: Type.Object(
          {
            token: Type.Unsafe<typeof Address>({ ...Address }),
            amount: Type.Unsafe<typeof UintString>({ ...UintString }),
          },
          { additionalProperties: false },
        ),
        nonce: Type.Unsafe<typeof UintString>({ ...UintString }),
        deadline: Type.Unsafe<typeof UintString>({ ...UintString }),
      },
      { additionalProperties: false },
    ),
    spender: Type.Unsafe<typeof Address>({ ...Address }),
    upgradeSuperToken: Type.Unsafe<typeof Address>({
      ...Address,
      description:
        "Wrapper SuperToken for implied upgrade, or the zero address for witness-only mode.",
    }),
    signature: Type.Unsafe<typeof Bytes>({
      ...Bytes,
      description: "Permit2 witness-transfer signature authorizing the relay.",
    }),
  },
  { additionalProperties: false },
);

export const CreateRelayExecutionRequestSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("clearMacroV1", {
        description: "Relay via `runMacro` with a ClearMacro digest signature.",
      }),
      ...SharedCreateRelayFields,
      signature: Type.Optional(
        Type.Unsafe<typeof Bytes>({
          ...Bytes,
          description:
            "Signature over `ClearMacroForwarderV1.getDigest(m, encodedPayload)`; request `macroAddress` is the macro contract (`m`).",
        }),
      ),
      authorization: Type.Optional(
        Type.Object(
          {
            type: Type.Literal("safeMessageV1", {
              description:
                "Authorize via Safe Message; provider polls until ERC-1271 validates the ClearMacro digest.",
            }),
            safeMessageHash: Type.Unsafe<typeof Bytes32>({
              ...Bytes32,
              description: "Safe Transaction Service message hash for the proposed EIP-712 payload.",
            }),
          },
          { additionalProperties: false },
        ),
      ),
    },
    {
      additionalProperties: false,
      examples: [
        {
          kind: "clearMacroV1",
          chainId: 11155420,
          macroAddress: "0x1111111111111111111111111111111111111111",
          signerAddress: "0x2222222222222222222222222222222222222222",
          payload: "0x1234",
          signature: "0xabcdef",
          value: "0",
        },
      ],
    },
  ),
  Type.Object(
    {
      kind: Type.Literal("clearMacroPermit2V1", {
        description:
          "Relay via `runPermit2AndMacro` with a Permit2 witness signature.",
      }),
      ...SharedCreateRelayFields,
      permit2: Permit2RequestSchema,
    },
    {
      additionalProperties: false,
      examples: [
        {
          kind: "clearMacroPermit2V1",
          chainId: 11155420,
          macroAddress: "0x1111111111111111111111111111111111111111",
          signerAddress: "0x2222222222222222222222222222222222222222",
          payload: "0x1234",
          permit2: {
            permit: {
              permitted: {
                token: "0x3333333333333333333333333333333333333333",
                amount: "1000000",
              },
              nonce: "123",
              deadline: "1760000000",
            },
            spender: "0x4444444444444444444444444444444444444444",
            upgradeSuperToken: "0x5555555555555555555555555555555555555555",
            signature: "0xabcdef",
          },
          value: "0",
        },
      ],
    },
  ),
]);

const RelayExecutionErrorSchema = Type.Object({
  code: Type.String({ description: "Machine-readable error code." }),
  message: Type.String({ description: "Human-readable error summary." }),
  category: Type.Union(
    [
      Type.Literal("user"),
      Type.Literal("provider"),
      Type.Literal("chain"),
      Type.Literal("relayer"),
      Type.Literal("unknown"),
    ],
    { description: "Error source category." },
  ),
  retryable: Type.Boolean({
    description: "Whether retrying the same request may succeed.",
  }),
});

const RelayExecutionReceiptSchema = Type.Object({
  transactionHash: Bytes32,
  blockNumber: Type.Unsafe<typeof UintString>({
    ...UintString,
    description:
      "Block number containing the transaction, as a decimal string.",
  }),
  blockHash: Type.Optional(Bytes32),
  status: Type.Union([Type.Literal("success"), Type.Literal("reverted")], {
    description: "Normalized onchain receipt outcome.",
  }),
  gasUsed: Type.Optional(
    Type.Unsafe<typeof UintString>({
      ...UintString,
      description: "Gas used by the transaction, as a decimal string.",
    }),
  ),
});

const RelayExecutionTransactionSchema = Type.Object({
  hash: Type.Unsafe<typeof Bytes32>({
    ...Bytes32,
    description:
      "Current EVM transaction hash. This may change before the execution is terminal.",
  }),
  from: Type.Optional(Address),
  to: Type.Unsafe<typeof Address>({
    ...Address,
    description: "Resolved ClearMacro forwarder address.",
  }),
  submittedAt: Type.Optional(
    Type.String({ description: "Relayer submission timestamp when known." }),
  ),
});

const RelayExecutionStateSchema = Type.Union(
  [
    Type.Literal("awaiting_authorization"),
    Type.Literal("pending"),
    Type.Literal("submitted"),
    Type.Literal("succeeded"),
    Type.Literal("reverted"),
    Type.Literal("rejected"),
    Type.Literal("failed"),
    Type.Literal("expired"),
    Type.Literal("canceled"),
  ],
  {
    description:
      "`awaiting_authorization` means a Safe message authorization is pending. `pending` means accepted but no current transaction hash is known. `submitted` means a current transaction hash is known. `succeeded`, `reverted`, `rejected`, `failed`, `expired`, and `canceled` are terminal.",
  },
);

const RelayAuthorizationProgressSchema = Type.Object({
  type: Type.Literal("safeMessageV1"),
  safeMessageHash: Bytes32,
  messageLink: Type.Optional(
    Type.String({
      description: "Deep link to review the Safe message in the Safe web app.",
    }),
  ),
});

export const RelayExecutionResponseSchema = Type.Object(
  {
    id: Type.String({
      description:
        "Stable provider execution ID. Dapps should track this ID rather than the EVM transaction hash.",
    }),
    state: RelayExecutionStateSchema,
    terminal: Type.Boolean({
      description: "True when the execution has reached a final public state.",
    }),
    kind: Type.Union(
      [Type.Literal("clearMacroV1"), Type.Literal("clearMacroPermit2V1")],
      { description: "Relay kind." },
    ),
    chainId: Type.Integer({ minimum: 1, description: "EVM chain ID." }),
    clientRequestId: Type.Optional(
      Type.String({
        description:
          "Dapp correlation ID from the create request, when provided.",
      }),
    ),
    metadata: Type.Record(Type.String(), Type.String(), {
      description: "Dapp-provided metadata echoed from the create request.",
    }),
    forwarderAddress: Type.Unsafe<typeof Address>({
      ...Address,
      description: "Provider-resolved ClearMacro forwarder for this chain.",
    }),
    macroAddress: Type.Unsafe<typeof Address>({
      ...Address,
      description:
        "ClearMacro contract address from the request and decoded payload.",
    }),
    signerAddress: Type.Unsafe<typeof Address>({
      ...Address,
      description: "Address that signed the relay digest.",
    }),
    nonce: Type.Unsafe<typeof UintString>({
      ...UintString,
      description: "Decoded ClearMacro nonce, as a decimal string.",
    }),
    validity: Type.Object({
      validAfter: Type.Unsafe<typeof UintString>({
        ...UintString,
        description:
          "Earliest accepted timestamp from the ClearMacro payload, as Unix seconds.",
      }),
      validBefore: Type.Unsafe<typeof UintString>({
        ...UintString,
        description:
          "Latest accepted timestamp from the ClearMacro payload, as Unix seconds. `0` means no upper bound.",
      }),
    }),
    value: Type.Unsafe<typeof UintString>({
      ...UintString,
      description:
        "Native token value sent with the relay transaction, as a decimal string.",
    }),
    transaction: Type.Optional(RelayExecutionTransactionSchema),
    receipt: Type.Optional(RelayExecutionReceiptSchema),
    error: Type.Optional(RelayExecutionErrorSchema),
    authorization: Type.Optional(RelayAuthorizationProgressSchema),
    timestamps: Type.Object({
      createdAt: Type.String({ description: "Execution creation timestamp." }),
      updatedAt: Type.String({
        description: "Last execution update timestamp.",
      }),
      terminalAt: Type.Optional(
        Type.String({
          description: "Terminal transition timestamp, when terminal.",
        }),
      ),
    }),
    links: Type.Object({
      self: Type.String({
        description: "Relative URL for this execution resource.",
      }),
    }),
  },
  {
    examples: [
      {
        id: "018f4f2d-8f5b-7c48-9b4a-cd9d4f2b8a01",
        state: "pending",
        terminal: false,
        kind: "clearMacroV1",
        chainId: 11155420,
        clientRequestId: "dashboard-transaction-123",
        metadata: { source: "dashboard" },
        forwarderAddress: "0x3333333333333333333333333333333333333333",
        macroAddress: "0x1111111111111111111111111111111111111111",
        signerAddress: "0x2222222222222222222222222222222222222222",
        nonce: "1",
        validity: { validAfter: "0", validBefore: "0" },
        value: "0",
        timestamps: {
          createdAt: "2026-05-14T17:00:00.000Z",
          updatedAt: "2026-05-14T17:00:00.000Z",
        },
        links: {
          self: "/v1/relay-executions/018f4f2d-8f5b-7c48-9b4a-cd9d4f2b8a01",
        },
      },
    ],
  },
);

export const RelayExecutionEventsResponseSchema = Type.Intersect([
  RelayExecutionResponseSchema,
  Type.Object({
    events: Type.Optional(
      Type.Array(Type.Any(), {
        description:
          "Sanitized lifecycle events. Present only when `include=events` is requested.",
      }),
    ),
  }),
]);

export const CapabilitiesMacroPolicySchema = Type.Union(
  [
    Type.Object(
      {
        mode: Type.Literal("allowlist", {
          description:
            "Only macros listed in `allowedMacros` are accepted for relay admission on this chain.",
        }),
        allowedMacros: Type.Array(
          Type.Object({
            domain: Type.String({
              minLength: 1,
              description:
                "Macro domain from the decoded ClearMacro payload; must match exactly for allowlist mode.",
            }),
            address: Type.Unsafe<typeof Address>({
              ...Address,
              description:
                "Macro contract address; must match `payload.security.macroContract` for allowlist mode.",
            }),
          }),
          {
            minItems: 1,
            description: "Explicit `(domain, address)` pairs this provider relays for the chain.",
          },
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        mode: Type.Literal("open", {
          description:
            "Provider does not enforce a macro allowlist on this chain; relay admission still requires valid payload, signature, readiness, and preflight.",
        }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      "Macro admission policy for the chain, mirroring `macroPolicy` in provider config. Informational only; `POST /v1/relay-executions` enforces policy.",
  },
);

export const CapabilitiesResponseSchema = Type.Object({
  providerName: Type.String({
    description:
      "Deployment-wide provider name that dapps must encode into `payload.security.provider`.",
  }),
  chains: Type.Array(
    Type.Object({
      chainId: Type.Integer({
        minimum: 1,
        description: "Configured EVM chain ID.",
      }),
      forwarderAddress: Type.Unsafe<typeof Address>({
        ...Address,
        description:
          "ClearMacro forwarder address dapps should use when constructing payloads for this chain.",
      }),
      supportedKinds: Type.Array(
        Type.Union([
          Type.Literal("clearMacroV1"),
          Type.Literal("clearMacroPermit2V1"),
        ]),
        {
          description: "Relay kinds supported by this provider on the chain.",
        },
      ),
      supportedAuthorizationMethods: Type.Array(
        Type.Union([Type.Literal("signature"), Type.Literal("safeMessageV1")], {
          description:
            "`signature` is top-level ClearMacro digest auth for `clearMacroV1`. `safeMessageV1` is optional Safe message authorization when enabled for the chain.",
        }),
        {
          minItems: 1,
          description:
            "Authorization methods supported for `clearMacroV1` on this chain. Always includes `signature`; may also include `safeMessageV1`.",
        },
      ),
      macroPolicy: Type.Unsafe<typeof CapabilitiesMacroPolicySchema>({
        ...CapabilitiesMacroPolicySchema,
        description: "Macro admission policy for this chain.",
      }),
    }),
    {
      description:
        "Chains configured for this provider. Relayer internals and RPC URLs are not exposed.",
    },
  ),
});

export const ErrorBodySchema = Type.Object({
  error: Type.Object({
    code: Type.String({
      description:
        "Machine-readable error code such as `VALIDATION_ERROR`, `UNAUTHORIZED`, `CHAIN_NOT_ALLOWED`, `NATIVE_VALUE_NOT_ALLOWED`, `MACRO_NOT_ALLOWED`, `PROVIDER_NOT_ALLOWED`, `DUPLICATE_EXECUTION`, `INVALID_CLEAR_MACRO_PAYLOAD`, `CLEAR_MACRO_EXPIRED`, `CLEAR_MACRO_NOT_YET_VALID`, `SIGNATURE_INVALID`, `PREFLIGHT_REVERTED`, `PROVIDER_NOT_READY`, `RELAYER_UNAVAILABLE`, `RELAYER_RATE_LIMITED`, or `CHAIN_UNAVAILABLE`.",
    }),
    message: Type.String({ description: "Human-readable error summary." }),
    category: Type.Union(
      [
        Type.Literal("user"),
        Type.Literal("provider"),
        Type.Literal("chain"),
        Type.Literal("relayer"),
        Type.Literal("auth"),
        Type.Literal("validation"),
        Type.Literal("unknown"),
      ],
      { description: "Error source category." },
    ),
    retryable: Type.Boolean({
      description: "Whether retrying the same request may succeed.",
    }),
    executionId: Type.Union([Type.String(), Type.Null()], {
      description:
        "Execution ID when one can be safely returned, otherwise null.",
    }),
    details: Type.Record(Type.String(), Type.Any(), {
      description: "Additional structured error details when available.",
    }),
  }),
});
