<!-- file: failure-catalog.md -->
# Structured Event Taxonomy

## 1. Event Schema
```json
{
  "event_id": "uuid",
  "txn_id": "uuid",
  "type": "TXN_FAILURE",
  "code": "ERR_201",
  "node_id": "uuid",
  "timestamp": "ISO8601",
  "retryable": false,
  "metadata": {}
}
2. Metrics & Dashboards
Failure Rate: count(failure_events) / count(txn_attempts).
Fallback Rate: count(FALLBACK_AUTH) / count(FAIL_REASON).
Sync Backlog: count(sync_outbox_items).
Alerts: Trigger if ERR_301 (Invalid Sig) > 5% of total, or Sync Backlog > 10,000.