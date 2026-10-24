// src/database/storage.ts
import fs from 'node:fs';
import path from 'node:path';
import type {
  Person,
  HouseholdProfile,
  RegistrationRecord,
  Card,
  GrainLot,
  LotCapGrant,
  CardQuotaLedger,
  DistributionTransaction,
  TransactionStateHistory,
  SignedProvisionalToken,
  FailureEvent,
  AuditEvent,
  DistributionNode,
} from '../core/types.js';

export interface DatabaseState {
  persons: Person[];
  household_profiles: HouseholdProfile[];
  registrations: RegistrationRecord[];
  cards: Card[];
  lots: GrainLot[];
  lot_cap_grants: LotCapGrant[];
  card_quota_ledger: CardQuotaLedger[];
  distribution_transactions: DistributionTransaction[];
  transaction_state_history: TransactionStateHistory[];
  provisional_tokens: SignedProvisionalToken[];
  failure_events: FailureEvent[];
  audit_events: AuditEvent[];
  distribution_nodes: DistributionNode[];
  idempotency_cache: Record<string, { status: number; body: unknown; timestamp: string }>;
  used_nonces: Record<string, { token_id: string; timestamp: string }>;
}

export class CentralDatabase {
  private state: DatabaseState;
  private filePath?: string;
  private lock = false;

  constructor(filePath?: string) {
    this.filePath = filePath;
    this.state = this.getInitialState();
    if (this.filePath && fs.existsSync(this.filePath)) {
      this.load();
    }
  }

  private getInitialState(): DatabaseState {
    return {
      persons: [],
      household_profiles: [],
      registrations: [],
      cards: [],
      lots: [],
      lot_cap_grants: [],
      card_quota_ledger: [],
      distribution_transactions: [],
      transaction_state_history: [],
      provisional_tokens: [],
      failure_events: [],
      audit_events: [],
      distribution_nodes: [],
      idempotency_cache: {},
      used_nonces: {},
    };
  }

  public load(): void {
    if (!this.filePath) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.state = JSON.parse(raw);
    } catch {
      // fallback to initial state
    }
  }

  public persist(): void {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to persist database:', e);
    }
  }

  public createSnapshot(): DatabaseState {
    return JSON.parse(JSON.stringify(this.state));
  }

  public restoreSnapshot(snapshot: DatabaseState): void {
    this.state = JSON.parse(JSON.stringify(snapshot));
    this.persist();
  }

  public clearAllData(): void {
    this.state = this.getInitialState();
    this.persist();
  }

  // --- Persons ---
  public getPersonById(id: string): Person | undefined {
    return this.state.persons.find((p) => p.id === id);
  }

  public getPersonByPhone(phone: string): Person | undefined {
    return this.state.persons.find((p) => p.phone_number === phone);
  }

  public insertPerson(person: Person, household: HouseholdProfile): void {
    if (this.state.persons.some((p) => p.phone_number === person.phone_number)) {
      throw new Error(`Unique constraint violation: phone_number ${person.phone_number} already registered.`);
    }
    this.state.persons.push(person);
    this.state.household_profiles.push(household);
    this.persist();
  }

  public listPersons(): Person[] {
    return [...this.state.persons];
  }

  public getHouseholdByPersonId(personId: string): HouseholdProfile | undefined {
    return this.state.household_profiles.find((h) => h.person_id === personId);
  }

  // --- Registrations ---
  public insertRegistration(reg: RegistrationRecord): void {
    this.state.registrations.push(reg);
    this.persist();
  }

  public getRegistration(id: string): RegistrationRecord | undefined {
    return this.state.registrations.find((r) => r.id === id);
  }

  public updateRegistration(reg: RegistrationRecord): void {
    const idx = this.state.registrations.findIndex((r) => r.id === reg.id);
    if (idx !== -1) {
      this.state.registrations[idx] = reg;
      this.persist();
    }
  }

  public listRegistrations(): RegistrationRecord[] {
    return [...this.state.registrations];
  }

  // --- Cards ---
  public insertCard(card: Card): void {
    this.state.cards.push(card);
    this.persist();
  }

  public getCard(id: string): Card | undefined {
    return this.state.cards.find((c) => c.id === id);
  }

  public getCardByPersonId(personId: string): Card | undefined {
    return this.state.cards.find((c) => c.person_id === personId);
  }

  public listCards(): Card[] {
    return [...this.state.cards];
  }

  // --- Lots & Grants ---
  public insertLot(lot: GrainLot): void {
    this.state.lots.push(lot);
    this.persist();
  }

  public getLot(id: string): GrainLot | undefined {
    return this.state.lots.find((l) => l.id === id);
  }

  public listLots(): GrainLot[] {
    return [...this.state.lots];
  }

  public insertLotGrant(grant: LotCapGrant): void {
    this.state.lot_cap_grants.push(grant);
    this.persist();
  }

  public getLotGrant(id: string): LotCapGrant | undefined {
    return this.state.lot_cap_grants.find((g) => g.id === id);
  }

  public getActiveGrantForNodeLot(nodeId: string, lotId: string): LotCapGrant | undefined {
    const now = Math.floor(Date.now() / 1000);
    return this.state.lot_cap_grants.find(
      (g) => g.node_id === nodeId && g.lot_id === lotId && g.expires_at > now && g.remaining_quantity > 0
    );
  }

  public listGrants(): LotCapGrant[] {
    return [...this.state.lot_cap_grants];
  }

  // --- Quota Ledger ---
  public getQuotaLedger(cardId: string, nodeId?: string): CardQuotaLedger | undefined {
    if (nodeId) {
      return this.state.card_quota_ledger.find((q) => q.card_id === cardId && q.node_id === nodeId);
    }
    return this.state.card_quota_ledger.find((q) => q.card_id === cardId);
  }

  public listQuotaLedger(): CardQuotaLedger[] {
    return [...this.state.card_quota_ledger];
  }

  public setQuotaLedger(ledger: CardQuotaLedger): void {
    const idx = this.state.card_quota_ledger.findIndex(
      (q) => q.card_id === ledger.card_id && q.node_id === ledger.node_id
    );
    if (idx !== -1) {
      this.state.card_quota_ledger[idx] = ledger;
    } else {
      this.state.card_quota_ledger.push(ledger);
    }
    this.persist();
  }

  /**
   * Atomic quota check & deduct (concurrency-safe simulating SELECT ... FOR UPDATE).
   */
  public atomicDeductQuota(
    cardId: string,
    nodeId: string,
    lotId: string,
    quantity: number
  ): { success: boolean; reason?: 'CARD_QUOTA_EXHAUSTED' | 'LOT_CAP_EXHAUSTED' | 'NOT_FOUND' } {
    // Acquire synchronous lock
    while (this.lock) {
      // In JS single-threaded event loop, synchronous block will not interleave,
      // but this guarantees safety for async tasks
    }
    this.lock = true;
    try {
      const lot = this.state.lots.find((l) => l.id === lotId);
      if (!lot || lot.remaining_quantity < quantity) {
        return { success: false, reason: 'LOT_CAP_EXHAUSTED' };
      }

      const ledger = this.state.card_quota_ledger.find(
        (q) => q.card_id === cardId && (q.node_id === nodeId || q.node_id === 'GLOBAL')
      );
      if (!ledger) {
        return { success: false, reason: 'NOT_FOUND' };
      }

      const available = ledger.allocated_qty - ledger.consumed_qty;
      if (available < quantity) {
        return { success: false, reason: 'CARD_QUOTA_EXHAUSTED' };
      }

      // Perform deduction atomically
      lot.remaining_quantity -= quantity;
      ledger.consumed_qty += quantity;
      this.persist();
      return { success: true };
    } finally {
      this.lock = false;
    }
  }

  public refundQuota(cardId: string, nodeId: string, lotId: string, quantity: number): void {
    const lot = this.state.lots.find((l) => l.id === lotId);
    if (lot) {
      lot.remaining_quantity = Math.min(lot.total_quantity, lot.remaining_quantity + quantity);
    }

    const ledger = this.state.card_quota_ledger.find(
      (q) => q.card_id === cardId && (q.node_id === nodeId || q.node_id === 'GLOBAL')
    );
    if (ledger) {
      ledger.consumed_qty = Math.max(0, ledger.consumed_qty - quantity);
    }
    this.persist();
  }

  // --- Transactions ---
  public insertTransaction(txn: DistributionTransaction): void {
    this.state.distribution_transactions.push(txn);
    this.persist();
  }

  public getTransaction(id: string): DistributionTransaction | undefined {
    return this.state.distribution_transactions.find((t) => t.id === id);
  }

  public updateTransaction(txn: DistributionTransaction): void {
    const idx = this.state.distribution_transactions.findIndex((t) => t.id === txn.id);
    if (idx !== -1) {
      this.state.distribution_transactions[idx] = txn;
      this.persist();
    }
  }

  public listTransactions(): DistributionTransaction[] {
    return [...this.state.distribution_transactions];
  }

  public insertStateHistory(history: TransactionStateHistory): void {
    this.state.transaction_state_history.push(history);
    this.persist();
  }

  public getStateHistory(txnId: string): TransactionStateHistory[] {
    return this.state.transaction_state_history.filter((h) => h.txn_id === txnId);
  }

  // --- Provisional Tokens ---
  public insertProvisionalToken(token: SignedProvisionalToken): void {
    this.state.provisional_tokens.push(token);
    this.persist();
  }

  public getProvisionalToken(id: string): SignedProvisionalToken | undefined {
    return this.state.provisional_tokens.find((t) => t.id === id);
  }

  public listProvisionalTokens(): SignedProvisionalToken[] {
    return [...this.state.provisional_tokens];
  }

  // --- Failure Events ---
  public insertFailureEvent(event: FailureEvent): void {
    this.state.failure_events.push(event);
    this.persist();
  }

  public listFailureEvents(): FailureEvent[] {
    return [...this.state.failure_events];
  }

  // --- Audit Events (Immutable) ---
  public insertAuditEvent(event: AuditEvent): void {
    this.state.audit_events.push(event);
    this.persist();
  }

  public updateAuditEvent(): never {
    throw new Error('Audit log is immutable. Modifications and deletions are strictly prohibited by security policy.');
  }

  public listAuditEvents(): AuditEvent[] {
    return [...this.state.audit_events];
  }

  // --- Distribution Nodes ---
  public insertNode(node: DistributionNode): void {
    this.state.distribution_nodes.push(node);
    this.persist();
  }

  public getNode(id: string): DistributionNode | undefined {
    return this.state.distribution_nodes.find((n) => n.id === id);
  }

  public updateNode(node: DistributionNode): void {
    const idx = this.state.distribution_nodes.findIndex((n) => n.id === node.id);
    if (idx !== -1) {
      this.state.distribution_nodes[idx] = node;
      this.persist();
    }
  }

  public listNodes(): DistributionNode[] {
    return [...this.state.distribution_nodes];
  }

  // --- Idempotency & Nonce ---
  public getIdempotency(key: string): { status: number; body: unknown } | undefined {
    return this.state.idempotency_cache[key];
  }

  public setIdempotency(key: string, status: number, body: unknown): void {
    this.state.idempotency_cache[key] = {
      status,
      body,
      timestamp: new Date().toISOString(),
    };
    this.persist();
  }

  public isNonceUsed(nonce: string): boolean {
    return Boolean(this.state.used_nonces[nonce]);
  }

  public markNonceUsed(nonce: string, tokenId: string): void {
    this.state.used_nonces[nonce] = {
      token_id: tokenId,
      timestamp: new Date().toISOString(),
    };
    this.persist();
  }
}
