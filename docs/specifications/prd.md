<!-- file: prd.md -->
# Product Requirements Document (PRD)

## 1. Product Vision
A secure, resilient beneficiary-registration and grain-distribution platform. It ensures accountable grain distribution during network outages via offline provisional issuance, cryptographic verification, and centralized reconciliation. 

## 2. Target Users & Personas
- **Beneficiary**: Registers, receives `personal_id`, views permitted info, receives receipts.
- **Registration Operator**: Assists with registration and profile corrections.
- **Distribution Operator**: Processes grain distribution (online/offline).
- **Supervisor**: Reviews activity, exceptions, and summaries.
- **Administrator**: Manages accounts, roles, lots, quotas, nodes.
- **Reconciliation Officer**: Investigates conflicts, approves authorized resolutions.
- **Auditor**: Reviews immutable audit records (read-only).
- **Security Tester**: Runs approved simulations in isolated environments.
- **System Operator**: Monitors availability, nodes, sync, backups.

## 3. Functional Requirements
### 3.1 Registration (REG-001 to REG-005)
- **Fields**: Name, `phone_number`, Date of Birth, Family Members, Yearly Net Income, Address, State, City. (Note: Ambiguous `number` field normalized to `phone_number`; no government ID collected).
- **Validation**: Strict formats, date boundaries, numeric ranges.
- **States**: Draft -> Submitted -> Verified -> Approved.
- **Consent**: Explicit opt-in required.

### 3.2 Personal ID (ID-001 to ID-003)
- Generated upon `Approved` status. Opaque UUIDv7. No PII encoded.
- Uniqueness enforced via DB constraints.
- Possession of ID does not grant unrestricted data access.

### 3.3 Portal & Autofill (PORTAL-001 to PORTAL-004)
- User signs in -> enters `personal_id` -> backend checks auth -> retrieves permitted fields -> populates predefined templates.
- No raw SQL execution. Strict field-level access control.

### 3.4 Transaction & Distribution (TXN-001 to TXN-005)
- 5-State Machine: `ATTEMPT` -> `FAIL_REASON` -> `FALLBACK_AUTH` -> `PROVISIONAL_ISSUE` -> `RECONCILED`.
- Supports units, precision, lot ownership, card association.
- Failed attempts recorded separately from completed issues.

### 3.5 Fraud & Failure (FRAUD-001 to FRAUD-003)
- Every failure gets a structured reason code.
- Per-card quotas and signed lot-caps enforced locally.
- **No global queue lock** for fraud investigations; suspicious events routed to review queues.

## 4. Non-Functional Requirements
- **Security**: Least privilege, encryption in transit/at rest, Ed25519 signing.
- **Availability**: Offline nodes must operate independently for up to 72 hours.
- **Consistency**: Eventual consistency for offline sync; strict consistency for online quotas.
- **Auditability**: Immutable append-only audit logs.

## 5. Product Boundaries
- **In Scope**: Registration, portal, offline distribution, reconciliation, admin dashboard, security lab.
- **Out of Scope**: Payment processing, physical logistics tracking, biometric verification.