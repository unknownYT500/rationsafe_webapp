// src/edge-node/edge-node.ts
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  SignedProvisionalToken,
  ProvisionalTokenPayload,
  SyncBatchRequest,
  SyncBatchResponse,
  ReasonCode,
  DistributionTransaction,
  TxnState,
} from '../core/types.js';
import { generateUuidV7 } from '../core/uuidv7.js';
import { hashCardId, signTokenPayload } from '../core/crypto.js';
import { validateTransition, createStateHistoryRecord } from '../core/state-machine.js';

export interface EdgeNodeConfig {
  nodeId: string;
  nodeName: string;
  privateKeyHex: string;
  publicKeyHex: string;
  dataDir: string;
}

export interface EdgeOutboxItem {
  id: string;
  token: SignedProvisionalToken;
  status: 'PENDING' | 'SYNCED' | 'FAILED';
  attempts: number;
  created_at: string;
}

export interface EdgeNodeState {
  counter: number;
  localQuotas: Record<string, { allocated: number; consumed: number }>;
  activeGrants: Record<string, { maxQuantity: number; consumed: number; expiresAt: number }>;
  outbox: EdgeOutboxItem[];
  transactions: DistributionTransaction[];
}

export class EdgeDistributionNode {
  public readonly config: EdgeNodeConfig;
  private stateFile: string;
  private state: EdgeNodeState;
  public isOnline: boolean = true;

  constructor(config: EdgeNodeConfig) {
    this.config = config;
    this.stateFile = path.join(config.dataDir, `node_${config.nodeId}_state.json`);
    this.state = this.loadState();
  }

  private loadState(): EdgeNodeState {
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }
    if (fs.existsSync(this.stateFile)) {
      try {
        const raw = fs.readFileSync(this.stateFile, 'utf-8');
        return JSON.parse(raw);
      } catch {
        // start clean if corrupt
      }
    }
    return {
      counter: 1000,
      localQuotas: {},
      activeGrants: {},
      outbox: [],
      transactions: [],
    };
  }

  private persistState(): void {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (e) {
      console.error(`Edge node ${this.config.nodeId} failed to persist state:`, e);
    }
  }

  public getCounter(): number {
    return this.state.counter;
  }

  public getOutboxDepth(): number {
    return this.state.outbox.filter((item) => item.status === 'PENDING').length;
  }

  public allocateLocalLease(cardId: string, quantity: number): void {
    const existing = this.state.localQuotas[cardId] || { allocated: 0, consumed: 0 };
    existing.allocated += quantity;
    this.state.localQuotas[cardId] = existing;
    this.persistState();
  }

  public getLocalCardQuota(cardId: string): { allocated: number; consumed: number; available: number } {
    const quota = this.state.localQuotas[cardId] || { allocated: 0, consumed: 0 };
    return {
      allocated: quota.allocated,
      consumed: quota.consumed,
      available: Math.max(0, quota.allocated - quota.consumed),
    };
  }

  public setGrant(grantId: string, maxQuantity: number, expiresAt: number): void {
    this.state.activeGrants[grantId] = {
      maxQuantity,
      consumed: 0,
      expiresAt,
    };
    this.persistState();
  }

  /**
   * Distribute Grain Provisionally (Online or Offline).
   * Executes the 5-state machine: ATTEMPT -> PROVISIONAL_ISSUE or FAIL_REASON -> FALLBACK_AUTH
   */
  public async issueProvisionalGrain(params: {
    cardId: string;
    lotId: string;
    grantId: string;
    quantity: number;
    idempotencyKey: string;
    allowFallback?: boolean;
  }): Promise<{
    transaction: DistributionTransaction;
    token?: SignedProvisionalToken;
    state: TxnState;
    error?: string;
    reasonCode?: ReasonCode;
  }> {
    const txnId = generateUuidV7();
    const nowIso = new Date().toISOString();

    // 1. Initial Attempt
    const txn: DistributionTransaction = {
      id: txnId,
      card_id: params.cardId,
      node_id: this.config.nodeId,
      lot_id: params.lotId,
      quantity: params.quantity,
      state: 'ATTEMPT',
      idempotency_key: params.idempotencyKey,
      created_at: nowIso,
      updated_at: nowIso,
    };

    // Check grant
    const grant = this.state.activeGrants[params.grantId];
    const nowSec = Math.floor(Date.now() / 1000);
    if (!grant || grant.expiresAt < nowSec || grant.consumed + params.quantity > grant.maxQuantity) {
      validateTransition(txn.state, 'FAIL_REASON');
      txn.state = 'FAIL_REASON';
      txn.failure_reason = 'ERR_202'; // Lot cap exhausted
      this.state.transactions.push(txn);
      this.persistState();
      return {
        transaction: txn,
        state: txn.state,
        error: 'Lot cap exhausted or grant expired',
        reasonCode: 'ERR_202',
      };
    }

    // Check local quota lease
    const localQuota = this.getLocalCardQuota(params.cardId);
    if (localQuota.available < params.quantity) {
      validateTransition(txn.state, 'FAIL_REASON');
      txn.state = 'FAIL_REASON';
      txn.failure_reason = 'ERR_201'; // Card quota exhausted

      if (params.allowFallback) {
        validateTransition(txn.state, 'FALLBACK_AUTH');
        txn.state = 'FALLBACK_AUTH';
        txn.fallback_reason = 'Authorized secondary supervisor offline override';
      } else {
        this.state.transactions.push(txn);
        this.persistState();
        return {
          transaction: txn,
          state: txn.state,
          error: 'Card quota exhausted on local lease',
          reasonCode: txn.failure_reason,
        };
      }
    }

    // If in FALLBACK_AUTH or ATTEMPT, transition to PROVISIONAL_ISSUE
    const targetState: TxnState = 'PROVISIONAL_ISSUE';
    validateTransition(txn.state, targetState);
    txn.state = targetState;

    // Deduct local grant and card lease
    grant.consumed += params.quantity;
    if (this.state.localQuotas[params.cardId]) {
      this.state.localQuotas[params.cardId].consumed += params.quantity;
    }

    // Persist counter atomically
    this.state.counter += 1;
    const currentCounter = this.state.counter;

    // Create Ed25519 Canonical Token Payload conforming to token-protocol.md
    const payload: ProvisionalTokenPayload = {
      v: 1,
      tid: txnId,
      nid: this.config.nodeId,
      lid: params.lotId,
      gid: params.grantId,
      qid: `quota_${params.cardId.slice(0, 8)}`,
      sub: hashCardId(params.cardId),
      n: crypto.randomBytes(16).toString('hex'),
      c: currentCounter,
      qty: Number(params.quantity.toFixed(2)),
      unit: 'kg',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour validity
      kid: `key_${this.config.nodeId.slice(0, 8)}`,
    };

    const signature = await signTokenPayload(payload, this.config.privateKeyHex);

    const signedToken: SignedProvisionalToken = {
      id: generateUuidV7(),
      txn_id: txnId,
      payload,
      signature,
      key_id: payload.kid,
      nonce: payload.n,
      counter: payload.c,
      created_at: nowIso,
    };

    // Add to local outbox
    this.state.outbox.push({
      id: generateUuidV7(),
      token: signedToken,
      status: 'PENDING',
      attempts: 0,
      created_at: nowIso,
    });

    this.state.transactions.push(txn);
    this.persistState();

    return {
      transaction: txn,
      token: signedToken,
      state: txn.state,
    };
  }

  /**
   * Generates a sync batch of pending provisional tokens.
   */
  public generateSyncBatch(maxItems = 100): SyncBatchRequest | null {
    const pending = this.state.outbox.filter((item) => item.status === 'PENDING').slice(0, maxItems);
    if (pending.length === 0) return null;

    return {
      batch_id: generateUuidV7(),
      tokens: pending.map((item) => item.token),
    };
  }

  /**
   * Processes ACK response from central server.
   */
  public processSyncResponse(response: SyncBatchResponse): void {
    for (const ack of response.items) {
      const item = this.state.outbox.find((o) => o.token.id === ack.token_id || o.token.txn_id === ack.txn_id);
      if (item) {
        if (ack.outcome === 'ACCEPTED' || ack.outcome === 'DUPLICATE') {
          item.status = 'SYNCED';
        } else if (ack.outcome === 'REJECTED' || ack.outcome === 'CONFLICT') {
          item.status = 'FAILED';
        }
      }

      const txn = this.state.transactions.find((t) => t.id === ack.txn_id);
      if (txn && ack.outcome === 'ACCEPTED') {
        txn.state = 'RECONCILED';
      }
    }
    // Retain completed entries in history, remove confirmed synced items
    this.state.outbox = this.state.outbox.filter((item) => item.status !== 'SYNCED');
    this.persistState();
  }
}
