
```markdown
<!-- file: reconciliation.md -->
# Synchronization & Reconciliation

## 1. Sync Lifecycle
1. Node creates token, writes to local SQLite, adds to local outbox.
2. Node batches outbox items (max 100 or 5 mins).
3. Node sends `POST /api/v1/nodes/{id}/sync` with batch.
4. Central API validates signatures, checks nonces, verifies quota leases.
5. Central API writes to MySQL, returns ACKs for each item.
6. Node removes ACKed items from outbox.

## 2. Reconciliation Outcomes
- **ACCEPTED**: Valid, recorded in central ledger.
- **REJECTED**: Invalid signature, expired grant, or policy violation.
- **DUPLICATE**: Nonce or txn_id already exists. Ignored safely.
- **CONFLICT**: Quota lease exceeded (e.g., node bug). Marked for manual review.
- **MANUAL_REVIEW**: Counter gap detected or ambiguous state.

## 3. Quota Accounting
- Central server tracks `allocated` vs `consumed` for each lease.
- If REJECTED, the reserved quota is refunded to the lease.
- Never double-count: A token is either consumed or refunded, not both.