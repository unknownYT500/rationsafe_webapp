<!-- file: requirements-traceability.md -->
# Requirements Traceability Matrix

| Req ID | Description | PRD | TRD | Arch | DB | API | Phase | Test |
|---|---|---|---|---|---|---|---|---|
| REG-001 | Registration fields | 3.1 | 1 | - | `persons` | POST /reg | P4 | T1 |
| ID-001 | UUIDv7 Generation | 3.2 | 1 | - | `persons` | - | P4 | T1 |
| PORTAL-001 | Authorized Lookup | 3.3 | 1 | 2 | - | GET /persons | P5 | T2 |
| TXN-001 | 5-State Machine | 3.4 | 1 | 2 | `txns` | POST /txn | P6 | T3 |
| CRYPTO-001 | Ed25519 Tokens | 3.4 | 1 | 2 | `tokens` | - | P7 | T4 |
| SYNC-001 | Idempotent Sync | 3.4 | 4 | 2 | `outbox` | POST /sync | P10 | T11 |
| QUOTA-001 | Lease Enforcement | 3.5 | 4 | 4 | `ledger` | - | P8 | T7 |
| FRAUD-001 | Structured Failures | 3.5 | 5 | - | `failures` | - | P6 | T13 |
| SEC-001 | RBAC & Auth | 4 | 2 | 2 | `users` | - | P3 | T2, T17 |
| OPS-001 | Node Monitoring | 4 | - | 2 | `nodes` | GET /nodes | P11 | - |

*Note: Full matrix contains 50+ rows. This is a representative subset.*