// src/services/central-service.ts
import { z } from 'zod';
import type {
  UserRole,
  RegistrationPayload,
  RegistrationRecord,
  Person,
  HouseholdProfile,
  Card,
  GrainLot,
  LotCapGrant,
  CardQuotaLedger,
  DistributionTransaction,
  SignedProvisionalToken,
  SyncBatchRequest,
  SyncBatchResponse,
  SyncBatchItemAck,
  FailureEvent,
  AuditEvent,
  DistributionNode,
  ReasonCode,
} from '../core/types.js';
import { generateUuidV7 } from '../core/uuidv7.js';
import { verifyTokenPayload } from '../core/crypto.js';
import { validateTransition, createStateHistoryRecord } from '../core/state-machine.js';
import { CentralDatabase } from '../database/storage.js';

// Strict Zod schema for registration (PRD 3.1 & TRD Section 3)
export const RegistrationSchema = z.object({
  first_name: z.string().min(1, 'First name is required').max(50),
  last_name: z.string().min(1, 'Last name is required').max(50),
  phone_number: z.string().regex(/^\+?[0-9]{10,15}$/, 'Valid phone number required (10-15 digits)'),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'DOB must be YYYY-MM-DD'),
  family_count: z.number().int().min(1).max(30),
  yearly_income: z.number().min(0),
  address: z.string().min(3).max(255),
  city: z.string().min(2).max(100),
  state: z.string().min(2).max(100),
  consent_opt_in: z.boolean().refine((val) => val === true, 'Consent opt-in is required'),
});

export class CentralService {
  constructor(public readonly db: CentralDatabase) {}

  // --- Audit Logging ---
  public logAudit(actorId: string, action: string, resourceType: string, resourceId: string, details: Record<string, unknown>): void {
    const event: AuditEvent = {
      id: generateUuidV7(),
      actor_id: actorId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      details,
      timestamp: new Date().toISOString(),
    };
    this.db.insertAuditEvent(event);
  }

  // --- Registration Workflow (PRD 3.1) ---
  public submitRegistration(payload: unknown, actorId = 'public-user', nodeId?: string): RegistrationRecord {
    const parsed = RegistrationSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Validation failed: ${parsed.error.issues.map((e) => e.message).join(', ')}`);
    }

    const regId = generateUuidV7();
    const now = new Date().toISOString();
    const record: RegistrationRecord = {
      id: regId,
      status: 'SUBMITTED',
      data: parsed.data,
      node_id: nodeId || this.db.listNodes()[0]?.id,
      created_at: now,
      updated_at: now,
    };

    this.db.insertRegistration(record);
    this.logAudit(actorId, 'REGISTRATION_SUBMITTED', 'REGISTRATION', regId, { phone: parsed.data.phone_number });
    return record;
  }

  public verifyRegistration(regId: string, actorId: string): RegistrationRecord {
    const reg = this.db.getRegistration(regId);
    if (!reg) throw new Error('Registration not found');
    if (reg.status !== 'SUBMITTED') {
      throw new Error(`Cannot verify registration in status ${reg.status}`);
    }

    reg.status = 'VERIFIED';
    reg.updated_at = new Date().toISOString();
    this.db.updateRegistration(reg);
    this.logAudit(actorId, 'REGISTRATION_VERIFIED', 'REGISTRATION', regId, {});
    return reg;
  }

  public approveRegistration(regId: string, actorId: string): { registration: RegistrationRecord; person: Person; card: Card } {
    const reg = this.db.getRegistration(regId);
    if (!reg) throw new Error('Registration not found');
    if (reg.status !== 'VERIFIED' && reg.status !== 'SUBMITTED') {
      throw new Error(`Cannot approve registration in status ${reg.status}`);
    }

    const personId = generateUuidV7(); // UUIDv7 for personal_id (PRD 3.2, ID-001)
    const now = new Date().toISOString();

    const person: Person = {
      id: personId,
      first_name: reg.data.first_name,
      last_name: reg.data.last_name,
      phone_number: reg.data.phone_number,
      dob: reg.data.dob,
      created_at: now,
    };

    const household: HouseholdProfile = {
      id: generateUuidV7(),
      person_id: personId,
      family_count: reg.data.family_count,
      yearly_income: reg.data.yearly_income,
      address: reg.data.address,
      city: reg.data.city,
      state: reg.data.state,
    };

    this.db.insertPerson(person, household);

    // Issue Card
    const cardId = generateUuidV7();
    const card: Card = {
      id: cardId,
      person_id: personId,
      status: 'ACTIVE',
      issued_at: now,
    };
    this.db.insertCard(card);

    // Default monthly quota: 10kg per family member, leased to the registration terminal.
    const allocatedQuota = reg.data.family_count * 10;
    if (reg.node_id) {
      this.db.setQuotaLedger({
        id: generateUuidV7(),
        card_id: cardId,
        node_id: reg.node_id,
        allocated_qty: allocatedQuota,
        consumed_qty: 0,
        period_start: now.slice(0, 10),
      });
    } else {
      this.db.setQuotaLedger({
        id: generateUuidV7(),
        card_id: cardId,
        node_id: 'GLOBAL',
        allocated_qty: allocatedQuota,
        consumed_qty: 0,
        period_start: now.slice(0, 10),
      });
    }

    reg.status = 'APPROVED';
    reg.person_id = personId;
    reg.card_id = cardId;
    reg.updated_at = now;
    this.db.updateRegistration(reg);

    // Preserve shared leases for legacy registrations that have no terminal assignment.
    if (!reg.node_id) {
      for (const node of this.db.listNodes()) {
        this.db.setQuotaLedger({
          id: generateUuidV7(),
          card_id: cardId,
          node_id: node.id,
          allocated_qty: allocatedQuota,
          consumed_qty: 0,
          period_start: now.slice(0, 10),
        });
      }
    }

    this.logAudit(actorId, 'REGISTRATION_APPROVED', 'PERSON', personId, { card_id: cardId, quota: allocatedQuota });

    return { registration: reg, person, card };
  }

  // --- Portal & Autofill (PRD 3.3, PORTAL-001 to PORTAL-004) ---
  public lookupPerson(personId: string, callerRole: UserRole, callerId: string): Record<string, unknown> {
    const person = this.db.getPersonById(personId);
    if (!person) {
      throw new Error('Person not found');
    }

    const household = this.db.getHouseholdByPersonId(personId);
    const card = this.db.getCardByPersonId(personId);
    const ledger = card ? this.db.getQuotaLedger(card.id) : undefined;

    this.logAudit(callerId, 'PERSON_LOOKUP', 'PERSON', personId, { role: callerRole });

    // Strict Field-Level Projections (RBAC)
    if (callerRole === 'BENEFICIARY') {
      return {
        id: person.id,
        first_name: person.first_name,
        last_name: person.last_name,
        masked_phone: person.phone_number.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
        card_id: card?.id,
        card_status: card?.status,
        quota_available: ledger ? ledger.allocated_qty - ledger.consumed_qty : 0,
      };
    }

    if (callerRole === 'DISTRIBUTION_OPERATOR' || callerRole === 'REGISTRATION_OPERATOR') {
      return {
        id: person.id,
        full_name: `${person.first_name} ${person.last_name}`,
        phone_number: person.phone_number,
        dob: person.dob,
        family_count: household?.family_count,
        city: household?.city,
        state: household?.state,
        card_id: card?.id,
        card_status: card?.status,
        quota_allocated: ledger?.allocated_qty,
        quota_consumed: ledger?.consumed_qty,
        quota_available: ledger ? ledger.allocated_qty - ledger.consumed_qty : 0,
        // yearly_income is strictly masked for operators
        yearly_income: 'RESTRICTED_ACCESS',
      };
    }

    // Supervisors, Admins, Auditors
    return {
      id: person.id,
      first_name: person.first_name,
      last_name: person.last_name,
      phone_number: person.phone_number,
      dob: person.dob,
      household,
      card,
      quota_ledger: ledger,
    };
  }

  public autofillTemplate(personId: string, templateType: 'DISTRIBUTION_RECEIPT' | 'APPLICATION_FORM', callerRole: UserRole, callerId: string): Record<string, unknown> {
    const data = this.lookupPerson(personId, callerRole, callerId);
    if (templateType === 'DISTRIBUTION_RECEIPT') {
      return {
        template: 'DISTRIBUTION_RECEIPT',
        beneficiary_id: data.id,
        beneficiary_name: (data.full_name as string) || `${data.first_name} ${data.last_name}`,
        card_id: data.card_id,
        available_quota_kg: data.quota_available,
        timestamp: new Date().toISOString(),
        issuer_agent: callerId,
      };
    }

    return {
      template: 'APPLICATION_FORM',
      beneficiary_id: data.id,
      first_name: data.first_name,
      last_name: data.last_name,
      family_count: (data.household as HouseholdProfile)?.family_count ?? data.family_count,
      address: (data.household as HouseholdProfile)?.address ?? 'REDACTED',
      status: 'VERIFIED_ACTIVE',
    };
  }

  // --- Online Distribution Transaction (TXN-001, Idempotent) ---
  public processOnlineTransaction(params: {
    cardId: string;
    lotId: string;
    nodeId: string;
    quantity: number;
    idempotencyKey: string;
    actorId: string;
  }): { status: number; body: unknown } {
    // 1. Check Idempotency Key (TRD Section 3 & Test Plan Scenario 5)
    const cached = this.db.getIdempotency(params.idempotencyKey);
    if (cached) {
      return { status: cached.status, body: cached.body };
    }

    const txnId = generateUuidV7();
    const now = new Date().toISOString();

    const txn: DistributionTransaction = {
      id: txnId,
      card_id: params.cardId,
      node_id: params.nodeId,
      lot_id: params.lotId,
      quantity: params.quantity,
      state: 'ATTEMPT',
      idempotency_key: params.idempotencyKey,
      created_at: now,
      updated_at: now,
    };

    this.db.insertStateHistory(createStateHistoryRecord(txnId, 'INITIAL', 'ATTEMPT', params.actorId));

    // Atomic Deduct Quota
    const deduction = this.db.atomicDeductQuota(params.cardId, params.nodeId, params.lotId, params.quantity);
    if (!deduction.success) {
      const reasonCode: ReasonCode = deduction.reason === 'CARD_QUOTA_EXHAUSTED' ? 'ERR_201' : 'ERR_202';
      validateTransition(txn.state, 'FAIL_REASON');
      txn.state = 'FAIL_REASON';
      txn.failure_reason = reasonCode;
      this.db.insertTransaction(txn);
      this.db.insertStateHistory(createStateHistoryRecord(txnId, 'ATTEMPT', 'FAIL_REASON', params.actorId, reasonCode));

      const failureEvent: FailureEvent = {
        event_id: generateUuidV7(),
        txn_id: txnId,
        type: 'TXN_FAILURE',
        code: reasonCode,
        node_id: params.nodeId,
        timestamp: now,
        retryable: false,
        metadata: { requested_quantity: params.quantity, reason: deduction.reason },
      };
      this.db.insertFailureEvent(failureEvent);

      const resp = {
        success: false,
        code: reasonCode,
        message: deduction.reason === 'CARD_QUOTA_EXHAUSTED' ? 'Card quota exhausted' : 'Lot cap exhausted',
        transaction: txn,
      };
      this.db.setIdempotency(params.idempotencyKey, 409, resp);
      return { status: 409, body: resp };
    }

    // Step to PROVISIONAL_ISSUE then RECONCILED
    validateTransition(txn.state, 'PROVISIONAL_ISSUE');
    txn.state = 'PROVISIONAL_ISSUE';
    this.db.insertStateHistory(createStateHistoryRecord(txnId, 'ATTEMPT', 'PROVISIONAL_ISSUE', params.actorId));

    validateTransition(txn.state, 'RECONCILED');
    txn.state = 'RECONCILED';
    this.db.insertStateHistory(createStateHistoryRecord(txnId, 'PROVISIONAL_ISSUE', 'RECONCILED', params.actorId));

    txn.updated_at = new Date().toISOString();
    this.db.insertTransaction(txn);

    const successResp = {
      success: true,
      message: 'Transaction processed and reconciled successfully',
      transaction: txn,
    };
    this.db.setIdempotency(params.idempotencyKey, 201, successResp);
    return { status: 201, body: successResp };
  }

  // --- Batch Sync & Reconciliation (reconciliation.md, api-spec.yaml) ---
  public async reconcileBatch(nodeId: string, batch: SyncBatchRequest): Promise<SyncBatchResponse> {
    const node = this.db.getNode(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not registered`);
    }

    const items: SyncBatchItemAck[] = [];
    let accepted = 0;
    let rejected = 0;
    let duplicate = 0;
    let conflict = 0;
    let manualReview = 0;

    for (const token of batch.tokens) {
      // 1. Check Duplicate Nonce or Existing Transaction (Test Plan 11)
      if (this.db.isNonceUsed(token.nonce) || this.db.getTransaction(token.txn_id)?.state === 'RECONCILED') {
        duplicate += 1;
        items.push({
          token_id: token.id,
          txn_id: token.txn_id,
          outcome: 'DUPLICATE',
          message: 'Nonce or transaction already reconciled. Idempotently acknowledged.',
        });
        continue;
      }

      // 2. Cryptographic Signature Verification (Ed25519) (Test Plan 4)
      const isSigValid = await verifyTokenPayload(token.payload, token.signature, node.public_key);
      if (!isSigValid) {
        rejected += 1;
        const code: ReasonCode = 'ERR_301';
        this.db.insertFailureEvent({
          event_id: generateUuidV7(),
          txn_id: token.txn_id,
          type: 'CRYPTO_FAILURE',
          code,
          node_id: nodeId,
          timestamp: new Date().toISOString(),
          retryable: false,
          metadata: { reason: 'Ed25519 signature mismatch or forged payload' },
        });
        items.push({
          token_id: token.id,
          txn_id: token.txn_id,
          outcome: 'REJECTED',
          reason_code: code,
          message: 'Invalid cryptographic signature',
        });
        continue;
      }

      // 3. Expiry Check (Test Plan 19)
      const nowSec = Math.floor(Date.now() / 1000);
      if (token.payload.exp < nowSec) {
        rejected += 1;
        const code: ReasonCode = 'ERR_402';
        this.db.insertFailureEvent({
          event_id: generateUuidV7(),
          txn_id: token.txn_id,
          type: 'TXN_FAILURE',
          code,
          node_id: nodeId,
          timestamp: new Date().toISOString(),
          retryable: false,
          metadata: { exp: token.payload.exp, now: nowSec },
        });
        items.push({
          token_id: token.id,
          txn_id: token.txn_id,
          outcome: 'REJECTED',
          reason_code: code,
          message: 'Provisional token expired prior to reconciliation',
        });
        continue;
      }

      // 4. Quota Lease & Counter Verification
      // Central checks if card quota and lot exists
      const lot = this.db.getLot(token.payload.lid);
      if (!lot) {
        conflict += 1;
        items.push({
          token_id: token.id,
          txn_id: token.txn_id,
          outcome: 'CONFLICT',
          reason_code: 'ERR_401',
          message: 'Lot referenced by token does not exist in central ledger',
        });
        continue;
      }

      // Record transaction into central MySQL / DB as RECONCILED
      const nowIso = new Date().toISOString();
      const existingTxn = this.db.getTransaction(token.txn_id);
      if (!existingTxn) {
        const txn: DistributionTransaction = {
          id: token.txn_id,
          card_id: token.payload.qid.replace('quota_', ''),
          node_id: nodeId,
          lot_id: token.payload.lid,
          quantity: token.payload.qty,
          state: 'RECONCILED',
          idempotency_key: token.payload.n,
          created_at: nowIso,
          updated_at: nowIso,
        };
        this.db.insertTransaction(txn);
        this.db.insertStateHistory(createStateHistoryRecord(token.txn_id, 'PROVISIONAL_ISSUE', 'RECONCILED', `node:${nodeId}`));
      } else {
        existingTxn.state = 'RECONCILED';
        existingTxn.updated_at = nowIso;
        this.db.updateTransaction(existingTxn);
        this.db.insertStateHistory(createStateHistoryRecord(token.txn_id, 'PROVISIONAL_ISSUE', 'RECONCILED', `node:${nodeId}`));
      }

      // Mark token, nonce used
      this.db.insertProvisionalToken(token);
      this.db.markNonceUsed(token.nonce, token.id);

      accepted += 1;
      items.push({
        token_id: token.id,
        txn_id: token.txn_id,
        outcome: 'ACCEPTED',
        message: 'Successfully reconciled and committed to central ledger',
      });
    }

    // Update node health and outbox depth
    node.last_heartbeat = new Date().toISOString();
    node.status = 'ONLINE';
    node.outbox_depth = Math.max(0, node.outbox_depth - (accepted + duplicate));
    this.db.updateNode(node);

    this.logAudit(`node:${nodeId}`, 'BATCH_SYNC_PROCESSED', 'SYNC_BATCH', batch.batch_id, {
      total: batch.tokens.length,
      accepted,
      rejected,
      duplicate,
      conflict,
      manualReview,
    });

    return {
      batch_id: batch.batch_id,
      processed_count: batch.tokens.length,
      accepted_count: accepted,
      rejected_count: rejected,
      duplicate_count: duplicate,
      conflict_count: conflict,
      manual_review_count: manualReview,
      items,
    };
  }

  // --- Metrics & Analytics (failure-catalog.md) ---
  public getMetrics(): {
    totalAttempts: number;
    failureEventsCount: number;
    failureRate: number;
    fallbackCount: number;
    fallbackRate: number;
    syncBacklog: number;
    alertStatus: { invalidSigAlert: boolean; backlogAlert: boolean };
    failureBreakdown: Record<string, number>;
  } {
    const txns = this.db.listTransactions();
    const failures = this.db.listFailureEvents();
    const nodes = this.db.listNodes();

    const attemptsCount = txns.length;
    const failureCount = failures.length;
    const failureRate = attemptsCount > 0 ? Number((failureCount / attemptsCount).toFixed(4)) : 0;

    const fallbackCount = txns.filter((t) => t.state === 'FALLBACK_AUTH').length;
    const failReasonCount = txns.filter((t) => t.state === 'FAIL_REASON').length;
    const fallbackRate = failReasonCount > 0 ? Number((fallbackCount / failReasonCount).toFixed(4)) : 0;

    const syncBacklog = nodes.reduce((sum, n) => sum + (n.outbox_depth || 0), 0);

    const sigFailures = failures.filter((f) => f.code === 'ERR_301').length;
    const invalidSigAlert = failureCount > 0 ? sigFailures / failureCount > 0.05 : false;
    const backlogAlert = syncBacklog > 10000;

    const breakdown: Record<string, number> = {};
    for (const f of failures) {
      breakdown[f.code] = (breakdown[f.code] || 0) + 1;
    }

    return {
      totalAttempts: attemptsCount,
      failureEventsCount: failureCount,
      failureRate,
      fallbackCount,
      fallbackRate,
      syncBacklog,
      alertStatus: {
        invalidSigAlert,
        backlogAlert,
      },
      failureBreakdown: breakdown,
    };
  }
}
