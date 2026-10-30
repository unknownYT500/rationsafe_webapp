# 🌾 RationSafe / GrainTrust: Sovereign Web Platform & Central Node API

[![Production Live](https://img.shields.io/badge/Production-Live%20on%20Vercel-success?logo=vercel&logoColor=white)](https://rationsafewebapp.vercel.app)
[![Core Tests](https://img.shields.io/badge/System%20Tests-20%2F20%20Passing-brightgreen.svg)](src/tests/system.test.ts)
[![Pentest](https://img.shields.io/badge/ArgosX%20Pentest-Verified%20Clean-0284c7.svg)](src/tests/pentest-argosx.test.ts)
[![Security](https://img.shields.io/badge/DPDPA%202023-Enforced%20(AES--GCM--256)-blueviolet.svg)](src/client/secure-storage-db.ts)
[![React](https://img.shields.io/badge/React-19.3-61DAFB?logo=react&logoColor=black)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-8.3-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Database](https://img.shields.io/badge/Database-IndexedDB%20%2B%20Supabase-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)

> **RationSafe / GrainTrust** is an enterprise-grade, fraud-resistant GovTech web administration platform and sovereign edge kiosk engineered to guarantee food security under the **National Food Security Act (NFSA 2013)**. Designed with a **Zero-Single-Point-of-Failure (Zero-SPOF)** architecture, the web kiosk runs 100% autonomously in the browser using client-side encrypted storage (Dexie.js / IndexedDB) and asymmetric **Ed25519 digital signatures**, enabling continuous grain disbursals and citizen enrollment even during total internet, cellular, and cloud outages.

🌐 **Live Production URL:** [https://rationsafewebapp.vercel.app](https://rationsafewebapp.vercel.app)  
📄 **Complete Judge Defense Manual:** [web_explained/Judge_Explanation_Web_Platform_Manual.pdf](../web_explained/Judge_Explanation_Web_Platform_Manual.pdf)

---

## 🏛️ Statutory Acts & Public Policy Compliance

GrainTrust is architected in strict compliance with the statutory laws, constitutional jurisprudence, and administrative regulations of the Republic of India:

| Statutory Act / Directive | Legal Mandate & Public Policy Obligation | GrainTrust Technical Implementation |
| :--- | :--- | :--- |
| **National Food Security Act (NFSA), 2013** | Statutory entitlement of 5 kg/person/month (Priority Households) or 35 kg/family/month (Antyodaya). **Mandatory Non-Denial of Service Guarantee:** No citizen can be denied grain due to network or biometric outage. | Strict quota calculations (`family_count * 10 kg`), autonomous offline dispensing via self-contained Ed25519 vouchers, and zero-downtime client-side failover. |
| **Essential Commodities Act (ECA), 1955** | Section 3 anti-hoarding, anti-diversion, and equitable distribution of essential foodstuffs. | Granary lot batch tracking (`lot-wheat-2026-01`), depot quota grants (`max_quantity`), depletion meters, and automated grain shrinkage alerts. |
| **Digital Personal Data Protection Act (DPDPA), 2023** | Citizen consent opt-in, purpose limitation, and data minimization of digital personal data. | Mandatory `consent_opt_in: true` checkbox, zero-knowledge demographic masking (`••••••••••`), and client-side **AES-GCM-256 field-level encryption** for all PII. |
| **Aadhaar Act, 2016 & Supreme Court Precedent (*Puttaswamy*, 2018)** | Biometric failure must not cause benefit exclusion; mandatory exception handling and supervisor overrides. | 5-stage state machine transitions biometric failure to `FALLBACK_AUTH`, issuing an Ed25519 provisional voucher with supervisor sign-off. |
| **IT Act, 2000 (Section 10A, 43A, 65, 66C)** | Legal validity of electronic contracts via digital signatures; liability for sensitive personal data protection. | Asymmetric **Ed25519 digital signatures** over RFC 8785 canonical JSON, non-repudiation, and tamper-evident audit logs. |
| **CERT-In Directives (2022)** | Microsecond NTP timestamping, distributed request tracing, and vulnerability remediation. | Append-only audit logs, W3C `traceparent` headers, structured JSON logging, and verified ArgosX / Strix DAST security compliance. |

---

## 🔐 Cryptographic Architecture & Security Matrix

```
+---------------------------------------------------------------------------------------------------+
|                                 GRAINTRUST CRYPTOGRAPHIC DEFENSE MATRIX                           |
+---------------------------------------------------------------------------------------------------+
|  1. Asymmetric Digital Signatures : Ed25519 (RFC 8032, Edwards-curve 25519, 128-bit security)     |
|  2. Client-Side PII Encryption    : AES-GCM-256 (Galois/Counter Mode, 256-bit key, 96-bit IV)     |
|  3. Payload Canonicalization      : RFC 8785 (Deterministic JSON key sorting & float formatting) |
|  4. Integrity & Hashing           : SHA-256 (FIPS 180-4, 32-byte cryptographic digests)           |
|  5. Globally Unique Identifiers   : UUIDv7 (RFC 9562, Monotonic time-ordered 48-bit timestamp)   |
|  6. Operator Session Auth         : JWT (RFC 7519, HMAC-SHA256 / HS256, 8-hour expiry)            |
|  7. Biometric Step-Up Challenge   : WebAuthn / FIDO2 (W3C standard public-key assertion)         |
|  8. Data in Transit               : TLS 1.3 / HTTPS (ECDHE key exchange, HSTS enforced)          |
|  9. Database Kernel Isolation     : PostgreSQL Row-Level Security (Mandatory kernel policies)     |
+---------------------------------------------------------------------------------------------------+
```

### 1. Asymmetric Ed25519 Offline Vouchers
Offline transactions produce a self-contained, digitally signed voucher signed by the edge distribution node's private key. The payload is canonicalized using **RFC 8785** to eliminate key-ordering ambiguity, ensuring deterministic signature verification across Node.js, browsers, and mobile devices without network connectivity.

### 2. Cryptographic Quota Lease Model (Double-Spending Prevention)
A beneficiary's monthly allocation is pre-partitioned into signed node-specific leases (e.g. 20 kg for Node Alpha, 20 kg for Node Beta). An offline terminal can only disburse against its own bound lease, mathematically preventing a citizen or rogue operator from double-spending across disconnected depots.

### 3. Strict 5-Stage Transaction State Machine
Governed by a deterministic state transition matrix in `src/core/state-machine.ts`:
```
[ATTEMPT] ──> [FAIL_REASON] ──> [FALLBACK_AUTH] ──> [PROVISIONAL_ISSUE] ──> [RECONCILED]
```
Transitions directly from `RECONCILED` back to `ATTEMPT` or skipping states throw strict invariant violations. Reconciled transactions are immutable and cannot be re-dispensed or altered.

---

## 🖥️ Operational Desks & Web Functionalities

The responsive cyber-glassmorphic web dashboard provides 6 mission-critical operational desks:

```
+--------------------------------------------------------------------------------------------------+
|                                    GRAINTRUST KIOSK DASHBOARD                                    |
|  [Desk 1: Dispense]  [Desk 2: KYC Intake]  [Desk 3: Edge Sync]  [Desk 4: Stock]  [Desk 5: Audit] |
|                                                                                                  |
|  Header Controls:                                                                                |
|  - Simulated Network Toggle (Online / Offline Autonomous)                                        |
|  - Role Switcher & Password Verification (Operator / Supervisor / Auditor / Admin)               |
|  - Vernacular Audio Synthesizer (Bilingual Hindi / English Voice Feedback)                       |
|  - Responsive Mobile Touch Drawer & Collapsible Sidebar                                          |
+--------------------------------------------------------------------------------------------------+
```

### 1. Grain Dispense Desk (`activeTab: 'distribution'`)
* **Card Directory & Camera QR Scanner:** Instant beneficiary search by card ID or live webcam scanning of dynamic QR codes from citizen mobile wallets.
* **Dual Execution Mode:**
  * *Online:* Dispatches atomic transaction to Supabase RPC `fn_online_dispense()`, locking the row and updating card quota and grain stockpile within 120ms.
  * *Offline Autonomous:* Checks local cryptographic lease, decrements local stock, signs an Ed25519 provisional voucher, and enqueues it in the durable outbox.
* **Live State Machine Stepper:** Real-time visual tracking of each lifecycle phase (`ATTEMPT` $\to$ `RECONCILED`).
* **Multi-Node Quota Guard:** Prevents cross-depot over-allocation by displaying per-node lease balances.

### 2. Citizen Enrollment & KYC Intake Desk (`activeTab: 'registrations'`)
* **Complete Intake Form:** Captures citizen names, phone number, date of birth, family count, annual income, and address.
* **DPDPA Statutory Consent Opt-In:** Enforces explicit citizen consent checkbox (`consent_opt_in: true`) prior to submission.
* **1-Click Demo Profile Generator:** Auto-fills authentic demographic test profiles across Indian states (Uttar Pradesh, Madhya Pradesh, West Bengal, Punjab).
* **Two-Phase Supervisor Workflow:**
  * *Phase 1 (Intake):* Registration operator enters data; stored as `SUBMITTED`.
  * *Phase 2 (Approval):* Field Supervisor or Administrator reviews socioeconomic data, executes **"Verify KYC"**, followed by **"Approve & Activate Card"**, atomically generating the citizen's smart ration card.

### 3. Edge Synchronization & Outbox Management (`activeTab: 'edge-sync'`)
* **Outbox Queue Depth Monitor:** Real-time badge tracking offline vouchers pending reconciliation (`pendingTokens`).
* **1-Click Batch Reconciliation:** Flushes and syncs offline outbox records with the central database via atomic PL/pgSQL procedure `fn_reconcile_sync_batch()`.
* **Idempotency Deduplication:** Every sync payload is tagged with a SHA-256 idempotency key (`idem_<timestamp>_<random>`), ensuring network retries never double-deduct inventory.
* **Sync History Stream:** Visual tabular timeline showing reconciled batches, transaction hashes, and latency metrics.

### 4. Granary Stockpile & Inventory Management (`activeTab: 'inventory'`)
* **Central Grain Silo Gauges:** Real-time meters tracking national reserves (e.g. National Reserve Wheat Batch 2026-A, Basmati Emergency Stockpile).
* **Depot Lot Grants:** Displays maximum grain quantity allocated to each regional edge terminal (e.g. 500 kg weekly cap for Node Alpha).
* **Shrinkage & Anti-Theft Warnings:** Flags irregular depletion rates to prevent black-market grain diversion.

### 5. Immutable Append-Only Audit Trail (`activeTab: 'audit-trail'`)
* **Chronological Security Event Stream:** Captures all disbursals, KYC submissions, role logins, and network state changes.
* **Color-Coded Classification Badges:** Emerald Green (Dispenses), Cyan (KYC & Card Approvals), Amber (Security Logins), Violet (Denials Prevented).
* **Cryptographic Event Inspector:** 1-click modal viewing microsecond timestamp, actor ID, resource type, and transaction hash.
* **Kernel Protection:** PostgreSQL RLS explicitly denies `UPDATE` and `DELETE` commands on `audit_events`.

### 6. Fleet Telemetry & Multi-Device Monitoring (`activeTab: 'fleet-telemetry'`)
* **4-Laptop Demonstration Environment:** Built specifically for multi-laptop government demonstrations, showing live telemetry across 4 simulated field machines:
  * **MACH-01:** Laptop 1 (Depot Alpha - Kanpur Urban)
  * **MACH-02:** Laptop 2 (Depot Beta - Kalyanpur Rural)
  * **MACH-03:** Laptop 3 (Mobile Distribution Van - Panki Outpost)
  * **MACH-04:** Laptop 4 (Regional Granary Command - Civil Lines)
* **Live Machine Presence:** Displays online/offline status, session IDs, outbox queue depths, disbursed totals, and active card allocations.
* **Device Profile Switcher:** Operators can click any machine card to simulate running from that specific field terminal.

---

## 🛠️ Technology Stack & Architecture

| Layer | Technologies Used | Justification |
| :--- | :--- | :--- |
| **Frontend Framework** | React 19, TypeScript 5, Vite 8 | Concurrent transitions, sub-second cold starts, static type safety. |
| **Client Storage Engine** | Dexie.js (IndexedDB) + `localStorage` | Zero-latency local transactional database enabling 100% offline autonomy. |
| **Cloud Synchronization** | Supabase (PostgreSQL 15), Supabase Realtime | Canonical relational storage, atomic RPCs, WebSocket Change Data Capture. |
| **Backend REST API** | Node.js 20+, Express 5, TypeScript | REST API gateway, rate limiting, and serverless edge functions on Vercel. |
| **Cryptography** | `@noble/ed25519`, Web Crypto API (AES-GCM-256) | Audited pure-JS elliptic curve signing, constant-time side-channel resistance. |
| **UI Design System** | Cyber-Glassmorphism, Vanilla CSS3, Lucide Icons | Zero-dependency responsive design, HSL color tokens, dark/light modes. |
| **Validation & Security** | Zod, JSON Web Tokens (HS256), WebAuthn FIDO2 | Runtime boundary sanitization and cryptographic session authentication. |
| **Testing & Verification** | TypeScript Test Runner (`tsx`), Python 3 | 20-scenario system test suite + 5-scenario ArgosX DAST pentest suite. |

---

## 🚀 Setup & Local Installation Guide

### Prerequisites
- Node.js (v18.0.0 or higher)
- npm or pnpm

### 1. Clone & Install
```bash
git clone https://github.com/unknownYT500/rationsafe_webapp.git
cd rationsafe_webapp
npm install
```

### 2. Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Populate `.env` with your Supabase credentials:
```env
VITE_SUPABASE_URL=https://byxvxvsvhiyeryavgafx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
JWT_SECRET=rationsafe_hardened_fallback_secret_key_minimum_32_characters_2026
PORT=3001
HOST=0.0.0.0
NODE_ENV=development
```

### 3. Run Development Servers
```bash
# Terminal 1: Launch Central Node REST API Server
npm run start:api
# Output: Grain Distribution API running on http://localhost:3001

# Terminal 2: Launch Vite Web Dashboard
npm run dev
# Output: Local: http://localhost:5173/
```

### 4. Run Test Suites
```bash
# 1. Core End-to-End System Integration Tests (20/20 Scenarios)
npm test

# 2. Independent ArgosX DAST Security Pentest Verification (5/5 Checks)
npm run test:pentest
```

### 5. Production Build
```bash
npm run build
npm run preview
```

---

## 📚 Technical Documentation & Guides

Comprehensive technical guides and architecture manuals are available in the repository:
* [Judge Explanation Web Platform Manual (PDF)](../web_explained/Judge_Explanation_Web_Platform_Manual.pdf) - 17-page publication-grade evaluation defense guide
* [Web Architecture & Working Manual](../web_explained/Web_Architecture_And_Working.pdf) - Deep dive into component architecture
* [API & Data Contracts Specification](../web_explained/api_and_data_contracts.pdf) - Complete schema and REST endpoint reference
* [Core Concepts & Libraries Guide](../web_explained/concepts_and_libraries.pdf) - Framework choices and cryptographic justifications
* [Logic & Design Patterns Guide](../web_explained/logic_and_architecture.pdf) - State machine and reconciliation logic
* [Unified Master Engineering Volume](../GrainTrust_RationSafe_Giant_Tech_Book.pdf) - Complete 100+ page master tech book

---

## ⚖️ License & Intellectual Property

Licensed under the **ISC License**. Developed as a sovereign GovTech architecture for the Ministry of Consumer Affairs, Food & Public Distribution and the National Food Security Mission.
