-- supabase/seed.sql
-- Seed data for GrainTrust PDS: Terminals, Grain Lots, Grants, and Sample Citizen Registrations

-- 1. DISTRIBUTION NODES
INSERT INTO distribution_nodes (id, name, public_key, status, outbox_depth, location)
VALUES
    ('node-alpha-001', 'Sector 4 Community Depot', 'd41d8cd98f00b204e9800998ecf8427e00000000000000000000000000000001', 'ONLINE', 0, 'Kanpur Urban Sector 4'),
    ('node-beta-002', 'Rural Outpost Station 9', 'd41d8cd98f00b204e9800998ecf8427e00000000000000000000000000000002', 'ONLINE', 0, 'Bithoor Rural Block 9')
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    location = EXCLUDED.location,
    status = EXCLUDED.status;

-- 2. GRAIN LOTS
INSERT INTO grain_lots (id, name, grain_type, total_quantity, remaining_quantity)
VALUES
    ('lot-wheat-2026-q1', 'Emergency Buffer Wheat Lot #44', 'WHEAT', 5000.00, 4850.00),
    ('lot-rice-2026-q1', 'Fortified Sona Masoori Rice Lot #12', 'RICE', 3000.00, 2950.00)
ON CONFLICT (id) DO UPDATE SET
    total_quantity = EXCLUDED.total_quantity,
    remaining_quantity = EXCLUDED.remaining_quantity;

-- 3. LOT-CAP GRANTS FOR NODES
INSERT INTO lot_cap_grants (id, lot_id, node_id, max_quantity, remaining_quantity, expires_at, signature)
VALUES
    ('grant-alpha-wheat', 'lot-wheat-2026-q1', 'node-alpha-001', 500.00, 500.00, EXTRACT(EPOCH FROM (NOW() + INTERVAL '7 days'))::BIGINT, 'sig_mock_grant_alpha'),
    ('grant-beta-wheat', 'lot-wheat-2026-q1', 'node-beta-002', 500.00, 500.00, EXTRACT(EPOCH FROM (NOW() + INTERVAL '7 days'))::BIGINT, 'sig_mock_grant_beta')
ON CONFLICT (id) DO NOTHING;

-- 4. INITIAL AUDIT EVENT
INSERT INTO audit_events (id, actor_id, action, resource_type, resource_id, details)
VALUES (
    'audit_system_init',
    'system',
    'SYSTEM_INITIALIZED',
    'SYSTEM',
    'central_ledger',
    '{"message": "GrainTrust central ledger seeded with initial depots and grain reserves"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;
