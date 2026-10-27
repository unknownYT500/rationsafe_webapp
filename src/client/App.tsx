// src/client/App.tsx
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
  type LocalDatabaseState,
  type CardBeneficiary,
  type GrainLotItem,
  type NodeItem,
  type AuditLogItem,
  type RegistrationItem,
} from './local-storage-db.js';
import {
  initializeAndMigrateDatabase,
  recordDispenseAsync,
  recordRegistrationAsync,
  verifyAndApproveRegistrationAsync,
  recordSyncAsync,
  toggleNodeOnlineStatusAsync,
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

export default function App(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<
    'distribution' | 'registrations' | 'edge-sync' | 'inventory' | 'audit-trail'
  >('distribution');
  const [activeRole, setActiveRole] = useState<UserRole>('DISTRIBUTION_OPERATOR');
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('node-alpha-001');
  const selectedNodeIdRef = useRef(selectedNodeId);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState<boolean>(false);
  const dataRequestRef = useRef(0);

  useEffect(() => {
    currentActiveRole = activeRole;
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

      // Optional remote API check (if backend is active)
      try {
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
      } catch {}

      // Overlay live cloud data from Supabase if provisioned and online
      try {
        const cloudData = await fetchCloudDataFromSupabase();
        if (cloudData) {
          if (cloudData.cards && cloudData.cards.length > 0) finalCards = cloudData.cards;
          if (cloudData.lots && cloudData.lots.length > 0) finalLots = cloudData.lots;
          if (cloudData.nodes && cloudData.nodes.length > 0) finalNodes = cloudData.nodes;
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
          };
          finalCards.unshift(reconstructedCard);
        }
      }

      // Ensure cards, nodes, and lots never empty in edge client
      if (finalCards.length === 0) {
        const seed = getInitialSeedDatabase();
        finalCards = [...seed.cards];
      }
      if (finalNodes.length === 0) {
        const seed = getInitialSeedDatabase();
        finalNodes = [...seed.nodes];
      }
      if (finalLots.length === 0) {
        const seed = getInitialSeedDatabase();
        finalLots = [...seed.lots];
      }

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
        setIsOnline(curr.status === 'ONLINE');
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

  // Active selected beneficiary card & terminal node
  const activeBeneficiary = cards.find((c) => c.id === selectedCardId) || cards[0];
  const activeLot = lots.find((l) => l.id === distLotId) || lots[0];
  const activeNode = nodes.find((n) => n.id === selectedNodeId) || nodes[0];
  const nodeAccent = selectedNodeId.includes('beta') ? 'var(--amber-400)' : 'var(--cyan-400)';

  const handleNodeChange = (nodeId: string) => {
    const nextNode = nodes.find((node) => node.id === nodeId);
    selectedNodeIdRef.current = nodeId;
    setSelectedNodeId(nodeId);
    // Keep active card selection intact across distribution terminals
    setIsOnline(nextNode?.status === 'ONLINE');
    setDistExecutionSummary(null);
    setDistCurrentState('ATTEMPT');
    setSyncNotice(null);
  };

  // Toggle Online/Offline
  const handleToggleOnline = async () => {
    try {
      const res = await safeFetchJson(`/api/v1/edge-nodes/${selectedNodeId}/toggle-online`, { method: 'POST' });
      if (res.ok && res.data) {
        setIsOnline(res.data.isOnline);
      } else {
        const toggleResult = await toggleNodeOnlineStatusAsync(selectedNodeId);
        setIsOnline(toggleResult.isOnline);
      }
    } catch {
      const toggleResult = await toggleNodeOnlineStatusAsync(selectedNodeId);
      setIsOnline(toggleResult.isOnline);
    }
    await loadAllData(selectedCardId);
  };

  // Submit Beneficiary Registration
  const handleSubmitRegistration = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegSubmitting(true);
    setRegFeedback(null);

    try {
      const res = await safeFetchJson('/api/v1/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...regForm, node_id: selectedNodeId }),
      });
      if (res.ok && res.data) {
        await insertRegistrationToSupabase({ id: res.data.id, node_id: selectedNodeId, data: regForm });
        setRegFeedback({
          type: 'success',
          message: `Registration recorded for ${regForm.first_name} ${regForm.last_name}! Record ID: ${res.data.id}. Click "Verify" & "Approve" below to activate their card.`,
        });
      } else {
        const { reg } = await recordRegistrationAsync(regForm, selectedNodeId);
        await insertRegistrationToSupabase({ id: reg.id, node_id: selectedNodeId, data: regForm });
        setRegFeedback({
          type: 'success',
          message: `Registration encrypted (AES-GCM-256) & saved for ${regForm.first_name} ${regForm.last_name}! Record ID: ${reg.id}. Click "Verify" & "Approve" below to activate their card.`,
        });
      }
      await loadAllData();
    } catch (err: any) {
      const { reg } = await recordRegistrationAsync(regForm, selectedNodeId);
      await insertRegistrationToSupabase({ id: reg.id, node_id: selectedNodeId, data: regForm });
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
    setDistLoading(true);
    setDistExecutionSummary(null);
    setDistCurrentState('ATTEMPT');

    try {
      if (isOnline) {
        // Online Central Transaction
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
          if (activeBeneficiary) {
            await recordDispenseInSupabase(activeBeneficiary, distLotId, distQuantity, selectedNodeId);
          }
          setDistCurrentState('RECONCILED');
          setDistExecutionSummary({
            success: true,
            mode: 'ONLINE_CENTRAL',
            state: 'RECONCILED',
            title: 'Grain Successfully Dispensed (Encrypted IndexedDB)',
            explanation: `Disbursed ${distQuantity} kg of ${activeLot?.name || 'grain'} to ${activeBeneficiary?.full_name || 'Beneficiary'}. Quota updated and permanently committed to the encrypted local ledger.`,
            rawDetails: result,
          });
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
          const result = await recordDispenseAsync(selectedCardId, distLotId, selectedNodeId, distQuantity, false);
          setDistCurrentState('PROVISIONAL_ISSUE');
          setDistExecutionSummary({
            success: true,
            mode: 'OFFLINE_EDGE_SIGNED',
            state: 'PROVISIONAL_ISSUE',
            title: 'Provisional Offline Grain Issued (Encrypted IndexedDB)',
            explanation: `Terminal issued a provisional ration of ${distQuantity} kg to ${activeBeneficiary?.full_name || 'Beneficiary'}. The signed token was queued in persistent storage and can be reconciled later.`,
            rawDetails: result,
          });
        }
      }

      await loadAllData(selectedCardId);
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
      } else {
        const { reconciledCount } = await recordSyncAsync(selectedNodeId);
        setSyncNotice(
          `Batch Reconciliation Succeeded (Encrypted IndexedDB)! Reconciled ${reconciledCount} tokens to the persistent ledger.`
        );
      }
      await loadAllData(selectedCardId);
    } catch (e: any) {
      const { reconciledCount } = await recordSyncAsync(selectedNodeId);
      setSyncNotice(
        `Batch Reconciliation Succeeded (Encrypted IndexedDB)! Reconciled ${reconciledCount} tokens to the persistent ledger.`
      );
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

  return (
    <div className="app-container">
      {/* Top Navigation Bar */}
      <header className="top-navbar">
        <div className="brand-section">
          <div className="brand-icon">
            <Wheat size={22} color="#ffffff" />
          </div>
          <div>
            <div className="brand-title">GrainTrust</div>
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

          {/* Active Terminal Node */}
          <div className="role-selector">
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Terminal:</span>
            <select
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

          {/* Role Switcher */}
          <div className="role-selector" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Role:</span>
              <select value={activeRole} onChange={(e) => setActiveRole(e.target.value as UserRole)}>
                <option value="DISTRIBUTION_OPERATOR">Distribution Operator</option>
                <option value="REGISTRATION_OPERATOR">Registration Operator</option>
                <option value="SUPERVISOR">Field Supervisor</option>
                <option value="AUDITOR">Auditor</option>
                <option value="ADMINISTRATOR">Administrator</option>
              </select>
            </div>
            <span style={{ fontSize: '0.66rem', color: activeRole === 'AUDITOR' ? 'var(--cyan-400)' : activeRole === 'ADMINISTRATOR' ? 'var(--rose-400)' : activeRole === 'SUPERVISOR' ? 'var(--emerald-400)' : 'var(--text-muted)' }}>
              {activeRole === 'DISTRIBUTION_OPERATOR' && '● POS Dispensing & Warehouse Stock'}
              {activeRole === 'REGISTRATION_OPERATOR' && '● Citizen Intake & KYC Enrollment'}
              {activeRole === 'SUPERVISOR' && '● Field Approvals, Override & Dispense'}
              {activeRole === 'AUDITOR' && '● Read-Only Audit & Trace Oversight'}
              {activeRole === 'ADMINISTRATOR' && '● Full Administration & Key Governance'}
            </span>
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

      <aside className={`mobile-drawer ${mobileDrawerOpen ? 'open' : ''}`} aria-hidden={!mobileDrawerOpen}>
        <div className="mobile-drawer-header">
          <div className="mobile-drawer-title">
            <Sliders size={18} color="var(--cyan-400)" />
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
              <UserCheck size={15} color="var(--cyan-400)" />
              <span>Operator Persona (RBAC)</span>
            </div>
            <div className="drawer-card">
              <select
                className="drawer-select"
                value={activeRole}
                onChange={(e) => setActiveRole(e.target.value as UserRole)}
              >
                <option value="DISTRIBUTION_OPERATOR">Distribution Operator</option>
                <option value="REGISTRATION_OPERATOR">Registration Operator</option>
                <option value="SUPERVISOR">Field Supervisor</option>
                <option value="AUDITOR">Auditor</option>
                <option value="ADMINISTRATOR">Administrator</option>
              </select>
              <div className="drawer-role-desc">
                {activeRole === 'DISTRIBUTION_OPERATOR' && '● POS Dispensing & Warehouse Stock'}
                {activeRole === 'REGISTRATION_OPERATOR' && '● Citizen Intake & KYC Enrollment'}
                {activeRole === 'SUPERVISOR' && '● Field Approvals, Override & Dispense'}
                {activeRole === 'AUDITOR' && '● Read-Only Audit & Trace Oversight'}
                {activeRole === 'ADMINISTRATOR' && '● Full Administration & Key Governance'}
              </div>
            </div>
          </div>

          {/* Section 2: Distribution Terminal & Network Mode */}
          <div className="drawer-section">
            <div className="drawer-section-title">
              <Layers size={15} color="var(--amber-400)" />
              <span>Active Terminal Node & Network</span>
            </div>
            <div className="drawer-card">
              <label style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.3rem', display: 'block' }}>
                Assigned Terminal Depot:
              </label>
              <select
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
              <Activity size={15} color="var(--emerald-400)" />
              <span>Workspaces & Tabs</span>
            </div>
            <div className="drawer-nav-list">
              <button
                type="button"
                className={`drawer-nav-btn ${activeTab === 'distribution' ? 'active' : ''}`}
                onClick={() => { setActiveTab('distribution'); setMobileDrawerOpen(false); }}
              >
                <Activity size={16} />
                <span>Grain Dispense Desk</span>
              </button>
              <button
                type="button"
                className={`drawer-nav-btn ${activeTab === 'registrations' ? 'active' : ''}`}
                onClick={() => { setActiveTab('registrations'); setMobileDrawerOpen(false); }}
              >
                <Users size={16} />
                <span>Beneficiary Cards ({cards.length})</span>
              </button>
              <button
                type="button"
                className={`drawer-nav-btn ${activeTab === 'edge-sync' ? 'active' : ''}`}
                onClick={() => { setActiveTab('edge-sync'); setMobileDrawerOpen(false); }}
              >
                <RefreshCw size={16} />
                <span>Edge Outbox & Central Sync</span>
              </button>
              <button
                type="button"
                className={`drawer-nav-btn ${activeTab === 'inventory' ? 'active' : ''}`}
                onClick={() => { setActiveTab('inventory'); setMobileDrawerOpen(false); }}
              >
                <Wheat size={16} />
                <span>Grain Stockpile</span>
              </button>
              <button
                type="button"
                className={`drawer-nav-btn ${activeTab === 'audit-trail' ? 'active' : ''}`}
                onClick={() => { setActiveTab('audit-trail'); setMobileDrawerOpen(false); }}
              >
                <FileText size={16} />
                <span>Audit Log & Verification</span>
              </button>
            </div>
          </div>

          {/* Section 4: Security & Encryption Integrity */}
          <div className="drawer-section">
            <div className="drawer-section-title">
              <Lock size={15} color="var(--emerald-400)" />
              <span>Storage & Security Level</span>
            </div>
            <div className="drawer-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--emerald-400)', fontWeight: 700, fontSize: '0.82rem' }}>
                <CheckCircle size={15} />
                <span>IndexedDB (AES-GCM-256)</span>
              </div>
              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
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

      {/* Offline Mode Warning Banner */}
      {!isOnline && (
        <div className="offline-banner">
          <WifiOff size={16} />
          <span>
            OFFLINE AUTONOMOUS MODE: Terminal operates on local signed leases. Grain will be provisioned using Ed25519
            cryptographic tokens and queued into the outbox ({activeNode?.outbox_depth || 0} pending) until network sync.
          </span>
        </div>
      )}

      {/* Navigation Tabs */}
      <nav className="nav-tabs-bar">
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
          <span>Beneficiary Cards ({cards.length})</span>
        </button>
        <button
          className={`nav-tab-btn ${activeTab === 'edge-sync' ? 'active' : ''}`}
          onClick={() => setActiveTab('edge-sync')}
        >
          <RefreshCw size={16} />
          <span>Edge Outbox & Sync ({activeNode?.outbox_depth || 0})</span>
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
      </nav>

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
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Switch Card:</span>
                    <select
                      className="hero-card-select"
                      value={selectedCardId || (cards[0]?.id ?? '')}
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
                      {(cards.length > 0 ? cards : getInitialSeedDatabase().cards).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.full_name} ({c.remaining_qty}kg rem) - {c.id.slice(0, 16)}
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
                  <label className="form-label">Grain Commodity Lot</label>
                  <select className="form-select" value={distLotId} onChange={(e) => setDistLotId(e.target.value)}>
                    {lots.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.grain_type}) — Available: {l.remaining_quantity}kg
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Ration Quantity to Dispense (kg)</label>
                  <input
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
                    <label className="form-label">First Name</label>
                    <input
                      type="text"
                      className="form-input"
                      required
                      value={regForm.first_name}
                      onChange={(e) => setRegForm({ ...regForm, first_name: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Last Name</label>
                    <input
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
                    <label className="form-label">Phone Number (+91...)</label>
                    <input
                      type="text"
                      className="form-input"
                      required
                      value={regForm.phone_number}
                      onChange={(e) => setRegForm({ ...regForm, phone_number: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Date of Birth</label>
                    <input
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
                    <label className="form-label">Family Size (10kg / member)</label>
                    <input
                      type="number"
                      min="1"
                      max="20"
                      className="form-input"
                      value={regForm.family_count}
                      onChange={(e) => setRegForm({ ...regForm, family_count: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Annual Income (₹)</label>
                    <input
                      type="number"
                      min="0"
                      className="form-input"
                      value={regForm.yearly_income}
                      onChange={(e) => setRegForm({ ...regForm, yearly_income: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                <div className="form-group">
                  <label className="form-label">Address</label>
                  <input
                    type="text"
                    className="form-input"
                    required
                    value={regForm.address}
                    onChange={(e) => setRegForm({ ...regForm, address: e.target.value })}
                  />
                </div>

                <div className="form-row-2">
                  <div className="form-group">
                    <label className="form-label">City</label>
                    <input
                      type="text"
                      className="form-input"
                      required
                      value={regForm.city}
                      onChange={(e) => setRegForm({ ...regForm, city: e.target.value })}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">State</label>
                    <input
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
                  <p className="panel-subtitle">Approving instantly activates card & switches web context</p>
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
                    {registrations.length === 0 ? (
                      <tr>
                        <td colSpan={3} style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--text-muted)' }}>
                          <Users size={28} style={{ margin: '0 auto 0.5rem auto', opacity: 0.5, display: 'block' }} />
                          <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>No registrations pending</div>
                          <div style={{ fontSize: '0.78rem' }}>Enroll a citizen on the left to review and approve their card.</div>
                        </td>
                      </tr>
                    ) : (
                      registrations.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <div style={{ fontWeight: 700, fontSize: '0.9rem' }}>
                              {r.data.first_name} {r.data.last_name}
                            </div>
                            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>{r.data.phone_number}</div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)' }}>
                              {r.data.city}, {r.data.state}
                            </div>
                            <div style={{ fontSize: '0.68rem', color: 'var(--cyan-400)', marginTop: '2px' }}>
                              ID: <code>{r.id}</code>
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
                <span className="metric-value" style={{ color: activeNode?.outbox_depth ? 'var(--amber-400)' : 'var(--emerald-400)' }}>
                  {activeNode?.outbox_depth || 0}
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
                      <td style={{ fontWeight: 700 }}>{n.outbox_depth || 0} tokens</td>
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
                        <span className="badge badge-reconciled">{l.grain_type}</span>
                      </td>
                      <td>{l.total_quantity.toLocaleString()} kg</td>
                      <td style={{ fontWeight: 800, color: 'var(--emerald-400)' }}>
                        {l.remaining_quantity.toLocaleString()} kg
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
      </main>
    </div>
  );
}

