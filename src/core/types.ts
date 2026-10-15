// src/core/types.ts

export type UserRole =
  | 'BENEFICIARY'
  | 'REGISTRATION_OPERATOR'
  | 'DISTRIBUTION_OPERATOR'
  | 'SUPERVISOR'
  | 'ADMINISTRATOR'
  | 'RECONCILIATION_OFFICER'
  | 'AUDITOR'
  | 'SECURITY_TESTER'
  | 'SYSTEM_OPERATOR';

export type RegistrationStatus = 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'APPROVED';

export type CardStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED';

export type TxnState =
  | 'ATTEMPT'
  | 'FAIL_REASON'
  | 'FALLBACK_AUTH'
  | 'PROVISIONAL_ISSUE'
  | 'RECONCILED';

export type ReasonCode =
  | 'ERR_101' // Invalid field format
  | 'ERR_201' // Card quota exhausted
  | 'ERR_202' // Lot cap exhausted
  | 'ERR_301' // Invalid signature
  | 'ERR_302' // Replayed nonce
  | 'ERR_401' // Central rejection
  | 'ERR_402' // Expired token
  | 'ERR_403' // Quota lease exceeded
  | 'ERR_404' // Resource not found
  | 'ERR_409' // State conflict / invalid transition
  | 'ERR_500'; // Internal system error

export type ReconciliationOutcome =
  | 'ACCEPTED'
  | 'REJECTED'
  | 'DUPLICATE'
  | 'CONFLICT'
  | 'MANUAL_REVIEW';

export interface Person {
  id: string; // UUIDv7
  first_name: string;
  last_name: string;
  phone_number: string;
  dob: string; // YYYY-MM-DD
  created_at: string;
}

export interface HouseholdProfile {
  id: string;
  person_id: string;
  family_count: number;
  yearly_income: number;
  address: string;
  city: string;
  state: string;
}

export interface RegistrationPayload {
  first_name: string;
  last_name: string;
  phone_number: string;
  dob: string;
  family_count: number;
  yearly_income: number;
  address: string;
  city: string;
  state: string;
  consent_opt_in: boolean;
}

export interface RegistrationRecord {
  id: string;
  status: RegistrationStatus;
  data: RegistrationPayload;
  node_id?: string;
  person_id?: string;
  card_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Card {
  id: string; // UUID
  person_id: string;
  status: CardStatus;
  issued_at: string;
}

export interface GrainLot {
  id: string;
  name: string;
  grain_type: string;
  total_quantity: number; // in kg
  remaining_quantity: number;
}

export interface LotCapGrant {
  id: string;
  lot_id: string;
  node_id: string;
  max_quantity: number;
  remaining_quantity: number;
  expires_at: number; // unix timestamp seconds
  signature: string;
}

export interface CardQuotaLedger {
  id: string;
  card_id: string;
  node_id: string;
  allocated_qty: number;
  consumed_qty: number;
  period_start: string;
}

export interface DistributionTransaction {
  id: string; // UUID
  card_id: string;
  node_id: string;
  lot_id: string;
  quantity: number;
  state: TxnState;
  idempotency_key: string;
  failure_reason?: ReasonCode;
  fallback_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface TransactionStateHistory {
  id: string;
  txn_id: string;
  from_state: TxnState | 'INITIAL';
  to_state: TxnState;
  reason_code?: ReasonCode;
  actor_id: string;
  timestamp: string;
}

export interface ProvisionalTokenPayload {
  v: 1;
  tid: string; // txn_uuid
  nid: string; // node_uuid
  lid: string; // lot_uuid
  gid: string; // grant_uuid
  qid: string; // quota_res_uuid
  sub: string; // sha256_hash_of_card_id
  n: string;   // unique_nonce
  c: number;   // counter
  qty: number; // e.g. 5.50
  unit: 'kg';  // unit
  iat: number; // unix epoch
  exp: number; // unix epoch
  kid: string; // key_uuid
}

export interface SignedProvisionalToken {
  id: string;
  txn_id: string;
  payload: ProvisionalTokenPayload;
  signature: string; // hex
  key_id: string;
  nonce: string;
  counter: number;
  created_at: string;
}

export interface FailureEvent {
  event_id: string;
  txn_id: string;
  type: 'TXN_FAILURE' | 'SYNC_FAILURE' | 'CRYPTO_FAILURE';
  code: ReasonCode;
  node_id: string;
  timestamp: string;
  retryable: boolean;
  metadata: Record<string, unknown>;
}

export interface AuditEvent {
  id: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface DistributionNode {
  id: string;
  name: string;
  public_key: string; // hex
  status: 'ONLINE' | 'OFFLINE' | 'SYNCING';
  last_heartbeat: string;
  outbox_depth: number;
  location: string;
}

export interface SyncBatchRequest {
  batch_id: string;
  tokens: SignedProvisionalToken[];
}

export interface SyncBatchItemAck {
  token_id: string;
  txn_id: string;
  outcome: ReconciliationOutcome;
  reason_code?: ReasonCode;
  message: string;
}

export interface SyncBatchResponse {
  batch_id: string;
  processed_count: number;
  accepted_count: number;
  rejected_count: number;
  duplicate_count: number;
  conflict_count: number;
  manual_review_count: number;
  items: SyncBatchItemAck[];
}
