<!-- file: runbooks.md -->
# Operational Runbooks

## 1. Distribution Node Offline
- **Detection**: Heartbeat missing > 5 mins.
- **Action**: Alert supervisor. Verify physical network. Node continues operating on local lease. No immediate intervention needed unless > 72h.

## 2. Sync Stalled / Outbox Full
- **Detection**: Outbox depth > 10,000.
- **Action**: Check central API health. Check node disk space. Restart node sync worker.

## 3. Invalid Signature Spike
- **Detection**: `ERR_301` rate > 5%.
- **Action**: Isolate node. Check for key compromise. Revoke key in central DB. Reprovision node.

## 4. Quota Discrepancy
- **Detection**: Central ledger shows consumed > allocated.
- **Action**: Halt node. Audit local SQLite. Run reconciliation script to identify rogue tokens.

## 5. Database Unavailable
- **Detection**: API 503 errors.
- **Action**: Failover to replica. If primary dead, promote replica. Notify users of degraded mode (offline nodes unaffected).

## 6. Suspected Key Compromise
- **Detection**: Anomalous token generation.
- **Action**: Revoke `kid` in central DB. Rotate node keys. Reconcile all pending tokens with old key manually.