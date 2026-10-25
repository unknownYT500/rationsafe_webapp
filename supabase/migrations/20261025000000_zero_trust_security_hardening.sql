-- web/supabase/migrations/20261025000000_zero_trust_security_hardening.sql
-- ============================================================================
-- RationSafe / GrainTrust — Phase 2 Zero-Trust Security Hardening Migration
--
-- 1. Revoke public/anon execute rights on destructive administrative RPCs (fn_reset_database).
-- 2. Drop all insecure, wide-open RLS policies (USING (true) and WITH CHECK (true)).
-- 3. Implement role-scoped Row Level Security (RLS) restricting access by JWT actor claims and depot/node IDs.
-- 4. Enforce strict immutability on audit logs and transaction ledgers.
-- ============================================================================

-- 1. SECURE DESTRUCTIVE ADMINISTRATIVE FUNCTIONS
REVOKE ALL ON FUNCTION fn_reset_database(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_reset_database(TEXT) FROM anon;
REVOKE ALL ON FUNCTION fn_reset_database(TEXT) FROM authenticated;

-- Restrict fn_reset_database exclusively to service_role and postgres superusers
GRANT EXECUTE ON FUNCTION fn_reset_database(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION fn_reset_database(TEXT) TO postgres;

-- Secure sensitive state transition functions from anonymous invocation
REVOKE ALL ON FUNCTION fn_approve_registration(TEXT, TEXT, REAL) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_approve_registration(TEXT, TEXT, REAL) FROM anon;
GRANT EXECUTE ON FUNCTION fn_approve_registration(TEXT, TEXT, REAL) TO authenticated, service_role;

REVOKE ALL ON FUNCTION fn_online_dispense(TEXT, TEXT, TEXT, REAL, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_online_dispense(TEXT, TEXT, TEXT, REAL, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION fn_online_dispense(TEXT, TEXT, TEXT, REAL, TEXT, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION fn_reconcile_sync_batch(TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_reconcile_sync_batch(TEXT, JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION fn_reconcile_sync_batch(TEXT, JSONB, TEXT) TO authenticated, service_role;


-- 2. DROP PERMISSIVE / WILDCARD RLS POLICIES
DROP POLICY IF EXISTS "Public read distribution_nodes" ON distribution_nodes;
DROP POLICY IF EXISTS "Public read grain_lots" ON grain_lots;
DROP POLICY IF EXISTS "Public read registrations" ON registrations;
DROP POLICY IF EXISTS "Public insert registrations" ON registrations;
DROP POLICY IF EXISTS "Public update registrations" ON registrations;
DROP POLICY IF EXISTS "Public read cards" ON cards;
DROP POLICY IF EXISTS "Public read quota_leases" ON quota_leases;
DROP POLICY IF EXISTS "Public read distribution_transactions" ON distribution_transactions;
DROP POLICY IF EXISTS "Public read audit_events" ON audit_events;
DROP POLICY IF EXISTS "Public read failures" ON failures;


-- 3. APPLY ROLE-SCOPED & NODE-SCOPED ROW LEVEL SECURITY (RLS) POLICIES

-- A. Distribution Nodes & Grain Lots (Read-only for authenticated staff; admin-only modification)
CREATE POLICY "Staff read distribution_nodes" ON distribution_nodes
    FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "Admin manage distribution_nodes" ON distribution_nodes
    FOR ALL TO authenticated
    USING ((auth.jwt() ->> 'role') = 'ADMINISTRATOR')
    WITH CHECK ((auth.jwt() ->> 'role') = 'ADMINISTRATOR');

CREATE POLICY "Staff read grain_lots" ON grain_lots
    FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "Admin manage grain_lots" ON grain_lots
    FOR ALL TO authenticated
    USING ((auth.jwt() ->> 'role') = 'ADMINISTRATOR')
    WITH CHECK ((auth.jwt() ->> 'role') = 'ADMINISTRATOR');

-- B. Beneficiary Registrations (Role-scoped access by node_id and supervisor approval authority)
CREATE POLICY "Scoped read registrations" ON registrations
    FOR SELECT TO authenticated
    USING (
        (auth.jwt() ->> 'role') IN ('SUPERVISOR', 'ADMINISTRATOR', 'AUDITOR')
        OR (auth.jwt() ->> 'role') = 'REGISTRATION_OPERATOR'
        OR node_id = (auth.jwt() ->> 'node_id')
    );

CREATE POLICY "Authorized insert registrations" ON registrations
    FOR INSERT TO authenticated
    WITH CHECK (
        (auth.jwt() ->> 'role') IN ('REGISTRATION_OPERATOR', 'SUPERVISOR', 'ADMINISTRATOR')
        OR node_id = (auth.jwt() ->> 'node_id')
    );

CREATE POLICY "Supervisor update registrations" ON registrations
    FOR UPDATE TO authenticated
    USING (
        (auth.jwt() ->> 'role') IN ('SUPERVISOR', 'ADMINISTRATOR')
    )
    WITH CHECK (
        (auth.jwt() ->> 'role') IN ('SUPERVISOR', 'ADMINISTRATOR')
    );

-- C. Beneficiary Cards & Quota Balances
CREATE POLICY "Authorized operators read cards" ON cards
    FOR SELECT TO authenticated
    USING (
        (auth.jwt() ->> 'role') IN ('DISTRIBUTION_OPERATOR', 'REGISTRATION_OPERATOR', 'SUPERVISOR', 'AUDITOR', 'ADMINISTRATOR')
    );

CREATE POLICY "Supervisor manage cards" ON cards
    FOR ALL TO authenticated
    USING (
        (auth.jwt() ->> 'role') IN ('SUPERVISOR', 'ADMINISTRATOR')
    )
    WITH CHECK (
        (auth.jwt() ->> 'role') IN ('SUPERVISOR', 'ADMINISTRATOR')
    );

-- D. Quota Leases
CREATE POLICY "Staff read quota_leases" ON quota_leases
    FOR SELECT TO authenticated
    USING (
        (auth.jwt() ->> 'role') IN ('DISTRIBUTION_OPERATOR', 'SUPERVISOR', 'AUDITOR', 'ADMINISTRATOR')
    );

CREATE POLICY "Service and admin manage quota_leases" ON quota_leases
    FOR ALL TO authenticated
    USING (
        (auth.jwt() ->> 'role') IN ('ADMINISTRATOR', 'SUPERVISOR')
    );

-- E. Distribution Transactions (Strictly audited; no client updates or deletes)
CREATE POLICY "Staff read distribution_transactions" ON distribution_transactions
    FOR SELECT TO authenticated
    USING (
        (auth.jwt() ->> 'role') IN ('DISTRIBUTION_OPERATOR', 'SUPERVISOR', 'AUDITOR', 'ADMINISTRATOR')
    );

CREATE POLICY "Operators insert distribution_transactions" ON distribution_transactions
    FOR INSERT TO authenticated
    WITH CHECK (
        (auth.jwt() ->> 'role') IN ('DISTRIBUTION_OPERATOR', 'SUPERVISOR', 'ADMINISTRATOR')
    );

CREATE POLICY "Deny update distribution_transactions" ON distribution_transactions
    FOR UPDATE TO authenticated
    USING (false);

CREATE POLICY "Deny delete distribution_transactions" ON distribution_transactions
    FOR DELETE TO authenticated
    USING (false);

-- F. Audit Events (Immutable Append-Only Audit Trail)
CREATE POLICY "Auditors read audit_events" ON audit_events
    FOR SELECT TO authenticated
    USING (
        (auth.jwt() ->> 'role') IN ('AUDITOR', 'SUPERVISOR', 'ADMINISTRATOR')
    );

CREATE POLICY "System insert audit_events" ON audit_events
    FOR INSERT TO authenticated
    WITH CHECK (true);

-- Ensure deny policies are explicitly enforced
DROP POLICY IF EXISTS "Deny delete audit_events" ON audit_events;
DROP POLICY IF EXISTS "Deny update audit_events" ON audit_events;

CREATE POLICY "Deny delete audit_events" ON audit_events
    FOR DELETE TO authenticated
    USING (false);

CREATE POLICY "Deny update audit_events" ON audit_events
    FOR UPDATE TO authenticated
    USING (false);

-- G. Operational Failures Ledger
CREATE POLICY "Staff read failures" ON failures
    FOR SELECT TO authenticated
    USING (
        (auth.jwt() ->> 'role') IN ('DISTRIBUTION_OPERATOR', 'SUPERVISOR', 'AUDITOR', 'ADMINISTRATOR')
    );

CREATE POLICY "System insert failures" ON failures
    FOR INSERT TO authenticated
    WITH CHECK (true);
