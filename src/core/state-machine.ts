// src/core/state-machine.ts
import type { TxnState, ReasonCode, TransactionStateHistory } from './types.js';
import { generateUuidV7 } from './uuidv7.js';

export class InvalidStateTransitionError extends Error {
  public code: ReasonCode = 'ERR_409';

  constructor(
    public fromState: TxnState | 'INITIAL',
    public toState: TxnState,
    message?: string
  ) {
    super(
      message ||
        `Invalid state transition from '${fromState}' to '${toState}'. Allowed transitions are strictly enforced.`
    );
    this.name = 'InvalidStateTransitionError';
  }
}

/**
 * Valid state transition matrix conforming to PRD 3.4 & TRD Section 1:
 * [ATTEMPT] -> [FAIL_REASON] -> [FALLBACK_AUTH] -> [PROVISIONAL_ISSUE] -> [RECONCILED]
 */
const VALID_TRANSITIONS: Record<TxnState | 'INITIAL', TxnState[]> = {
  INITIAL: ['ATTEMPT'],
  ATTEMPT: ['FAIL_REASON', 'PROVISIONAL_ISSUE'],
  FAIL_REASON: ['FALLBACK_AUTH'],
  FALLBACK_AUTH: ['PROVISIONAL_ISSUE'],
  PROVISIONAL_ISSUE: ['RECONCILED'],
  RECONCILED: [],
};

function isValidState(value: unknown): value is TxnState | 'INITIAL' {
  return value === 'INITIAL' || value === 'ATTEMPT' || value === 'FAIL_REASON' || value === 'FALLBACK_AUTH' || value === 'PROVISIONAL_ISSUE' || value === 'RECONCILED';
}

export function canTransition(from: TxnState | 'INITIAL', to: TxnState): boolean {
  if (!isValidState(from) || !isValidState(to)) {
    return false;
  }
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function validateTransition(from: TxnState | 'INITIAL', to: TxnState): void {
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

export function createStateHistoryRecord(
  txnId: string,
  fromState: TxnState | 'INITIAL',
  toState: TxnState,
  actorId: string,
  reasonCode?: ReasonCode
): TransactionStateHistory {
  if (typeof txnId !== 'string' || txnId.trim().length === 0) {
    throw new Error('Transaction ID is required to create a state history record.');
  }
  if (typeof actorId !== 'string' || actorId.trim().length === 0) {
    throw new Error('Actor ID is required to create a state history record.');
  }
  if (!canTransition(fromState, toState)) {
    throw new InvalidStateTransitionError(fromState, toState, 'State transition blocked by policy.');
  }

  return {
    id: generateUuidV7(),
    txn_id: txnId,
    from_state: fromState,
    to_state: toState,
    reason_code: reasonCode,
    actor_id: actorId,
    timestamp: new Date().toISOString(),
  };
}

