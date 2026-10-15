<!-- file: trd.md -->
# Technical Requirements Document

## 1. Functional Technical Requirements
- **REG-TECH-01**: API accepts registration payload, validates schema, returns 201 with `registration_id`.
- **ID-TECH-01**: Background worker generates UUIDv7 upon approval.
- **TXN-TECH-01**: State machine enforces valid transitions. Invalid transitions return 409 Conflict.
- **CRYPTO-TECH-01**: Node generates Ed25519 token. Central verifies signature using registered public key.

## 2. API Contract (Summary)
- **Auth**: Bearer tokens (JWT) for staff/admin. Session cookies for public.
- **Endpoints**:
  - `POST /api/v1/registrations`
  - `GET /api/v1/persons/{id}` (Strict RBAC)
  - `POST /api/v1/transactions` (Idempotency-Key required)
  - `POST /api/v1/nodes/{id}/sync` (Batch sync)
  - `GET /api/v1/admin/quotas`
- **Errors**: Standard envelope `{ code, message, correlation_id, retryable, details }`.

## 3. Validation & Error Handling
- All inputs validated via Zod/Class-Validator.
- Idempotency keys prevent duplicate issues on retry.
- 429 Too Many Requests for rate limiting.

## 4. Transactional Integrity
- MySQL `SERIALIZABLE` or `REPEATABLE READ` with `SELECT ... FOR UPDATE` for quota deductions.
- Optimistic locking (`version` column) for profile updates.
- Edge nodes use SQLite `WAL` mode with immediate transactions for atomic counter increments.

## 5. Failure Reason Catalog (Subset)
- `ERR_101`: Invalid field format.
- `ERR_201`: Card quota exhausted.
- `ERR_202`: Lot cap exhausted.
- `ERR_301`: Invalid signature.
- `ERR_302`: Replayed nonce.
- `ERR_401`: Central rejection.

## 6. Technical Acceptance
- Concurrency test: 100 concurrent requests for 10 quota units must result in exactly 10 successes and 90 failures.
- Replay test: Submit same idempotency key twice; second returns cached success without re-deducting quota.