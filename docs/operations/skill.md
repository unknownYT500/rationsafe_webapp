
<!-- file: skill.md -->
# Engineering & AI-Agent Skill Guide

## 1. Mandatory Workflow
1. Read `prd.md`, `trd.md`, `architecture.md`.
2. Identify affected Requirement IDs.
3. Check API contract and DB schema.
4. Implement smallest coherent change.
5. Run tests (`npm run test`, `npm run test:e2e`).
6. Update docs and traceability matrix.
7. Generate Agent Change Report.

## 2. Coding Standards
- **Language**: TypeScript (Strict mode).
- **Formatting**: Prettier + ESLint.
- **Security**: No hardcoded secrets. No `any` types. No raw SQL string concatenation.

## 3. Database Rules
- All schema changes via Prisma Migrations.
- Never drop tables without explicit approval.
- Quota deductions must be in a single DB transaction.

## 4. Crypto & Distributed Rules
- Use `@noble/ed25519` or `tweetnacl`. Never write custom crypto.
- Tokens must use canonical JSON serialization.
- Counters must be persisted to disk immediately.
- Explain concurrency impact in PR description for any quota/txn code.

## 5. Definition of Done
- Code implemented.
- Unit/Integration tests passing.
- API docs updated.
- Security review passed.
- Agent Change Report submitted.

## 6. Agent Change Report Template
- **Files Modified**: ...
- **Requirements Addressed**: ...
- **Tests Executed**: ...
- **Security Considerations**: ...
- **Deviations**: ...