// src/client/supabase.ts
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import type {
  CardBeneficiary,
  GrainLotItem,
  NodeItem,
  RegistrationItem,
  AuditLogItem,
  MachineTelemetry,
  MachineEventLog,
} from './local-storage-db.js';

const DEFAULT_SUPABASE_URL = 'https://byxvxvsvhiyeryavgafx.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5eHZ4dnN2aGl5ZXJ5YXZnYWZ4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwNzU3MjksImV4cCI6MjEwNzY1MTcyOX0.UU-Qs8cO4bcDZ-5qZA9xgEDRjLY1IDr65ZMaoyK3AsA';

const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || DEFAULT_SUPABASE_URL;
const supabaseAnonKey = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_ANON_KEY) || DEFAULT_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(
  supabaseUrl &&
  supabaseAnonKey &&
  !supabaseAnonKey.includes('dummy') &&
  !supabaseAnonKey.includes('your_anon') &&
  !supabaseAnonKey.includes('your-anon') &&
  !supabaseUrl.includes('your-project-ref')
);

export function getSupabaseStatus(): { configured: boolean; url: string; mode: 'cloud' | 'local' | 'standby' } {
  if (!isSupabaseConfigured) {
    return { configured: false, url: '', mode: 'standby' };
  }
  const isCloud = supabaseUrl.includes('.supabase.co');
  return {
    configured: true,
    url: supabaseUrl,
    mode: isCloud ? 'cloud' : 'local',
  };
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
      },
    })
  : null;

/**
 * Subscribes to realtime updates for RationSafe tables.
 * Calls `onUpdate` callback whenever any table changes.
 */
export function subscribeToGrainTrustUpdates(onUpdate: (table: string, payload: any) => void): RealtimeChannel | null {
  if (!isSupabaseConfigured || !supabase) {
    console.info('[Supabase] Standby mode: Set VITE_SUPABASE_URL & VITE_SUPABASE_ANON_KEY in .env to connect to live Supabase cloud.');
    return null;
  }

  console.info(`[Supabase] Connected to realtime channel: ${supabaseUrl}`);
  const channel = supabase
    .channel('rationsafe_realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, (payload) => onUpdate('cards', payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'grain_lots' }, (payload) => onUpdate('grain_lots', payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'registrations' }, (payload) => onUpdate('registrations', payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'distribution_transactions' }, (payload) => onUpdate('distribution_transactions', payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'distribution_nodes' }, (payload) => onUpdate('distribution_nodes', payload))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_events' }, (payload) => onUpdate('audit_events', payload))
    .subscribe();

  return channel;
}

/**
 * Safely fetches live cloud data from Supabase if tables exist.
 * Returns null if tables are not yet provisioned in the project schema.
 */
export async function fetchCloudDataFromSupabase(): Promise<{
  cards?: CardBeneficiary[];
  lots?: GrainLotItem[];
  nodes?: NodeItem[];
  registrations?: RegistrationItem[];
  auditLogs?: AuditLogItem[];
} | null> {
  if (!isSupabaseConfigured || !supabase) return null;

  try {
    const [cardsRes, lotsRes, nodesRes, regsRes, auditRes, ledgerRes, personsRes] = await Promise.all([
      supabase.from('cards').select('*'),
      supabase.from('grain_lots').select('*'),
      supabase.from('distribution_nodes').select('*'),
      supabase.from('registrations').select('*'),
      supabase.from('audit_events').select('*').order('created_at', { ascending: false }).limit(50),
      supabase.from('card_quota_ledger').select('*'),
      supabase.from('persons').select('*'),
    ]);

    // If any fundamental table is missing from schema cache, gracefully return null
    if (cardsRes.error || lotsRes.error || nodesRes.error) {
      return null;
    }

    const personsMap = new Map<string, any>((personsRes.data || []).map((p: any) => [p.id, p]));
    const ledgerMap = new Map<string, any>((ledgerRes.data || []).map((l: any) => [l.card_id, l]));

    const mappedCards: CardBeneficiary[] = (cardsRes.data || []).map((c: any) => {
      const person = personsMap.get(c.person_id) || {};
      const ledger = ledgerMap.get(c.id) || {};
      const allocated = Number(ledger.allocated_quantity || 30);
      const consumed = Number(ledger.consumed_quantity || 0);
      const remaining = Number(ledger.remaining_quantity ?? allocated - consumed);

      return {
        id: c.id,
        person_id: c.person_id,
        status: c.status || 'ACTIVE',
        issued_at: c.issued_at || c.created_at || new Date().toISOString(),
        first_name: person.first_name || 'Beneficiary',
        last_name: person.last_name || '',
        full_name: person.first_name ? `${person.first_name} ${person.last_name || ''}`.trim() : 'Verified Citizen',
        phone_number: person.phone_number || '',
        family_count: 3,
        address: person.address || 'Registered Residence',
        city: person.city || 'District Depot',
        state: person.state || 'State PDS',
        allocated_qty: allocated,
        consumed_qty: consumed,
        remaining_qty: remaining,
        machine_id: c.machine_id || person.machine_id || (c.id?.includes('mvpo') ? 'MACH-01' : undefined),
        machine_name: c.machine_name || person.machine_name || (c.id?.includes('mvpo') ? 'Laptop 1 (Depot Alpha - Kanpur Urban)' : undefined),
      };
    });

    const mappedLots: GrainLotItem[] = (lotsRes.data || []).map((l: any) => {
      const grainType = l.grain_type || (l.name?.toLowerCase().includes('rice') ? 'Rice' : 'Wheat');
      const total = Number(l.total_quantity ?? 5000);
      const remaining = Number(l.remaining_quantity ?? total);
      return {
        id: l.id,
        name: l.name || `${grainType} Reserve Lot`,
        grain_type: grainType,
        total_quantity: total,
        remaining_quantity: remaining,
        initial_qty: total,
        remaining_qty: remaining,
        unit: 'kg',
        commodity: grainType,
        status: remaining > 0 ? 'AVAILABLE' : 'DEPLETED',
      };
    });

    const mappedNodes: NodeItem[] = (nodesRes.data || []).map((n: any) => {
      const isOnlineStatus = n.status === 'OFFLINE' ? false : (n.status === 'ONLINE' || n.status === 'ACTIVE' || n.is_online === true);
      return {
        id: n.id,
        name: n.name || n.id,
        public_key: n.public_key || `ed25519_pub_${n.id}`,
        location: n.location || 'Fair Price Shop Depot',
        status: isOnlineStatus ? 'ONLINE' : 'OFFLINE',
        is_online: isOnlineStatus,
        last_heartbeat: n.last_heartbeat || new Date().toISOString(),
        last_sync: n.last_heartbeat || new Date().toISOString(),
        outbox_depth: Number(n.outbox_depth || 0),
      };
    });

    const mappedRegs: RegistrationItem[] = (regsRes.data || [])
      .filter((r: any) =>
        !r.id.startsWith('config_') &&
        !r.id.startsWith('mach_') &&
        r.data?.type !== 'MACHINE_TELEMETRY' &&
        r.data?.type !== 'MACHINE_EVENT_LOG' &&
        r.data?.type !== 'SYSTEM_ADMIN_CONFIG'
      )
      .map((r: any) => ({
        id: r.id,
        status: r.status,
        node_id: r.node_id,
        person_id: r.person_id,
        card_id: r.card_id,
        data: r.data || {},
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));

    const mappedAudit: AuditLogItem[] = (auditRes.data || []).map((a: any) => ({
      id: a.id,
      timestamp: a.timestamp || a.created_at || new Date().toISOString(),
      action: a.action,
      event_type: a.action,
      actor_id: a.actor_id || 'system',
      resource_type: a.resource_type || 'system',
      resource_id: a.resource_id || '',
      details: a.details || {},
    }));

    return {
      cards: mappedCards.length > 0 ? mappedCards : undefined,
      lots: mappedLots.length > 0 ? mappedLots : undefined,
      nodes: mappedNodes.length > 0 ? mappedNodes : undefined,
      registrations: mappedRegs,
      auditLogs: mappedAudit,
    };
  } catch (err) {
    console.warn('[Supabase] fetchCloudData error, falling back to local vault:', err);
    return null;
  }
}

/**
 * Inserts a new citizen registration into Supabase.
 */
export async function insertRegistrationToSupabase(reg: {
  id: string;
  node_id: string;
  data: any;
}): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  try {
    const { error } = await supabase.from('registrations').insert({
      id: reg.id,
      status: 'SUBMITTED',
      node_id: reg.node_id,
      data: reg.data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (error) {
      console.warn('[Supabase] Insert registration failed:', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[Supabase] Insert registration error:', e);
    return false;
  }
}

/**
 * Updates an approved registration and creates the corresponding person, card, and quota ledger in Supabase.
 */
export async function approveRegistrationInSupabase(
  regId: string,
  approvedCard: CardBeneficiary
): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  try {
    const now = new Date().toISOString();

    // 1. Update registration
    await supabase.from('registrations').update({
      status: 'APPROVED',
      card_id: approvedCard.id,
      person_id: approvedCard.person_id,
      updated_at: now,
    }).eq('id', regId);

    // 2. Upsert person
    await supabase.from('persons').upsert({
      id: approvedCard.person_id,
      first_name: approvedCard.first_name,
      last_name: approvedCard.last_name,
      phone_number: approvedCard.phone_number || `+9198${Date.now().toString().slice(-8)}`,
      dob: '1990-01-01',
      created_at: now,
    });

    // 3. Upsert card
    await supabase.from('cards').upsert({
      id: approvedCard.id,
      person_id: approvedCard.person_id,
      status: 'ACTIVE',
      issued_at: approvedCard.issued_at || now,
      created_at: now,
    });

    // 4. Upsert quota ledger
    await supabase.from('card_quota_ledger').upsert({
      id: `ledger-${approvedCard.id}`,
      card_id: approvedCard.id,
      period: now.slice(0, 7),
      allocated_quantity: approvedCard.allocated_qty,
      consumed_quantity: approvedCard.consumed_qty || 0,
      remaining_quantity: approvedCard.remaining_qty,
      updated_at: now,
    });

    // 5. Audit event
    await supabase.from('audit_events').insert({
      id: `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      actor_id: 'supervisor-01',
      action: 'CARD_ISSUED',
      resource_type: 'card',
      resource_id: approvedCard.id,
      details: {
        message: `Card approved and ration quota (${approvedCard.allocated_qty}kg) allocated to ${approvedCard.full_name}`,
        quota_allocated: approvedCard.allocated_qty,
      },
      timestamp: now,
    });

    return true;
  } catch (e) {
    console.warn('[Supabase] Approve registration in cloud error:', e);
    return false;
  }
}

/**
 * Records a dispense transaction in Supabase, updating stock and the beneficiary quota ledger.
 */
export async function recordDispenseInSupabase(
  card: CardBeneficiary,
  lotId: string,
  quantity: number,
  nodeId: string
): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  try {
    const now = new Date().toISOString();
    const newConsumed = card.consumed_qty + quantity;
    const newRemaining = Math.max(0, card.remaining_qty - quantity);

    // 1. Update card quota ledger
    await supabase.from('card_quota_ledger').upsert({
      id: `ledger-${card.id}`,
      card_id: card.id,
      period: now.slice(0, 7),
      allocated_quantity: card.allocated_qty,
      consumed_quantity: newConsumed,
      remaining_quantity: newRemaining,
      updated_at: now,
    });

    // 2. Fetch and decrement grain lot remaining stock
    const { data: lotData } = await supabase.from('grain_lots').select('remaining_quantity').eq('id', lotId).maybeSingle();
    if (lotData) {
      const updatedStock = Math.max(0, Number(lotData.remaining_quantity) - quantity);
      await supabase.from('grain_lots').update({
        remaining_quantity: updatedStock,
        updated_at: now,
      }).eq('id', lotId);
    }

    // 3. Insert transaction
    const txnId = `txn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    await supabase.from('distribution_transactions').insert({
      id: txnId,
      card_id: card.id,
      node_id: nodeId,
      lot_id: lotId,
      quantity,
      state: 'RECONCILED',
      created_at: now,
    });

    // 4. Insert audit event
    await supabase.from('audit_events').insert({
      id: `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      actor_id: nodeId,
      action: 'GRAIN_DISPENSED_ONLINE',
      resource_type: 'TRANSACTION',
      resource_id: txnId,
      details: {
        card_id: card.id,
        lot_id: lotId,
        quantity,
        remaining_quota: newRemaining,
      },
      timestamp: now,
    });

    return true;
  } catch (e) {
    console.warn('[Supabase] Record dispense in cloud error:', e);
    return false;
  }
}

/**
 * Centrally authenticates passwords against Supabase.
 * In offline mode, the caller must block Administrator access.
 */
export async function verifyRolePasswordInSupabase(
  password: string,
  targetRole?: string
): Promise<{ success: boolean; message?: string }> {
  if (!isSupabaseConfigured || !supabase) {
    const isOk = password === 'adrenaline';
    return { success: isOk, message: isOk ? undefined : 'Incorrect security password.' };
  }

  try {
    const { data, error } = await supabase
      .from('registrations')
      .select('data')
      .eq('id', 'config_admin_credentials')
      .maybeSingle();

    if (error) {
      console.warn('[Supabase] Verify role error:', error.message);
      const isOk = password === 'adrenaline';
      return { success: isOk, message: isOk ? undefined : 'Incorrect security password.' };
    }

    const storedHash = data?.data?.password_hash || 'adrenaline';
    if (password === storedHash) {
      return { success: true };
    }
    return { success: false, message: 'Incorrect security password.' };
  } catch (err: any) {
    console.warn('[Supabase] verifyRolePassword exception:', err);
    const isOk = password === 'adrenaline';
    return { success: isOk, message: isOk ? undefined : 'Authentication error.' };
  }
}

/**
 * Centrally authenticates the Administrator password against Supabase.
 * In offline mode, the caller must block access.
 */
export async function verifyAdminPasswordInSupabase(password: string): Promise<{ success: boolean; message?: string }> {
  return verifyRolePasswordInSupabase(password, 'ADMINISTRATOR');
}

/**
 * Updates the central administrator password in Supabase.
 */
export async function updateAdminPasswordInSupabase(newPassword: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  try {
    const { error } = await supabase.from('registrations').upsert({
      id: 'config_admin_credentials',
      node_id: 'node-alpha-001',
      status: 'SUBMITTED',
      data: {
        type: 'SYSTEM_ADMIN_CONFIG',
        password_hash: newPassword,
        updated_at: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    });
    return !error;
  } catch (e) {
    console.warn('[Supabase] updateAdminPassword error:', e);
    return false;
  }
}

/**
 * Upserts live machine presence and telemetry to Supabase.
 */
export async function upsertMachineTelemetryInSupabase(telemetry: MachineTelemetry): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  try {
    const { error } = await supabase.from('registrations').upsert({
      id: `mach_telemetry_${telemetry.machine_id}`,
      node_id: telemetry.node_id || 'node-alpha-001',
      status: 'SUBMITTED',
      data: {
        type: 'MACHINE_TELEMETRY',
        ...telemetry,
      },
      updated_at: new Date().toISOString(),
    });
    return !error;
  } catch (e) {
    console.warn('[Supabase] Upsert machine telemetry error:', e);
    return false;
  }
}

/**
 * Fetches collective fleet telemetry for all active/registered field machines.
 */
export async function fetchFleetTelemetryFromSupabase(): Promise<MachineTelemetry[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  try {
    const { data, error } = await supabase
      .from('registrations')
      .select('*')
      .like('id', 'mach_telemetry_%');

    if (error || !data) return [];

    return data
      .filter((r: any) => r.data?.type === 'MACHINE_TELEMETRY')
      .map((r: any) => r.data as MachineTelemetry);
  } catch (e) {
    console.warn('[Supabase] Fetch fleet telemetry error:', e);
    return [];
  }
}

/**
 * Records a machine operational event log in Supabase.
 */
export async function recordMachineEventLogInSupabase(log: Omit<MachineEventLog, 'id'>): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;
  try {
    const id = `mach_log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const { error } = await supabase.from('registrations').insert({
      id,
      node_id: 'node-alpha-001',
      status: 'SUBMITTED',
      data: {
        type: 'MACHINE_EVENT_LOG',
        id,
        ...log,
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return !error;
  } catch (e) {
    console.warn('[Supabase] Record machine log error:', e);
    return false;
  }
}

/**
 * Fetches collective machine event logs across all devices.
 */
export async function fetchMachineEventLogsFromSupabase(): Promise<MachineEventLog[]> {
  if (!isSupabaseConfigured || !supabase) return [];
  try {
    const { data, error } = await supabase
      .from('registrations')
      .select('*')
      .like('id', 'mach_log_%')
      .order('created_at', { ascending: false })
      .limit(60);

    if (error || !data) return [];

    return data
      .filter((r: any) => r.data?.type === 'MACHINE_EVENT_LOG')
      .map((r: any) => ({
        id: r.data?.id || r.id,
        machine_id: r.data?.machine_id || 'UNKNOWN',
        session_id: r.data?.session_id || 'N/A',
        machine_name: r.data?.machine_name || 'Field Machine',
        event_type: r.data?.event_type || 'INFO',
        title: r.data?.title || 'Operational Event',
        message: r.data?.message || '',
        timestamp: r.data?.timestamp || r.created_at || new Date().toISOString(),
        details: r.data?.details,
      } as MachineEventLog));
  } catch (e) {
    console.warn('[Supabase] Fetch machine logs error:', e);
    return [];
  }
}

