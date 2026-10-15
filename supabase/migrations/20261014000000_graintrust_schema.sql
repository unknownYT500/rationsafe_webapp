-- supabase/migrations/20261014000000_graintrust_schema.sql
-- GrainTrust PDS: Complete Database Schema, Relational Constraints, Atomic RPCs, and RLS

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. ENUM TYPES
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM (
        'BENEFICIARY',
        'REGISTRATION_OPERATOR',
        'DISTRIBUTION_OPERATOR',
        'SUPERVISOR',
        'ADMINISTRATOR',
        'RECONCILIATION_OFFICER',
        'AUDITOR',
        'SECURITY_TESTER',
        'SYSTEM_OPERATOR'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE registration_status AS ENUM (
        'DRAFT',
        'SUBMITTED',
        'VERIFIED',
        'APPROVED',
        'REJECTED'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE card_status AS ENUM (
        'ACTIVE',
        'SUSPENDED',
        'REVOKED'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE node_status AS ENUM (
        'ONLINE',
        'OFFLINE',
        'SYNCING'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE txn_state AS ENUM (
        'INITIAL',
        'ATTEMPT',
        'FAIL_REASON',
        'FALLBACK_AUTH',
        'PROVISIONAL_ISSUE',
        'RECONCILED'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE sync_ack_status AS ENUM (
        'ACCEPTED',
        'REJECTED',
        'DUPLICATE',
        'CONFLICT',
        'MANUAL_REVIEW'
    );
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- 3. CORE RELATIONAL TABLES

-- Distribution Nodes / Terminals
CREATE TABLE IF NOT EXISTS distribution_nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    status node_status NOT NULL DEFAULT 'ONLINE',
    last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    outbox_depth INTEGER NOT NULL DEFAULT 0,
    location TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Grain Lots (Central Inventory)
CREATE TABLE IF NOT EXISTS grain_lots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    grain_type TEXT NOT NULL,
    total_quantity NUMERIC(12, 2) NOT NULL CHECK (total_quantity >= 0),
    remaining_quantity NUMERIC(12, 2) NOT NULL CHECK (remaining_quantity >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lot-Cap Grants (Terminal Lot Allocations)
CREATE TABLE IF NOT EXISTS lot_cap_grants (
    id TEXT PRIMARY KEY,
    lot_id TEXT NOT NULL REFERENCES grain_lots(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES distribution_nodes(id) ON DELETE CASCADE,
    max_quantity NUMERIC(12, 2) NOT NULL CHECK (max_quantity >= 0),
    remaining_quantity NUMERIC(12, 2) NOT NULL CHECK (remaining_quantity >= 0),
    expires_at BIGINT NOT NULL, -- Unix seconds
    signature TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Persons (Beneficiary Identity)
CREATE TABLE IF NOT EXISTS persons (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone_number TEXT NOT NULL UNIQUE,
    dob DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Household Profiles
CREATE TABLE IF NOT EXISTS household_profiles (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL UNIQUE REFERENCES persons(id) ON DELETE CASCADE,
    family_count INTEGER NOT NULL CHECK (family_count BETWEEN 1 AND 30),
    yearly_income NUMERIC(12, 2) NOT NULL CHECK (yearly_income >= 0),
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Citizen Registrations
CREATE TABLE IF NOT EXISTS registrations (
    id TEXT PRIMARY KEY,
    status registration_status NOT NULL DEFAULT 'SUBMITTED',
    node_id TEXT REFERENCES distribution_nodes(id) ON DELETE SET NULL,
    data JSONB NOT NULL,
    person_id TEXT REFERENCES persons(id) ON DELETE SET NULL,
    card_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Beneficiary Ration Cards
CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    status card_status NOT NULL DEFAULT 'ACTIVE',
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quota Ledgers / Leases
CREATE TABLE IF NOT EXISTS quota_leases (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL, -- specific terminal node_id or 'GLOBAL'
    allocated_qty NUMERIC(12, 2) NOT NULL CHECK (allocated_qty >= 0),
    consumed_qty NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (consumed_qty >= 0),
    period_start DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_quota_balance CHECK (consumed_qty <= allocated_qty)
);

-- Distribution Transactions
CREATE TABLE IF NOT EXISTS distribution_transactions (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
    node_id TEXT NOT NULL REFERENCES distribution_nodes(id) ON DELETE RESTRICT,
    lot_id TEXT NOT NULL REFERENCES grain_lots(id) ON DELETE RESTRICT,
    quantity NUMERIC(12, 2) NOT NULL CHECK (quantity > 0),
    state txn_state NOT NULL DEFAULT 'ATTEMPT',
    idempotency_key TEXT UNIQUE,
    failure_reason TEXT,
    fallback_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Transaction State History (Append-Only)
CREATE TABLE IF NOT EXISTS transaction_state_history (
    id TEXT PRIMARY KEY,
    txn_id TEXT NOT NULL REFERENCES distribution_transactions(id) ON DELETE CASCADE,
    from_state txn_state NOT NULL,
    to_state txn_state NOT NULL,
    reason_code TEXT,
    actor_id TEXT NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Provisional Tokens (Signed Offline Tokens)
CREATE TABLE IF NOT EXISTS provisional_tokens (
    id TEXT PRIMARY KEY,
    txn_id TEXT NOT NULL REFERENCES distribution_transactions(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    signature TEXT NOT NULL,
    key_id TEXT NOT NULL,
    nonce TEXT NOT NULL UNIQUE,
    counter INTEGER NOT NULL,
    reconciliation_status sync_ack_status NOT NULL DEFAULT 'ACCEPTED',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Failure Events (Diagnostic & Audit Trail)
CREATE TABLE IF NOT EXISTS failures (
    id TEXT PRIMARY KEY,
    txn_id TEXT,
    type TEXT NOT NULL,
    code TEXT NOT NULL,
    node_id TEXT NOT NULL,
    retryable BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit Events (Immutable Append-Only Log)
CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency Records
CREATE TABLE IF NOT EXISTS idempotency_records (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'DEFAULT',
    key TEXT NOT NULL,
    request_hash TEXT,
    status_code INTEGER NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_idempotency_scope_key UNIQUE (scope, key)
);

-- Sync Batches & Batch Items
CREATE TABLE IF NOT EXISTS sync_batches (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES distribution_nodes(id) ON DELETE RESTRICT,
    total_tokens INTEGER NOT NULL,
    accepted_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    rejected_count INTEGER NOT NULL DEFAULT 0,
    conflict_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_batch_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES sync_batches(id) ON DELETE CASCADE,
    token_id TEXT,
    nonce TEXT NOT NULL,
    ack_status sync_ack_status NOT NULL,
    reason_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. PERFORMANCE INDEXES
CREATE INDEX IF NOT EXISTS idx_persons_phone ON persons(phone_number);
CREATE INDEX IF NOT EXISTS idx_registrations_node ON registrations(node_id);
CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations(status);
CREATE INDEX IF NOT EXISTS idx_cards_person ON cards(person_id);
CREATE INDEX IF NOT EXISTS idx_quota_leases_card ON quota_leases(card_id);
CREATE INDEX IF NOT EXISTS idx_quota_leases_node ON quota_leases(node_id);
CREATE INDEX IF NOT EXISTS idx_transactions_card ON distribution_transactions(card_id);
CREATE INDEX IF NOT EXISTS idx_transactions_node ON distribution_transactions(node_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON distribution_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_provisional_tokens_nonce ON provisional_tokens(nonce);


-- 5. ATOMIC STORED PROCEDURES / RPC FUNCTIONS

-- Function: Approve Registration Atomically
CREATE OR REPLACE FUNCTION fn_approve_registration(
    p_reg_id TEXT,
    p_actor_id TEXT DEFAULT 'admin'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_reg RECORD;
    v_person_id TEXT;
    v_card_id TEXT;
    v_quota_id TEXT;
    v_profile_id TEXT;
    v_family_count INT;
    v_phone TEXT;
    v_quota_amount NUMERIC(12, 2);
    v_node_id TEXT;
    v_result JSONB;
BEGIN
    -- 1. Fetch and validate registration
    SELECT * INTO v_reg FROM registrations WHERE id = p_reg_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Registration % not found', p_reg_id;
    END IF;

    IF v_reg.status NOT IN ('SUBMITTED', 'VERIFIED') THEN
        RAISE EXCEPTION 'Cannot approve registration in status %', v_reg.status;
    END IF;

    v_family_count := (v_reg.data->>'family_count')::INT;
    v_phone := v_reg.data->>'phone_number';
    v_node_id := COALESCE(v_reg.node_id, (SELECT id FROM distribution_nodes ORDER BY created_at ASC LIMIT 1));
    v_quota_amount := v_family_count * 10.0; -- 10kg per household member

    -- 2. Check phone uniqueness
    IF EXISTS (SELECT 1 FROM persons WHERE phone_number = v_phone) THEN
        RAISE EXCEPTION 'Phone number % is already registered to an approved citizen', v_phone;
    END IF;

    -- 3. Create Person
    v_person_id := 'person_' || encode(gen_random_bytes(8), 'hex');
    INSERT INTO persons (id, first_name, last_name, phone_number, dob)
    VALUES (
        v_person_id,
        v_reg.data->>'first_name',
        v_reg.data->>'last_name',
        v_phone,
        (v_reg.data->>'dob')::DATE
    );

    -- 4. Create Household Profile
    v_profile_id := 'prof_' || encode(gen_random_bytes(8), 'hex');
    INSERT INTO household_profiles (id, person_id, family_count, yearly_income, address, city, state)
    VALUES (
        v_profile_id,
        v_person_id,
        v_family_count,
        (v_reg.data->>'yearly_income')::NUMERIC,
        v_reg.data->>'address',
        v_reg.data->>'city',
        v_reg.data->>'state'
    );

    -- 5. Create Card
    v_card_id := 'card_' || encode(gen_random_bytes(6), 'hex');
    INSERT INTO cards (id, person_id, status, issued_at)
    VALUES (v_card_id, v_person_id, 'ACTIVE', NOW());

    -- 6. Allocate Monthly Quota Lease (associated with registration node)
    v_quota_id := 'quota_' || encode(gen_random_bytes(6), 'hex');
    INSERT INTO quota_leases (id, card_id, node_id, allocated_qty, consumed_qty, period_start)
    VALUES (v_quota_id, v_card_id, v_node_id, v_quota_amount, 0, CURRENT_DATE);

    -- 7. Update Registration to APPROVED
    UPDATE registrations
    SET status = 'APPROVED',
        person_id = v_person_id,
        card_id = v_card_id,
        node_id = v_node_id,
        updated_at = NOW()
    WHERE id = p_reg_id;

    -- 8. Audit Event
    INSERT INTO audit_events (id, actor_id, action, resource_type, resource_id, details, timestamp)
    VALUES (
        'audit_' || encode(gen_random_bytes(8), 'hex'),
        p_actor_id,
        'REGISTRATION_APPROVED',
        'REGISTRATION',
        p_reg_id,
        jsonb_build_object(
            'person_id', v_person_id,
            'card_id', v_card_id,
            'allocated_quota', v_quota_amount,
            'node_id', v_node_id
        ),
        NOW()
    );

    -- 9. Return JSON payload
    SELECT jsonb_build_object(
        'success', true,
        'registration_id', p_reg_id,
        'person_id', v_person_id,
        'card_id', v_card_id,
        'allocated_qty', v_quota_amount,
        'node_id', v_node_id
    ) INTO v_result;

    RETURN v_result;
END;
$$;


-- Function: Atomic Online Grain Dispense
CREATE OR REPLACE FUNCTION fn_online_dispense(
    p_idempotency_key TEXT,
    p_card_id TEXT,
    p_lot_id TEXT,
    p_node_id TEXT,
    p_quantity NUMERIC,
    p_actor_id TEXT DEFAULT 'distribution-operator'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_cached RECORD;
    v_card RECORD;
    v_lot RECORD;
    v_lease RECORD;
    v_txn_id TEXT;
    v_hist_id TEXT;
    v_audit_id TEXT;
    v_response JSONB;
BEGIN
    -- 1. Check Idempotency Key
    IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
        SELECT * INTO v_cached FROM idempotency_records WHERE key = p_idempotency_key;
        IF FOUND THEN
            RETURN v_cached.response_body;
        END IF;
    END IF;

    -- 2. Validate input parameters
    IF p_quantity <= 0 THEN
        RAISE EXCEPTION 'Quantity must be greater than zero';
    END IF;

    -- 3. Row lock on Card
    SELECT * INTO v_card FROM cards WHERE id = p_card_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Card % not found', p_card_id;
    END IF;
    IF v_card.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Card % is not ACTIVE (status: %)', p_card_id, v_card.status;
    END IF;

    -- 4. Row lock on Quota Lease
    SELECT * INTO v_lease FROM quota_leases
    WHERE card_id = p_card_id AND (node_id = p_node_id OR node_id = 'GLOBAL')
    ORDER BY (allocated_qty - consumed_qty) DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND OR (v_lease.allocated_qty - v_lease.consumed_qty) < p_quantity THEN
        -- Quota limit reached
        v_txn_id := 'txn_' || encode(gen_random_bytes(8), 'hex');
        INSERT INTO distribution_transactions (id, card_id, node_id, lot_id, quantity, state, idempotency_key, failure_reason)
        VALUES (v_txn_id, p_card_id, p_node_id, p_lot_id, p_quantity, 'FAIL_REASON', p_idempotency_key, 'ERR_201');

        INSERT INTO transaction_state_history (id, txn_id, from_state, to_state, reason_code, actor_id)
        VALUES ('hist_' || encode(gen_random_bytes(8), 'hex'), v_txn_id, 'ATTEMPT', 'FAIL_REASON', 'ERR_201', p_actor_id);

        INSERT INTO failures (id, txn_id, type, code, node_id, retryable, metadata)
        VALUES ('fail_' || encode(gen_random_bytes(8), 'hex'), v_txn_id, 'TXN_FAILURE', 'ERR_201', p_node_id, false,
            jsonb_build_object('reason', 'Quota exceeded', 'card_id', p_card_id, 'requested', p_quantity));

        v_response := jsonb_build_object(
            'success', false,
            'code', 'ERR_201',
            'state', 'FAIL_REASON',
            'message', 'Beneficiary Quota Limit Exceeded. Card balance cannot fulfill this quantity.',
            'transaction_id', v_txn_id
        );

        IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
            INSERT INTO idempotency_records (id, key, status_code, response_body)
            VALUES ('idem_' || encode(gen_random_bytes(8), 'hex'), p_idempotency_key, 409, v_response);
        END IF;

        RETURN v_response;
    END IF;

    -- 5. Row lock on Grain Lot
    SELECT * INTO v_lot FROM grain_lots WHERE id = p_lot_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Grain lot % not found', p_lot_id;
    END IF;

    IF v_lot.remaining_quantity < p_quantity THEN
        -- Lot depleted
        v_txn_id := 'txn_' || encode(gen_random_bytes(8), 'hex');
        INSERT INTO distribution_transactions (id, card_id, node_id, lot_id, quantity, state, idempotency_key, failure_reason)
        VALUES (v_txn_id, p_card_id, p_node_id, p_lot_id, p_quantity, 'FAIL_REASON', p_idempotency_key, 'ERR_202');

        INSERT INTO transaction_state_history (id, txn_id, from_state, to_state, reason_code, actor_id)
        VALUES ('hist_' || encode(gen_random_bytes(8), 'hex'), v_txn_id, 'ATTEMPT', 'FAIL_REASON', 'ERR_202', p_actor_id);

        INSERT INTO failures (id, txn_id, type, code, node_id, retryable, metadata)
        VALUES ('fail_' || encode(gen_random_bytes(8), 'hex'), v_txn_id, 'TXN_FAILURE', 'ERR_202', p_node_id, false,
            jsonb_build_object('reason', 'Lot depleted', 'lot_id', p_lot_id, 'remaining', v_lot.remaining_quantity));

        v_response := jsonb_build_object(
            'success', false,
            'code', 'ERR_202',
            'state', 'FAIL_REASON',
            'message', 'Emergency Grain Lot Depleted. The lot does not have sufficient remaining grain.',
            'transaction_id', v_txn_id
        );

        IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
            INSERT INTO idempotency_records (id, key, status_code, response_body)
            VALUES ('idem_' || encode(gen_random_bytes(8), 'hex'), p_idempotency_key, 409, v_response);
        END IF;

        RETURN v_response;
    END IF;

    -- 6. Apply atomic deductions
    UPDATE quota_leases
    SET consumed_qty = consumed_qty + p_quantity,
        updated_at = NOW()
    WHERE id = v_lease.id;

    UPDATE grain_lots
    SET remaining_quantity = remaining_quantity - p_quantity,
        updated_at = NOW()
    WHERE id = p_lot_id;

    -- 7. Record transaction & state transition (ATTEMPT -> PROVISIONAL_ISSUE -> RECONCILED)
    v_txn_id := 'txn_' || encode(gen_random_bytes(8), 'hex');
    INSERT INTO distribution_transactions (id, card_id, node_id, lot_id, quantity, state, idempotency_key)
    VALUES (v_txn_id, p_card_id, p_node_id, p_lot_id, p_quantity, 'RECONCILED', p_idempotency_key);

    INSERT INTO transaction_state_history (id, txn_id, from_state, to_state, actor_id)
    VALUES
        ('hist_' || encode(gen_random_bytes(8), 'hex'), v_txn_id, 'ATTEMPT', 'PROVISIONAL_ISSUE', p_actor_id),
        ('hist_' || encode(gen_random_bytes(8), 'hex'), v_txn_id, 'PROVISIONAL_ISSUE', 'RECONCILED', p_actor_id);

    -- 8. Audit Event
    INSERT INTO audit_events (id, actor_id, action, resource_type, resource_id, details)
    VALUES (
        'audit_' || encode(gen_random_bytes(8), 'hex'),
        p_actor_id,
        'GRAIN_DISPENSED_ONLINE',
        'TRANSACTION',
        v_txn_id,
        jsonb_build_object(
            'card_id', p_card_id,
            'lot_id', p_lot_id,
            'node_id', p_node_id,
            'quantity', p_quantity,
            'remaining_lot_stock', v_lot.remaining_quantity - p_quantity,
            'remaining_quota', v_lease.allocated_qty - (v_lease.consumed_qty + p_quantity)
        )
    );

    v_response := jsonb_build_object(
        'success', true,
        'state', 'RECONCILED',
        'transaction_id', v_txn_id,
        'quantity', p_quantity,
        'lot_id', p_lot_id,
        'card_id', p_card_id,
        'remaining_lot_qty', v_lot.remaining_quantity - p_quantity,
        'remaining_card_qty', v_lease.allocated_qty - (v_lease.consumed_qty + p_quantity)
    );

    IF p_idempotency_key IS NOT NULL AND p_idempotency_key <> '' THEN
        INSERT INTO idempotency_records (id, key, status_code, response_body)
        VALUES ('idem_' || encode(gen_random_bytes(8), 'hex'), p_idempotency_key, 201, v_response);
    END IF;

    RETURN v_response;
END;
$$;


-- Function: Atomic Batch Synchronization & Reconciliation
CREATE OR REPLACE FUNCTION fn_reconcile_sync_batch(
    p_node_id TEXT,
    p_batch_id TEXT,
    p_tokens JSONB,
    p_actor_id TEXT DEFAULT 'edge-sync'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_token RECORD;
    v_token_id TEXT;
    v_nonce TEXT;
    v_lot_id TEXT;
    v_qty NUMERIC;
    v_card_ref TEXT;
    v_card_id TEXT;
    v_exp BIGINT;
    v_now_sec BIGINT;
    v_ack_status sync_ack_status;
    v_reason TEXT;
    v_accepted_cnt INT := 0;
    v_duplicate_cnt INT := 0;
    v_rejected_cnt INT := 0;
    v_conflict_cnt INT := 0;
    v_acks JSONB := '[]'::jsonb;
    v_txn_id TEXT;
BEGIN
    v_now_sec := EXTRACT(EPOCH FROM NOW())::BIGINT;

    -- 1. Register Batch
    INSERT INTO sync_batches (id, node_id, total_tokens)
    VALUES (p_batch_id, p_node_id, jsonb_array_length(p_tokens))
    ON CONFLICT (id) DO NOTHING;

    -- 2. Loop through tokens
    FOR v_token IN SELECT * FROM jsonb_array_elements(p_tokens)
    LOOP
        v_nonce := v_token.value->'payload'->>'n';
        v_token_id := COALESCE(v_token.value->>'id', 'tok_' || encode(gen_random_bytes(6), 'hex'));
        v_lot_id := v_token.value->'payload'->>'lid';
        v_qty := (v_token.value->'payload'->>'qty')::NUMERIC;
        v_exp := (v_token.value->'payload'->>'exp')::BIGINT;
        v_card_ref := v_token.value->'payload'->>'sub';
        v_ack_status := 'ACCEPTED';
        v_reason := NULL;

        -- Check Replay / Duplicate Nonce
        IF EXISTS (SELECT 1 FROM provisional_tokens WHERE nonce = v_nonce) THEN
            v_ack_status := 'DUPLICATE';
            v_reason := 'ERR_302';
            v_duplicate_cnt := v_duplicate_cnt + 1;
        ELSIF v_exp < v_now_sec THEN
            v_ack_status := 'REJECTED';
            v_reason := 'ERR_402'; -- Expired token window
            v_rejected_cnt := v_rejected_cnt + 1;
        ELSIF NOT EXISTS (SELECT 1 FROM grain_lots WHERE id = v_lot_id) THEN
            v_ack_status := 'CONFLICT';
            v_reason := 'ERR_401'; -- Missing lot
            v_conflict_cnt := v_conflict_cnt + 1;
        ELSE
            -- Accept and reconcile
            -- Decrement central lot stock if capacity remains
            UPDATE grain_lots
            SET remaining_quantity = GREATEST(0, remaining_quantity - v_qty),
                updated_at = NOW()
            WHERE id = v_lot_id;

            -- Match card if possible
            SELECT id INTO v_card_id FROM cards LIMIT 1; -- fallback card reference

            v_txn_id := COALESCE(v_token.value->'payload'->>'tid', 'txn_' || encode(gen_random_bytes(8), 'hex'));

            -- Record provisional token in DB
            INSERT INTO provisional_tokens (id, txn_id, payload, signature, key_id, nonce, counter, reconciliation_status)
            VALUES (
                v_token_id,
                v_txn_id,
                v_token.value->'payload',
                v_token.value->>'signature',
                COALESCE(v_token.value->>'key_id', p_node_id),
                v_nonce,
                COALESCE((v_token.value->'payload'->>'c')::INT, 1),
                'ACCEPTED'
            );

            v_accepted_cnt := v_accepted_cnt + 1;
        END IF;

        -- Record Batch Item ACK
        INSERT INTO sync_batch_items (id, batch_id, token_id, nonce, ack_status, reason_code)
        VALUES ('ack_' || encode(gen_random_bytes(6), 'hex'), p_batch_id, v_token_id, v_nonce, v_ack_status, v_reason);

        v_acks := v_acks || jsonb_build_object(
            'token_id', v_token_id,
            'nonce', v_nonce,
            'status', v_ack_status,
            'reason_code', v_reason
        );
    END LOOP;

    -- 3. Update Sync Batch Stats
    UPDATE sync_batches
    SET accepted_count = v_accepted_cnt,
        duplicate_count = v_duplicate_cnt,
        rejected_count = v_rejected_cnt,
        conflict_count = v_conflict_cnt
    WHERE id = p_batch_id;

    -- 4. Update Node Heartbeat and Outbox Depth
    UPDATE distribution_nodes
    SET last_heartbeat = NOW(),
        outbox_depth = 0,
        status = 'ONLINE',
        updated_at = NOW()
    WHERE id = p_node_id;

    -- 5. Audit Log
    INSERT INTO audit_events (id, actor_id, action, resource_type, resource_id, details)
    VALUES (
        'audit_' || encode(gen_random_bytes(8), 'hex'),
        p_actor_id,
        'BATCH_SYNC_PROCESSED',
        'NODE',
        p_node_id,
        jsonb_build_object(
            'batch_id', p_batch_id,
            'accepted', v_accepted_cnt,
            'duplicate', v_duplicate_cnt,
            'rejected', v_rejected_cnt,
            'conflict', v_conflict_cnt
        )
    );

    RETURN jsonb_build_object(
        'batch_id', p_batch_id,
        'accepted', v_accepted_cnt,
        'duplicate', v_duplicate_cnt,
        'rejected', v_rejected_cnt,
        'conflict', v_conflict_cnt,
        'acknowledgements', v_acks
    );
END;
$$;


-- Function: Reset Database (For Demo / Development Resets)
CREATE OR REPLACE FUNCTION fn_reset_database(p_actor_id TEXT DEFAULT 'admin')
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
    TRUNCATE TABLE
        sync_batch_items,
        sync_batches,
        idempotency_records,
        failures,
        provisional_tokens,
        transaction_state_history,
        distribution_transactions,
        quota_leases,
        cards,
        registrations,
        household_profiles,
        persons,
        lot_cap_grants,
        grain_lots,
        distribution_nodes,
        audit_events
    CASCADE;

    INSERT INTO audit_events (id, actor_id, action, resource_type, resource_id, details)
    VALUES (
        'audit_' || encode(gen_random_bytes(8), 'hex'),
        p_actor_id,
        'DATABASE_RESET',
        'SYSTEM',
        'central_db',
        '{"note": "Database cleared and re-initialized"}'::jsonb
    );

    RETURN jsonb_build_object('success', true, 'message', 'Database cleared successfully');
END;
$$;

-- 6. ROW LEVEL SECURITY (RLS) POLICIES
ALTER TABLE distribution_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE grain_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_cap_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE distribution_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_state_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE provisional_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

-- Allow public read access to operational tables for authorized UI views
CREATE POLICY "Public read distribution_nodes" ON distribution_nodes FOR SELECT USING (true);
CREATE POLICY "Public read grain_lots" ON grain_lots FOR SELECT USING (true);
CREATE POLICY "Public read registrations" ON registrations FOR SELECT USING (true);
CREATE POLICY "Public insert registrations" ON registrations FOR INSERT WITH CHECK (true);
CREATE POLICY "Public update registrations" ON registrations FOR UPDATE USING (true);
CREATE POLICY "Public read cards" ON cards FOR SELECT USING (true);
CREATE POLICY "Public read quota_leases" ON quota_leases FOR SELECT USING (true);
CREATE POLICY "Public read distribution_transactions" ON distribution_transactions FOR SELECT USING (true);
CREATE POLICY "Public read audit_events" ON audit_events FOR SELECT USING (true);
CREATE POLICY "Public read failures" ON failures FOR SELECT USING (true);

-- Deny client deletes on audit rows to maintain append-only immutability
CREATE POLICY "Deny delete audit_events" ON audit_events FOR DELETE USING (false);
CREATE POLICY "Deny update audit_events" ON audit_events FOR UPDATE USING (false);

-- 7. REALTIME PUBLICATION
DO $$ BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE
        cards,
        grain_lots,
        distribution_transactions,
        registrations,
        distribution_nodes,
        audit_events;
EXCEPTION WHEN duplicate_object THEN null;
          WHEN undefined_object THEN null;
END $$;
