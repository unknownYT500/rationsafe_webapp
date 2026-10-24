
```markdown
<!-- file: test-plan.md -->
# Verification & Quality Plan

## 1. Critical Scenarios
1. **ID Uniqueness**: 1000 concurrent registrations yield 1000 unique UUIDv7s.
2. **RBAC**: User A cannot fetch User B's profile via API.
3. **State Machine**: Transition from `RECONCILED` to `ATTEMPT` returns 400.
4. **Crypto**: Modified token byte fails Ed25519 verification.
5. **Replay**: Same idempotency key returns 200 but doesn't deduct quota twice.
6. **Counter Persistence**: Kill node process, restart, counter resumes exactly where it left off.
7. **Quota Race**: 50 concurrent requests for 10 units. Exactly 10 succeed, 40 fail with `ERR_201`.
8. **Node Isolation**: Node A and Node B both offline. Both spend their leased quota. Sync succeeds without conflict.
9. **Lot Cap**: Node attempts to spend beyond signed grant. Rejected locally and centrally.
10. **Outage Recovery**: Network cut during sync. Node restarts. Outbox replays safely.
11. **Idempotent Sync**: Send same sync batch twice. Second returns success, no duplicate records.
12. **Reconciliation Resume**: Kill worker mid-batch. Restart worker. Batch completes without duplication.
13. **Failure Events**: Every rejected txn generates a `failure_event` with correct `reason_code`.
14. **Backup Restore**: Restore MySQL from snapshot. Data matches pre-backup state.
15. **Backend RBAC**: UI hides admin button, but API still enforces 403 if user lacks role.
16. **Multi-Node Quota**: Central allocates 100 units. Node A gets 60, Node B gets 40. Sum = 100.
17. **Audit Immutability**: Attempt to `UPDATE` audit log returns error.
18. **Token Expiry**: Token with `exp` in past is rejected by central server.
19. **Fallback Auth**: Txn fails primary, eligible for fallback. Transitions to `FALLBACK_AUTH`.
