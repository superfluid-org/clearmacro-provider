import { randomUUID, createHash } from "node:crypto";
import type { DbClient } from "./client.js";
import { assertTransitionState, isTerminalState, type RelayExecutionState } from "../tx/lifecycle.js";
import type { AppMetrics } from "../metrics/metrics.js";
import { recordTerminalTransition } from "../metrics/terminalExecutions.js";

/** Internal placeholder while an OZ submit is in flight; not a real relayer id. */
export const SUBMISSION_CLAIM_PREFIX = "claim:";

export type RelayExecutionError = {
  code: string;
  message: string;
  category: "user" | "provider" | "chain" | "relayer" | "unknown";
  retryable: boolean;
};

export type RelayExecutionReceipt = {
  transactionHash: `0x${string}`;
  blockNumber: string;
  blockHash?: `0x${string}`;
  status: "success" | "reverted";
  gasUsed?: string;
};

export type RelayExecutionRow = {
  id: string;
  clientId: string;
  clientRequestId: string | null;
  requestBodyHash: string;
  digest: string;
  domain: string;
  kind: string;
  state: RelayExecutionState;
  terminal: number;
  chainId: number;
  ozRelayerId: string;
  ozTransactionId: string | null;
  forwarderAddress: string;
  macroAddress: string;
  signerAddress: string;
  nonce: string;
  validAfter: string;
  validBefore: string;
  value: string;
  payload: string;
  signature: string | null;
  permit2Json: string | null;
  metadataJson: string;
  forceAfterPreflightRevert: number;
  authorizationType: string | null;
  safeMessageHash: string | null;
  authorizationPollAt: string | null;
  authorizationPollAttempts: number;
  authorizationLastErrorJson: string | null;
  signatureSource: string | null;
  currentTransactionHash: string | null;
  transactionHashesJson: string;
  receiptJson: string | null;
  requiredConfirmations: number | null;
  lastErrorJson: string | null;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
};

export type NewRelayExecution = Omit<
  RelayExecutionRow,
  | "id"
  | "state"
  | "terminal"
  | "ozTransactionId"
  | "currentTransactionHash"
  | "transactionHashesJson"
  | "receiptJson"
  | "lastErrorJson"
  | "createdAt"
  | "updatedAt"
  | "terminalAt"
  | "authorizationType"
  | "safeMessageHash"
  | "authorizationPollAt"
  | "authorizationPollAttempts"
  | "authorizationLastErrorJson"
  | "signatureSource"
> & {
  authorizationType?: string | null;
  safeMessageHash?: string | null;
  authorizationPollAt?: string | null;
  authorizationPollAttempts?: number;
  authorizationLastErrorJson?: string | null;
  signatureSource?: string | null;
};

export type RelayExecutionEvent = {
  id: string;
  executionId: string;
  type: string;
  actor: string;
  reason: string;
  detailsJson: string;
  createdAt: string;
};

export type CreateRequestAuditOutcome =
  | "CREATED"
  | "DUPLICATE_REPLAYED"
  | "DUPLICATE_HIDDEN"
  | "MACRO_NOT_ALLOWED"
  | "PROVIDER_NOT_ALLOWED"
  | "INVALID_CLEAR_MACRO_PAYLOAD"
  | "CLEAR_MACRO_EXPIRED"
  | "CLEAR_MACRO_NOT_YET_VALID"
  | "SIGNATURE_INVALID"
  | "PREFLIGHT_REVERTED"
  | "READINESS_UNAVAILABLE"
  | "CHAIN_UNAVAILABLE"
  | "CHAIN_NOT_ALLOWED"
  | "VALIDATION_ERROR"
  | "NATIVE_VALUE_NOT_ALLOWED";

export type CreateRequestAuditInput = {
  clientId: string;
  requestBodyHash: string;
  outcomeCode: CreateRequestAuditOutcome;
  executionId: string | null;
  chainId: number | null;
  kind: string | null;
  forwarderAddress: string | null;
  domain: string | null;
  macroAddress: string | null;
  signerAddress: string | null;
  providerName: string | null;
  nonce: string | null;
  digest: string | null;
};

const mapRelayExecution = (row: Record<string, unknown>): RelayExecutionRow => ({
  id: String(row.id),
  clientId: String(row.client_id),
  clientRequestId: row.client_request_id === null ? null : String(row.client_request_id),
  requestBodyHash: String(row.request_body_hash),
  digest: String(row.digest),
  domain: String(row.domain),
  kind: String(row.kind),
  state: String(row.state) as RelayExecutionState,
  terminal: Number(row.terminal),
  chainId: Number(row.chain_id),
  ozRelayerId: String(row.oz_relayer_id),
  ozTransactionId: row.oz_transaction_id === null ? null : String(row.oz_transaction_id),
  forwarderAddress: String(row.forwarder_address),
  macroAddress: String(row.macro_address),
  signerAddress: String(row.signer_address),
  nonce: String(row.nonce),
  validAfter: String(row.valid_after),
  validBefore: String(row.valid_before),
  value: String(row.value),
  payload: String(row.payload),
  signature: row.signature === null ? null : String(row.signature),
  permit2Json: row.permit2_json === null ? null : String(row.permit2_json),
  metadataJson: String(row.metadata_json),
  forceAfterPreflightRevert: Number(row.force_after_preflight_revert),
  authorizationType: row.authorization_type === null ? null : String(row.authorization_type),
  safeMessageHash: row.safe_message_hash === null ? null : String(row.safe_message_hash),
  authorizationPollAt: row.authorization_poll_at === null ? null : String(row.authorization_poll_at),
  authorizationPollAttempts: Number(row.authorization_poll_attempts ?? 0),
  authorizationLastErrorJson:
    row.authorization_last_error_json === null ? null : String(row.authorization_last_error_json),
  signatureSource: row.signature_source === null ? null : String(row.signature_source),
  currentTransactionHash: row.current_transaction_hash === null ? null : String(row.current_transaction_hash),
  transactionHashesJson: String(row.transaction_hashes_json),
  receiptJson: row.receipt_json === null ? null : String(row.receipt_json),
  requiredConfirmations: row.required_confirmations === null ? null : Number(row.required_confirmations),
  lastErrorJson: row.last_error_json === null ? null : String(row.last_error_json),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  terminalAt: row.terminal_at === null ? null : String(row.terminal_at),
});

function nowIso(): string {
  return new Date().toISOString();
}

export class RelayExecutionRepository {
  constructor(
    private readonly client: DbClient,
    private readonly metrics?: Pick<AppMetrics, "executionsTerminalCounter">,
  ) {}

  createPending(input: NewRelayExecution): RelayExecutionRow {
    const timestamp = nowIso();
    const id = randomUUID();
    this.client.db
      .prepare(
        `INSERT INTO relay_executions(
            id, client_id, client_request_id, request_body_hash, digest, domain, kind, state, terminal,
            chain_id, oz_relayer_id, oz_transaction_id, forwarder_address, macro_address, signer_address, nonce,
            valid_after, valid_before, value, payload, signature, permit2_json, metadata_json, force_after_preflight_revert,
            authorization_type, safe_message_hash, authorization_poll_at, authorization_poll_attempts,
            authorization_last_error_json, signature_source,
            current_transaction_hash, transaction_hashes_json, receipt_json,
            required_confirmations, last_error_json, created_at, updated_at, terminal_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, '[]', NULL, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        id,
        input.clientId,
        input.clientRequestId,
        input.requestBodyHash,
        input.digest,
        input.domain,
        input.kind,
        input.chainId,
        input.ozRelayerId,
        input.forwarderAddress,
        input.macroAddress,
        input.signerAddress,
        input.nonce,
        input.validAfter,
        input.validBefore,
        input.value,
        input.payload,
        input.signature,
        input.permit2Json,
        input.metadataJson,
        input.forceAfterPreflightRevert,
        input.requiredConfirmations,
        timestamp,
        timestamp,
      );
    return this.getByIdOrThrow(id);
  }

  createAwaitingAuthorization(
    input: NewRelayExecution & {
      authorizationType: "safeMessageV1";
      safeMessageHash: string;
    },
  ): RelayExecutionRow {
    const timestamp = nowIso();
    const id = randomUUID();
    this.client.db
      .prepare(
        `INSERT INTO relay_executions(
            id, client_id, client_request_id, request_body_hash, digest, domain, kind, state, terminal,
            chain_id, oz_relayer_id, oz_transaction_id, forwarder_address, macro_address, signer_address, nonce,
            valid_after, valid_before, value, payload, signature, permit2_json, metadata_json, force_after_preflight_revert,
            authorization_type, safe_message_hash, authorization_poll_at, authorization_poll_attempts,
            authorization_last_error_json, signature_source,
            current_transaction_hash, transaction_hashes_json, receipt_json,
            required_confirmations, last_error_json, created_at, updated_at, terminal_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_authorization', 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, '[]', NULL, ?, NULL, ?, ?, NULL)`,
      )
      .run(
        id,
        input.clientId,
        input.clientRequestId,
        input.requestBodyHash,
        input.digest,
        input.domain,
        input.kind,
        input.chainId,
        input.ozRelayerId,
        input.forwarderAddress,
        input.macroAddress,
        input.signerAddress,
        input.nonce,
        input.validAfter,
        input.validBefore,
        input.value,
        input.payload,
        input.permit2Json,
        input.metadataJson,
        input.forceAfterPreflightRevert,
        input.authorizationType,
        input.safeMessageHash,
        timestamp,
        input.requiredConfirmations,
        timestamp,
        timestamp,
      );
    return this.getByIdOrThrow(id);
  }

  listAwaitingAuthorizationDue(limit: number, nowIsoValue = nowIso()): RelayExecutionRow[] {
    const rows = this.client.db
      .prepare(
        `SELECT * FROM relay_executions
         WHERE terminal = 0 AND state = 'awaiting_authorization'
           AND (authorization_poll_at IS NULL OR authorization_poll_at <= ?)
         ORDER BY authorization_poll_at ASC, created_at ASC
         LIMIT ?`,
      )
      .all(nowIsoValue, limit) as Record<string, unknown>[];
    return rows.map(mapRelayExecution);
  }

  scheduleAuthorizationPoll(
    executionId: string,
    input: {
      pollAt: string;
      pollAttempts: number;
      lastErrorJson?: string | null;
    },
  ): RelayExecutionRow {
    this.client.db
      .prepare(
        `UPDATE relay_executions
         SET authorization_poll_at = ?, authorization_poll_attempts = ?,
             authorization_last_error_json = COALESCE(?, authorization_last_error_json),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.pollAt,
        input.pollAttempts,
        input.lastErrorJson ?? null,
        nowIso(),
        executionId,
      );
    return this.getByIdOrThrow(executionId);
  }

  promoteToPending(
    executionId: string,
    input: { signature: string; signatureSource: string; forceAfterPreflightRevert: number },
  ): RelayExecutionRow {
    return this.client.transaction(() => {
      const existing = this.getByIdOrThrow(executionId);
      if (existing.state !== "awaiting_authorization") {
        throw new Error(`Cannot promote execution ${executionId} from state ${existing.state}`);
      }
      assertTransitionState("awaiting_authorization", "pending");
      const timestamp = nowIso();
      this.client.db
        .prepare(
          `UPDATE relay_executions
           SET state = 'pending', signature = ?, signature_source = ?, force_after_preflight_revert = ?,
               authorization_poll_at = NULL, updated_at = ?
           WHERE id = ? AND state = 'awaiting_authorization'`,
        )
        .run(
          input.signature,
          input.signatureSource,
          input.forceAfterPreflightRevert,
          timestamp,
          executionId,
        );
      return this.getByIdOrThrow(executionId);
    });
  }

  getById(id: string): RelayExecutionRow | undefined {
    const row = this.client.db.prepare("SELECT * FROM relay_executions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapRelayExecution(row) : undefined;
  }

  getByIdOrThrow(id: string): RelayExecutionRow {
    const row = this.getById(id);
    if (!row) {
      throw new Error(`Execution not found: ${id}`);
    }
    return row;
  }

  findByDedupKey(chainId: number, forwarderAddress: string, signerAddress: string, digest: string): RelayExecutionRow | undefined {
    const row = this.client.db
      .prepare("SELECT * FROM relay_executions WHERE chain_id = ? AND forwarder_address = ? AND signer_address = ? AND digest = ?")
      .get(chainId, forwarderAddress.toLowerCase(), signerAddress.toLowerCase(), digest) as Record<string, unknown> | undefined;
    return row ? mapRelayExecution(row) : undefined;
  }

  listSubmittable(limit: number): RelayExecutionRow[] {
    const rows = this.client.db
      .prepare(
        "SELECT * FROM relay_executions WHERE terminal = 0 AND oz_transaction_id IS NULL AND state = 'pending' ORDER BY created_at ASC LIMIT ?",
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapRelayExecution);
  }

  listPollable(limit: number): RelayExecutionRow[] {
    const rows = this.client.db
      .prepare(
        `SELECT * FROM relay_executions
         WHERE terminal = 0
           AND oz_transaction_id IS NOT NULL
           AND oz_transaction_id NOT LIKE ?
           AND state IN ('pending','submitted')
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(`${SUBMISSION_CLAIM_PREFIX}%`, limit) as Record<string, unknown>[];
    return rows.map(mapRelayExecution);
  }

  /**
   * Atomically cancel a pre-submit execution. Returns null when another actor
   * already claimed submission or terminalized the row.
   */
  tryClientCancel(executionId: string, errorJson: string): RelayExecutionRow | null {
    let shouldRecordTerminal = false;
    const updated = this.client.transaction(() => {
      const timestamp = nowIso();
      const result = this.client.db
        .prepare(
          `UPDATE relay_executions
           SET state = 'canceled', terminal = 1, updated_at = ?, terminal_at = COALESCE(terminal_at, ?),
               last_error_json = COALESCE(?, last_error_json)
           WHERE id = ?
             AND terminal = 0
             AND oz_transaction_id IS NULL
             AND state IN ('awaiting_authorization', 'pending')`,
        )
        .run(timestamp, timestamp, errorJson, executionId);
      if (result.changes === 0) {
        return null;
      }
      shouldRecordTerminal = true;
      return this.getByIdOrThrow(executionId);
    });
    if (shouldRecordTerminal && updated) {
      recordTerminalTransition(this.metrics, updated);
    }
    return updated;
  }

  /** Claim a pending row immediately before OZ submit so DELETE cannot race it. */
  claimForSubmission(executionId: string): boolean {
    const timestamp = nowIso();
    const claimId = `${SUBMISSION_CLAIM_PREFIX}${randomUUID()}`;
    const result = this.client.db
      .prepare(
        `UPDATE relay_executions
         SET oz_transaction_id = ?, updated_at = ?
         WHERE id = ?
           AND terminal = 0
           AND state = 'pending'
           AND oz_transaction_id IS NULL`,
      )
      .run(claimId, timestamp, executionId);
    return result.changes === 1;
  }

  releaseSubmissionClaim(executionId: string): void {
    const timestamp = nowIso();
    this.client.db
      .prepare(
        `UPDATE relay_executions
         SET oz_transaction_id = NULL, updated_at = ?
         WHERE id = ?
           AND terminal = 0
           AND state = 'pending'
           AND oz_transaction_id LIKE ?`,
      )
      .run(timestamp, executionId, `${SUBMISSION_CLAIM_PREFIX}%`);
  }

  getOldestNonterminalCreatedAt(chainId: number, state: RelayExecutionState): string | null {
    const row = this.client.db
      .prepare(
        `SELECT MIN(created_at) AS oldest_created_at
         FROM relay_executions
         WHERE terminal = 0 AND chain_id = ? AND state = ?`,
      )
      .get(chainId, state) as { oldest_created_at: string | null } | undefined;
    return row?.oldest_created_at ?? null;
  }

  transitionState(executionId: string, toState: RelayExecutionState, options?: { errorJson?: string; ozTransactionId?: string }): RelayExecutionRow {
    let shouldRecordTerminal = false;
    const updated = this.client.transaction(() => {
      const existing = this.getByIdOrThrow(executionId);
      assertTransitionState(existing.state, toState);
      const wasTerminal = isTerminalState(existing.state);
      const terminal = isTerminalState(toState) ? 1 : 0;
      const timestamp = nowIso();
      const terminalAt = terminal ? timestamp : null;
      this.client.db
        .prepare(
          `UPDATE relay_executions
           SET state = ?, terminal = ?, updated_at = ?, terminal_at = COALESCE(terminal_at, ?),
               oz_transaction_id = COALESCE(?, oz_transaction_id),
               last_error_json = COALESCE(?, last_error_json)
           WHERE id = ?`,
        )
        .run(toState, terminal, timestamp, terminalAt, options?.ozTransactionId ?? null, options?.errorJson ?? null, executionId);
      const next = this.getByIdOrThrow(executionId);
      shouldRecordTerminal = !wasTerminal && isTerminalState(toState);
      return next;
    });
    // Increment only after COMMIT so a rolled-back transition cannot leave a phantom sample.
    if (shouldRecordTerminal) {
      recordTerminalTransition(this.metrics, updated);
    }
    return updated;
  }

  updateMetadata(
    executionId: string,
    updates: {
      ozTransactionId?: string;
      currentTransactionHash?: `0x${string}`;
      transactionHashes?: `0x${string}`[];
      receipt?: RelayExecutionReceipt;
      error?: RelayExecutionError;
    },
  ): RelayExecutionRow {
    const existing = this.getByIdOrThrow(executionId);
    const nextHashes = updates.transactionHashes ? JSON.stringify(updates.transactionHashes) : existing.transactionHashesJson;
    const nextReceipt = updates.receipt ? JSON.stringify(updates.receipt) : existing.receiptJson;
    const nextError = updates.error ? JSON.stringify(updates.error) : existing.lastErrorJson;
    this.client.db
      .prepare(
        `UPDATE relay_executions
         SET oz_transaction_id = COALESCE(?, oz_transaction_id),
             current_transaction_hash = COALESCE(?, current_transaction_hash),
             transaction_hashes_json = ?,
             receipt_json = ?,
             last_error_json = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        updates.ozTransactionId ?? null,
        updates.currentTransactionHash ?? null,
        nextHashes,
        nextReceipt,
        nextError,
        nowIso(),
        executionId,
      );
    return this.getByIdOrThrow(executionId);
  }

  appendCurrentHashChange(executionId: string, hash: `0x${string}`): RelayExecutionRow {
    const row = this.getByIdOrThrow(executionId);
    const hashes = JSON.parse(row.transactionHashesJson) as `0x${string}`[];
    hashes.push(hash);
    return this.updateMetadata(executionId, {
      currentTransactionHash: hash,
      transactionHashes: hashes,
    });
  }

  applySubmitAcknowledgement(executionId: string, ozTransactionId: string, hash: `0x${string}` | null): RelayExecutionRow {
    return this.client.transaction(() => {
      const row = this.getByIdOrThrow(executionId);
      if (row.terminal === 1) {
        throw new Error(`Cannot acknowledge submit for terminal execution: ${executionId}`);
      }
      const timestamp = nowIso();
      if (hash) {
        const hashes = JSON.parse(row.transactionHashesJson) as `0x${string}`[];
        hashes.push(hash);
        this.client.db
          .prepare(
            `UPDATE relay_executions
             SET oz_transaction_id = ?, current_transaction_hash = ?, transaction_hashes_json = ?, updated_at = ?
             WHERE id = ? AND terminal = 0`,
          )
          .run(ozTransactionId, hash, JSON.stringify(hashes), timestamp, executionId);
        const updated = this.getByIdOrThrow(executionId);
        if (updated.state === "pending") {
          assertTransitionState("pending", "submitted");
          this.client.db
            .prepare(`UPDATE relay_executions SET state = 'submitted', updated_at = ? WHERE id = ? AND terminal = 0`)
            .run(timestamp, executionId);
        }
      } else {
        this.client.db
          .prepare(`UPDATE relay_executions SET oz_transaction_id = ?, updated_at = ? WHERE id = ? AND terminal = 0`)
          .run(ozTransactionId, timestamp, executionId);
      }
      return this.getByIdOrThrow(executionId);
    });
  }

  updateLastError(executionId: string, errorJson: string): RelayExecutionRow {
    const timestamp = nowIso();
    this.client.db
      .prepare("UPDATE relay_executions SET last_error_json = ?, updated_at = ? WHERE id = ?")
      .run(errorJson, timestamp, executionId);
    return this.getByIdOrThrow(executionId);
  }
}

export class RelayExecutionEventRepository {
  constructor(private readonly client: DbClient) {}

  append(input: Omit<RelayExecutionEvent, "id" | "createdAt"> & { id?: string; createdAt?: string }): RelayExecutionEvent {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    this.client.db
      .prepare("INSERT INTO relay_execution_events(id, execution_id, type, actor, reason, details_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.executionId, input.type, input.actor, input.reason, input.detailsJson, createdAt);
    return { id, executionId: input.executionId, type: input.type, actor: input.actor, reason: input.reason, detailsJson: input.detailsJson, createdAt };
  }

  listByExecution(executionId: string): RelayExecutionEvent[] {
    const rows = this.client.db
      .prepare("SELECT * FROM relay_execution_events WHERE execution_id = ? ORDER BY created_at ASC")
      .all(executionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      executionId: String(row.execution_id),
      type: String(row.type),
      actor: String(row.actor),
      reason: String(row.reason),
      detailsJson: String(row.details_json),
      createdAt: String(row.created_at),
    }));
  }
}

export class CreateRequestAuditLogRepository {
  constructor(private readonly client: DbClient) {}

  append(input: CreateRequestAuditInput): void {
    const id = randomUUID();
    this.client.db
      .prepare(
        `INSERT INTO create_request_audit_log(
          id, created_at, client_id, request_body_hash, outcome_code, execution_id,
          chain_id, kind, forwarder_address, domain, macro_address, signer_address, provider_name, nonce, digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        nowIso(),
        input.clientId,
        input.requestBodyHash,
        input.outcomeCode,
        input.executionId,
        input.chainId,
        input.kind,
        input.forwarderAddress,
        input.domain,
        input.macroAddress,
        input.signerAddress,
        input.providerName,
        input.nonce,
        input.digest,
      );
  }
}

export type RelayerTransactionUpsert = {
  ozTransactionId: string;
  executionId: string;
  ozRelayerId: string;
  status: string;
  statusReason: string | null;
  txHash: string | null;
  nonce: string | null;
  gasLimit: string | null;
  gasPrice: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  rawJson: string;
  submittedAt: string | null;
  includedAt: string | null;
  confirmedAt: string | null;
  receiptJson: string | null;
  lastPolledAt: string | null;
};

export type RelayerTransactionRow = {
  ozTransactionId: string;
  executionId: string;
  ozRelayerId: string;
  status: string;
  statusReason: string | null;
  txHash: string | null;
  nonce: string | null;
  gasLimit: string | null;
  gasPrice: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  rawJson: string;
  submittedAt: string | null;
  includedAt: string | null;
  confirmedAt: string | null;
  receiptJson: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const mapRelayerTransaction = (row: Record<string, unknown>): RelayerTransactionRow => ({
  ozTransactionId: String(row.oz_transaction_id),
  executionId: String(row.execution_id),
  ozRelayerId: String(row.oz_relayer_id),
  status: String(row.status),
  statusReason: row.status_reason === null ? null : String(row.status_reason),
  txHash: row.tx_hash === null ? null : String(row.tx_hash),
  nonce: row.nonce === null ? null : String(row.nonce),
  gasLimit: row.gas_limit === null ? null : String(row.gas_limit),
  gasPrice: row.gas_price === null ? null : String(row.gas_price),
  maxFeePerGas: row.max_fee_per_gas === null ? null : String(row.max_fee_per_gas),
  maxPriorityFeePerGas: row.max_priority_fee_per_gas === null ? null : String(row.max_priority_fee_per_gas),
  rawJson: String(row.raw_json),
  submittedAt: row.submitted_at === null ? null : String(row.submitted_at),
  includedAt: row.included_at === null ? null : String(row.included_at),
  confirmedAt: row.confirmed_at === null ? null : String(row.confirmed_at),
  receiptJson: row.receipt_json === null ? null : String(row.receipt_json),
  lastPolledAt: row.last_polled_at === null ? null : String(row.last_polled_at),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export class RelayerTransactionRepository {
  constructor(private readonly client: DbClient) {}

  upsert(input: RelayerTransactionUpsert): void {
    const timestamp = nowIso();
    this.client.db
      .prepare(
        `INSERT INTO relayer_transactions(
          oz_transaction_id, execution_id, oz_relayer_id, status, status_reason, tx_hash, nonce, gas_limit, gas_price,
          max_fee_per_gas, max_priority_fee_per_gas, raw_json, submitted_at, included_at, confirmed_at, receipt_json, last_polled_at, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(oz_transaction_id) DO UPDATE SET
          execution_id = excluded.execution_id,
          oz_relayer_id = excluded.oz_relayer_id,
          status = excluded.status,
          status_reason = excluded.status_reason,
          tx_hash = excluded.tx_hash,
          nonce = excluded.nonce,
          gas_limit = excluded.gas_limit,
          gas_price = excluded.gas_price,
          max_fee_per_gas = excluded.max_fee_per_gas,
          max_priority_fee_per_gas = excluded.max_priority_fee_per_gas,
          raw_json = excluded.raw_json,
          submitted_at = excluded.submitted_at,
          included_at = excluded.included_at,
          confirmed_at = excluded.confirmed_at,
          receipt_json = excluded.receipt_json,
          last_polled_at = excluded.last_polled_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.ozTransactionId,
        input.executionId,
        input.ozRelayerId,
        input.status,
        input.statusReason,
        input.txHash,
        input.nonce,
        input.gasLimit,
        input.gasPrice,
        input.maxFeePerGas,
        input.maxPriorityFeePerGas,
        input.rawJson,
        input.submittedAt,
        input.includedAt,
        input.confirmedAt,
        input.receiptJson,
        input.lastPolledAt,
        timestamp,
        timestamp,
      );
  }

  getByExecutionId(executionId: string): RelayerTransactionRow | undefined {
    const row = this.client.db
      .prepare("SELECT * FROM relayer_transactions WHERE execution_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(executionId) as Record<string, unknown> | undefined;
    return row ? mapRelayerTransaction(row) : undefined;
  }
}

export function sha256HexUtf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
