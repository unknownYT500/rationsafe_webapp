# GrainTrust: Complete Supabase Setup & Synchronization Guide

This guide provides step-by-step instructions to configure, migrate, and connect **Supabase** with both the **GrainTrust Web Dashboard** (`web/`) and the **GrainTrust Android Mobile Terminal** (`mobile/`).

---

## 🏗️ Architecture Overview

Supabase serves as the single source of truth for the entire GrainTrust ecosystem:
- **Relational PostgreSQL Database**: 12 normalized tables tracking citizens, ration cards, monthly quotas, grain stockpile lots, distribution depots, and audit events.
- **Atomic Stored Procedures (RPCs)**: `fn_online_dispense`, `fn_reconcile_sync_batch`, and `fn_approve_registration` ensure thread-safe, race-condition-free quota deductions.
- **Realtime WebSocket Bus**: Instant synchronization between Web terminals and Android mobile edge terminals.
- **Offline Ledger Reconciliation**: Cryptographically signed Ed25519 tokens queued offline in Android's local SQLite database are reconciled against Supabase when internet connectivity is restored.

---

## 📋 Step 1: Create Your Supabase Project

You can use either **Supabase Cloud** (recommended) or a **Local Supabase Instance**.

### Option A: Supabase Cloud (Recommended)
1. Go to [https://supabase.com](https://supabase.com) and sign in.
2. Click **New Project**, choose an organization, and name your project (e.g., `graintrust-production`).
3. Set a strong database password and select a region close to your target users (e.g., `ap-south-1` for Mumbai).
4. Wait ~2 minutes for the database to provision.
5. In your project dashboard, navigate to **Project Settings** (gear icon) $\to$ **API**.
6. Copy the following credentials:
   - **Project URL**: `https://<your-project-ref>.supabase.co`
   - **Project API Keys** $\to$ `anon` / `public`: `<your-anon-public-key>`
   - **Project API Keys** $\to$ `service_role` (optional for backend scripts): `<your-service-role-secret-key>`

### Option B: Local Supabase Instance (Docker)
If developing locally without an internet connection:
```bash
# In your terminal
npx supabase init
npx supabase start
```
Note the printed API URL (typically `http://localhost:54321`) and `anon key`.

---

## 🗄️ Step 2: Apply Migrations & Seed Data

The schema and seed files are located in `web/supabase/` (and mirrored in `mobile/supabase/`).

### 1. Apply Schema & Stored Procedures
1. In the Supabase Dashboard, click on **SQL Editor** in the left sidebar.
2. Click **New Query**.
3. Open the file `web/supabase/migrations/20261014000000_graintrust_schema.sql`, copy its entire content, and paste it into the SQL Editor.
4. Click **Run** (or press `Ctrl+Enter`).
5. **What this creates**:
   - `persons`, `household_profiles`, `registrations`, `cards`
   - `lots`, `lot_cap_grants`, `card_quota_ledger`
   - `distribution_nodes`, `distribution_transactions`, `transaction_state_history`
   - `provisional_tokens`, `failure_events`, `audit_events`
   - Functions: `fn_online_dispense()`, `fn_approve_registration()`, `fn_reconcile_sync_batch()`
   - Adds all tables to the `supabase_realtime` publication.

### 2. Apply Seed Data
1. In the Supabase SQL Editor, click **New Query**.
2. Open the file `web/supabase/seed.sql`, copy its content, and paste it.
3. Click **Run**.
4. **What this populates**:
   - Default distribution depots: `Sector 4 Community Depot` (`node-alpha-001`) and `Rural Outpost Station 9` (`node-beta-002`).
   - Central grain stockpile lots: `LOT-WHEAT-2026-01` (5,000 kg Premium Sharbati Wheat) and `LOT-RICE-2026-02` (3,500 kg Sona Masoori Rice).
   - Depot quota allocation grants.

---

## 🌐 Step 3: Configure the Web Application (`web/`)

### 1. Set Environment Variables
In the `web/` directory, create a `.env` file from `.env.example`:

```bash
cd web
cp .env.example .env
```

Open `.env` and fill in your Supabase credentials:
```env
# Supabase Cloud Configuration
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-token>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-token>

# Node API Server Settings
PORT=3001
HOST=0.0.0.0
NODE_ENV=development
```

### 2. Start Web Dashboard & API
```bash
# Terminal 1: Start Node API Server
npm run start:api

# Terminal 2: Start Vite Dev Server
npm run dev
```

### 3. Verify Connection
- Open `http://localhost:5173` in your browser.
- Look at the top navigation bar:
  - If properly configured, the status badge will indicate **ONLINE / SUPABASE CONNECTED**.
  - In browser Developer Tools (F12 $\to$ Console), you will see:
    ```
    [Supabase] Initialized client with https://<your-project-ref>.supabase.co
    [Supabase Realtime] Subscribed to graintrust_realtime channel
    ```

---

## 📱 Step 4: Configure the Android Mobile App (`mobile/`)

The mobile app connects to Supabase directly via the `supabase_flutter` SDK with local SQLite caching for autonomous offline operation.

### Method 1: Using `--dart-define` (Recommended - No Code Changes)
Pass your Supabase credentials at compile-time:

```bash
cd mobile

flutter run \
  --dart-define=SUPABASE_URL=https://<your-project-ref>.supabase.co \
  --dart-define=SUPABASE_ANON_KEY=<your-anon-token>
```

### Method 2: Update Default Values in Code
Alternatively, edit `mobile/lib/config/env.dart`:
```dart
class AppEnv {
  static const String supabaseUrl = String.fromEnvironment(
    'SUPABASE_URL',
    defaultValue: 'https://<your-project-ref>.supabase.co',
  );

  static const String supabaseAnonKey = String.fromEnvironment(
    'SUPABASE_ANON_KEY',
    defaultValue: '<your-anon-token>',
  );
  ...
}
```

### ⚠️ Android Emulator Networking Notes
- **Supabase Cloud**: Works seamlessly out of the box since the emulator has internet access.
- **Local Supabase / Localhost API**:
  - In Android emulators, `localhost` refers to the emulator device itself.
  - To communicate with local services running on your development PC, either use `10.0.2.2` (the host machine loopback) or run ADB reverse tunnels:
    ```bash
    # Forward host port 3001 (Node API) and 54321 (Local Supabase) to the emulator:
    adb reverse tcp:3001 tcp:3001
    adb reverse tcp:54321 tcp:54321
    ```

### 3. Verify Mobile Connection
- When the app boots on the emulator or device:
  - The top-right badge will show **ONLINE** with a glowing emerald indicator.
  - In `flutter logs` / Logcat, you will see:
    ```
    I/flutter: [Supabase] Initialized successfully with https://<your-project-ref>.supabase.co
    I/flutter: [Supabase Realtime] Subscribed to graintrust_mobile_realtime channel
    ```

---

## 🔄 Step 5: Test Bidirectional Synchronization

To verify that both Web and Mobile are fully synchronized with Supabase:

1. **Test Registration Sync**:
   - On the **Mobile App** (or Emulator), tap the **Cards** tab.
   - Tap **Sample Citizen** to auto-fill the form, then tap **Submit Application**.
   - Switch to the **Web Dashboard** $\to$ navigate to **Registrations**.
   - Notice the new applicant appears **in real-time** without reloading the page!
   - Approve the citizen on the Web Dashboard; observe the newly generated Ration Card appear immediately on Mobile.

2. **Test Realtime Dispense**:
   - On the **Mobile App**, select the newly approved ration card on the **Dispense** tab.
   - Tap **Issue Grain (Online Reconciled)**.
   - The transaction executes via Supabase RPC `fn_online_dispense()`.
   - On the **Web Dashboard**, inspect the **Audit Log** and **Stockpile** tabs; notice the lot quantity decreased and the audit event was appended in real time.

3. **Test Offline-to-Online Batch Reconciliation**:
   - On the Mobile App, tap the **ONLINE** pill to simulate network disconnection (turns into red **OFFLINE** pill).
   - Dispense grain; the app signs an Ed25519 token locally, deducts from local SQLite, and increments the **Sync** tab outbox badge.
   - Tap the **OFFLINE** pill to restore network connection.
   - Tap **Trigger Batch Sync Now** on the **Sync** tab.
   - The batch is sent to Supabase `fn_reconcile_sync_batch()`, the audit log is updated, and the outbox depth resets to `0`.

---

## 🛡️ Security & Row-Level Security (RLS)

- The schema provided in `20261014000000_graintrust_schema.sql` includes Row-Level Security (RLS) policies.
- Tables allow `SELECT` and specific `INSERT` operations with the `anon` key, while administrative overrides and batch reconciliation run securely via `SECURITY DEFINER` functions.
- For production deployments, update the Supabase RLS policies to restrict write access to authenticated depot operator JWT claims.
