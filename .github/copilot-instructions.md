# Stock Scanner PWA - AI Coding Instructions

## Architecture Overview

This is a **single-page PWA** contained entirely in `index.html` (~6200 lines). It uses:
- **Supabase** as primary backend (real-time sync, auth, RLS)
- **localStorage** as offline fallback
- **Html5Qrcode** for barcode scanning
- **TailwindCSS** (CDN) for styling

### Key Data Flow
1. **Stock Takes** (`stock_takes` table) → session containers grouping scans by date/type
2. **Stock Scans** (`stock_scans` table) → individual pallet/item records
3. **Session Devices** (`session_devices` table) → multi-device presence tracking with heartbeats
4. **Products** → reference data for FP (Finished Products) and RM (Raw Materials)

### Session Types
- **FP (Finished Products)**: 13-digit QR codes → `BBBBBPPPPCCCC` (batch/pallet/cases)
- **RM (Raw Materials)**: Alpha-prefixed codes with stock code + batch + expiry

## Code Organization

All code lives in `index.html` within a single `<script>` block:
```
Lines 110-160:   Supabase config & initialization
Lines 158-250:   `db` helper object (Supabase/localStorage abstraction)
Lines 250-650:   Product database loaders (FP, RM, product types)
Lines 650-800:   Session management helpers
Lines 800-1050:  Supabase session sync (heartbeats, device presence)
Lines 1050+:     `ScannerApp` class (main application logic & rendering)
```

### Key Objects & Functions
- `db` - Database abstraction layer with `mode` ('supabase' | 'localStorage')
- `ScannerApp` - Main class managing UI state and scan lifecycle
- `upsertSessionDevicePresence()` - Heartbeat updates (15-second interval)
- `checkDuplicateInSupabase()` - Cross-device duplicate detection
- `logClientEvent()` - Telemetry via `log_event` RPC

## Database Schema

See `docs/data-contract.md` for complete schema. Critical tables:
- `stock_scans` - All scan records (session_id links to stock_takes)
- `stock_takes` - Session metadata (id format: `YYYY-MM-DD-{FP|RM}-N`)
- `session_devices` - Device presence tracking with heartbeats
- `products` / `raw_materials` / `product_types` - Reference data

### Migration Patterns
Migrations in `supabase/migrations/` follow pattern `YYYYMMDD_description.sql`. Each uses:
- `BEGIN;`/`COMMIT;` transactions
- `IF EXISTS` guards for idempotency
- Indexes on foreign keys and frequently queried columns

## Development Conventions

### Adding New Features
1. State lives on `ScannerApp` instance properties
2. UI updates via `this.render()` (debounced at 16ms)
3. Modal dialogs use `this.showModal({ title, message, type, fields, onConfirm })`
4. Haptic feedback: `this.triggerHaptic('success' | 'warning' | 'light')`

### Supabase Patterns
- Always check `supabaseSessionsEnabled` before calling Supabase
- Use `logClientEvent()` for error telemetry
- Heartbeat errors should NOT block user workflow (catch and log)
- Session saves handle duplicate key errors with update fallback

### QR Code Parsing
FP codes: `/^\d{13}$/` → parse as batch(5) + pallet(4) + cases(4)
RM codes: Start with letter → extract stock code from `rawMaterialsDatabase` keys

## Testing & Debugging

No formal test suite. Debug via:
- Browser DevTools console (Supabase calls logged)
- `localStorage` inspection for cached state
- Supabase Dashboard for table data verification

## Deployment

Hosted on Netlify. No build step - static `index.html` served directly.
Supabase credentials are embedded (anon key only, RLS-protected).

## Common Tasks

### Adding a new scan field
1. Add column via new migration in `supabase/migrations/`
2. Update `INSERT`/`SELECT` in relevant `ScannerApp` methods
3. Update `loadScans()` field mapping
4. Update `docs/data-contract.md`

### Modifying session lifecycle
1. Check `changeSessionStatusSupabase()` for status transitions
2. Update `session_status_events` if adding new states
3. Consider device heartbeat implications (`startHeartbeat`/`stopHeartbeat`)
