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
  RECONCILED: [], // Terminal state. Never allow transitioning back.
};

export function canTransition(from: TxnState | 'INITIAL', to: TxnState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function validateTransition(
  from: TxnState | 'INITIAL',
  to: TxnState
): void {
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
