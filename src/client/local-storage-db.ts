// src/client/local-storage-db.ts
/**
 * Autonomous Client-Side JSON Database Engine for RationSafe
 * Provides persistent offline-first storage in browser localStorage.
 * This fallback is sanitized to avoid storing plaintext PII.
 */

export interface CardBeneficiary {
  id: string;
  person_id: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  issued_at: string;
  first_name: string;
  last_name: string;
  full_name: string;
  phone_number: string;
  family_count: number;
  address: string;
  city: string;
  state: string;
  allocated_qty: number;
  consumed_qty: number;
  remaining_qty: number;
  machine_id?: string;
  machine_name?: string;
}

export interface MachineTelemetry {
  machine_id: string;
  session_id: string;
  machine_name: string;
  role: string;
  status: 'ONLINE' | 'OFFLINE';
  is_online: boolean;
  last_ping: string;
  outbox_count: number;
  disbursed_total: number;
  cards_count: number;
  node_id: string;
  location: string;
}

export interface MachineEventLog {
  id: string;
  machine_id: string;
  session_id: string;
  machine_name: string;
  event_type: 'MACHINE_OFFLINE' | 'MACHINE_ONLINE' | 'BATCH_SYNC' | 'DISPENSE' | 'CARD_ENROLLED' | 'SUPERVISOR_OVERRIDE';
  title: string;
  message: string;
  timestamp: string;
  details?: any;
}

export const PRESET_MACHINES = [
  {
    id: 'MACH-01',
    name: 'Laptop 1 (Depot Alpha - Kanpur Urban)',
    location: 'Kanpur Urban Sector 4',
    nodeId: 'node-alpha-001',
    defaultRole: 'DISTRIBUTION_OPERATOR',
  },
  {
    id: 'MACH-02',
    name: 'Laptop 2 (Outpost 9 - Bithoor Rural)',
    location: 'Bithoor Rural Block 9',
    nodeId: 'node-beta-002',
    defaultRole: 'DISTRIBUTION_OPERATOR',
  },
  {
    id: 'MACH-03',
    name: 'Laptop 3 (Mobile POS Unit 3 - Ganga Ghat)',
    location: 'Ganga Ghat Fair Price Post',
    nodeId: 'node-alpha-001',
    defaultRole: 'REGISTRATION_OPERATOR',
  },
  {
    id: 'MACH-04',
    name: 'Laptop 4 (Central Governance & Command Hub)',
    location: 'State Command Center',
    nodeId: 'node-alpha-001',
    defaultRole: 'ADMINISTRATOR',
  },
];

export interface GrainLotItem {
  id: string;
  name: string;
  grain_type: string;
  total_quantity: number;
  remaining_quantity: number;
  initial_qty?: number;
  remaining_qty?: number;
  unit?: string;
  commodity?: string;
  status?: string;
}

export interface NodeItem {
  id: string;
  name: string;
  public_key: string;
  status: 'ONLINE' | 'OFFLINE';
  last_heartbeat: string;
  outbox_depth: number;
  location?: string;
  is_online?: boolean;
  last_sync?: string;
}

export interface RegistrationItem {
  id: string;
  status: 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'APPROVED' | 'REJECTED';
  node_id?: string;
  data: {
    first_name: string;
    last_name: string;
    phone_number: string;
    dob: string;
    family_count: number;
    yearly_income: number;
    address: string;
    city: string;
    state: string;
    consent_opt_in?: boolean;
  };
  person_id?: string;
  card_id?: string;
  created_at: string;
  updated_at?: string;
}

export interface AuditLogItem {
  id: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  details: Record<string, unknown> | string;
  timestamp: string;
  event_type?: string;
}

export interface LocalDatabaseState {
  cards: CardBeneficiary[];
  lots: GrainLotItem[];
  nodes: NodeItem[];
  registrations: RegistrationItem[];
  auditLogs: AuditLogItem[];
  metrics: {
    active_cards: number;
    total_grain_disbursed: number;
    reconciliation_rate: number;
    pending_audit_events: number;
  };
}

const STORAGE_KEY = 'rationsafe_json_store_v1';

function redactString(value: string): string {
  if (!value) return value;
  return value.length <= 2 ? '[REDACTED]' : '[REDACTED]';
}

function sanitizeAuditDetails(details: AuditLogItem['details']): AuditLogItem['details'] {
  if (typeof details === 'string') {
    return '[REDACTED]';
  }
  if (!details || typeof details !== 'object') {
    return { message: '[REDACTED]' };
  }

  const clone = { ...(details as Record<string, unknown>) };
  for (const key of Object.keys(clone)) {
    const val = clone[key];
    if (typeof val === 'string') {
      clone[key] = '[REDACTED]';
    }
  }
  return clone;
}

export function sanitizeForStorage(state: LocalDatabaseState): LocalDatabaseState {
  return {
    ...state,
    cards: state.cards.map((card) => ({
      ...card,
      first_name: redactString(card.first_name),
      last_name: redactString(card.last_name),
      full_name: redactString(card.full_name),
      phone_number: redactString(card.phone_number),
      address: redactString(card.address),
      city: redactString(card.city),
      state: redactString(card.state),
    })),
    registrations: state.registrations.map((reg) => ({
      ...reg,
      data: {
        ...reg.data,
        first_name: redactString(reg.data.first_name),
        last_name: redactString(reg.data.last_name),
        phone_number: redactString(reg.data.phone_number),
        address: redactString(reg.data.address),
        city: redactString(reg.data.city),
        state: redactString(reg.data.state),
      },
    })),
    auditLogs: state.auditLogs.map((log) => ({
      ...log,
      actor_id: redactString(log.actor_id),
      resource_id: redactString(log.resource_id),
      details: sanitizeAuditDetails(log.details),
    })),
  };
}

export function getInitialSeedDatabase(): LocalDatabaseState {
  const cards: CardBeneficiary[] = [
    {
      id: 'card-demo-001',
      person_id: 'person-001',
      status: 'ACTIVE',
      issued_at: '2026-10-10T08:30:00Z',
      first_name: 'Aarav',
      last_name: 'Sharma',
      full_name: 'Aarav Sharma',
      phone_number: '+91 98765 43210',
      family_count: 4,
      address: 'Sector 8, Ward 12',
      city: 'Kanpur',
      state: 'Uttar Pradesh',
      allocated_qty: 20,
      consumed_qty: 5,
      remaining_qty: 15,
      machine_id: 'MACH-01',
      machine_name: 'Laptop 1 (Depot Alpha - Kanpur Urban)',
    },
    {
      id: 'card-demo-002',
      person_id: 'person-002',
      status: 'ACTIVE',
      issued_at: '2026-10-11T09:15:00Z',
      first_name: 'Priya',
      last_name: 'Patel',
      full_name: 'Priya Patel',
      phone_number: '+91 98123 45678',
      family_count: 3,
      address: 'Village Chowk, Station Rd',
      city: 'Unnao',
      state: 'Uttar Pradesh',
      allocated_qty: 15,
      consumed_qty: 10,
      remaining_qty: 5,
      machine_id: 'MACH-02',
      machine_name: 'Laptop 2 (Outpost 9 - Bithoor Rural)',
    },
    {
      id: 'card-demo-003',
      person_id: 'person-003',
      status: 'ACTIVE',
      issued_at: '2026-10-12T11:45:00Z',
      first_name: 'Sunita',
      last_name: 'Devi',
      full_name: 'Sunita Devi',
      phone_number: '+91 98234 56789',
      family_count: 5,
      address: 'Near Old Water Tank, Ward 4',
      city: 'Lucknow',
      state: 'Uttar Pradesh',
      allocated_qty: 25,
      consumed_qty: 0,
      remaining_qty: 25,
      machine_id: 'MACH-03',
      machine_name: 'Laptop 3 (Mobile POS Unit 3 - Ganga Ghat)',
    },
    {
      id: 'card-demo-004',
      person_id: 'person-004',
      status: 'ACTIVE',
      issued_at: '2026-10-13T10:00:00Z',
      first_name: 'Fatima',
      last_name: 'Sheikh',
      full_name: 'Fatima Sheikh',
      phone_number: '+91 98223 34455',
      family_count: 3,
      address: 'Block C, Sector 4',
      city: 'Kanpur',
      state: 'Uttar Pradesh',
      allocated_qty: 30,
      consumed_qty: 0,
      remaining_qty: 30,
      machine_id: 'MACH-01',
      machine_name: 'Laptop 1 (Depot Alpha - Kanpur Urban)',
    },
    {
      id: 'card-demo-005',
      person_id: 'person-005',
      status: 'ACTIVE',
      issued_at: '2026-10-14T14:20:00Z',
      first_name: 'Vikram',
      last_name: 'Singh',
      full_name: 'Vikram Singh',
      phone_number: '+91 98334 55667',
      family_count: 4,
      address: 'Rural Post 9',
      city: 'Bithoor',
      state: 'Uttar Pradesh',
      allocated_qty: 30,
      consumed_qty: 0,
      remaining_qty: 30,
      machine_id: 'MACH-02',
      machine_name: 'Laptop 2 (Outpost 9 - Bithoor Rural)',
    },
  ];

  const lots: GrainLotItem[] = [
    {
      id: 'lot-wheat-2026-01',
      name: 'National Reserve Wheat Batch 2026-A',
      grain_type: 'Wheat',
      remaining_quantity: 4835,
      total_quantity: 5000,
    },
    {
      id: 'lot-rice-2026-02',
      name: 'Emergency Stockpile Rice 2026-B',
      grain_type: 'Rice',
      remaining_quantity: 3390,
      total_quantity: 3500,
    },
  ];

  const nodes: NodeItem[] = [
    {
      id: 'node-alpha-001',
      name: 'Distribution Node Alpha (District 1)',
      public_key: 'ed25519_pub_alpha_8f9a2b1c3d4e5f60718293a4b5c6d7e8',
      status: 'ONLINE',
      last_heartbeat: new Date().toISOString(),
      outbox_depth: 0,
      location: 'Sector 4 Community Depot',
    },
    {
      id: 'node-beta-002',
      name: 'Distribution Node Beta (Rural Outpost)',
      public_key: 'ed25519_pub_beta_1a2b3c4d5e6f708192a3b4c5d6e7f8a9',
      status: 'ONLINE',
      last_heartbeat: new Date().toISOString(),
      outbox_depth: 0,
      location: 'Rural Outpost Station 9',
    },
  ];

  const registrations: RegistrationItem[] = [
    {
      id: 'reg-demo-101',
      person_id: 'person-demo-101',
      node_id: 'node-alpha-001',
      status: 'SUBMITTED',
      created_at: new Date(Date.now() - 3600000).toISOString(),
      updated_at: new Date(Date.now() - 3600000).toISOString(),
      data: {
        first_name: 'Ramesh',
        last_name: 'Verma',
        phone_number: '+91 98555 12345',
        dob: '1988-04-12',
        family_count: 4,
        yearly_income: 48000,
        address: 'Basti No. 4, G.T. Road',
        city: 'Kanpur',
        state: 'Uttar Pradesh',
        consent_opt_in: true,
      },
    },
  ];

  const auditLogs: AuditLogItem[] = [
    {
      id: 'audit-001',
      timestamp: new Date(Date.now() - 7200000).toISOString(),
      action: 'SYSTEM_BOOT',
      event_type: 'SYSTEM_BOOT',
      actor_id: 'system',
      resource_type: 'ledger_core',
      resource_id: 'ledger_core',
      details: { message: 'JSON local ledger initialized with sovereign seed reserves.' },
    },
    {
      id: 'audit-002',
      timestamp: new Date(Date.now() - 3600000).toISOString(),
      action: 'CITIZEN_ENROLLED',
      event_type: 'CITIZEN_ENROLLED',
      actor_id: 'operator-desk',
      resource_type: 'registration',
      resource_id: 'reg-demo-101',
      details: { message: 'Beneficiary registration submitted for Ramesh Verma.' },
    },
  ];

  return {
    cards,
    lots,
    nodes,
    registrations,
    auditLogs,
    metrics: {
      active_cards: cards.length,
      total_grain_disbursed: 15,
      reconciliation_rate: 100,
      pending_audit_events: 0,
    },
  };
}

export function loadDatabase(): LocalDatabaseState {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.cards && parsed.lots && parsed.nodes) {
          return {
            cards: parsed.cards || [],
            lots: parsed.lots || [],
            nodes: (parsed.nodes || []).map((n: any, idx: number) => ({
              ...n,
              public_key: n.public_key || (idx === 0 ? 'ed25519_pub_alpha_8f9a2b1c3d4e5f60718293a4b5c6d7e8' : 'ed25519_pub_beta_1a2b3c4d5e6f708192a3b4c5d6e7f8a9'),
              last_heartbeat: n.last_heartbeat || new Date().toISOString(),
              location: n.location || 'Depot',
            })),
            registrations: (parsed.registrations || []).map((r: any) => ({
              ...r,
              node_id: r.node_id || 'node-alpha-001',
              updated_at: r.updated_at || r.created_at || new Date().toISOString(),
            })),
            auditLogs: (parsed.auditLogs || []).map((l: any) => ({
              ...l,
              action: l.action || l.event_type || 'SYSTEM_EVENT',
              resource_type: l.resource_type || 'system',
              details: typeof l.details === 'object' && l.details !== null ? l.details : { message: String(l.details || '') },
            })),
            metrics: parsed.metrics || {
              active_cards: (parsed.cards || []).length,
              total_grain_disbursed: 15,
              reconciliation_rate: 100,
              pending_audit_events: 0,
            },
          };
        }
      }
    }
  } catch (e) {
    console.warn('[LocalJSONDB] Read error, resetting to seed defaults:', e);
  }

  const initial = getInitialSeedDatabase();
  saveDatabase(initial);
  return initial;
}

export function saveDatabase(state: LocalDatabaseState): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const sanitized = sanitizeForStorage(state);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
    }
  } catch (e) {
    console.error('[LocalJSONDB] Write error:', e);
  }
}

export function resetDatabase(): LocalDatabaseState {
  const fresh = getInitialSeedDatabase();
  saveDatabase(fresh);
  return fresh;
}

export function recordRegistration(
  formData: RegistrationItem['data'],
  nodeId: string = 'node-alpha-001'
): { reg: RegistrationItem; state: LocalDatabaseState } {
  const db = loadDatabase();
  const id = `reg-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
  const now = new Date().toISOString();
  const reg: RegistrationItem = {
    id,
    person_id: `person-${Date.now().toString(36)}`,
    node_id: nodeId,
    status: 'SUBMITTED',
    created_at: now,
    updated_at: now,
    data: { ...formData },
  };
  db.registrations = [reg, ...db.registrations];
  db.auditLogs = [
    {
      id: `audit-${Date.now().toString(36)}`,
      timestamp: now,
      action: 'CITIZEN_ENROLLED',
      event_type: 'CITIZEN_ENROLLED',
      actor_id: 'operator-desk',
      resource_type: 'registration',
      resource_id: id,
      details: {
        message: `Beneficiary registration submitted for ${formData.first_name} ${formData.last_name} (${nodeId}).`,
      },
    },
    ...db.auditLogs,
  ];
  saveDatabase(db);
  return { reg, state: db };
}

export function verifyAndApproveRegistration(
  regId: string
): { card: CardBeneficiary; reg: RegistrationItem; state: LocalDatabaseState } | null {
  const db = loadDatabase();
  const regIndex = db.registrations.findIndex((r) => r.id === regId);
  if (regIndex === -1) return null;

  const reg = db.registrations[regIndex];
  const cardId = `card-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
  const now = new Date().toISOString();

  reg.status = 'APPROVED';
  reg.card_id = cardId;
  reg.updated_at = now;

  const quota = (reg.data.family_count || 3) * 10;
  const newCard: CardBeneficiary = {
    id: cardId,
    person_id: reg.person_id || `person-${Date.now().toString(36)}`,
    status: 'ACTIVE',
    issued_at: now,
    first_name: reg.data.first_name,
    last_name: reg.data.last_name,
    full_name: `${reg.data.first_name} ${reg.data.last_name}`,
    phone_number: reg.data.phone_number,
    family_count: reg.data.family_count,
    address: reg.data.address,
    city: reg.data.city,
    state: reg.data.state,
    allocated_qty: quota,
    consumed_qty: 0,
    remaining_qty: quota,
  };

  db.cards = [newCard, ...db.cards];
  db.metrics.active_cards = db.cards.length;
  db.auditLogs = [
    {
      id: `audit-${Date.now().toString(36)}`,
      timestamp: now,
      action: 'CARD_ISSUED',
      event_type: 'CARD_ISSUED',
      actor_id: 'supervisor-01',
      resource_type: 'card',
      resource_id: cardId,
      details: {
        message: `Card approved and ration quota (${quota}kg) allocated to ${newCard.full_name}.`,
        quota_allocated: quota,
      },
    },
    ...db.auditLogs,
  ];

  saveDatabase(db);
  return { card: newCard, reg, state: db };
}

export function recordDispense(
  cardId: string,
  lotId: string,
  nodeId: string,
  quantity: number,
  isOnline: boolean
): { state: LocalDatabaseState; card: CardBeneficiary; lot: GrainLotItem } | null {
  const db = loadDatabase();
  const cardIndex = db.cards.findIndex((c) => c.id === cardId);
  const lotIndex = db.lots.findIndex((l) => l.id === lotId);
  if (cardIndex === -1 || lotIndex === -1) return null;

  const card = db.cards[cardIndex];
  const lot = db.lots[lotIndex];

  card.consumed_qty += quantity;
  card.remaining_qty = Math.max(0, card.remaining_qty - quantity);

  lot.remaining_quantity = Math.max(0, lot.remaining_quantity - quantity);

  const node = db.nodes.find((n) => n.id === nodeId);
  if (!isOnline && node) {
    node.outbox_depth = (node.outbox_depth || 0) + 1;
  }

  db.metrics.total_grain_disbursed += quantity;

  const now = new Date().toISOString();
  db.auditLogs = [
    {
      id: `audit-${Date.now().toString(36)}`,
      timestamp: now,
      action: isOnline ? 'ONLINE_DISPENSE' : 'OFFLINE_TOKEN_ISSUED',
      event_type: isOnline ? 'ONLINE_DISPENSE' : 'OFFLINE_TOKEN_ISSUED',
      actor_id: isOnline ? 'staff-distributor' : nodeId,
      resource_type: 'distribution_transaction',
      resource_id: cardId,
      details: {
        message: `${isOnline ? 'Online ledger' : 'Offline signed token'}: Dispensed ${quantity}kg of ${lot.grain_type} to ${card.full_name}.`,
        quantity,
        lot_id: lotId,
      },
    },
    ...db.auditLogs,
  ];

  saveDatabase(db);
  return { state: db, card, lot };
}

export function recordSync(nodeId: string): { state: LocalDatabaseState; reconciledCount: number } {
  const db = loadDatabase();
  const node = db.nodes.find((n) => n.id === nodeId);
  const reconciledCount = node?.outbox_depth || 0;
  if (node) {
    node.outbox_depth = 0;
  }
  db.metrics.reconciliation_rate = 100;
  const now = new Date().toISOString();
  db.auditLogs = [
    {
      id: `audit-${Date.now().toString(36)}`,
      timestamp: now,
      action: 'BATCH_RECONCILIATION',
      event_type: 'BATCH_RECONCILIATION',
      actor_id: nodeId,
      resource_type: 'reconciliation',
      resource_id: 'ledger_core',
      details: {
        message: `Outbox reconciled: Synchronized ${reconciledCount} provisional tokens to ledger.`,
        reconciled_count: reconciledCount,
      },
    },
    ...db.auditLogs,
  ];
  saveDatabase(db);
  return { state: db, reconciledCount };
}

export function toggleNodeOnlineStatus(nodeId: string): { isOnline: boolean; state: LocalDatabaseState } {
  const db = loadDatabase();
  const node = db.nodes.find((n) => n.id === nodeId);
  let isOnline = true;
  if (node) {
    const nextStatus = node.status === 'ONLINE' ? 'OFFLINE' : 'ONLINE';
    node.status = nextStatus;
    node.is_online = nextStatus === 'ONLINE';
    isOnline = nextStatus === 'ONLINE';
    saveDatabase(db);
  }
  if (typeof window !== 'undefined') {
    localStorage.setItem(`graintrust_terminal_online_${nodeId}`, String(isOnline));
  }
  return { isOnline, state: db };
}
