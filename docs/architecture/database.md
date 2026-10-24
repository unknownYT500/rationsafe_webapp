<!-- file: database.md -->
# Data Model & Database Design

## 1. Entity-Relationship Diagram
```mermaid
erDiagram
    PERSONS ||--o| HOUSEHOLD_PROFILES : has
    PERSONS ||--o| CARDS : holds
    CARDS ||--o{ CARD_QUOTA_LEDGER : tracks
    LOTS ||--o{ LOT_CAP_GRANTS : issues
    LOT_CAP_GRANTS ||--o{ DISTRIBUTION_NODES : allocated_to
    DISTRIBUTION_NODES ||--o{ DISTRIBUTION_TRANSACTIONS : processes
    DISTRIBUTION_TRANSACTIONS ||--o{ TRANSACTION_STATE_HISTORY : tracks
    DISTRIBUTION_TRANSACTIONS ||--o| PROVISIONAL_TOKENS : generates
2. Data Dictionary (Key Tables)
persons: id (UUID), first_name, last_name, phone_number (unique), dob, created_at.
household_profiles: id, person_id (FK), family_count, yearly_income (DECIMAL(12,2)), address, city, state.
cards: id (UUID), person_id (FK), status, issued_at.
lots: id, name, grain_type, total_quantity (DECIMAL).
lot_cap_grants: id, lot_id, node_id, max_quantity, expires_at, signature.
card_quota_ledger: id, card_id, node_id, allocated_qty, consumed_qty, period_start.
distribution_transactions: id, card_id, node_id, lot_id, quantity, state (ENUM), idempotency_key.
transaction_state_history: id, txn_id, from_state, to_state, reason_code, actor_id, timestamp.
provisional_tokens: id, txn_id, payload (JSON), signature, key_id, nonce, counter.
failure_events: id, txn_id, reason_code, metadata (JSON), timestamp.
audit_events: id, actor_id, action, resource_type, resource_id, details (JSON), timestamp.