<!-- file: design.md -->
# Design & UX Specification

## 1. User-Facing Screens
### 1.1 Public & Beneficiary
- **Registration Landing/Form**: Clean, accessible, step-by-step wizard. Validates inputs inline.
- **ID Issuance/Recovery**: Displays generated UUIDv7. Allows secure recovery via verified phone.
- **Beneficiary Profile**: Read-only view of permitted data.

### 1.2 Staff & Operations
- **Staff Dashboard**: High-level metrics (active nodes, sync backlog, failure rates).
- **ID Lookup & Autofill**: Search by ID. Displays only authorized fields. Clear "Unauthorized" states.
- **Transaction Form**: Selects lot, card, quantity. Shows real-time quota availability.
- **Txn State Tracker**: Visual 5-state pipeline. Highlights current state, timestamps, and reason codes.

### 1.3 Admin & Security
- **Quota/Lot Management**: Tables for creating lots, setting caps, allocating node leases.
- **Failure Analytics**: Dashboards for reason codes, replay attempts, counter gaps.
- **Multi-Node Health**: Node status (Online/Offline/Syncing), outbox depth, last heartbeat.
- **Audit Viewer**: Immutable log viewer with strict filtering.

## 2. Design System
- **Typography**: System UI font stack. High legibility.
- **Colors**: Restrained palette. Status colors: Green (Success), Blue (Info), Yellow (Warning/Provisional), Red (Error/Rejected). Never rely on color alone (use icons/text).
- **Accessibility**: WCAG 2.1 AA. Full keyboard navigation. Screen reader labels for all state changes.

## 3. Transaction Visualization
Visual tracker: `[ATTEMPT] -> [FAIL_REASON] -> [FALLBACK_AUTH] -> [PROVISIONAL_ISSUE] -> [RECONCILED]`
- Nodes light up based on current state.
- Tooltips show transition history and actor.
- `PROVISIONAL_ISSUE` shows a distinct "Pending Sync" badge until `RECONCILED`.

## 4. Offline & Error Presentation
- **Offline Mode**: Yellow banner. "Operating on local quota. Sync pending."
- **Provisional vs Reconciled**: Provisional = Yellow badge. Reconciled = Green (Accepted) or Red (Rejected). Never show "Success" for provisional.

