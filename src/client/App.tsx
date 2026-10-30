import React, { useState, useEffect, useRef } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  RefreshCw,
  Wifi,
  WifiOff,
  Database,
  Users,
  Lock,
  Play,
  FileText,
  Layers,
  Activity,
  Award,
  ArrowRight,
  Clock,
  Key,
  CreditCard,
  UserCheck,
  ChevronRight,
  HelpCircle,
  Wheat,
  PlusCircle,
  Check,
  XCircle,
  Menu,
  X,
  Sliders,
  Monitor,
  Radio,
  Eye,
  EyeOff,
  Shield,
  ShieldCheck,
  Server,
  Filter,
  ChevronLeft,
  TrendingUp,
  BarChart3,
} from 'lucide-react';
import type { UserRole, TxnState, ReasonCode } from '../core/types.js';
import {
  subscribeToGrainTrustUpdates,
  getSupabaseStatus,
  supabase,
  isSupabaseConfigured,
  fetchCloudDataFromSupabase,
  insertRegistrationToSupabase,
  approveRegistrationInSupabase,
  recordDispenseInSupabase,
  verifyAdminPasswordInSupabase,
  verifyRolePasswordInSupabase,
  updateAdminPasswordInSupabase,
  upsertMachineTelemetryInSupabase,
  fetchFleetTelemetryFromSupabase,
  recordMachineEventLogInSupabase,
  fetchMachineEventLogsFromSupabase,
} from './supabase.js';
import {
  loadDatabase,
  saveDatabase,
  resetDatabase as resetLocalDb,
  getInitialSeedDatabase,
  recordRegistration,
  verifyAndApproveRegistration,
  recordDispense,
  recordSync,
  toggleNodeOnlineStatus,
  PRESET_MACHINES,
  type LocalDatabaseState,
  type CardBeneficiary,
  type GrainLotItem,
  type NodeItem,
  type AuditLogItem,
  type RegistrationItem,
  type MachineTelemetry,
  type MachineEventLog,
} from './local-storage-db.js';
import {
  initializeAndMigrateDatabase,
  recordDispenseAsync,
  recordRegistrationAsync,
  verifyAndApproveRegistrationAsync,
  recordSyncAsync,
  toggleNodeOnlineStatusAsync,
  getPendingOfflineTokensAsync,
  type OfflineTokenItem,
  secureDb,
} from './secure-storage-db.js';

interface HumanDiagnostic {
  title: string;
  explanation: string;
  remediation: string;
  severity: 'error' | 'warning' | 'info';
}

function getFailureDiagnostic(code: string | undefined, message: string | undefined, details?: any): HumanDiagnostic {
  switch (code) {
    case 'ERR_201':
      return {
        title: 'Beneficiary Quota Limit Exceeded',
        explanation:
          message ||
          'This card has exhausted its allocated monthly grain ration. The requested quantity exceeds the remaining balance for this household.',
        remediation:
          'Reduce the requested quantity to match the available remaining quota, or enable "Supervisor Offline Fallback Override" if field authorization was granted.',
        severity: 'error',
      };
    case 'ERR_202':
      return {
        title: 'Emergency Grain Lot Depleted',
        explanation:
          message ||
          'The selected grain storage reserve has reached its signed distribution cap. No more grain can be dispensed from this specific lot.',
        remediation:
          'Select a different active grain lot with remaining capacity or request the depot manager to allocate a new lot grant.',
        severity: 'error',
      };
    case 'ERR_301':
      return {
        title: 'Cryptographic Signature Verification Failed',
        explanation:
          'The digital signature on this provisional token does not match the node’s Ed25519 public key. The token payload appears to have been altered or tampered with in transit.',
        remediation:
          'Do not dispense grain on this token. Verify terminal cryptographic key registration in the security console.',
        severity: 'error',
      };
    case 'ERR_302':
      return {
        title: 'Replay Attack Prevented (Duplicate Nonce)',
        explanation:
          'This token nonce or transaction ID has already been verified and permanently committed to the central ledger. Resubmission was rejected to prevent double-spending.',
        remediation:
          'No action needed. The central ledger safely acknowledged the duplicate token without double-deducting grain.',
        severity: 'warning',
      };
    case 'ERR_402':
      return {
        title: 'Provisional Token Window Expired',
        explanation:
          'This provisional offline issuance token was generated outside the acceptable validity time window (expired over 1 hour ago).',
        remediation:
          'Re-issue a fresh distribution attempt on the edge terminal to generate an active cryptographic timestamp.',
        severity: 'error',
      };
    case 'ERR_403':
      return {
        title: 'Terminal Quota Lease Depleted',
        explanation:
          'The local edge terminal has consumed its pre-allocated daily quota lease for offline operations.',
        remediation:
          'Connect the terminal to the central network to sync queued transactions and receive a new quota lease.',
        severity: 'warning',
      };
    case 'ERR_409':
      return {
        title: 'State Transition Violation',
        explanation:
          message ||
          'The requested lifecycle step violates the 5-state transition engine rules (e.g. attempting to restart a finalized RECONCILED transaction).',
        remediation:
          'Begin a new distribution attempt with a fresh idempotency key.',
        severity: 'error',
      };
    default:
      return {
        title: 'Operation Rejected',
        explanation: message || 'The transaction could not be processed due to a validation or business policy constraint.',
        remediation: 'Review the entered parameters, verify card connectivity, and retry the request.',
        severity: 'error',
      };
  }
}

let currentAuthToken = '';
let currentActiveRole: UserRole = 'DISTRIBUTION_OPERATOR';
const DATA_REFRESH_INTERVAL_MS = 15000;

export function setClientAuthToken(token: string) {
  currentAuthToken = token;
}

async function safeFetchJson<T = any>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const headers = new Headers(init?.headers || {});
    if (currentAuthToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${currentAuthToken}`);
    }

    // The server accepts bearer tokens only. Custom x-user-* headers are legacy trust signals and can be spoofed.
    if (init?.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(input, { ...init, headers });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      return {
        ok: res.ok,
        status: res.status,
        data,
        error: !res.ok ? (data?.message || data?.error || `HTTP ${res.status}`) : undefined,
      };
    }
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      error: res.ok ? undefined : (text.slice(0, 150) || `HTTP ${res.status}`),
    };
  } catch (err: any) {
    return { ok: false, status: 0, error: err.message || 'Network request failed' };
  }
}

function getRoleShortName(role: UserRole): string {
  switch (role) {
    case 'DISTRIBUTION_OPERATOR':
      return 'Distribution';
    case 'REGISTRATION_OPERATOR':
      return 'Registration';
    case 'SUPERVISOR':
      return 'Supervisor';
    case 'AUDITOR':
      return 'Auditor';
    case 'ADMINISTRATOR':
      return 'Admin';
    default:
      return role;
  }
}

function getRoleLongName(role: UserRole): string {
  switch (role) {
    case 'DISTRIBUTION_OPERATOR':
      return 'Distribution Operator';
    case 'REGISTRATION_OPERATOR':
      return 'Registration Operator';
    case 'SUPERVISOR':
      return 'Field Supervisor';
    case 'AUDITOR':
      return 'Auditor';
    case 'ADMINISTRATOR':
      return 'Administrator';
    default:
      return role;
  }
}

export default function App(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<
    'distribution' | 'registrations' | 'edge-sync' | 'inventory' | 'audit-trail' | 'fleet-telemetry'
  >('distribution');
  const [activeRole, setActiveRole] = useState<UserRole>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('graintrust_active_role') as UserRole;
      if (saved && ['DISTRIBUTION_OPERATOR', 'REGISTRATION_OPERATOR', 'SUPERVISOR', 'AUDITOR', 'ADMINISTRATOR'].includes(saved)) {
        return saved;
      }
    }
    return 'DISTRIBUTION_OPERATOR';
  });
  const [isOnline, setIsOnline] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('graintrust_terminal_online_node-alpha-001');
      if (saved !== null) return saved === 'true';
    }
    return true;
  });
  const [selectedNodeId, setSelectedNodeId] = useState<string>('node-alpha-001');
  const selectedNodeIdRef = useRef(selectedNodeId);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState<boolean>(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('graintrust_sidebar_collapsed') === 'true';
    }
    return false;
  });

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') {
        localStorage.setItem('graintrust_sidebar_collapsed', String(next));
      }
      return next;
    });
  };
  const dataRequestRef = useRef(0);
  const apiReachableRef = useRef<boolean | null>(null);
  const lastApiProbeTimeRef = useRef<number>(0);

  // Field Machine Identity (for 4-laptop demonstration)
  const [currentMachineId, setCurrentMachineId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('graintrust_machine_id') || 'MACH-01';
    }
    return 'MACH-01';
  });
  const [currentMachineName, setCurrentMachineName] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('graintrust_machine_name') || 'Laptop 1 (Depot Alpha - Kanpur Urban)';
    }
    return 'Laptop 1 (Depot Alpha - Kanpur Urban)';
  });
  const [sessionId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const existing = sessionStorage.getItem('graintrust_session_id');
      if (existing) return existing;
      const gen = `SESS-${Date.now().toString(36).slice(-4)}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      sessionStorage.setItem('graintrust_session_id', gen);
      return gen;
    }
    return 'SESS-DEMO-01';
  });

  // Role Security Password Authentication Modal State (Password required for all roles)
  const [roleAuthModalOpen, setRoleAuthModalOpen] = useState<boolean>(false);
  const [pendingTargetRole, setPendingTargetRole] = useState<UserRole>('DISTRIBUTION_OPERATOR');
  const [rolePasswordInput, setRolePasswordInput] = useState<string>('');
  const [roleAuthLoading, setRoleAuthLoading] = useState<boolean>(false);
  const [roleAuthError, setRoleAuthError] = useState<string | null>(null);
  const [adminOfflineBlockedModal, setAdminOfflineBlockedModal] = useState<boolean>(false);

  // Machine Switcher Modal State
  const [machineModalOpen, setMachineModalOpen] = useState<boolean>(false);

  // Fleet Telemetry & Central Logs State (for Administrator view)
  const [fleetTelemetry, setFleetTelemetry] = useState<MachineTelemetry[]>([]);
  const [machineLogs, setMachineLogs] = useState<MachineEventLog[]>([]);
  const [fleetLoading, setFleetLoading] = useState<boolean>(false);
  const [selectedMachineFilter, setSelectedMachineFilter] = useState<string>('ALL');
  const [selectedLogTypeFilter, setSelectedLogTypeFilter] = useState<string>('ALL');

  // Change Admin Password Modal State
  const [changePasswordModalOpen, setChangePasswordModalOpen] = useState<boolean>(false);
  const [newAdminPassword, setNewAdminPassword] = useState<string>('');
  const [changePasswordStatus, setChangePasswordStatus] = useState<string | null>(null);

  useEffect(() => {
    currentActiveRole = activeRole;
    if (typeof window !== 'undefined') {
      localStorage.setItem('graintrust_active_role', activeRole);
    }
  }, [activeRole]);

  // Core Data
  const [cards, setCards] = useState<CardBeneficiary[]>([]);
  const [selectedCardId, setSelectedCardId] = useState<string>('');
  const selectedCardIdRef = useRef<string>('');
  const [lots, setLots] = useState<GrainLotItem[]>([]);
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [registrations, setRegistrations] = useState<RegistrationItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [pendingTokens, setPendingTokens] = useState<OfflineTokenItem[]>([]);

  // Distribution Form
  const [distLotId, setDistLotId] = useState<string>('');
  const [distQuantity, setDistQuantity] = useState<number>(5.0);
  const [distAllowFallback, setDistAllowFallback] = useState<boolean>(false);
  const [distLoading, setDistLoading] = useState<boolean>(false);
  const [distCurrentState, setDistCurrentState] = useState<TxnState>('ATTEMPT');
  const [distExecutionSummary, setDistExecutionSummary] = useState<{
    success: boolean;
    mode: 'ONLINE_CENTRAL' | 'OFFLINE_EDGE_SIGNED';
    state: TxnState;
    title: string;
    explanation: string;
    remediation?: string;
    rawDetails?: any;
  } | null>(null);

  // RBAC Permission Gates matching backend security policies
  const canDispense = ['DISTRIBUTION_OPERATOR', 'SUPERVISOR', 'ADMINISTRATOR'].includes(activeRole);
  const canApproveRegistrations = ['SUPERVISOR', 'ADMINISTRATOR'].includes(activeRole);
  const canResetDb = activeRole === 'ADMINISTRATOR';

  // Registration Form
  const [regForm, setRegForm] = useState({
    first_name: '',
    last_name: '',
    phone_number: '',
    dob: '1992-05-14',
    family_count: 4,
    yearly_income: 54000,
    address: 'Sector 8, Ward 12, Subhash Nagar',
    city: 'Kanpur',
    state: 'Uttar Pradesh',
    consent_opt_in: true,
  });
  const [regSubmitting, setRegSubmitting] = useState<boolean>(false);
  const [regFeedback, setRegFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Sync
  const [syncLoading, setSyncLoading] = useState<boolean>(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  // Load all data from API, Supabase, or encrypted IndexedDB store
  const loadAllData = async (preferredCardId?: string, nodeId = selectedNodeIdRef.current) => {
    const requestId = ++dataRequestRef.current;

    try {
      let localDb: LocalDatabaseState;
      try {
        localDb = await initializeAndMigrateDatabase();
      } catch (err) {
        console.warn('[Storage] IndexedDB fallback to memory:', err);
        localDb = loadDatabase();
      }

      let finalCards: CardBeneficiary[] = [...localDb.cards];
      let finalLots: GrainLotItem[] = [...localDb.lots];
      let finalNodes: NodeItem[] = [...localDb.nodes];
      let finalRegs: RegistrationItem[] = [...localDb.registrations];
      let finalAudit: AuditLogItem[] = [...localDb.auditLogs];
      let finalMetrics = { ...localDb.metrics };

      // Optional remote API check (gate with periodic health check to prevent flooding errors when backend is inactive)
      const now = Date.now();
      const shouldProbeApi =
        apiReachableRef.current === true ||
        apiReachableRef.current === null ||
        now - lastApiProbeTimeRef.current > 60000;

      if (shouldProbeApi) {
        try {
          lastApiProbeTimeRef.current = now;
          const health = await safeFetchJson<{ status: string; mode?: string }>('/api/health');
          if (health.ok) {
            apiReachableRef.current = true;
            // In cloud serverless mode, Supabase is the unified cloud ledger; probe local endpoints if in local standalone mode or authenticated
            if (health.data?.mode !== 'serverless-edge' || currentAuthToken) {
              const [cardsRes, lotsRes, nodesRes, regsRes, auditRes] = await Promise.all([
                safeFetchJson<CardBeneficiary[]>(`/api/v1/cards?node_id=${encodeURIComponent(nodeId)}`),
                safeFetchJson<GrainLotItem[]>('/api/v1/lots'),
                safeFetchJson<NodeItem[]>('/api/v1/nodes'),
                safeFetchJson<RegistrationItem[]>('/api/v1/registrations'),
                safeFetchJson<AuditLogItem[]>('/api/v1/audit'),
              ]);

              if (cardsRes.ok && Array.isArray(cardsRes.data) && cardsRes.data.length > 0) finalCards = cardsRes.data;
              if (lotsRes.ok && Array.isArray(lotsRes.data) && lotsRes.data.length > 0) finalLots = lotsRes.data;
              if (nodesRes.ok && Array.isArray(nodesRes.data) && nodesRes.data.length > 0) finalNodes = nodesRes.data;
              if (regsRes.ok && Array.isArray(regsRes.data) && regsRes.data.length > 0) finalRegs = regsRes.data;
              if (auditRes.ok && Array.isArray(auditRes.data) && auditRes.data.length > 0) finalAudit = auditRes.data;
            }
          } else {
            apiReachableRef.current = false;
          }

        } catch {
          apiReachableRef.current = false;
        }
      }

      // Overlay live cloud data from Supabase if provisioned and online
      try {
        const cloudData = await fetchCloudDataFromSupabase();
        if (cloudData) {
          if (cloudData.cards && cloudData.cards.length > 0) finalCards = cloudData.cards;
          if (cloudData.lots && cloudData.lots.length > 0) finalLots = cloudData.lots;
          if (cloudData.nodes && cloudData.nodes.length > 0) {
            finalNodes = cloudData.nodes.map((cn) => {
              const ln = localDb.nodes.find((n) => n.id === cn.id);
              const localPref = typeof window !== 'undefined' ? localStorage.getItem(`graintrust_terminal_online_${cn.id}`) : null;
              const isNodeOnline = localPref !== null 
                ? localPref === 'true' 
                : (ln?.status ? ln.status === 'ONLINE' : (cn.status === 'ONLINE'));
              return {
                ...cn,
                status: isNodeOnline ? 'ONLINE' : 'OFFLINE',
                is_online: isNodeOnline,
                outbox_depth: ln?.outbox_depth !== undefined ? ln.outbox_depth : cn.outbox_depth,
              };
            });
          }
          if (cloudData.registrations && cloudData.registrations.length > 0) finalRegs = cloudData.registrations;
          if (cloudData.auditLogs && cloudData.auditLogs.length > 0) finalAudit = cloudData.auditLogs;
        }
      } catch (e) {
        console.warn('[Supabase] fetchCloudData error in loadAllData:', e);
      }

      // Reconcile approved registrations to guarantee newly issued cards always appear
      for (const reg of finalRegs) {
        if (reg.status === 'APPROVED' && reg.card_id && !finalCards.some((c) => c.id === reg.card_id)) {
          const quota = (reg.data.family_count || 3) * 10;
          const reconstructedCard: CardBeneficiary = {
            id: reg.card_id,
            person_id: reg.person_id || `person-${reg.id}`,
            status: 'ACTIVE',
            issued_at: reg.updated_at || reg.created_at || new Date().toISOString(),
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
            machine_id: (reg.data as any)?.machine_id || currentMachineId,
            machine_name: (reg.data as any)?.machine_name || currentMachineName,
          };
          finalCards.unshift(reconstructedCard);
        }
      }

      // Ensure cards, nodes, and lots never empty in edge client
      if (finalCards.length === 0) {
        const seed = getInitialSeedDatabase();
        finalCards = [...seed.cards];
      }

      // Ensure every card has machine attribution for field isolation & admin collective ledger
      finalCards = finalCards.map((c) => {
        if (c.machine_id) return c;
        if (c.id === 'card-demo-001' || c.id?.includes('mvpo')) {
          return { ...c, machine_id: 'MACH-01', machine_name: 'Laptop 1 (Depot Alpha - Kanpur Urban)' };
        }
        if (c.id === 'card-demo-002') {
          return { ...c, machine_id: 'MACH-02', machine_name: 'Laptop 2 (Outpost 9 - Bithoor Rural)' };
        }
        if (c.id === 'card-demo-003') {
          return { ...c, machine_id: 'MACH-03', machine_name: 'Laptop 3 (Mobile POS Unit 3 - Ganga Ghat)' };
        }
        if (c.id === 'card-demo-004') {
          return { ...c, machine_id: 'MACH-01', machine_name: 'Laptop 1 (Depot Alpha - Kanpur Urban)' };
        }
        if (c.id === 'card-demo-005') {
          return { ...c, machine_id: 'MACH-02', machine_name: 'Laptop 2 (Outpost 9 - Bithoor Rural)' };
        }
        return { ...c, machine_id: 'MACH-01', machine_name: 'Laptop 1 (Depot Alpha - Kanpur Urban)' };
      });

      if (finalNodes.length === 0) {
        const seed = getInitialSeedDatabase();
        finalNodes = [...seed.nodes];
      }
      if (finalLots.length === 0) {
        const seed = getInitialSeedDatabase();
        finalLots = [...seed.lots];
      }

      // Ensure all finalNodes have normalized status and is_online properties matching local preferences
      finalNodes = finalNodes.map((n) => {
        const localPref = typeof window !== 'undefined' ? localStorage.getItem(`graintrust_terminal_online_${n.id}`) : null;
        const isNodeOnline = localPref !== null 
          ? localPref === 'true' 
          : (n.status ? n.status === 'ONLINE' : (n.is_online ?? true));
        return {
          ...n,
          status: isNodeOnline ? 'ONLINE' : 'OFFLINE',
          is_online: isNodeOnline,
        };
      });

      // Keep local JSON database in sync as secondary fallback
      saveDatabase({
        cards: finalCards,
        lots: finalLots,
        nodes: finalNodes,
        registrations: finalRegs,
        auditLogs: finalAudit,
        metrics: finalMetrics,
      });

      if (requestId !== dataRequestRef.current) return;

      setCards(finalCards);
      const targetCardId = preferredCardId || selectedCardIdRef.current;
      if (targetCardId && finalCards.some((c) => c.id === targetCardId)) {
        setSelectedCardId(targetCardId);
        selectedCardIdRef.current = targetCardId;
      } else if (finalCards.length > 0) {
        setSelectedCardId(finalCards[0].id);
        selectedCardIdRef.current = finalCards[0].id;
      }

      setLots(finalLots);
      if (!distLotId && finalLots.length > 0) {
        setDistLotId(finalLots[0].id);
      }

      setNodes(finalNodes);
      if (nodeId === selectedNodeIdRef.current) {
        const curr = finalNodes.find((n) => n.id === nodeId) || finalNodes[0];
        if (curr) {
          setIsOnline(curr.status === 'ONLINE');
        }
      }

      // Sync loaded cards and lots into secureDb to ensure offline edge operations find them
      try {
        for (const c of finalCards) {
          const existing = await secureDb.cards.get(c.id);
          if (!existing) {
            await secureDb.cards.put(c);
          }
        }
        for (const l of finalLots) {
          const existing = await secureDb.lots.get(l.id);
          if (!existing) {
            await secureDb.lots.put(l);
          }
        }
        const currentTokens = await getPendingOfflineTokensAsync();
        setPendingTokens(currentTokens);
      } catch (err) {
        console.warn('[Storage] Background cache sync notice:', err);
      }

      setRegistrations(finalRegs);
      setAuditLogs(finalAudit);
      if (finalMetrics) setMetrics(finalMetrics);
    } catch (e) {
      console.warn('Sync notice:', e);
    }
  };

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
    loadAllData(undefined, selectedNodeId);
    const interval = setInterval(() => loadAllData(undefined, selectedNodeIdRef.current), DATA_REFRESH_INTERVAL_MS);

    // Live bidirectional sync from Supabase
    const channel = subscribeToGrainTrustUpdates((table) => {
      console.log(`[Supabase Realtime] Change detected in table: ${table}`);
      loadAllData(undefined, selectedNodeIdRef.current);
    });

    return () => {
      clearInterval(interval);
      channel?.unsubscribe();
    };
  }, [selectedNodeId]);

  // Machine-Specific Card Filtering vs. Admin Collective View
  const fieldVisibleCards = cards.filter((c) => {
    if (activeRole === 'ADMINISTRATOR') return true;
    return !c.machine_id || c.machine_id === currentMachineId;
  });

  const displayedCards = activeRole === 'ADMINISTRATOR'
    ? (selectedMachineFilter === 'ALL' ? cards : cards.filter((c) => c.machine_id === selectedMachineFilter))
    : fieldVisibleCards;

  const displayedRegistrations = activeRole === 'ADMINISTRATOR'
    ? (selectedMachineFilter === 'ALL' ? registrations : registrations.filter((r) => (r.data as any)?.machine_id === selectedMachineFilter))
    : registrations.filter((r) => !(r.data as any)?.machine_id || (r.data as any)?.machine_id === currentMachineId);

  // Active selected beneficiary card & terminal node
  const activeBeneficiary = displayedCards.find((c) => c.id === selectedCardId) || displayedCards[0] || cards[0];
  const activeLot = lots.find((l) => l.id === distLotId) || lots[0];
  const activeNode = nodes.find((n) => n.id === selectedNodeId) || nodes[0];
  const nodeAccent = selectedNodeId.includes('beta') ? 'var(--amber-400)' : 'var(--cyan-400)';

  // Telemetry Heartbeat to Supabase
  useEffect(() => {
    const sendHeartbeat = async () => {
      if (!isOnline) return;
      try {
        const activeCardCount = cards.filter((c) => !c.machine_id || c.machine_id === currentMachineId).length;
        await upsertMachineTelemetryInSupabase({
          machine_id: currentMachineId,
          session_id: sessionId,
          machine_name: currentMachineName,
          role: activeRole,
          status: isOnline ? 'ONLINE' : 'OFFLINE',
          is_online: isOnline,
          last_ping: new Date().toISOString(),
          outbox_count: pendingTokens.length,
          disbursed_total: metrics?.total_grain_disbursed || 0,
          cards_count: activeCardCount,
          node_id: selectedNodeId,
          location: PRESET_MACHINES.find((m) => m.id === currentMachineId)?.location || 'Fair Price Depot',
        });
      } catch (err) {
        console.warn('[Telemetry] Heartbeat error:', err);
      }
    };

    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 15000);
    return () => clearInterval(interval);
  }, [isOnline, currentMachineId, currentMachineName, activeRole, pendingTokens.length, metrics, cards.length, selectedNodeId]);

  // Refresh Fleet Data for Admin
  const refreshFleetData = async () => {
    setFleetLoading(true);
    try {
      const [telemetryData, logsData] = await Promise.all([
        fetchFleetTelemetryFromSupabase(),
        fetchMachineEventLogsFromSupabase(),
      ]);

      const mergedTelemetry: MachineTelemetry[] = PRESET_MACHINES.map((preset) => {
        const live = telemetryData.find((t) => t.machine_id === preset.id);
        if (live) return live;
        return {
          machine_id: preset.id,
          session_id: preset.id === currentMachineId ? sessionId : 'SESS-STANDBY',
          machine_name: preset.name,
          role: preset.defaultRole,
          status: preset.id === currentMachineId ? (isOnline ? 'ONLINE' : 'OFFLINE') : 'OFFLINE',
          is_online: preset.id === currentMachineId ? isOnline : false,
          last_ping: preset.id === currentMachineId ? new Date().toISOString() : 'Awaiting initialization',
          outbox_count: preset.id === currentMachineId ? pendingTokens.length : 0,
          disbursed_total: 0,
          cards_count: cards.filter((c) => c.machine_id === preset.id).length,
          node_id: preset.nodeId,
          location: preset.location,
        };
      });

      setFleetTelemetry(mergedTelemetry);
      setMachineLogs(logsData);
    } catch (err) {
      console.warn('[Telemetry] Error refreshing fleet data:', err);
    } finally {
      setFleetLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'fleet-telemetry' || activeRole === 'ADMINISTRATOR') {
      refreshFleetData();
      const interval = setInterval(refreshFleetData, 8000);
      return () => clearInterval(interval);
    }
  }, [activeTab, activeRole]);

  // Operator Role Switcher and Password Verification Handler (Every role requires password)
  const openRoleAuthModal = (targetRole?: UserRole) => {
    const nextRole = targetRole || activeRole;
    setPendingTargetRole(nextRole);
    setRolePasswordInput('');
    setRoleAuthError(null);
    setRoleAuthModalOpen(true);
  };

  const handleRoleChangeRequest = (newRole: UserRole) => {
    openRoleAuthModal(newRole);
  };

  const handleVerifyRolePassword = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!rolePasswordInput) {
      setRoleAuthError('Please enter the security password.');
      return;
    }

    // In offline autonomous mode, Administrator role cannot be accessed
    if (pendingTargetRole === 'ADMINISTRATOR' && !isOnline) {
      setRoleAuthModalOpen(false);
      setAdminOfflineBlockedModal(true);
      return;
    }

    setRoleAuthLoading(true);
    setRoleAuthError(null);

    try {
      const result = await verifyRolePasswordInSupabase(rolePasswordInput, pendingTargetRole);
      if (result.success) {
        setActiveRole(pendingTargetRole);
        if (typeof window !== 'undefined') {
          localStorage.setItem('graintrust_active_role', pendingTargetRole);
        }
        setRoleAuthModalOpen(false);
        setRolePasswordInput('');

        await recordMachineEventLogInSupabase({
          machine_id: currentMachineId,
          session_id: sessionId,
          machine_name: currentMachineName,
          event_type: 'ROLE_LOGIN',
          title: `${getRoleLongName(pendingTargetRole)} Authenticated`,
          message: `${currentMachineName} (${currentMachineId}) successfully unlocked ${getRoleLongName(pendingTargetRole)} session.`,
          timestamp: new Date().toISOString(),
        });

        if (pendingTargetRole === 'ADMINISTRATOR') {
          setActiveTab('fleet-telemetry');
        }
      } else {
        setRoleAuthError(result.message || 'Incorrect security password. Access denied.');
      }
    } catch {
      setRoleAuthError('Authentication request failed. Please check network connection.');
    } finally {
      setRoleAuthLoading(false);
    }
  };

  const handleSelectMachineProfile = (presetId: string) => {
    const preset = PRESET_MACHINES.find((p) => p.id === presetId);
    if (!preset) return;
    setCurrentMachineId(preset.id);
    setCurrentMachineName(preset.name);
    if (typeof window !== 'undefined') {
      localStorage.setItem('graintrust_machine_id', preset.id);
      localStorage.setItem('graintrust_machine_name', preset.name);
    }
    handleNodeChange(preset.nodeId);
    setMachineModalOpen(false);
  };

  const handleNodeChange = (nodeId: string) => {
    const nextNode = nodes.find((node) => node.id === nodeId);
    selectedNodeIdRef.current = nodeId;
    setSelectedNodeId(nodeId);
    // Keep active card selection intact across distribution terminals
    const localPref = typeof window !== 'undefined' ? localStorage.getItem(`graintrust_terminal_online_${nodeId}`) : null;
    const isNodeOnline = localPref !== null 
      ? localPref === 'true' 
      : (nextNode?.status ? nextNode.status === 'ONLINE' : (nextNode?.is_online ?? true));
    setIsOnline(isNodeOnline);
    setDistExecutionSummary(null);
    setDistCurrentState('ATTEMPT');
    setSyncNotice(null);
  };

  // Toggle Online/Offline
  const handleToggleOnline = async () => {
    const nextOnlineState = !isOnline;
    setIsOnline(nextOnlineState);
    if (typeof window !== 'undefined') {
      localStorage.setItem(`graintrust_terminal_online_${selectedNodeId}`, String(nextOnlineState));
    }

    // If switching to offline while in Administrator role, drop back to Supervisor for safety
    if (!nextOnlineState && activeRole === 'ADMINISTRATOR') {
      setActiveRole('SUPERVISOR');
      alert('Administrator session suspended: The Administrator control panel cannot be operated in Offline Mode. Automatically switched to Field Supervisor.');
    }

    try {
      await secureDb.nodes.where('id').equals(selectedNodeId).modify((node) => {
        node.status = nextOnlineState ? 'ONLINE' : 'OFFLINE';
        node.is_online = nextOnlineState;
      });
      toggleNodeOnlineStatus(selectedNodeId);
    } catch (e) {
      console.warn('[Storage] Error updating node status on toggle:', e);
    }

    try {
      await safeFetchJson(`/api/v1/edge-nodes/${selectedNodeId}/toggle-online`, { method: 'POST' });
    } catch {}

    // Log machine transition event to Supabase
    recordMachineEventLogInSupabase({
      machine_id: currentMachineId,
      session_id: sessionId,
      machine_name: currentMachineName,
      event_type: nextOnlineState ? 'MACHINE_ONLINE' : 'MACHINE_OFFLINE',
      title: nextOnlineState ? 'Machine Reconnected Online' : 'Machine Switched to Offline',
      message: nextOnlineState
        ? `${currentMachineName} (${currentMachineId}) established live network handshake with central cloud ledger.`
        : `${currentMachineName} (${currentMachineId}) switched to Offline Edge Mode. Operating autonomously on local cryptographic leases.`,
      timestamp: new Date().toISOString(),
    });

    await loadAllData(selectedCardId, selectedNodeId);
  };

  // Submit Beneficiary Registration
  const handleSubmitRegistration = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegSubmitting(true);
    setRegFeedback(null);

    const submissionData = {
      ...regForm,
      machine_id: currentMachineId,
      machine_name: currentMachineName,
    };

    try {
      const res = await safeFetchJson('/api/v1/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...submissionData, node_id: selectedNodeId }),
      });
      if (res.ok && res.data) {
        await insertRegistrationToSupabase({ id: res.data.id, node_id: selectedNodeId, data: submissionData });
        setRegFeedback({
          type: 'success',
          message: `Registration recorded at ${currentMachineName} for ${regForm.first_name} ${regForm.last_name}! Record ID: ${res.data.id}. Click "Verify" & "Approve" below to activate their card.`,
        });
      } else {
        const { reg } = await recordRegistrationAsync(submissionData as any, selectedNodeId);
        await insertRegistrationToSupabase({ id: reg.id, node_id: selectedNodeId, data: submissionData });
        setRegFeedback({
          type: 'success',
          message: `Registration encrypted (AES-GCM-256) & saved at ${currentMachineName} for ${regForm.first_name} ${regForm.last_name}! Record ID: ${reg.id}. Click "Verify" & "Approve" below to activate their card.`,
        });
      }

      await recordMachineEventLogInSupabase({
        machine_id: currentMachineId,
        session_id: sessionId,
        machine_name: currentMachineName,
        event_type: 'CARD_ENROLLED',
        title: 'New Beneficiary KYC Enrolled',
        message: `${currentMachineName} (${currentMachineId}) enrolled citizen ${regForm.first_name} ${regForm.last_name} (${regForm.family_count} members, ${regForm.family_count * 10}kg quota).`,
        timestamp: new Date().toISOString(),
      });

      await loadAllData();
    } catch (err: any) {
      const { reg } = await recordRegistrationAsync(submissionData as any, selectedNodeId);
      await insertRegistrationToSupabase({ id: reg.id, node_id: selectedNodeId, data: submissionData });
      setRegFeedback({
        type: 'success',
        message: `Registration encrypted (AES-GCM-256) & saved for ${regForm.first_name} ${regForm.last_name}! Record ID: ${reg.id}. Click "Verify" & "Approve" below to activate.`,
      });
      await loadAllData();
    } finally {
      setRegSubmitting(false);
    }
  };

  // Auto-fill demo profile
  const handleDemoFill = () => {
    const demoProfiles = [
      { first_name: 'Rajesh', last_name: 'Kumar', phone: '+919871122334', count: 5, income: 42000, city: 'Varanasi', state: 'Uttar Pradesh' },
      { first_name: 'Fatima', last_name: 'Sheikh', phone: '+919822334455', count: 3, income: 38000, city: 'Bhopal', state: 'Madhya Pradesh' },
      { first_name: 'Ananya', last_name: 'Sen', phone: '+919833445566', count: 4, income: 51000, city: 'Kolkata', state: 'West Bengal' },
      { first_name: 'Gurpreet', last_name: 'Singh', phone: '+919844556677', count: 6, income: 60000, city: 'Amritsar', state: 'Punjab' },
    ];
    const pick = demoProfiles[Math.floor(Math.random() * demoProfiles.length)];
    setRegForm({
      first_name: pick.first_name,
      last_name: pick.last_name,
      phone_number: pick.phone,
      dob: '1990-06-20',
      family_count: pick.count,
      yearly_income: pick.income,
      address: 'House #45, Near Community Center',
      city: pick.city,
      state: pick.state,
      consent_opt_in: true,
    });
  };

  // Verify and Approve Registration -> Auto-switches to new Card!
  const handleApproveRegistration = async (regId: string) => {
    if (!canApproveRegistrations) {
      alert(`Access Denied (RBAC): Current role "${activeRole}" does not have card approval authority. Please switch role to Field Supervisor or Administrator to approve registrations.`);
      return;
    }
    try {
      // 1. Verify if not already verified
      await safeFetchJson(`/api/v1/registrations/${regId}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      // 2. Approve
      const res = await safeFetchJson(`/api/v1/registrations/${regId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.ok && res.data) {
        const newCardId = res.data.card.id;
        selectedCardIdRef.current = newCardId;
        await loadAllData(newCardId);
        setSelectedCardId(newCardId);
        setDistExecutionSummary(null);
        setDistCurrentState('ATTEMPT');
        setActiveTab('distribution');
        alert(
          `Card Activated Successfully!\n\n` +
            `Beneficiary: ${res.data.person.first_name} ${res.data.person.last_name}\n` +
            `Personal ID: ${res.data.person.id}\n` +
            `Card ID: ${newCardId}\n\n` +
            `You can now dispense grain directly!`
        );
      } else {
        const approved = await verifyAndApproveRegistrationAsync(regId);
        if (approved) {
          await approveRegistrationInSupabase(regId, approved.card);
          selectedCardIdRef.current = approved.card.id;
          await loadAllData(approved.card.id);
          setSelectedCardId(approved.card.id);
          setDistExecutionSummary(null);
          setDistCurrentState('ATTEMPT');
          setActiveTab('distribution');
          alert(
            `Card Activated Successfully!\n\n` +
              `Beneficiary: ${approved.card.full_name}\n` +
              `Card ID: ${approved.card.id}\n` +
              `Allocated Quota: ${approved.card.allocated_qty} kg\n\n` +
              `Citizen PII protected by AES-GCM-256 field-level encryption.`
          );
        }
      }
    } catch (e: any) {
      const approved = await verifyAndApproveRegistrationAsync(regId);
      if (approved) {
        await approveRegistrationInSupabase(regId, approved.card);
        selectedCardIdRef.current = approved.card.id;
        await loadAllData(approved.card.id);
        setSelectedCardId(approved.card.id);
        setDistExecutionSummary(null);
        setDistCurrentState('ATTEMPT');
        setActiveTab('distribution');
        alert(
          `Card Activated Successfully!\n\n` +
            `Beneficiary: ${approved.card.full_name}\n` +
            `Card ID: ${approved.card.id}\n` +
            `Allocated Quota: ${approved.card.allocated_qty} kg\n\n` +
            `Citizen PII protected by AES-GCM-256 field-level encryption.`
        );
      } else {
        alert(`Approval notice: ${e.message || 'Operation recorded in local database.'}`);
      }
    }
  };

  // Dispense Grain (Online or Offline with Clear Text Explanations)
  const handleDispenseGrain = async () => {
    if (!canDispense) {
      alert(`Access Denied (RBAC): Current role "${activeRole}" cannot dispense grain. Switch to Distribution Operator, Field Supervisor, or Administrator.`);
      return;
    }
    if (!selectedCardId || !distLotId) return;
    const currentCard = cards.find((c) => c.id === selectedCardId) || activeBeneficiary;
    if (!currentCard) return;

    // Strict Quota Validation Rule: Block if requested quantity exceeds balance unless supervisor override is enabled
    if (distQuantity > currentCard.remaining_qty && !distAllowFallback) {
      setDistCurrentState('FAIL_REASON');
      const diag = getFailureDiagnostic('ERR_201', 'Card quota exhausted on local lease');
      setDistExecutionSummary({
        success: false,
        mode: isOnline ? 'ONLINE_CENTRAL' : 'OFFLINE_EDGE_SIGNED',
        state: 'FAIL_REASON',
        title: 'Quota Exceeded (ERR_201: Card Quota Exhausted)',
        explanation: `Requested ration of ${distQuantity} kg exceeds remaining balance of ${currentCard.remaining_qty} kg. In standard operator mode, dispensing beyond available quota is strictly blocked.`,
        remediation: 'Check "Enable Supervisor Offline Fallback Auth" above if you wish to simulate an emergency supervisor override.',
        rawDetails: {
          code: 'ERR_201',
          error: 'Card quota exhausted on local lease',
          requested_quantity: distQuantity,
          available_remaining: currentCard.remaining_qty,
        },
      });
      return;
    }

    setDistLoading(true);
    setDistExecutionSummary(null);
    setDistCurrentState('ATTEMPT');

    try {
      if (isOnline) {
        // 1. Primary Online Central Transaction: Commit directly to Supabase cloud database ledger
        if (isSupabaseConfigured && activeBeneficiary) {
          const cloudResult = await recordDispenseInSupabase(
            activeBeneficiary,
            distLotId,
            distQuantity,
            selectedNodeId
          );

          if (cloudResult.success) {
            // Synchronously mirror to local encrypted storage for offline fallback cache
            const localResult = await recordDispenseAsync(selectedCardId, distLotId, selectedNodeId, distQuantity, true);
            setDistCurrentState('RECONCILED');
            setDistExecutionSummary({
              success: true,
              mode: 'ONLINE_CENTRAL',
              state: 'RECONCILED',
              title: 'Grain Successfully Dispensed & Reconciled',
              explanation: `Successfully disbursed ${distQuantity} kg of ${activeLot?.name || 'grain'} to ${activeBeneficiary?.full_name || 'Beneficiary'}. The transaction was authenticated and committed to the Supabase cloud ledger.`,
              rawDetails: cloudResult.data || localResult,
            });
            await loadAllData(selectedCardId, selectedNodeId);
            return;
          } else if (cloudResult.code) {
            setDistCurrentState('FAIL_REASON');
            const diag = getFailureDiagnostic(cloudResult.code, cloudResult.error);
            setDistExecutionSummary({
              success: false,
              mode: 'ONLINE_CENTRAL',
              state: 'FAIL_REASON',
              title: diag.title,
              explanation: diag.explanation,
              remediation: diag.remediation,
              rawDetails: { code: cloudResult.code, error: cloudResult.error },
            });
            return;
          }
        }

        // 2. Standalone or Local Node API Fallback
        const res = await safeFetchJson('/api/v1/transactions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'idempotency-key': `online_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          },
          body: JSON.stringify({
            card_id: selectedCardId,
            lot_id: distLotId,
            node_id: selectedNodeId,
            quantity: distQuantity,
          }),
        });

        if (res.ok && res.data) {
          setDistCurrentState('RECONCILED');
          setDistExecutionSummary({
            success: true,
            mode: 'ONLINE_CENTRAL',
            state: 'RECONCILED',
            title: 'Grain Successfully Dispensed & Reconciled',
            explanation: `Successfully disbursed ${distQuantity} kg of ${activeLot?.name || 'grain'} to ${activeBeneficiary?.full_name || 'Beneficiary'}. The transaction was authenticated and committed to the central ledger.`,
            rawDetails: res.data,
          });
          await loadAllData(selectedCardId, selectedNodeId);
        } else if (res.data?.code) {
          setDistCurrentState('FAIL_REASON');
          const diag = getFailureDiagnostic(res.data.code, res.data.message);
          setDistExecutionSummary({
            success: false,
            mode: 'ONLINE_CENTRAL',
            state: 'FAIL_REASON',
            title: diag.title,
            explanation: diag.explanation,
            remediation: diag.remediation,
            rawDetails: res.data,
          });
        } else {
          const result = await recordDispenseAsync(selectedCardId, distLotId, selectedNodeId, distQuantity, true);
          setDistCurrentState('RECONCILED');
          setDistExecutionSummary({
            success: true,
            mode: 'ONLINE_CENTRAL',
            state: 'RECONCILED',
            title: 'Grain Successfully Dispensed (Encrypted IndexedDB)',
            explanation: `Disbursed ${distQuantity} kg of ${activeLot?.name || 'grain'} to ${activeBeneficiary?.full_name || 'Beneficiary'}. Quota updated and permanently committed to the encrypted local ledger.`,
            rawDetails: result,
          });
          await loadAllData(selectedCardId, selectedNodeId);
        }
      } else {

        // Offline Edge Node Issuance (Ed25519 Token)
        const res = await safeFetchJson(`/api/v1/edge-nodes/${selectedNodeId}/issue`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'idempotency-key': `offline_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          },
          body: JSON.stringify({
            card_id: selectedCardId,
            lot_id: distLotId,
            grant_id: distLotId,
            quantity: distQuantity,
            allow_fallback: distAllowFallback,
          }),
        });

        if (res.ok && res.data) {
          setDistCurrentState(res.data.state || 'PROVISIONAL_ISSUE');
          setDistExecutionSummary({
            success: true,
            mode: 'OFFLINE_EDGE_SIGNED',
            state: res.data.state || 'PROVISIONAL_ISSUE',
            title: 'Provisional Offline Grain Issued (Cryptographically Signed)',
            explanation: `Terminal ${activeNode?.name || 'Alpha'} issued a provisional ration of ${distQuantity} kg to ${activeBeneficiary?.full_name || 'Beneficiary'}. A tamper-evident token was created and queued for later reconciliation.`,
            rawDetails: res.data,
          });
        } else if (res.data?.code) {
          setDistCurrentState('FAIL_REASON');
          const diag = getFailureDiagnostic(res.data.reasonCode || res.data.code, res.data.error || res.data.message);
          setDistExecutionSummary({
            success: false,
            mode: 'OFFLINE_EDGE_SIGNED',
            state: 'FAIL_REASON',
            title: diag.title,
            explanation: diag.explanation,
            remediation: diag.remediation,
            rawDetails: res.data,
          });
        } else {
          const result = await recordDispenseAsync(
            selectedCardId,
            distLotId,
            selectedNodeId,
            distQuantity,
            false,
            distAllowFallback,
            activeBeneficiary,
            activeLot
          );
          if (result?.card) {
            setCards((prev) => prev.map((c) => (c.id === selectedCardId ? result.card : c)));
          }
          setDistCurrentState('PROVISIONAL_ISSUE');
          setDistExecutionSummary({
            success: true,
            mode: 'OFFLINE_EDGE_SIGNED',
            state: 'PROVISIONAL_ISSUE',
            title: 'Provisional Offline Grain Issued (Encrypted IndexedDB)',
            explanation: `Terminal issued a provisional ration of ${distQuantity} kg to ${activeBeneficiary?.full_name || 'Beneficiary'}.${distAllowFallback ? ' (Authorized via Supervisor Offline Fallback)' : ''} The cryptographically signed token was queued into the outbox and will be reconciled during central sync.`,
            rawDetails: result,
          });
        }
      }

      await loadAllData(selectedCardId);

      // Log dispense event to Supabase telemetry
      recordMachineEventLogInSupabase({
        machine_id: currentMachineId,
        session_id: sessionId,
        machine_name: currentMachineName,
        event_type: 'DISPENSE',
        title: `Dispensed ${distQuantity}kg ${distAllowFallback ? '(Supervisor Override)' : ''}`,
        message: `${currentMachineName} (${currentMachineId}) dispensed ${distQuantity}kg grain to ${activeBeneficiary?.full_name} (${isOnline ? 'Online Central' : 'Offline Provisional'}).`,
        timestamp: new Date().toISOString(),
        details: {
          card_id: activeBeneficiary?.id,
          quantity: distQuantity,
          lot_id: distLotId,
          is_online: isOnline,
        },
      });
    } catch (e: any) {
      setDistCurrentState('FAIL_REASON');
      setDistExecutionSummary({
        success: false,
        mode: isOnline ? 'ONLINE_CENTRAL' : 'OFFLINE_EDGE_SIGNED',
        state: 'FAIL_REASON',
        title: 'Communication Fault',
        explanation: e.message || 'An unexpected error occurred.',
        remediation: 'Verify network connectivity or terminal status.',
      });
    } finally {
      setDistLoading(false);
    }
  };

  // Trigger Outbox Sync Now
  const handleTriggerSync = async () => {
    setSyncLoading(true);
    setSyncNotice(null);
    try {
      const res = await safeFetchJson(`/api/v1/edge-nodes/${selectedNodeId}/sync-now`, { method: 'POST' });
      if (res.ok && res.data) {
        setSyncNotice(
          `Batch Reconciliation Succeeded! Reconciled ${res.data.accepted_count || 0} tokens to the central ledger.`
        );
        recordMachineEventLogInSupabase({
          machine_id: currentMachineId,
          session_id: sessionId,
          machine_name: currentMachineName,
          event_type: 'BATCH_SYNC',
          title: `Batch Sync: Reconciled ${res.data.accepted_count || 0} Token(s)`,
          message: `${currentMachineName} (${currentMachineId}) synced ${res.data.accepted_count || 0} token(s) to central cloud ledger.`,
          timestamp: new Date().toISOString(),
        });
      } else {
        const { reconciledCount, tokens } = await recordSyncAsync(selectedNodeId);
        
        // Push each pending offline token to live Supabase cloud database
        for (const token of tokens) {
          const card = cards.find((c) => c.id === token.card_id) || ({
            id: token.card_id,
            full_name: token.card_name,
            consumed_qty: 0,
            remaining_qty: 30,
            allocated_qty: 30,
          } as CardBeneficiary);
          await recordDispenseInSupabase(card, token.lot_id, token.quantity, token.node_id);
        }

        setPendingTokens([]);
        setSyncNotice(
          `Batch Reconciliation Succeeded! Successfully synchronized ${reconciledCount} provisional token(s) to the central Supabase ledger.`
        );

        recordMachineEventLogInSupabase({
          machine_id: currentMachineId,
          session_id: sessionId,
          machine_name: currentMachineName,
          event_type: 'BATCH_SYNC',
          title: `Batch Sync: Reconciled ${reconciledCount} Token(s)`,
          message: `${currentMachineName} (${currentMachineId}) synced ${reconciledCount} provisional offline token(s) to central cloud ledger.`,
          timestamp: new Date().toISOString(),
          details: { count: reconciledCount },
        });
      }
      await loadAllData(selectedCardId);
    } catch (e: any) {
      const { reconciledCount } = await recordSyncAsync(selectedNodeId);
      setSyncNotice(
        `Batch Reconciliation Succeeded (Encrypted IndexedDB)! Reconciled ${reconciledCount} tokens to the persistent ledger.`
      );
      recordMachineEventLogInSupabase({
        machine_id: currentMachineId,
        session_id: sessionId,
        machine_name: currentMachineName,
        event_type: 'BATCH_SYNC',
        title: `Batch Sync: Reconciled ${reconciledCount} Token(s)`,
        message: `${currentMachineName} (${currentMachineId}) reconciled ${reconciledCount} token(s) in local vault.`,
        timestamp: new Date().toISOString(),
      });
      await loadAllData(selectedCardId);
    } finally {
      setSyncLoading(false);
    }
  };

  const handleResetDatabase = async () => {
    if (!canResetDb) {
      alert(`Access Denied (RBAC): Only the Administrator role can execute database reset. Current role: "${activeRole}".`);
      return;
    }
    if (!window.confirm('Are you sure you want to reset demo records to seed defaults?')) {
      return;
    }
    try {
      await safeFetchJson('/api/v1/admin/reset', { method: 'POST' });
    } catch {}
    try {
      await secureDb.transaction('rw', [
        secureDb.cards,
        secureDb.lots,
        secureDb.nodes,
        secureDb.registrations,
        secureDb.auditLogs,
        secureDb.metadata,
      ], async () => {
        await secureDb.cards.clear();
        await secureDb.lots.clear();
        await secureDb.nodes.clear();
        await secureDb.registrations.clear();
        await secureDb.auditLogs.clear();
        await secureDb.metadata.clear();
      });
    } catch (err) {
      console.warn('Error clearing secureDb:', err);
    }
    resetLocalDb();
    await initializeAndMigrateDatabase();
    selectedCardIdRef.current = '';
    setSelectedCardId('');
    setDistExecutionSummary(null);
    setDistCurrentState('ATTEMPT');
    alert('Database refreshed to seed defaults under Encrypted IndexedDB successfully!');
    await loadAllData();
  };
  const handleUpdateAdminPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAdminPassword || newAdminPassword.length < 4) {
      setChangePasswordStatus('Password must be at least 4 characters long.');
      return;
    }
    setChangePasswordStatus('Updating password in Supabase cloud...');
    try {
      const res = await updateAdminPasswordInSupabase(newAdminPassword);
      if (res.success) {
        setChangePasswordStatus('Admin password successfully updated in Supabase cloud!');
        setTimeout(() => {
          setChangePasswordModalOpen(false);
          setNewAdminPassword('');
          setChangePasswordStatus(null);
        }, 1200);
      } else {
        setChangePasswordStatus(`Failed: ${res.message}`);
      }
    } catch {
      setChangePasswordStatus('Network error while updating password.');
    }
  };

  // Governance KPI Telemetry (Computed strictly in-memory from existing arrays)
  const totalQuotaAllocated = cards.reduce((acc, c) => acc + (Number(c.allocated_qty) || 0), 0);
  const totalQuotaConsumed = cards.reduce((acc, c) => acc + (Number(c.consumed_qty) || 0), 0);
  const totalQuotaBalance = cards.reduce(
    (acc, c) =>
      acc +
      (c.remaining_balance !== undefined && !isNaN(Number(c.remaining_balance))
        ? Number(c.remaining_balance)
        : (Number(c.allocated_qty) || 0) - (Number(c.consumed_qty) || 0)),
    0
  );
  const quotaDisbursedPercent =
    totalQuotaAllocated > 0 ? ((totalQuotaConsumed / totalQuotaAllocated) * 100).toFixed(1) : '0.0';
  const totalGrainStock = lots.reduce((acc, l) => acc + (Number(l.remaining_quantity) || 0), 0);
  const outboxPendingCount = Math.max(activeNode?.outbox_depth || 0, pendingTokens.length);

  return (
    <div className="app-container">
      {/* Top Navigation Bar */}
      <header className="top-navbar">
        <div className="brand-section">
          <div className="brand-icon">
            <Wheat size={22} color="#ffffff" />
          </div>
          <div>
            <h1 className="brand-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, fontSize: 'inherit', fontWeight: 'inherit', lineHeight: 'inherit' }}>
              <span>GrainTrust</span>
              <span className="gov-seal-pill desktop-only">NFSA SOVEREIGN</span>
            </h1>
            <div className="brand-subtitle desktop-only">Resilient Registration & Offline Grain Distribution Ledger</div>
          </div>
        </div>

        {/* Desktop Status Controls (Visible only on desktop screens) */}
        <div className="status-controls desktop-only">
          {/* Storage & Database Engine Status Pill */}
          <div
            className="role-selector"
            title="Active Storage: Non-blocking Dexie IndexedDB with SubtleCrypto AES-GCM-256 Citizen PII Encryption & FIFO Log Retention"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.35rem 0.65rem',
              borderRadius: '9999px',
              border: '1px solid rgba(52, 211, 153, 0.4)',
              background: 'rgba(16, 185, 129, 0.12)',
              cursor: 'default',
            }}
          >
            <Lock size={13} color="var(--emerald-400)" />
            <span
              style={{
                fontSize: '0.72rem',
                fontWeight: 600,
                letterSpacing: '0.02em',
                color: 'var(--emerald-400)',
              }}
            >
              Storage: IndexedDB (AES-GCM-256)
            </span>
          </div>

          {/* Hardware Machine Identity Badge */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.45rem',
              padding: '0.35rem 0.65rem',
              borderRadius: 'var(--radius-md)',
              border: '1px solid rgba(16, 185, 129, 0.35)',
              background: 'rgba(15, 23, 42, 0.85)',
              color: 'var(--emerald-400)',
            }}
            title={`Physical Hardware Machine: ${currentMachineId} | Deployed at ${currentMachineName}`}
          >
            <Monitor size={14} color="var(--emerald-400)" />
            <span style={{ fontSize: '0.74rem', fontWeight: 800, color: '#ffffff', letterSpacing: '0.03em' }}>
              {currentMachineId}:
            </span>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              {currentMachineName.split('(')[0].trim()}
            </span>
            <span
              style={{
                fontSize: '0.62rem',
                fontFamily: 'var(--font-mono)',
                background: 'rgba(16, 185, 129, 0.15)',
                color: 'var(--emerald-400)',
                padding: '1px 5px',
                borderRadius: '4px',
              }}
            >
              {sessionId}
            </span>
            <button
              type="button"
              onClick={() => setMachineModalOpen(true)}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '4px',
                color: 'var(--text-muted)',
                fontSize: '0.65rem',
                padding: '1px 5px',
                cursor: 'pointer',
                marginLeft: '2px',
              }}
              title="Configure device hardware ID"
            >
              Device ID
            </button>
          </div>

          {/* Active Terminal Node */}
          <div className="role-selector">
            <label htmlFor="header-terminal-select" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer' }}>Terminal:</label>
            <select
              id="header-terminal-select"
              aria-label="Select Assigned Distribution Terminal Depot"
              value={selectedNodeId || 'node-alpha-001'}
              onChange={(e) => handleNodeChange(e.target.value)}
              style={{ minWidth: '180px', cursor: 'pointer' }}
            >
              {(nodes.length > 0 ? nodes : getInitialSeedDatabase().nodes).map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </div>

          {/* Online/Offline Toggle */}
          <button
            className={`node-mode-toggle ${isOnline ? 'online' : 'offline'}`}
            onClick={handleToggleOnline}
            title="Click to toggle edge terminal network connectivity"
          >
            {isOnline ? <Wifi size={14} /> : <WifiOff size={14} />}
            <span>{isOnline ? 'Network: Online' : 'Network: Offline (Edge)'}</span>
          </button>

          {/* Authenticated Operator Persona Badge (No casual demo dropdown) */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.55rem',
              background: 'rgba(15, 23, 42, 0.85)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: 'var(--radius-md)',
              padding: '0.35rem 0.7rem',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                <UserCheck size={14} color={activeRole === 'ADMINISTRATOR' ? 'var(--rose-400)' : 'var(--emerald-400)'} />
                <span style={{ fontSize: '0.76rem', fontWeight: 700, color: '#ffffff' }}>
                  {getRoleLongName(activeRole)}
                </span>
                {activeRole === 'ADMINISTRATOR' && (
                  <span style={{ fontSize: '0.62rem', background: 'rgba(244, 63, 94, 0.2)', color: 'var(--rose-400)', padding: '1px 5px', borderRadius: '4px', fontWeight: 700 }}>
                    ROOT
                  </span>
                )}
              </div>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                Authenticated Operator
              </span>
            </div>

            <button
              type="button"
              className="btn-secondary"
              style={{
                fontSize: '0.72rem',
                padding: '0.25rem 0.6rem',
                borderRadius: '6px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                border: '1px solid rgba(16, 185, 129, 0.4)',
                background: 'rgba(16, 185, 129, 0.12)',
                color: 'var(--emerald-400)',
                cursor: 'pointer',
                fontWeight: 600,
              }}
              onClick={() => openRoleAuthModal()}
              title="Authenticate and switch operator role (Password required for all roles)"
            >
              <Lock size={12} />
              <span>Switch Role</span>
            </button>
          </div>

          {/* Reset Database Button */}
          <button
            className="btn-secondary"
            style={{
              fontSize: '0.75rem',
              padding: '0.35rem 0.65rem',
              color: canResetDb ? 'var(--rose-400)' : 'var(--text-muted)',
              borderColor: canResetDb ? 'rgba(244, 63, 94, 0.4)' : 'rgba(255, 255, 255, 0.1)',
              background: canResetDb ? 'rgba(244, 63, 94, 0.1)' : 'transparent',
              opacity: canResetDb ? 1 : 0.5,
              cursor: canResetDb ? 'pointer' : 'not-allowed',
            }}
            onClick={handleResetDatabase}
            disabled={!canResetDb}
            title={canResetDb ? "Completely clear all database records, citizens, cards, and transactions" : "Only Administrator can reset the database"}
          >
            {canResetDb ? 'Clear DB' : 'Clear DB (Admin Only)'}
          </button>
        </div>

        {/* Mobile Header Actions (Visible only on mobile/tablet screens) */}
        <div className="mobile-header-actions mobile-only">
          <button
            type="button"
            className="mobile-quick-pill"
            onClick={() => setMobileDrawerOpen(true)}
            title="Open system controls & terminal drawer"
          >
            <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
            <span className="mobile-role-text">{getRoleShortName(activeRole)}</span>
          </button>

          <button
            type="button"
            className="mobile-menu-toggle-btn"
            onClick={() => setMobileDrawerOpen(true)}
            aria-label="Open System Controls Menu"
            title="Open System Controls & Terminal Settings"
          >
            <Menu size={20} />
          </button>
        </div>
      </header>

      {/* Mobile Slide-Over System Controls Drawer & Backdrop */}
      {mobileDrawerOpen && (
        <div
          className="mobile-drawer-backdrop"
          onClick={() => setMobileDrawerOpen(false)}
        />
      )}

      <aside
        className={`mobile-drawer ${mobileDrawerOpen ? 'open' : ''}`}
        aria-hidden={!mobileDrawerOpen}
        inert={!mobileDrawerOpen ? true : undefined}
      >
        <div className="mobile-drawer-header">
          <div className="mobile-drawer-title">
            <Sliders size={18} color="#166c52" />
            <span>Terminal & System Controls</span>
          </div>
          <button
            type="button"
            className="mobile-drawer-close"
            onClick={() => setMobileDrawerOpen(false)}
            aria-label="Close Controls Drawer"
          >
            <X size={20} />
          </button>
        </div>

        <div className="mobile-drawer-content">
          {/* Section 1: Active Role Persona */}
          <div className="drawer-section">
            <div className="drawer-section-title">
              <UserCheck size={15} color="#166c52" />
              <span>Operator Persona (RBAC)</span>
            </div>
            <div className="drawer-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
                <div>
                  <div style={{ fontSize: '0.72rem', color: '#789085' }}>Active Logged-in Operator:</div>
                  <strong style={{ fontSize: '0.95rem', color: '#214239' }}>{getRoleLongName(activeRole)}</strong>
                </div>
                <span className="badge badge-reconciled">AUTHENTICATED</span>
              </div>
              <div className="drawer-role-desc" style={{ marginBottom: '0.85rem' }}>
                {activeRole === 'DISTRIBUTION_OPERATOR' && '● POS Dispensing & Warehouse Stock'}
                {activeRole === 'REGISTRATION_OPERATOR' && '● Citizen Intake & KYC Enrollment'}
                {activeRole === 'SUPERVISOR' && '● Field Approvals, Override & Dispense'}
                {activeRole === 'AUDITOR' && '● Read-Only Audit & Trace Oversight'}
                {activeRole === 'ADMINISTRATOR' && '● Full Administration & Key Governance'}
              </div>
              <button
                type="button"
                className="btn-primary"
                style={{
                  width: '100%',
                  padding: '0.55rem',
                  fontSize: '0.8rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.45rem',
                  background: '#166c52',
                }}
                onClick={() => {
                  setMobileDrawerOpen(false);
                  openRoleAuthModal();
                }}
              >
                <Lock size={14} />
                <span>Switch / Authenticate Role</span>
              </button>
            </div>
          </div>

          {/* Section 2: Distribution Terminal & Network Mode */}
          <div className="drawer-section">
            <div className="drawer-section-title">
              <Layers size={15} color="#9d6610" />
              <span>Active Terminal Node & Network</span>
            </div>
            <div className="drawer-card">
              <label htmlFor="drawer-terminal-depot-select" style={{ fontSize: '0.72rem', color: '#354a40', marginBottom: '0.3rem', display: 'block', cursor: 'pointer' }}>
                Assigned Terminal Depot:
              </label>
              <select
                id="drawer-terminal-depot-select"
                aria-label="Select Assigned Distribution Terminal Depot"
                className="drawer-select"
                value={selectedNodeId || 'node-alpha-001'}
                onChange={(e) => handleNodeChange(e.target.value)}
              >
                {(nodes.length > 0 ? nodes : getInitialSeedDatabase().nodes).map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>

              <div style={{ marginTop: '0.75rem' }}>
                <button
                  type="button"
                  className={`node-mode-toggle ${isOnline ? 'online' : 'offline'}`}
                  style={{ width: '100%', justifyContent: 'center', padding: '0.6rem 1rem' }}
                  onClick={handleToggleOnline}
                >
                  {isOnline ? <Wifi size={15} /> : <WifiOff size={15} />}
                  <span>{isOnline ? 'Network: Online Central Mode' : 'Network: Offline (Edge Signed)'}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Section 3: Navigation Workspaces */}
          <div className="drawer-section">
            <div className="drawer-section-title">
              <Activity size={15} color="#166c52" />
              <span>Workspaces & Tabs</span>
            </div>
            <div className="drawer-nav-list">
              <button
                type="button"
                className={`drawer-nav-btn ${activeTab === 'distribution' ? 'active' : ''}`}
                onClick={() => { setActiveTab('distribution'); setMobileDrawerOpen(false); }}
              >
                <Activity size={16} color={activeTab === 'distribution' ? '#166c52' : '#789085'} />
                <span>Grain Dispense Desk</span>
              </button>
              <button
                type="button"
                className={`drawer-nav-btn ${activeTab === 'registrations' ? 'active' : ''}`}
                onClick={() => { setActiveTab('registrations'); setMobileDrawerOpen(false); }}
              >
                <Users size={16} color={activeTab === 'registrations' ? '#166c52' : '#789085'} />
                <span>Beneficiary Cards ({cards.length})</span>
              </button>
              <button
                type="button"
                className={`drawer-nav-btn ${activeTab === 'edge-sync' ? 'active' : ''}`}
                onClick={() => { setActiveTab('edge-sync'); setMobileDrawerOpen(false); }}
              >
                <RefreshCw size={16} color={activeTab === 'edge-sync' ? '#166c52' : '#789085'} />
                <span>Edge Outbox & Central Sync</span>
              </button>
              <button
                type="button"
                className={`drawer-nav-btn ${activeTab === 'inventory' ? 'active' : ''}`}
                onClick={() => { setActiveTab('inventory'); setMobileDrawerOpen(false); }}
              >
                <Wheat size={16} color={activeTab === 'inventory' ? '#166c52' : '#789085'} />
                <span>Grain Stockpile</span>
              </button>
              <button
                type="button"
                className={`drawer-nav-btn ${activeTab === 'audit-trail' ? 'active' : ''}`}
                onClick={() => { setActiveTab('audit-trail'); setMobileDrawerOpen(false); }}
              >
                <FileText size={16} color={activeTab === 'audit-trail' ? '#166c52' : '#789085'} />
                <span>Audit Log & Verification</span>
              </button>
              <button
                type="button"
                className={`drawer-nav-btn ${activeTab === 'fleet-telemetry' ? 'active' : ''}`}
                onClick={() => {
                  setMobileDrawerOpen(false);
                  if (activeRole !== 'ADMINISTRATOR') {
                    handleRoleChangeRequest('ADMINISTRATOR');
                  } else {
                    setActiveTab('fleet-telemetry');
                  }
                }}
                style={{
                  color: activeRole === 'ADMINISTRATOR' ? '#b91c1c' : undefined,
                }}
              >
                <Monitor size={16} color={activeRole === 'ADMINISTRATOR' ? '#b91c1c' : '#789085'} />
                <span>Rural Edge Fleet & Telemetry {activeRole !== 'ADMINISTRATOR' ? '🔒' : ''}</span>
              </button>
            </div>
          </div>

          {/* Section 4: Security & Encryption Integrity */}
          <div className="drawer-section">
            <div className="drawer-section-title">
              <Lock size={15} color="#166c52" />
              <span>Storage & Security Level</span>
            </div>
            <div className="drawer-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#166c52', fontWeight: 700, fontSize: '0.82rem' }}>
                <CheckCircle size={15} color="#166c52" />
                <span>IndexedDB (AES-GCM-256)</span>
              </div>
              <div style={{ fontSize: '0.74rem', color: '#789085', lineHeight: 1.4 }}>
                Citizen PII encrypted on device via WebCrypto SubtleCrypto. Zero-knowledge cryptographic proof generation.
              </div>
            </div>
          </div>

          {/* Section 5: Administration Reset */}
          <div className="drawer-section" style={{ marginTop: 'auto', paddingTop: '0.75rem' }}>
            <button
              type="button"
              className="btn-secondary"
              style={{
                width: '100%',
                fontSize: '0.8rem',
                padding: '0.6rem 1rem',
                color: canResetDb ? 'var(--rose-400)' : 'var(--text-muted)',
                borderColor: canResetDb ? 'rgba(244, 63, 94, 0.4)' : 'rgba(255, 255, 255, 0.1)',
                background: canResetDb ? 'rgba(244, 63, 94, 0.1)' : 'transparent',
                opacity: canResetDb ? 1 : 0.5,
                cursor: canResetDb ? 'pointer' : 'not-allowed',
                justifyContent: 'center',
              }}
              onClick={() => {
                setMobileDrawerOpen(false);
                handleResetDatabase();
              }}
              disabled={!canResetDb}
            >
              <Database size={15} />
              <span>{canResetDb ? 'Clear Database (Seed Reset)' : 'Clear DB (Admin Only)'}</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main App Shell with Persistent Sidebar + Main Workspace */}
      <div className="app-shell">
        {/* Desktop Sovereign Command Sidebar */}
        <aside className={`sovereign-sidebar desktop-only ${sidebarCollapsed ? 'collapsed' : ''}`} aria-label="Governance Navigation">
          {/* Sidebar Top Header & Collapse Toggle */}
          <div className="sidebar-header-row">
            {!sidebarCollapsed && (
              <div className="sidebar-brand-badge">
                <Shield size={14} color="#166c52" />
                <span>COMMAND DESK</span>
              </div>
            )}
            <button
              type="button"
              className="sidebar-collapse-btn"
              onClick={toggleSidebar}
              title={sidebarCollapsed ? "Expand Command Sidebar" : "Collapse Command Sidebar"}
              aria-label="Toggle Command Sidebar"
            >
              {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
          </div>

          {/* Operational Desks */}
          <div className="sidebar-section">
            <div className="sidebar-section-title">
              <Activity size={12} color="#166c52" />
              <span>Operational Desks</span>
            </div>
            <div className="sidebar-nav-list">
              <button
                type="button"
                className={`sidebar-nav-btn ${activeTab === 'distribution' ? 'active' : ''}`}
                onClick={() => setActiveTab('distribution')}
                title="Grain Dispense Desk"
              >
                <Activity size={16} color={activeTab === 'distribution' ? '#166c52' : '#789085'} />
                <span className="sidebar-label">Grain Dispense Desk</span>
              </button>

              <button
                type="button"
                className={`sidebar-nav-btn ${activeTab === 'registrations' ? 'active' : ''}`}
                onClick={() => setActiveTab('registrations')}
                title="Beneficiary Cards"
              >
                <Users size={16} color={activeTab === 'registrations' ? '#166c52' : '#789085'} />
                <span className="sidebar-label">Beneficiary Cards</span>
                <span className="sidebar-badge">{displayedCards.length}</span>
              </button>

              <button
                type="button"
                className={`sidebar-nav-btn ${activeTab === 'edge-sync' ? 'active' : ''}`}
                onClick={() => setActiveTab('edge-sync')}
                title="Edge Outbox & Central Sync"
              >
                <RefreshCw size={16} color={activeTab === 'edge-sync' ? '#166c52' : '#789085'} />
                <span className="sidebar-label">Edge Outbox & Sync</span>
                {outboxPendingCount > 0 ? (
                  <span className="sidebar-badge highlight">{outboxPendingCount}</span>
                ) : (
                  <span className="sidebar-badge">0</span>
                )}
              </button>

              <button
                type="button"
                className={`sidebar-nav-btn ${activeTab === 'inventory' ? 'active' : ''}`}
                onClick={() => setActiveTab('inventory')}
                title="Grain Stockpile Reserves"
              >
                <Wheat size={16} color={activeTab === 'inventory' ? '#166c52' : '#789085'} />
                <span className="sidebar-label">Grain Stockpile</span>
                <span className="sidebar-badge">{lots.length}</span>
              </button>
            </div>
          </div>

          {/* Governance & Audit */}
          <div className="sidebar-section">
            <div className="sidebar-section-title">
              <ShieldCheck size={12} color="#166c52" />
              <span>Governance & Audit</span>
            </div>
            <div className="sidebar-nav-list">
              <button
                type="button"
                className={`sidebar-nav-btn ${activeTab === 'audit-trail' ? 'active' : ''}`}
                onClick={() => setActiveTab('audit-trail')}
                title="Immutable Audit Log"
              >
                <FileText size={16} color={activeTab === 'audit-trail' ? '#166c52' : '#789085'} />
                <span className="sidebar-label">Immutable Audit Log</span>
              </button>

              <button
                type="button"
                className={`sidebar-nav-btn ${activeTab === 'fleet-telemetry' ? 'active' : ''}`}
                onClick={() => {
                  if (activeRole !== 'ADMINISTRATOR') {
                    handleRoleChangeRequest('ADMINISTRATOR');
                  } else {
                    setActiveTab('fleet-telemetry');
                  }
                }}
                title="Rural Edge Fleet & Telemetry"
              >
                <Monitor size={16} color={activeTab === 'fleet-telemetry' ? '#b91c1c' : '#789085'} />
                <span className="sidebar-label">Edge Fleet & Logs</span>
                {activeRole !== 'ADMINISTRATOR' && <Lock size={12} style={{ marginLeft: 'auto', opacity: 0.5 }} />}
              </button>
            </div>
          </div>

          {/* Security Footer Card */}
          <div className="sidebar-footer-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.72rem', fontWeight: 700, color: '#166c52' }}>
              <CheckCircle size={14} color="#166c52" />
              <span>WebCrypto AES-256</span>
            </div>
            <div style={{ fontSize: '0.67rem', color: '#789085', lineHeight: 1.35 }}>
              Zero-knowledge citizen PII encryption active.
            </div>
          </div>
        </aside>

        {/* Dashboard Content Area */}
        <div className="dashboard-content-area">
          {/* Executive Governance KPI Strip (Mobile Adaptive) */}
          <section className="governance-kpi-strip" aria-label="Governance Telemetry Pulse">
            {/* KPI 1: Quota Disbursed */}
            <div className="kpi-card">
              <div className="kpi-card-header">
                <span className="kpi-card-label">
                  <TrendingUp size={13} color="var(--emerald-400)" />
                  Quota Disbursed
                </span>
                <span className="badge badge-reconciled" style={{ fontSize: '0.65rem' }}>{quotaDisbursedPercent}%</span>
              </div>
              <div className="kpi-card-value">
                {totalQuotaConsumed}
                <span className="kpi-card-unit">kg drawn</span>
              </div>
              <div className="kpi-progress-bar">
                <div
                  className="kpi-progress-fill"
                  style={{
                    width: `${Math.min(100, Math.max(2, Number(quotaDisbursedPercent)))}%`,
                    background: 'linear-gradient(90deg, var(--emerald-500), var(--cyan-400))',
                  }}
                />
              </div>
              <div className="kpi-card-sub">
                <span>Allocated: {totalQuotaAllocated} kg</span>
                <span>Bal: {totalQuotaBalance} kg</span>
              </div>
            </div>

            {/* KPI 2: Buffer Reserve */}
            <div className="kpi-card">
              <div className="kpi-card-header">
                <span className="kpi-card-label">
                  <Wheat size={13} color="var(--amber-400)" />
                  Buffer Reserve Stock
                </span>
                <span className="gov-seal-pill" style={{ fontSize: '0.58rem', padding: '1px 5px' }}>OPTIMAL</span>
              </div>
              <div className="kpi-card-value">
                {totalGrainStock.toLocaleString()}
                <span className="kpi-card-unit">kg grain</span>
              </div>
              <div className="kpi-progress-bar">
                <div
                  className="kpi-progress-fill"
                  style={{
                    width: '94%',
                    background: 'linear-gradient(90deg, var(--amber-500), var(--emerald-400))',
                  }}
                />
              </div>
              <div className="kpi-card-sub">
                <span>{lots.length} Certified Lots</span>
                <span>Depot Silo #44</span>
              </div>
            </div>

            {/* KPI 3: Ledger Integrity */}
            <div className="kpi-card">
              <div className="kpi-card-header">
                <span className="kpi-card-label">
                  <ShieldCheck size={13} color={outboxPendingCount > 0 ? 'var(--amber-400)' : 'var(--emerald-400)'} />
                  Ledger Integrity
                </span>
                <span className={outboxPendingCount === 0 ? 'badge badge-reconciled' : 'badge badge-provisional'} style={{ fontSize: '0.65rem' }}>
                  {outboxPendingCount === 0 ? 'SYNCED' : 'PENDING'}
                </span>
              </div>
              <div className="kpi-card-value">
                {outboxPendingCount}
                <span className="kpi-card-unit">{outboxPendingCount === 1 ? 'token queued' : 'tokens queued'}</span>
              </div>
              <div className="kpi-progress-bar">
                <div
                  className="kpi-progress-fill"
                  style={{
                    width: outboxPendingCount === 0 ? '100%' : '35%',
                    background: outboxPendingCount === 0 ? 'var(--emerald-400)' : 'var(--amber-400)',
                  }}
                />
              </div>
              <div className="kpi-card-sub">
                <span>{outboxPendingCount === 0 ? 'Central Ledger Reconciled' : 'Offline Tokens Awaiting Sync'}</span>
                <span>Ed25519</span>
              </div>
            </div>

            {/* KPI 4: Terminal Identity */}
            <div className="kpi-card">
              <div className="kpi-card-header">
                <span className="kpi-card-label">
                  <Monitor size={13} color="var(--cyan-400)" />
                  Terminal Identity
                </span>
                <span className={`status-dot ${isOnline ? 'online' : 'offline'}`} />
              </div>
              <div className="kpi-card-value">
                {currentMachineId}
                <span className="kpi-card-unit" style={{ fontSize: '0.74rem' }}>({isOnline ? 'ONLINE' : 'OFFLINE'})</span>
              </div>
              <div className="kpi-progress-bar">
                <div
                  className="kpi-progress-fill"
                  style={{
                    width: '100%',
                    background: 'linear-gradient(90deg, var(--cyan-500), var(--indigo-500))',
                  }}
                />
              </div>
              <div className="kpi-card-sub">
                <span>{activeNode?.name ? activeNode.name.split('(')[0].trim() : 'Depot Alpha'}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.64rem', color: 'var(--cyan-400)' }}>{sessionId}</span>
              </div>
            </div>
          </section>

      {/* Offline Mode Warning Banner */}
      {!isOnline && (
        <div className="offline-banner">
          <WifiOff size={16} />
          <span>
            OFFLINE AUTONOMOUS MODE: Terminal operates on local signed leases. Grain will be provisioned using Ed25519
            cryptographic tokens and queued into the outbox ({Math.max(activeNode?.outbox_depth || 0, pendingTokens.length)} pending) until network sync.
          </span>
        </div>
      )}

      {/* Navigation Tabs (Mobile Only) */}
      <nav className="nav-tabs-bar mobile-only">
        <button
          className={`nav-tab-btn ${activeTab === 'distribution' ? 'active' : ''}`}
          onClick={() => setActiveTab('distribution')}
        >
          <Activity size={16} />
          <span>Grain Dispense Desk</span>
        </button>
        <button
          className={`nav-tab-btn ${activeTab === 'registrations' ? 'active' : ''}`}
          onClick={() => setActiveTab('registrations')}
        >
          <Users size={16} />
          <span>Beneficiary Cards ({displayedCards.length})</span>
        </button>
        <button
          className={`nav-tab-btn ${activeTab === 'edge-sync' ? 'active' : ''}`}
          onClick={() => setActiveTab('edge-sync')}
        >
          <RefreshCw size={16} />
          <span>Edge Outbox & Sync ({Math.max(activeNode?.outbox_depth || 0, pendingTokens.length)})</span>
        </button>
        <button
          className={`nav-tab-btn ${activeTab === 'inventory' ? 'active' : ''}`}
          onClick={() => setActiveTab('inventory')}
        >
          <Database size={16} />
          <span>Grain Stockpile</span>
        </button>
        <button
          className={`nav-tab-btn ${activeTab === 'audit-trail' ? 'active' : ''}`}
          onClick={() => setActiveTab('audit-trail')}
        >
          <FileText size={16} />
          <span>Immutable Audit Log</span>
        </button>
        <button
          className={`nav-tab-btn ${activeTab === 'fleet-telemetry' ? 'active' : ''}`}
          onClick={() => {
            if (activeRole !== 'ADMINISTRATOR') {
              handleRoleChangeRequest('ADMINISTRATOR');
            } else {
              setActiveTab('fleet-telemetry');
            }
          }}
          style={{
            borderLeft: activeRole === 'ADMINISTRATOR' ? '2px solid var(--rose-500)' : undefined,
            color: activeTab === 'fleet-telemetry' ? '#ffffff' : activeRole === 'ADMINISTRATOR' ? 'var(--rose-400)' : undefined,
          }}
        >
          <Monitor size={16} />
          <span>Rural Edge Fleet & Telemetry {activeRole !== 'ADMINISTRATOR' ? '🔒' : ''}</span>
        </button>
      </nav>

      {/* Network Reconnected Sync Banner */}
      {isOnline && Math.max(activeNode?.outbox_depth || 0, pendingTokens.length) > 0 && (
        <div
          style={{
            background: 'linear-gradient(90deg, rgba(245, 158, 11, 0.15), rgba(16, 185, 129, 0.15))',
            border: '1px solid rgba(245, 158, 11, 0.4)',
            borderRadius: 'var(--radius-md)',
            padding: '0.75rem 1.25rem',
            marginBottom: '1rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', color: 'var(--amber-400)', fontSize: '0.86rem' }}>
            <RefreshCw size={17} />
            <span>
              <strong>Network Online:</strong> {Math.max(activeNode?.outbox_depth || 0, pendingTokens.length)} provisional offline token(s) ready to sync to the central cloud database.
            </span>
          </div>
          <button
            className="btn-primary"
            style={{ padding: '0.4rem 0.9rem', fontSize: '0.78rem' }}
            onClick={handleTriggerSync}
            disabled={syncLoading}
          >
            {syncLoading ? 'Syncing...' : 'Reconcile Outbox Now'}
          </button>
        </div>
      )}

      <main className="main-view" key={activeTab}>
        {/* TAB 1: GRAIN DISTRIBUTION DESK */}
        {activeTab === 'distribution' && (
          <div className="tab-view tab-view--distribution">
            <div
              aria-live="polite"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '1rem',
                marginBottom: '1rem',
                padding: '0.9rem 1.1rem',
                border: `1px solid color-mix(in srgb, ${nodeAccent} 45%, transparent)`,
                borderLeft: `4px solid ${nodeAccent}`,
                borderRadius: 'var(--radius-md)',
                background: 'rgba(15, 23, 42, 0.7)',
              }}
            >
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em' }}>
                  ACTIVE DISTRIBUTION TERMINAL
                </div>
                <div style={{ color: '#ffffff', fontSize: '1rem', fontWeight: 800, marginTop: '0.2rem' }}>
                  {activeNode?.name || 'Loading terminal…'}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: '0.2rem' }}>
                  {activeNode?.location || 'Location unavailable'} · ID: {activeNode?.id || selectedNodeId}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                <button
                  type="button"
                  onClick={handleToggleOnline}
                  className={`terminal-toggle-btn ${isOnline ? 'active-online' : 'active-offline'}`}
                  title="Click to toggle network connectivity: Switch between Online Central Mode and Offline Autonomous Edge Mode"
                >
                  <span className="toggle-pill-dot" />
                  <span>{isOnline ? 'ONLINE — CENTRAL LEDGER' : 'OFFLINE — LOCAL EDGE LEASE'}</span>
                  <span className="toggle-action-hint">Click to Simulate {isOnline ? 'Offline' : 'Online'}</span>
                </button>
              </div>
            </div>
            {/* Multi-Device Machine Isolation vs. Administrator Collective Notice */}
            {activeRole === 'ADMINISTRATOR' ? (
              <div
                style={{
                  background: 'rgba(244, 63, 94, 0.1)',
                  border: '1px solid rgba(244, 63, 94, 0.3)',
                  borderRadius: 'var(--radius-md)',
                  padding: '0.65rem 1rem',
                  marginBottom: '1.25rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '0.6rem',
                  fontSize: '0.82rem',
                  color: 'var(--rose-400)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                  <ShieldCheck size={18} />
                  <span>
                    <strong>ADMINISTRATOR COLLECTIVE VIEW:</strong> Showing all <strong>{cards.length} cards</strong> across all 4 field laptops.
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Filter size={14} color="var(--text-muted)" />
                  <label htmlFor="admin-machine-filter-select" style={{ fontSize: '0.74rem', color: 'var(--text-muted)', cursor: 'pointer' }}>Filter Machine:</label>
                  <select
                    id="admin-machine-filter-select"
                    aria-label="Filter cards by edge machine"
                    value={selectedMachineFilter}
                    onChange={(e) => setSelectedMachineFilter(e.target.value)}
                    style={{
                      background: '#090d16',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '4px',
                      color: '#ffffff',
                      fontSize: '0.74rem',
                      padding: '3px 8px',
                    }}
                  >
                    <option value="ALL">All Machines ({cards.length} cards)</option>
                    {PRESET_MACHINES.map((pm) => (
                      <option key={pm.id} value={pm.id}>
                        {pm.id} - {pm.name.split('(')[0].trim()}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div
                style={{
                  background: 'rgba(56, 189, 248, 0.08)',
                  border: '1px solid rgba(56, 189, 248, 0.25)',
                  borderRadius: 'var(--radius-md)',
                  padding: '0.65rem 1rem',
                  marginBottom: '1.25rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '0.6rem',
                  fontSize: '0.82rem',
                  color: 'var(--cyan-400)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                  <Radio size={18} />
                  <span>
                    <strong>LOCAL MACHINE ISOLATION ACTIVE:</strong> Terminal <strong>{currentMachineId}</strong> ({currentMachineName.split('(')[0].trim()}).
                    Only cards registered/assigned to this machine are visible ({displayedCards.length} of {cards.length} cards).
                  </span>
                </div>
                <span
                  style={{
                    fontSize: '0.72rem',
                    padding: '3px 9px',
                    borderRadius: '4px',
                    background: 'rgba(56, 189, 248, 0.15)',
                    border: '1px solid var(--cyan-500)',
                    color: 'var(--cyan-400)',
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                  }}
                >
                  ISOLATED HARDWARE LEDGER
                </span>
              </div>
            )}

            <div className="beneficiary-hero"
              style={{
                background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.95))',
                border: '1px solid var(--border-accent)',
                borderRadius: 'var(--radius-lg)',
                padding: '1.25rem 1.5rem',
                marginBottom: '1.5rem',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <div
                    style={{
                      width: '48px',
                      height: '48px',
                      borderRadius: 'var(--radius-md)',
                      background: 'linear-gradient(135deg, var(--cyan-500), var(--indigo-500))',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <CreditCard size={24} color="#ffffff" />
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                      <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#ffffff' }}>
                        {activeBeneficiary?.full_name || 'No Card Selected'}
                      </h2>
                      <span className="badge badge-reconciled">
                        {activeBeneficiary?.status || 'ACTIVE'}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                      Card ID: <code style={{ color: 'var(--cyan-400)', fontWeight: 700 }}>{activeBeneficiary?.id || 'N/A'}</code>
                      {' • '}Phone: <strong>{activeBeneficiary?.phone_number || 'N/A'}</strong>
                      {' • '}Family: <strong>{activeBeneficiary?.family_count || 1} members</strong>
                      {' • '}Terminal: <strong style={{ color: 'var(--cyan-400)' }}>{activeBeneficiary?.machine_id || currentMachineId}</strong> ({activeBeneficiary?.machine_name ? activeBeneficiary.machine_name.split('(')[0].trim() : currentMachineName.split('(')[0].trim()})
                    </div>
                  </div>
                </div>

                <div className="hero-actions-bar" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <div
                    className="role-selector hero-card-selector"
                    style={{
                      background: '#090d16',
                      border: '1px solid var(--border-subtle)',
                      padding: '0.35rem 0.65rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      borderRadius: 'var(--radius-md)',
                    }}
                  >
                    <CreditCard size={15} color="var(--cyan-400)" />
                    <label htmlFor="hero-beneficiary-card-select" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', cursor: 'pointer' }}>Switch Card:</label>
                    <select
                      id="hero-beneficiary-card-select"
                      aria-label="Switch Active Beneficiary Card for Dispense"
                      className="hero-card-select"
                      value={selectedCardId || (displayedCards[0]?.id ?? cards[0]?.id ?? '')}
                      onChange={(e) => {
                        const newId = e.target.value;
                        selectedCardIdRef.current = newId;
                        setSelectedCardId(newId);
                        setDistExecutionSummary(null);
                        setDistCurrentState('ATTEMPT');
                      }}
                      style={{
                        cursor: 'pointer',
                        background: 'transparent',
                        color: 'var(--text-main)',
                        fontWeight: 600,
                        fontSize: '0.82rem',
                        outline: 'none',
                        border: 'none',
                      }}
                    >
                      {(displayedCards.length > 0 ? displayedCards : (activeRole === 'ADMINISTRATOR' ? cards : fieldVisibleCards)).map((c) => (
                        <option key={c.id} value={c.id}>
                          [{c.machine_id || 'MACH-01'}] {c.full_name} ({c.remaining_qty}kg rem) - {c.id.slice(0, 16)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button
                    className="btn-primary hero-insert-btn"
                    style={{ fontSize: '0.8rem', padding: '0.45rem 0.9rem' }}
                    onClick={() => {
                      handleDemoFill();
                      setActiveTab('registrations');
                    }}
                    title="Register a new beneficiary and issue an immediate grain card"
                  >
                    <PlusCircle size={15} />
                    <span>Insert New Card</span>
                  </button>
                </div>
              </div>

              {activeBeneficiary && (
                <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.84rem', marginBottom: '0.4rem' }}>
                    <span>
                      Monthly Quota Allocation:{' '}
                      <strong style={{ color: '#ffffff' }}>{activeBeneficiary.allocated_qty} kg</strong>
                    </span>
                    <span>
                      Drawn so far:{' '}
                      <strong style={{ color: 'var(--amber-400)' }}>{activeBeneficiary.consumed_qty} kg</strong>
                      {' • '}
                      Remaining Balance:{' '}
                      <strong style={{ color: 'var(--emerald-400)', fontSize: '0.95rem' }}>
                        {activeBeneficiary.remaining_qty} kg
                      </strong>
                    </span>
                  </div>

                  <div
                    style={{
                      height: '10px',
                      background: '#090d16',
                      borderRadius: '5px',
                      overflow: 'hidden',
                      display: 'flex',
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.min(100, (activeBeneficiary.consumed_qty / (activeBeneficiary.allocated_qty || 1)) * 100)}%`,
                        background: 'linear-gradient(90deg, var(--amber-500), var(--rose-500))',
                        transition: 'width 0.4s ease',
                      }}
                    />
                    <div
                      style={{
                        width: `${Math.max(0, 100 - (activeBeneficiary.consumed_qty / (activeBeneficiary.allocated_qty || 1)) * 100)}%`,
                        background: 'var(--emerald-500)',
                        opacity: 0.8,
                        transition: 'width 0.4s ease',
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="glass-panel" style={{ marginBottom: '1.5rem' }}>
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">
                    <Activity size={20} color="var(--cyan-400)" />
                    Grain Dispense Workflow (5-State Engine)
                  </h2>
                  <p className="panel-subtitle">
                    Automated transitions: ATTEMPT → PROVISIONAL_ISSUE / FAIL_REASON → FALLBACK_AUTH → RECONCILED
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleToggleOnline}
                  className={`terminal-toggle-btn ${isOnline ? 'active-online' : 'active-offline'}`}
                  style={{ padding: '0.35rem 0.8rem', fontSize: '0.75rem' }}
                  title="Click to toggle network: Test Online vs Offline Dispense"
                >
                  <span className="toggle-pill-dot" />
                  <span>{isOnline ? 'Online Central Validation' : 'Offline Ed25519 Token Signing'}</span>
                  <span className="toggle-action-hint">Toggle to {isOnline ? 'Offline' : 'Online'}</span>
                </button>
              </div>

              <div className="dispense-network-mode-pill">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className="toggle-pill-dot" style={{ background: isOnline ? '#10b981' : '#f59e0b', boxShadow: isOnline ? '0 0 8px #10b981' : '0 0 8px #f59e0b' }} />
                  <span>
                    Current Scenario: <strong>{isOnline ? 'Online Mode (Central Cloud Ledger)' : 'Offline Mode (Autonomous Edge Leases)'}</strong>
                  </span>
                </div>
                <button type="button" onClick={handleToggleOnline} className="btn-text-toggle">
                  Simulate {isOnline ? 'Offline Outage' : 'Online Restored'}
                </button>
              </div>

              <div className="pipeline-stepper">
                <div className="pipeline-connector" />
                <div className={`pipeline-step ${distCurrentState === 'ATTEMPT' ? 'active' : ''}`}>
                  <div className={`step-node ${distCurrentState === 'ATTEMPT' ? 'active-ATTEMPT' : ''}`}>1</div>
                  <span className="step-label">ATTEMPT</span>
                </div>
                <div className={`pipeline-step ${distCurrentState === 'FAIL_REASON' ? 'active' : ''}`}>
                  <div className={`step-node ${distCurrentState === 'FAIL_REASON' ? 'active-FAIL_REASON' : ''}`}>2</div>
                  <span className="step-label">FAIL_REASON</span>
                </div>
                <div className={`pipeline-step ${distCurrentState === 'FALLBACK_AUTH' ? 'active' : ''}`}>
                  <div className={`step-node ${distCurrentState === 'FALLBACK_AUTH' ? 'active-FALLBACK_AUTH' : ''}`}>3</div>
                  <span className="step-label">FALLBACK_AUTH</span>
                </div>
                <div className={`pipeline-step ${distCurrentState === 'PROVISIONAL_ISSUE' ? 'active' : ''}`}>
                  <div className={`step-node ${distCurrentState === 'PROVISIONAL_ISSUE' ? 'active-PROVISIONAL_ISSUE' : ''}`}>4</div>
                  <span className="step-label">PROVISIONAL</span>
                </div>
                <div className={`pipeline-step ${distCurrentState === 'RECONCILED' ? 'active' : ''}`}>
                  <div className={`step-node ${distCurrentState === 'RECONCILED' ? 'active-RECONCILED' : ''}`}>5</div>
                  <span className="step-label">RECONCILED</span>
                </div>
              </div>

              <div className="grid-3" style={{ marginTop: '1.5rem' }}>
                <div className="form-group">
                  <label className="form-label" htmlFor="dispense-lot-select">Grain Commodity Lot</label>
                  <select
                    id="dispense-lot-select"
                    aria-label="Grain Commodity Lot"
                    className="form-select"
                    value={distLotId}
                    onChange={(e) => setDistLotId(e.target.value)}
                  >
                    {lots.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.grain_type}) — Available: {l.remaining_quantity}kg
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="dispense-qty-input">Ration Quantity to Dispense (kg)</label>
                  <input
                    id="dispense-qty-input"
                    aria-label="Ration Quantity to Dispense in kilograms"
                    type="number"
                    step="0.5"
                    min="0.5"
                    max="100"
                    className="form-input"
                    value={distQuantity}
                    onChange={(e) => setDistQuantity(parseFloat(e.target.value) || 0)}
                  />
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    Beneficiary remaining quota: {activeBeneficiary?.remaining_qty || 0} kg
                  </span>
                </div>

              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1.25rem' }}>
                <input
                  type="checkbox"
                  id="fallback-override-check"
                  checked={distAllowFallback}
                  onChange={(e) => setDistAllowFallback(e.target.checked)}
                />
                <label htmlFor="fallback-override-check" style={{ fontSize: '0.82rem', color: 'var(--text-main)', cursor: 'pointer' }}>
                  Enable Supervisor Offline Fallback Auth (allows supervisor override to step into <code>FALLBACK_AUTH</code> if quota blocked)
                </label>
              </div>

              <button
                className="btn-primary"
                onClick={handleDispenseGrain}
                disabled={distLoading || !selectedCardId || distQuantity <= 0 || !canDispense}
                style={{
                  opacity: !canDispense ? 0.6 : 1,
                  cursor: !canDispense ? 'not-allowed' : 'pointer',
                  background: !canDispense ? '#475569' : undefined,
                }}
                title={!canDispense ? `${activeRole} cannot dispense grain (Requires Distribution Operator, Supervisor, or Admin)` : undefined}
              >
                <Play size={16} />
                <span>
                  {distLoading
                    ? 'Processing Authorization...'
                    : !canDispense
                    ? `Role Restricted (${activeRole === 'AUDITOR' ? 'Auditor: Read-Only' : 'Dispense Disabled'})`
                    : `Authorize & Dispense ${distQuantity}kg to ${activeBeneficiary?.full_name || 'Card'}`}
                </span>
              </button>

              {distExecutionSummary && (
                <div
                  style={{
                    marginTop: '1.5rem',
                    padding: '1.25rem',
                    borderRadius: 'var(--radius-md)',
                    background: distExecutionSummary.success
                      ? 'rgba(16, 185, 129, 0.1)'
                      : 'rgba(244, 63, 94, 0.1)',
                    border: `1px solid ${
                      distExecutionSummary.success ? 'var(--emerald-500)' : 'var(--rose-500)'
                    }`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                      {distExecutionSummary.success ? (
                        <CheckCircle size={22} color="var(--emerald-400)" />
                      ) : (
                        <XCircle size={22} color="var(--rose-400)" />
                      )}
                      <div>
                        <h4
                          style={{
                            fontSize: '1rem',
                            fontWeight: 800,
                            color: distExecutionSummary.success ? 'var(--emerald-400)' : 'var(--rose-400)',
                          }}
                        >
                          {distExecutionSummary.title}
                        </h4>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          Execution Mode: <strong>{distExecutionSummary.mode}</strong> • Final State: <strong>{distExecutionSummary.state}</strong>
                        </div>
                      </div>
                    </div>

                    <span
                      className={`badge ${
                        distExecutionSummary.success ? 'badge-reconciled' : 'badge-failed'
                      }`}
                    >
                      {distExecutionSummary.state}
                    </span>
                  </div>

                  <div
                    style={{
                      marginTop: '0.85rem',
                      padding: '0.75rem 1rem',
                      borderRadius: 'var(--radius-sm)',
                      background: 'rgba(15, 23, 42, 0.6)',
                      fontSize: '0.86rem',
                      lineHeight: 1.5,
                      color: '#ffffff',
                    }}
                  >
                    <div style={{ fontWeight: 600, color: 'var(--cyan-400)', marginBottom: '0.2rem' }}>
                      Operational Report:
                    </div>
                    {distExecutionSummary.explanation}
                  </div>

                  {distExecutionSummary.remediation && (
                    <div
                      style={{
                        marginTop: '0.6rem',
                        fontSize: '0.82rem',
                        color: 'var(--amber-400)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                      }}
                    >
                      <HelpCircle size={15} />
                      <span>{distExecutionSummary.remediation}</span>
                    </div>
                  )}

                  {distExecutionSummary.success && (
                    <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.85rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      <div>Dispensed: <strong style={{ color: '#ffffff' }}>{distQuantity} kg</strong></div>
                      <div>Updated Balance: <strong style={{ color: 'var(--emerald-400)' }}>{activeBeneficiary?.remaining_qty} kg</strong></div>
                      <div>Card: <code style={{ color: 'var(--cyan-400)' }}>{selectedCardId}</code></div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'registrations' && (
          <div className="grid-2">
            <div className="glass-panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">
                    <Users size={20} color="var(--cyan-400)" />
                    Beneficiary Enrollment Wizard
                  </h2>
                  <p className="panel-subtitle">Registers household and issues a unique grain card</p>
                </div>
                <button
                  className="btn-secondary"
                  onClick={handleDemoFill}
                  style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}
                >
                  Generate Sample Citizen
                </button>
              </div>

              {regFeedback && (
                <div
                  style={{
                    padding: '0.75rem',
                    borderRadius: 'var(--radius-sm)',
                    marginBottom: '1rem',
                    fontSize: '0.84rem',
                    background: regFeedback.type === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(244, 63, 94, 0.15)',
                    border: `1px solid ${regFeedback.type === 'success' ? 'var(--emerald-500)' : 'var(--rose-500)'}`,
                    color: regFeedback.type === 'success' ? 'var(--emerald-400)' : 'var(--rose-400)',
                  }}
                >
                  {regFeedback.message}
                </div>
              )}

              <form onSubmit={handleSubmitRegistration}>
                <div className="form-row-2">
                  <div className="form-group">
                    <label className="form-label" htmlFor="reg-first-name-input">First Name</label>
                    <input
                      id="reg-first-name-input"
                      aria-label="Beneficiary First Name"
                      type="text"
                      className="form-input"
                      required
                      value={regForm.first_name}
                      onChange={(e) => setRegForm({ ...regForm, first_name: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="reg-last-name-input">Last Name</label>
                    <input
                      id="reg-last-name-input"
                      aria-label="Beneficiary Last Name"
                      type="text"
                      className="form-input"
                      required
                      value={regForm.last_name}
                      onChange={(e) => setRegForm({ ...regForm, last_name: e.target.value })}
                    />
                  </div>
                </div>

                <div className="form-row-2">
                  <div className="form-group">
                    <label className="form-label" htmlFor="reg-phone-input">Phone Number (+91...)</label>
                    <input
                      id="reg-phone-input"
                      aria-label="Beneficiary Phone Number"
                      type="text"
                      className="form-input"
                      required
                      value={regForm.phone_number}
                      onChange={(e) => setRegForm({ ...regForm, phone_number: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="reg-dob-input">Date of Birth</label>
                    <input
                      id="reg-dob-input"
                      aria-label="Beneficiary Date of Birth"
                      type="date"
                      className="form-input"
                      required
                      value={regForm.dob}
                      onChange={(e) => setRegForm({ ...regForm, dob: e.target.value })}
                    />
                  </div>
                </div>

                <div className="form-row-2">
                  <div className="form-group">
                    <label className="form-label" htmlFor="reg-family-count-input">Family Size (10kg / member)</label>
                    <input
                      id="reg-family-count-input"
                      aria-label="Family Member Count"
                      type="number"
                      min="1"
                      max="20"
                      className="form-input"
                      value={regForm.family_count}
                      onChange={(e) => setRegForm({ ...regForm, family_count: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="reg-income-input">Annual Income (₹)</label>
                    <input
                      id="reg-income-input"
                      aria-label="Annual Household Income in Rupees"
                      type="number"
                      min="0"
                      className="form-input"
                      value={regForm.yearly_income}
                      onChange={(e) => setRegForm({ ...regForm, yearly_income: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="reg-address-input">Address</label>
                  <input
                    id="reg-address-input"
                    aria-label="Street Address"
                    type="text"
                    className="form-input"
                    required
                    value={regForm.address}
                    onChange={(e) => setRegForm({ ...regForm, address: e.target.value })}
                  />
                </div>

                <div className="form-row-2">
                  <div className="form-group">
                    <label className="form-label" htmlFor="reg-city-input">City</label>
                    <input
                      id="reg-city-input"
                      aria-label="City"
                      type="text"
                      className="form-input"
                      required
                      value={regForm.city}
                      onChange={(e) => setRegForm({ ...regForm, city: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="reg-state-input">State</label>
                    <input
                      id="reg-state-input"
                      aria-label="State"
                      type="text"
                      className="form-input"
                      required
                      value={regForm.state}
                      onChange={(e) => setRegForm({ ...regForm, state: e.target.value })}
                    />
                  </div>
                </div>

                <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: '0.5rem' }} disabled={regSubmitting}>
                  <Users size={16} />
                  <span>{regSubmitting ? 'Submitting...' : 'Register Beneficiary'}</span>
                </button>
              </form>
            </div>

            <div className="glass-panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">
                    <Award size={20} color="var(--emerald-400)" />
                    Beneficiary Registry & Card Issuance
                  </h2>
                  <p className="panel-subtitle">
                    {activeRole === 'ADMINISTRATOR'
                      ? `Administrator Global Registry: Showing all ${registrations.length} registrations across all field machines`
                      : `Local Registry (${currentMachineId}): Showing registrations enrolled on this device (${displayedRegistrations.length} records)`}
                  </p>
                </div>
              </div>

              <div className="data-table-wrapper" style={{ maxHeight: '540px', overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Citizen / Contact</th>
                      <th>Family / Card ID</th>
                      <th>Status / Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedRegistrations.length === 0 ? (
                      <tr>
                        <td colSpan={3} style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--text-muted)' }}>
                          <Users size={28} style={{ margin: '0 auto 0.5rem auto', opacity: 0.5, display: 'block' }} />
                          <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>No registrations for this machine</div>
                          <div style={{ fontSize: '0.78rem' }}>Enroll a citizen on the left or switch machine profile to view records from other depots.</div>
                        </td>
                      </tr>
                    ) : (
                      displayedRegistrations.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                              {r.data.first_name} {r.data.last_name}
                            </div>
                            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{r.data.phone_number}</div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                              {r.data.city}, {r.data.state}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '3px', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: '0.68rem', color: 'var(--cyan-400)' }}>
                                ID: <code>{r.id.slice(0, 16)}</code>
                              </span>
                              <span
                                style={{
                                  fontSize: '0.65rem',
                                  padding: '1px 5px',
                                  borderRadius: '3px',
                                  background: 'rgba(56, 189, 248, 0.15)',
                                  color: 'var(--cyan-400)',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '3px',
                                }}
                              >
                                <Monitor size={10} />
                                {(r.data as any)?.machine_id || (r as any).machine_id || 'MACH-01'}
                              </span>
                            </div>
                          </td>
                          <td>
                            <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                              {r.data.family_count} members ({r.data.family_count * 10}kg quota)
                            </div>
                            {r.card_id ? (
                              <code style={{ fontSize: '0.72rem', color: 'var(--emerald-400)' }}>Card: {r.card_id.slice(0, 14)}...</code>
                            ) : (
                              <span style={{ fontSize: '0.72rem', color: 'var(--amber-400)', fontWeight: 600 }}>
                                ● Pending Card Issuance
                              </span>
                            )}
                          </td>
                          <td>
                            {r.status !== 'APPROVED' ? (
                              <button
                                className="btn-primary"
                                style={{
                                  fontSize: '0.76rem',
                                  padding: '0.45rem 0.75rem',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.35rem',
                                  background: canApproveRegistrations
                                    ? 'linear-gradient(135deg, #059669 0%, #10b981 100%)'
                                    : '#475569',
                                  boxShadow: canApproveRegistrations
                                    ? '0 2px 8px rgba(16, 185, 129, 0.35)'
                                    : 'none',
                                  cursor: canApproveRegistrations ? 'pointer' : 'not-allowed',
                                  opacity: canApproveRegistrations ? 1 : 0.6,
                                }}
                                onClick={() => canApproveRegistrations && handleApproveRegistration(r.id)}
                                disabled={!canApproveRegistrations}
                                title={canApproveRegistrations ? "Approve registration and activate card" : "Requires Supervisor or Administrator approval"}
                              >
                                <CheckCircle size={14} />
                                {canApproveRegistrations ? 'Approve & Issue Card' : 'Approval Restricted (Supervisor Only)'}
                              </button>
                            ) : (
                              <button
                                className="btn-secondary"
                                style={{
                                  fontSize: '0.76rem',
                                  padding: '0.45rem 0.75rem',
                                  color: 'var(--emerald-400)',
                                  borderColor: 'var(--emerald-500)',
                                }}
                                onClick={async () => {
                                  if (r.card_id) {
                                    selectedCardIdRef.current = r.card_id;
                                    await loadAllData(r.card_id);
                                    setSelectedCardId(r.card_id);
                                    setDistExecutionSummary(null);
                                    setDistCurrentState('ATTEMPT');
                                    setActiveTab('distribution');
                                  }
                                }}
                              >
                                Dispense to Card →
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'edge-sync' && (
          <div className="glass-panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">
                  <RefreshCw size={20} color="var(--cyan-400)" />
                  Edge Terminal Outbox & Central Ledger Reconciliation
                </h2>
                <p className="panel-subtitle">Offline provisional tokens waiting to sync to MySQL source of truth</p>
              </div>
              <button className="btn-primary" onClick={handleTriggerSync} disabled={syncLoading || !isOnline}>
                <RefreshCw size={15} />
                <span>{syncLoading ? 'Reconciling...' : 'Trigger Batch Sync Now'}</span>
              </button>
            </div>

            {syncNotice && (
              <div
                style={{
                  padding: '0.85rem',
                  borderRadius: 'var(--radius-sm)',
                  marginBottom: '1.25rem',
                  fontSize: '0.85rem',
                  background: 'rgba(56, 189, 248, 0.15)',
                  border: '1px solid var(--cyan-500)',
                  color: 'var(--cyan-400)',
                }}
              >
                {syncNotice}
              </div>
            )}

            <div className="grid-3" style={{ marginBottom: '1.5rem' }}>
              <div className="metric-box">
                <span className="metric-label">Active Terminal</span>
                <span className="metric-value">{activeNode?.name}</span>
                <span className="metric-sub">ID: {activeNode?.id}</span>
              </div>
              <div className="metric-box">
                <span className="metric-label">Queued Provisional Tokens</span>
                <span className="metric-value" style={{ color: Math.max(activeNode?.outbox_depth || 0, pendingTokens.length) ? 'var(--amber-400)' : 'var(--emerald-400)' }}>
                  {Math.max(activeNode?.outbox_depth || 0, pendingTokens.length)}
                </span>
                <span className="metric-sub">Awaiting central verification</span>
              </div>
              <div className="metric-box">
                <span className="metric-label">Connection State</span>
                <span className="metric-value" style={{ color: isOnline ? 'var(--emerald-400)' : 'var(--amber-400)' }}>
                  {isOnline ? 'ONLINE' : 'OFFLINE'}
                </span>
                <span className="metric-sub">{isOnline ? 'Sync available' : 'Operating on local lease'}</span>
              </div>
            </div>

            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Terminal Node</th>
                    <th>Status</th>
                    <th>Pending Outbox</th>
                    <th>Location</th>
                    <th>Ed25519 Public Key</th>
                  </tr>
                </thead>
                <tbody>
                  {nodes.map((n) => (
                    <tr key={n.id}>
                      <td style={{ fontWeight: 700 }}>{n.name}</td>
                      <td>
                        <span className={`badge ${n.status === 'ONLINE' ? 'badge-reconciled' : 'badge-provisional'}`}>
                          {n.status}
                        </span>
                      </td>
                      <td style={{ fontWeight: 700 }}>
                        {n.id === selectedNodeId ? Math.max(n.outbox_depth || 0, pendingTokens.length) : (n.outbox_depth || 0)} tokens
                      </td>
                      <td>{n.location || 'Depot'}</td>
                      <td>
                        <code style={{ fontSize: '0.72rem', color: 'var(--cyan-400)' }}>
                          {n.public_key?.slice(0, 16)}...
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pendingTokens.length > 0 && (
              <div style={{ marginTop: '1.75rem' }}>
                <h3 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--amber-400)' }}>
                  <Clock size={16} />
                  <span>Pending Offline Provisional Tokens Queued in Outbox ({pendingTokens.length})</span>
                </h3>
                <div className="data-table-wrapper">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Token ID</th>
                        <th>Citizen / Beneficiary</th>
                        <th>Commodity Lot</th>
                        <th>Quantity</th>
                        <th>Created At</th>
                        <th>Authorization Mode</th>
                        <th>Reconciliation Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingTokens.map((t) => (
                        <tr key={t.id}>
                          <td><code style={{ fontSize: '0.75rem', color: 'var(--cyan-400)' }}>{t.id}</code></td>
                          <td style={{ fontWeight: 600 }}>{t.card_name}</td>
                          <td>{t.lot_name}</td>
                          <td style={{ fontWeight: 700, color: 'var(--emerald-400)' }}>{t.quantity} kg</td>
                          <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{new Date(t.timestamp).toLocaleTimeString()}</td>
                          <td>
                            <span className={`badge ${t.allow_fallback ? 'badge-provisional' : 'badge-reconciled'}`}>
                              {t.allow_fallback ? 'Supervisor Override' : 'Standard Offline Lease'}
                            </span>
                          </td>
                          <td>
                            <span style={{ fontSize: '0.8rem', color: 'var(--amber-400)', fontWeight: 600 }}>
                              ⏳ Pending Central Sync
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'inventory' && (
          <div className="glass-panel">
            <div className="panel-header">
              <h2 className="panel-title">
                <Database size={20} color="var(--emerald-400)" />
                Central Stockpile Inventory & Grain Reserves
              </h2>
            </div>
            <div className="data-table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Reserve Lot Name</th>
                    <th>Grain Type</th>
                    <th>Total Allocation</th>
                    <th>Remaining Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map((l) => (
                    <tr key={l.id}>
                      <td style={{ fontWeight: 700 }}>{l.name}</td>
                      <td>
                        <span className="badge badge-reconciled">{l.grain_type || 'Wheat'}</span>
                      </td>
                      <td>{(l.total_quantity ?? 5000).toLocaleString()} kg</td>
                      <td style={{ fontWeight: 800, color: 'var(--emerald-400)' }}>
                        {(l.remaining_quantity ?? 5000).toLocaleString()} kg
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'audit-trail' && (
          <div className="glass-panel">
            <div className="panel-header">
              <h2 className="panel-title">
                <FileText size={20} color="var(--cyan-400)" />
                Immutable Append-Only Audit Trail
              </h2>
            </div>
            <div className="data-table-wrapper" style={{ maxHeight: '520px', overflowY: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Actor ID</th>
                    <th>Action</th>
                    <th>Resource Type</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.slice(-15).reverse().map((log) => (
                    <tr key={log.id}>
                      <td style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </td>
                      <td style={{ fontWeight: 600 }}>{log.actor_id}</td>
                      <td>
                        <span className="badge badge-reconciled">{log.action}</span>
                      </td>
                      <td>{log.resource_type}</td>
                      <td style={{ fontSize: '0.75rem', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                        {JSON.stringify(log.details)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 6: RURAL EDGE FLEET SUPERVISION & TELEMETRY */}
        {activeTab === 'fleet-telemetry' && (
          <div>
            {activeRole !== 'ADMINISTRATOR' ? (
              <div
                className="glass-panel"
                style={{
                  textAlign: 'center',
                  padding: '3.5rem 1.5rem',
                  maxWidth: '680px',
                  margin: '2rem auto',
                  border: '1px solid rgba(244, 63, 94, 0.3)',
                }}
              >
                <div
                  style={{
                    width: '64px',
                    height: '64px',
                    borderRadius: '50%',
                    background: 'rgba(244, 63, 94, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    margin: '0 auto 1.25rem auto',
                  }}
                >
                  <Lock size={32} color="var(--rose-400)" />
                </div>
                <h2 style={{ fontSize: '1.4rem', fontWeight: 800, color: '#ffffff', marginBottom: '0.6rem' }}>
                  Administrator Access Required
                </h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1.75rem' }}>
                  The Rural Edge Fleet & Telemetry Control Center provides live supervision, heartbeat monitoring, and collective beneficiary logs across all 4 deployed machines. Operator credentials must be authenticated as Administrator via Supabase cloud credentials.
                </p>
                <button
                  type="button"
                  className="btn-primary"
                  style={{
                    background: 'linear-gradient(135deg, #e11d48, #be123c)',
                    fontSize: '0.9rem',
                    padding: '0.65rem 1.4rem',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                  }}
                  onClick={() => handleRoleChangeRequest('ADMINISTRATOR')}
                >
                  <Key size={16} />
                  <span>Authenticate as Administrator</span>
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                {/* Header Panel */}
                <div className="glass-panel">
                  <div className="panel-header" style={{ flexWrap: 'wrap', gap: '1rem' }}>
                    <div>
                      <h2 className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <Monitor size={22} color="var(--rose-400)" />
                        Rural Edge Fleet Supervision & Telemetry Control Center
                      </h2>
                      <p className="panel-subtitle">
                        Central real-time monitoring of 4 deployed machines in rural depots, outbox synchronization, and collective beneficiary ledger.
                      </p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => setChangePasswordModalOpen(true)}
                        style={{ fontSize: '0.78rem', padding: '0.4rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                      >
                        <Key size={14} />
                        <span>Change Supabase Master Password</span>
                      </button>
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={refreshFleetData}
                        disabled={fleetLoading}
                        style={{ fontSize: '0.78rem', padding: '0.4rem 0.8rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                      >
                        <RefreshCw size={14} className={fleetLoading ? 'animate-spin' : ''} />
                        <span>{fleetLoading ? 'Refreshing...' : 'Refresh Fleet Telemetry'}</span>
                      </button>
                    </div>
                  </div>

                  {/* 4 Summary Metric Cards */}
                  <div className="grid-4" style={{ marginTop: '0.5rem' }}>
                    <div className="metric-box">
                      <span className="metric-label">Deployed Terminals</span>
                      <span className="metric-value" style={{ color: 'var(--cyan-400)' }}>4 Machines</span>
                      <span className="metric-sub">Kanpur, Bithoor, Ganga Ghat, Admin Hub</span>
                    </div>
                    <div className="metric-box">
                      <span className="metric-label">Online Fleet Pulse</span>
                      <span className="metric-value" style={{ color: 'var(--emerald-400)' }}>
                        {fleetTelemetry.filter((t) => t.is_online).length} of {fleetTelemetry.length || 4} Live
                      </span>
                      <span className="metric-sub">
                        {fleetTelemetry.filter((t) => !t.is_online).length} operating in edge autonomous mode
                      </span>
                    </div>
                    <div className="metric-box">
                      <span className="metric-label">Collective Beneficiaries</span>
                      <span className="metric-value" style={{ color: '#ffffff' }}>
                        {cards.length} Cards
                      </span>
                      <span className="metric-sub">Aggregated across all rural laptops</span>
                    </div>
                    <div className="metric-box">
                      <span className="metric-label">Global Grain Disbursed</span>
                      <span className="metric-value" style={{ color: 'var(--amber-400)' }}>
                        {(metrics?.total_grain_disbursed || 0).toLocaleString()} kg
                      </span>
                      <span className="metric-sub">Total verified ration disbursed</span>
                    </div>
                  </div>
                </div>

                {/* Deployed Rural Machines Status Grid */}
                <div className="glass-panel">
                  <div className="panel-header">
                    <div>
                      <h3 className="panel-title" style={{ fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Server size={18} color="var(--cyan-400)" />
                        Deployed Field Terminals (4-Laptop Hardware Profiles)
                      </h3>
                      <p className="panel-subtitle">
                        Live hardware heartbeat, assigned operator role, network connectivity, and edge outbox depths.
                      </p>
                    </div>
                    <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                      Auto-refreshes every 8 seconds via Supabase
                    </span>
                  </div>

                  <div className="grid-2" style={{ gap: '1rem', marginTop: '0.5rem' }}>
                    {fleetTelemetry.map((m) => {
                      const isCurrentThisLaptop = m.machine_id === currentMachineId;
                      return (
                        <div
                          key={m.machine_id}
                          style={{
                            background: isCurrentThisLaptop
                              ? 'linear-gradient(135deg, rgba(30, 41, 59, 0.9), rgba(15, 23, 42, 0.95))'
                              : 'rgba(15, 23, 42, 0.7)',
                            border: isCurrentThisLaptop
                              ? '1px solid var(--cyan-500)'
                              : '1px solid var(--border-subtle)',
                            borderRadius: 'var(--radius-md)',
                            padding: '1.1rem 1.25rem',
                            position: 'relative',
                            boxShadow: isCurrentThisLaptop ? '0 0 16px rgba(56, 189, 248, 0.15)' : 'none',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span
                                  style={{
                                    fontSize: '0.72rem',
                                    fontWeight: 800,
                                    padding: '2px 8px',
                                    borderRadius: '4px',
                                    background: 'rgba(56, 189, 248, 0.2)',
                                    color: 'var(--cyan-400)',
                                    letterSpacing: '0.05em',
                                  }}
                                >
                                  {m.machine_id}
                                </span>
                                <h4 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#ffffff', margin: 0 }}>
                                  {m.machine_name.split('(')[0].trim()}
                                </h4>
                                {isCurrentThisLaptop && (
                                  <span
                                    style={{
                                      fontSize: '0.62rem',
                                      padding: '1px 6px',
                                      borderRadius: '999px',
                                      background: 'rgba(16, 185, 129, 0.2)',
                                      color: 'var(--emerald-400)',
                                      fontWeight: 700,
                                    }}
                                  >
                                    THIS DEVICE
                                  </span>
                                )}
                              </div>
                              <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                                📍 {m.location}
                              </div>
                            </div>
                            <span
                              className={`badge ${m.is_online ? 'badge-reconciled' : 'badge-provisional'}`}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                            >
                              <span
                                style={{
                                  width: '7px',
                                  height: '7px',
                                  borderRadius: '50%',
                                  background: m.is_online ? 'var(--emerald-400)' : 'var(--amber-400)',
                                  boxShadow: m.is_online ? '0 0 8px var(--emerald-400)' : 'none',
                                }}
                              />
                              {m.is_online ? 'ONLINE' : 'OFFLINE (EDGE)'}
                            </span>
                          </div>

                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(2, 1fr)',
                              gap: '0.6rem',
                              padding: '0.85rem',
                              background: '#090d16',
                              borderRadius: 'var(--radius-sm)',
                              fontSize: '0.78rem',
                              marginBottom: '0.75rem',
                            }}
                          >
                            <div style={{ gridColumn: 'span 2', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.45rem 0.65rem', background: 'rgba(255, 255, 255, 0.04)', borderRadius: '6px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.74rem' }}>Role Logged In:</span>
                              <span style={{ fontWeight: 700, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.82rem' }}>
                                <UserCheck size={14} color="var(--emerald-400)" />
                                {getRoleLongName(m.role as UserRole)}
                              </span>
                            </div>
                            <div>
                              <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.68rem' }}>Session ID:</span>
                              <code style={{ color: 'var(--cyan-400)', fontSize: '0.72rem' }}>{m.session_id}</code>
                            </div>
                            <div>
                              <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.68rem' }}>Connectivity:</span>
                              <span style={{ fontWeight: 700, color: m.is_online ? 'var(--emerald-400)' : 'var(--amber-400)' }}>
                                {m.is_online ? 'Cloud Synchronized' : 'Offline Autonomous'}
                              </span>
                            </div>
                            <div>
                              <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.68rem' }}>Outbox Depth:</span>
                              <span style={{ fontWeight: 700, color: m.outbox_count > 0 ? 'var(--amber-400)' : 'var(--emerald-400)' }}>
                                {m.outbox_count} offline tokens
                              </span>
                            </div>
                            <div>
                              <span style={{ color: 'var(--text-muted)', display: 'block', fontSize: '0.68rem' }}>Enrolled Cards:</span>
                              <span style={{ fontWeight: 700, color: '#ffffff' }}>
                                {cards.filter((c) => c.machine_id === m.machine_id).length} local cards
                              </span>
                            </div>
                          </div>

                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            <span>
                              Last Telemetry Ping: <strong style={{ color: '#ffffff' }}>{m.last_ping && m.last_ping.includes('T') ? new Date(m.last_ping).toLocaleTimeString() : m.last_ping}</strong>
                            </span>
                            <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                              Hardware ID: {m.machine_id}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Central Machine Activity & Transition Logs */}
                <div className="glass-panel">
                  <div className="panel-header" style={{ flexWrap: 'wrap', gap: '1rem' }}>
                    <div>
                      <h3 className="panel-title" style={{ fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Activity size={18} color="var(--cyan-400)" />
                        Multi-Machine Transition & Operational Step Logs
                      </h3>
                      <p className="panel-subtitle">
                        Collective machine-wise audit: Machines toggling offline/online, edge dispenses, outbox syncs, and citizen enrolments.
                      </p>
                    </div>
                    {/* Filters */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
                        <Filter size={13} color="var(--text-muted)" />
                        <label htmlFor="audit-terminal-filter-select" style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>Terminal:</label>
                        <select
                          id="audit-terminal-filter-select"
                          aria-label="Filter audit logs by terminal machine"
                          value={selectedMachineFilter}
                          onChange={(e) => setSelectedMachineFilter(e.target.value)}
                          style={{
                            background: '#090d16',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: '4px',
                            color: '#ffffff',
                            fontSize: '0.74rem',
                            padding: '3px 8px',
                          }}
                        >
                          <option value="ALL">All Machines</option>
                          {PRESET_MACHINES.map((pm) => (
                            <option key={pm.id} value={pm.id}>
                              {pm.id} - {pm.name.split('(')[0].trim()}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
                        <label htmlFor="audit-event-type-filter-select" style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>Event Type:</label>
                        <select
                          id="audit-event-type-filter-select"
                          aria-label="Filter audit logs by event type"
                          value={selectedLogTypeFilter}
                          onChange={(e) => setSelectedLogTypeFilter(e.target.value)}
                          style={{
                            background: '#090d16',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: '4px',
                            color: '#ffffff',
                            fontSize: '0.74rem',
                            padding: '3px 8px',
                          }}
                        >
                          <option value="ALL">All Events</option>
                          <option value="MACHINE_OFFLINE">Machine Offline Transitions</option>
                          <option value="MACHINE_ONLINE">Machine Online Restorations</option>
                          <option value="DISPENSE">Ration Dispenses</option>
                          <option value="BATCH_SYNC">Batch Reconciliations</option>
                          <option value="CARD_ENROLLED">Citizen KYC Enrolments</option>
                          <option value="SUPERVISOR_OVERRIDE">Admin / Supervisor Auth</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  <div className="data-table-wrapper" style={{ maxHeight: '420px', overflowY: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Timestamp</th>
                          <th>Origin Terminal</th>
                          <th>Event Action</th>
                          <th>Session ID</th>
                          <th>Operational Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {machineLogs
                          .filter((l) => (selectedMachineFilter === 'ALL' ? true : l.machine_id === selectedMachineFilter))
                          .filter((l) => (selectedLogTypeFilter === 'ALL' ? true : l.event_type === selectedLogTypeFilter))
                          .length === 0 ? (
                          <tr>
                            <td colSpan={5} style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--text-muted)' }}>
                              <Activity size={26} style={{ margin: '0 auto 0.5rem auto', opacity: 0.5, display: 'block' }} />
                              <div style={{ fontWeight: 600, fontSize: '0.88rem' }}>No telemetry logs matching selected filters</div>
                              <div style={{ fontSize: '0.76rem' }}>Events will stream here automatically as laptops operate and sync.</div>
                            </td>
                          </tr>
                        ) : (
                          machineLogs
                            .filter((l) => (selectedMachineFilter === 'ALL' ? true : l.machine_id === selectedMachineFilter))
                            .filter((l) => (selectedLogTypeFilter === 'ALL' ? true : l.event_type === selectedLogTypeFilter))
                            .map((log) => {
                              const badgeStyle =
                                log.event_type === 'MACHINE_OFFLINE'
                                  ? { background: 'rgba(244, 63, 94, 0.15)', color: 'var(--rose-400)', border: '1px solid var(--rose-500)' }
                                  : log.event_type === 'MACHINE_ONLINE'
                                  ? { background: 'rgba(16, 185, 129, 0.15)', color: 'var(--emerald-400)', border: '1px solid var(--emerald-500)' }
                                  : log.event_type === 'BATCH_SYNC'
                                  ? { background: 'rgba(56, 189, 248, 0.15)', color: 'var(--cyan-400)', border: '1px solid var(--cyan-500)' }
                                  : log.event_type === 'DISPENSE'
                                  ? { background: 'rgba(245, 158, 11, 0.15)', color: 'var(--amber-400)', border: '1px solid var(--amber-500)' }
                                  : { background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', border: '1px solid #a855f7' };

                              return (
                                <tr key={log.id}>
                                  <td style={{ fontSize: '0.74rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                                    {new Date(log.timestamp).toLocaleTimeString()}
                                  </td>
                                  <td>
                                    <div style={{ fontWeight: 700, fontSize: '0.82rem', color: '#ffffff' }}>
                                      {log.machine_id}
                                    </div>
                                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                      {log.machine_name.split('(')[0].trim()}
                                    </div>
                                  </td>
                                  <td>
                                    <span
                                      style={{
                                        fontSize: '0.68rem',
                                        fontWeight: 700,
                                        padding: '2px 8px',
                                        borderRadius: '4px',
                                        display: 'inline-block',
                                        ...badgeStyle,
                                      }}
                                    >
                                      {log.event_type.replace('_', ' ')}
                                    </span>
                                  </td>
                                  <td>
                                    <code style={{ fontSize: '0.72rem', color: 'var(--cyan-400)' }}>{log.session_id}</code>
                                  </td>
                                  <td>
                                    <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#ffffff' }}>
                                      {log.title}
                                    </div>
                                    <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                      {log.message}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Collective Multi-Machine Beneficiary Cards Ledger */}
                <div className="glass-panel">
                  <div className="panel-header">
                    <div>
                      <h3 className="panel-title" style={{ fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <CreditCard size={18} color="var(--emerald-400)" />
                        Collective Beneficiary Ledger Across All Machines ({cards.length} Total)
                      </h3>
                      <p className="panel-subtitle">
                        Administrator aggregate view: While individual rural laptops only display local cards, the central Administrator has holistic visibility.
                      </p>
                    </div>
                  </div>

                  <div className="data-table-wrapper" style={{ maxHeight: '380px', overflowY: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Citizen Name</th>
                          <th>Card ID</th>
                          <th>Origin Terminal</th>
                          <th>Quota Allocation</th>
                          <th>Remaining Balance</th>
                          <th>Card Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cards.map((c) => (
                          <tr key={c.id}>
                            <td style={{ fontWeight: 700 }}>{c.full_name}</td>
                            <td>
                              <code style={{ fontSize: '0.74rem', color: 'var(--cyan-400)' }}>{c.id}</code>
                            </td>
                            <td>
                              <span
                                style={{
                                  fontSize: '0.72rem',
                                  padding: '2px 8px',
                                  borderRadius: '4px',
                                  background: 'rgba(56, 189, 248, 0.15)',
                                  color: 'var(--cyan-400)',
                                  fontWeight: 600,
                                }}
                              >
                                {c.machine_id || 'MACH-01'} ({c.machine_name ? c.machine_name.split('(')[0].trim() : 'Laptop 1'})
                              </span>
                            </td>
                            <td>{c.allocated_qty} kg</td>
                            <td style={{ fontWeight: 800, color: 'var(--emerald-400)' }}>
                              {c.remaining_qty} kg
                            </td>
                            <td>
                              <span className="badge badge-reconciled">{c.status}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
        </div>
      </div>

      {/* MODAL 1: Operator Role Security Password Authentication Modal (White & Green Theme) */}
      {roleAuthModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.75)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <div
            style={{
              background: '#ffffff',
              border: '1.5px solid #10b981',
              borderRadius: '20px',
              maxWidth: '480px',
              width: '100%',
              boxShadow: '0 25px 60px -15px rgba(5, 150, 105, 0.25), 0 10px 25px -5px rgba(0, 0, 0, 0.1)',
              overflow: 'hidden',
              color: '#0f172a',
            }}
          >
            {/* White & Green Header */}
            <div
              style={{
                background: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)',
                borderBottom: '1px solid #d1fae5',
                padding: '1.4rem 1.75rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.85rem',
              }}
            >
              <div
                style={{
                  width: '46px',
                  height: '46px',
                  borderRadius: '12px',
                  background: '#ffffff',
                  border: '1.5px solid #10b981',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 10px rgba(16, 185, 129, 0.15)',
                  flexShrink: 0,
                }}
              >
                <ShieldCheck size={24} color="#059669" />
              </div>
              <div style={{ flex: 1 }}>
                <h3 style={{ fontSize: '1.18rem', fontWeight: 800, color: '#065f46', margin: 0 }}>
                  Operator Role Authentication
                </h3>
                <span style={{ fontSize: '0.76rem', color: '#059669', fontWeight: 600 }}>
                  Device: {currentMachineId} · {currentMachineName.split('(')[0].trim()}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setRoleAuthModalOpen(false);
                  setRolePasswordInput('');
                  setRoleAuthError(null);
                }}
                style={{
                  background: '#ffffff',
                  border: '1px solid #d1fae5',
                  borderRadius: '8px',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#64748b',
                  cursor: 'pointer',
                }}
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: '1.5rem 1.75rem' }}>
              <p style={{ fontSize: '0.84rem', color: '#475569', lineHeight: 1.5, marginBottom: '1.25rem' }}>
                Select target operator role and enter the system security password. All roles require cryptographic authentication to ensure accountability across field machines.
              </p>

              {roleAuthError && (
                <div
                  style={{
                    background: '#fef2f2',
                    border: '1.5px solid #f87171',
                    borderRadius: '10px',
                    padding: '0.75rem 1rem',
                    fontSize: '0.82rem',
                    color: '#b91c1c',
                    fontWeight: 600,
                    marginBottom: '1.25rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                  }}
                >
                  <AlertTriangle size={16} color="#b91c1c" />
                  <span>{roleAuthError}</span>
                </div>
              )}

              <form onSubmit={handleVerifyRolePassword}>
                {/* Target Role Selector */}
                <div style={{ marginBottom: '1.15rem' }}>
                  <label
                    htmlFor="target-role-persona-select"
                    style={{
                      display: 'block',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      color: '#1e293b',
                      marginBottom: '0.45rem',
                      cursor: 'pointer',
                    }}
                  >
                    Target Role Persona
                  </label>
                  <select
                    id="target-role-persona-select"
                    aria-label="Target Role Persona"
                    value={pendingTargetRole}
                    onChange={(e) => setPendingTargetRole(e.target.value as UserRole)}
                    style={{
                      width: '100%',
                      padding: '0.75rem 1rem',
                      fontSize: '0.9rem',
                      fontWeight: 600,
                      color: '#0f172a',
                      background: '#f8fafc',
                      border: '1.5px solid #cbd5e1',
                      borderRadius: '10px',
                      cursor: 'pointer',
                      outline: 'none',
                    }}
                  >
                    <option value="DISTRIBUTION_OPERATOR">Distribution Operator (POS Dispense & Stock)</option>
                    <option value="REGISTRATION_OPERATOR">Registration Operator (Citizen KYC & Enrollment)</option>
                    <option value="SUPERVISOR">Field Supervisor (Field Approvals & Overrides)</option>
                    <option value="AUDITOR">Auditor (Read-Only Audit & Trace Oversight)</option>
                    <option value="ADMINISTRATOR">Administrator (Fleet Supervision & Full System Governance - Online)</option>
                  </select>
                  {pendingTargetRole === 'ADMINISTRATOR' && !isOnline && (
                    <div style={{ fontSize: '0.75rem', color: '#d97706', marginTop: '0.35rem', fontWeight: 600 }}>
                      ⚠️ Terminal is currently Offline. Administrator access requires online cloud verification.
                    </div>
                  )}
                </div>

                {/* Password Input */}
                <div style={{ marginBottom: '1.5rem' }}>
                  <label
                    htmlFor="role-security-password-input"
                    style={{
                      display: 'block',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      color: '#1e293b',
                      marginBottom: '0.45rem',
                      cursor: 'pointer',
                    }}
                  >
                    Security Password
                  </label>
                  <input
                    id="role-security-password-input"
                    aria-label="Security Password"
                    type="password"
                    style={{
                      width: '100%',
                      padding: '0.75rem 1rem',
                      fontSize: '0.95rem',
                      color: '#0f172a',
                      background: '#ffffff',
                      border: '1.5px solid #cbd5e1',
                      borderRadius: '10px',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                    placeholder="Enter security password..."
                    value={rolePasswordInput}
                    onChange={(e) => setRolePasswordInput(e.target.value)}
                    autoFocus
                  />
                </div>

                {/* Action Buttons */}
                <div style={{ display: 'flex', gap: '0.85rem' }}>
                  <button
                    type="button"
                    style={{
                      flex: 1,
                      padding: '0.75rem 1rem',
                      fontSize: '0.88rem',
                      fontWeight: 600,
                      background: '#f1f5f9',
                      border: '1px solid #cbd5e1',
                      borderRadius: '10px',
                      color: '#475569',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setRoleAuthModalOpen(false);
                      setRolePasswordInput('');
                      setRoleAuthError(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    style={{
                      flex: 1.5,
                      padding: '0.75rem 1rem',
                      fontSize: '0.88rem',
                      fontWeight: 700,
                      background: '#059669',
                      border: 'none',
                      borderRadius: '10px',
                      color: '#ffffff',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.45rem',
                      boxShadow: '0 4px 14px rgba(5, 150, 105, 0.35)',
                    }}
                    disabled={roleAuthLoading}
                  >
                    <Lock size={15} />
                    <span>{roleAuthLoading ? 'Verifying...' : 'Authenticate & Login'}</span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: Admin Offline Blocked Notice Modal (White & Green / Amber Theme) */}
      {adminOfflineBlockedModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.75)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <div
            style={{
              background: '#ffffff',
              border: '1.5px solid #f59e0b',
              borderRadius: '20px',
              maxWidth: '480px',
              width: '100%',
              boxShadow: '0 25px 60px -15px rgba(245, 158, 11, 0.25), 0 10px 25px -5px rgba(0, 0, 0, 0.1)',
              overflow: 'hidden',
              color: '#0f172a',
            }}
          >
            <div
              style={{
                background: 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)',
                borderBottom: '1px solid #fde68a',
                padding: '1.4rem 1.75rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.85rem',
              }}
            >
              <div
                style={{
                  width: '46px',
                  height: '46px',
                  borderRadius: '12px',
                  background: '#ffffff',
                  border: '1.5px solid #f59e0b',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 10px rgba(245, 158, 11, 0.15)',
                  flexShrink: 0,
                }}
              >
                <AlertTriangle size={24} color="#d97706" />
              </div>
              <div style={{ flex: 1 }}>
                <h3 style={{ fontSize: '1.18rem', fontWeight: 800, color: '#92400e', margin: 0 }}>
                  Admin Locked in Offline Mode
                </h3>
                <span style={{ fontSize: '0.76rem', color: '#b45309', fontWeight: 600 }}>
                  Security Protocol Enforcement
                </span>
              </div>
            </div>

            <div style={{ padding: '1.5rem 1.75rem' }}>
              <p style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.5, marginBottom: '1rem' }}>
                <strong>Access Restricted:</strong> In Offline Autonomous Mode, the Administrator governance hub cannot be accessed. Central Supabase cloud authentication is strictly mandated to verify root administrator privileges and prevent edge privilege escalation.
              </p>

              <div
                style={{
                  background: '#f8fafc',
                  borderLeft: '4px solid #059669',
                  borderRadius: '8px',
                  padding: '0.85rem 1rem',
                  fontSize: '0.8rem',
                  color: '#334155',
                  marginBottom: '1.5rem',
                }}
              >
                Edge terminals operating without connectivity should function under <strong>Field Supervisor</strong> or <strong>Distribution Operator</strong> roles using offline cryptographic leases.
              </div>

              <div style={{ display: 'flex', gap: '0.85rem' }}>
                <button
                  type="button"
                  style={{
                    flex: 1,
                    padding: '0.75rem 1rem',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    background: '#f1f5f9',
                    border: '1px solid #cbd5e1',
                    borderRadius: '10px',
                    color: '#475569',
                    cursor: 'pointer',
                  }}
                  onClick={() => setAdminOfflineBlockedModal(false)}
                >
                  Stay Offline
                </button>
                <button
                  type="button"
                  style={{
                    flex: 1.5,
                    padding: '0.75rem 1rem',
                    fontSize: '0.85rem',
                    fontWeight: 700,
                    background: '#059669',
                    border: 'none',
                    borderRadius: '10px',
                    color: '#ffffff',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.45rem',
                    boxShadow: '0 4px 14px rgba(5, 150, 105, 0.35)',
                  }}
                  onClick={() => {
                    setAdminOfflineBlockedModal(false);
                    handleToggleOnline();
                    setTimeout(() => {
                      openRoleAuthModal('ADMINISTRATOR');
                    }, 400);
                  }}
                >
                  <Wifi size={15} />
                  <span>Switch Online & Login</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: Device Hardware Identity Configuration (White & Green Theme) */}
      {machineModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.75)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <div
            style={{
              background: '#ffffff',
              border: '1.5px solid #10b981',
              borderRadius: '20px',
              maxWidth: '560px',
              width: '100%',
              boxShadow: '0 25px 60px -15px rgba(5, 150, 105, 0.25), 0 10px 25px -5px rgba(0, 0, 0, 0.1)',
              overflow: 'hidden',
              color: '#0f172a',
            }}
          >
            <div
              style={{
                background: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)',
                borderBottom: '1px solid #d1fae5',
                padding: '1.4rem 1.75rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
                <div
                  style={{
                    width: '44px',
                    height: '44px',
                    borderRadius: '12px',
                    background: '#ffffff',
                    border: '1.5px solid #10b981',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Monitor size={22} color="#059669" />
                </div>
                <div>
                  <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#065f46', margin: 0 }}>
                    Device Hardware Identity Configuration
                  </h3>
                  <span style={{ fontSize: '0.78rem', color: '#059669', fontWeight: 600 }}>
                    Local Machine ID & Telemetry Registration
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setMachineModalOpen(false)}
                style={{
                  background: '#ffffff',
                  border: '1px solid #d1fae5',
                  borderRadius: '8px',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#64748b',
                  cursor: 'pointer',
                }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ padding: '1.5rem 1.75rem' }}>
              <p style={{ fontSize: '0.84rem', color: '#475569', lineHeight: 1.5, marginBottom: '1.25rem' }}>
                Configure the permanent hardware identity of this physical laptop. Each terminal stores its identity in local browser storage and synchronizes its telemetry, outbox, and logs directly with Supabase.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
                {PRESET_MACHINES.map((preset) => {
                  const isSelected = preset.id === currentMachineId;
                  return (
                    <div
                      key={preset.id}
                      onClick={() => handleSelectMachineProfile(preset.id)}
                      style={{
                        background: isSelected ? '#ecfdf5' : '#f8fafc',
                        border: isSelected ? '2px solid #059669' : '1px solid #e2e8f0',
                        borderRadius: '12px',
                        padding: '0.9rem 1.1rem',
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span
                            style={{
                              fontSize: '0.72rem',
                              fontWeight: 800,
                              padding: '2px 8px',
                              borderRadius: '4px',
                              background: isSelected ? '#059669' : '#e2e8f0',
                              color: isSelected ? '#ffffff' : '#334155',
                            }}
                          >
                            {preset.id}
                          </span>
                          <strong style={{ color: '#0f172a', fontSize: '0.92rem' }}>
                            {preset.name}
                          </strong>
                        </div>
                        <div style={{ fontSize: '0.76rem', color: '#64748b', marginTop: '0.25rem' }}>
                          📍 {preset.location}
                        </div>
                      </div>
                      {isSelected ? (
                        <span
                          style={{
                            fontSize: '0.72rem',
                            fontWeight: 800,
                            padding: '3px 10px',
                            borderRadius: '999px',
                            background: '#d1fae5',
                            color: '#065f46',
                            border: '1px solid #a7f3d0',
                          }}
                        >
                          THIS DEVICE
                        </span>
                      ) : (
                        <span style={{ fontSize: '0.76rem', color: '#059669', fontWeight: 600 }}>Assign →</span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  style={{
                    padding: '0.6rem 1.25rem',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    background: '#059669',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: 'pointer',
                  }}
                  onClick={() => setMachineModalOpen(false)}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 4: Central Password Update Modal (White & Green Theme) */}
      {changePasswordModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.75)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
          }}
        >
          <div
            style={{
              background: '#ffffff',
              border: '1.5px solid #10b981',
              borderRadius: '20px',
              maxWidth: '460px',
              width: '100%',
              boxShadow: '0 25px 60px -15px rgba(5, 150, 105, 0.25), 0 10px 25px -5px rgba(0, 0, 0, 0.1)',
              overflow: 'hidden',
              color: '#0f172a',
            }}
          >
            <div
              style={{
                background: 'linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%)',
                borderBottom: '1px solid #d1fae5',
                padding: '1.4rem 1.75rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem' }}>
                <div
                  style={{
                    width: '44px',
                    height: '44px',
                    borderRadius: '12px',
                    background: '#ffffff',
                    border: '1.5px solid #10b981',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Key size={22} color="#059669" />
                </div>
                <div>
                  <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#065f46', margin: 0 }}>
                    Update Central Master Password
                  </h3>
                  <span style={{ fontSize: '0.78rem', color: '#059669', fontWeight: 600 }}>
                    Supabase Cloud Security Ledger
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setChangePasswordModalOpen(false)}
                style={{
                  background: '#ffffff',
                  border: '1px solid #d1fae5',
                  borderRadius: '8px',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#64748b',
                  cursor: 'pointer',
                }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ padding: '1.5rem 1.75rem' }}>
              <p style={{ fontSize: '0.84rem', color: '#475569', lineHeight: 1.5, marginBottom: '1.25rem' }}>
                Centrally update the master security password in Supabase. All deployed field terminals will immediately require this password to authenticate operator roles.
              </p>

              {changePasswordStatus && (
                <div
                  style={{
                    background: changePasswordStatus.includes('success') ? '#f0fdf4' : '#fef2f2',
                    border: `1.5px solid ${changePasswordStatus.includes('success') ? '#10b981' : '#f87171'}`,
                    borderRadius: '10px',
                    padding: '0.75rem 1rem',
                    fontSize: '0.82rem',
                    color: changePasswordStatus.includes('success') ? '#065f46' : '#b91c1c',
                    fontWeight: 600,
                    marginBottom: '1.25rem',
                  }}
                >
                  {changePasswordStatus}
                </div>
              )}

              <form onSubmit={handleUpdateAdminPassword}>
                <div style={{ marginBottom: '1.5rem' }}>
                  <label
                    htmlFor="new-admin-master-password-input"
                    style={{
                      display: 'block',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      color: '#1e293b',
                      marginBottom: '0.45rem',
                      cursor: 'pointer',
                    }}
                  >
                    New Master Password
                  </label>
                  <input
                    id="new-admin-master-password-input"
                    aria-label="New Master Password"
                    type="password"
                    style={{
                      width: '100%',
                      padding: '0.75rem 1rem',
                      fontSize: '0.95rem',
                      color: '#0f172a',
                      background: '#ffffff',
                      border: '1.5px solid #cbd5e1',
                      borderRadius: '10px',
                      outline: 'none',
                      boxSizing: 'border-box',
                    }}
                    placeholder="Enter new master password (min 4 chars)..."
                    value={newAdminPassword}
                    onChange={(e) => setNewAdminPassword(e.target.value)}
                    autoFocus
                  />
                </div>

                <div style={{ display: 'flex', gap: '0.85rem' }}>
                  <button
                    type="button"
                    style={{
                      flex: 1,
                      padding: '0.75rem 1rem',
                      fontSize: '0.88rem',
                      fontWeight: 600,
                      background: '#f1f5f9',
                      border: '1px solid #cbd5e1',
                      borderRadius: '10px',
                      color: '#475569',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setChangePasswordModalOpen(false);
                      setNewAdminPassword('');
                      setChangePasswordStatus(null);
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    style={{
                      flex: 1.5,
                      padding: '0.75rem 1rem',
                      fontSize: '0.88rem',
                      fontWeight: 700,
                      background: '#059669',
                      border: 'none',
                      borderRadius: '10px',
                      color: '#ffffff',
                      cursor: 'pointer',
                      boxShadow: '0 4px 14px rgba(5, 150, 105, 0.35)',
                    }}
                  >
                    Update Central Password
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


