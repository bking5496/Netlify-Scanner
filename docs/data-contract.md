# Stock Scanner Data Contract

_Last updated: 2025-11-30_

This document describes the persistent data model that backs the Stock Scanner PWA, including tables, helper functions, triggers, and access policies. Use it to understand how the web app, Supabase, and (legacy) Netlify/Neon deployments share and validate information.

## High-Level Architecture

- **Primary store:** Supabase Postgres. The app talks directly to Supabase when credentials are provided.
- **Fallbacks:** A Netlify Function + Neon database (legacy) or localStorage (offline). When Supabase connectivity exists, the client keeps an active heartbeat to ensure device presence and session metadata stay in sync server-side.
- **Auth:** Supabase JWTs may include an `app_role` claim. If absent, the backend looks up `app_roles` by `auth.uid()`; anonymous users default to `operator`.

## Tables

### `stock_scans`
Captures every counted pallet/item.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid/text | Existing primary key (not altered in migration). |
| `take_date` | date | Date of the stock take. Indexed indirectly via `stock_takes`. |
| `session_id` | text | Links to `stock_takes.id`; enables multi-device aggregation. |
| `session_type` | text | `FP` (default) or `RM`. Drives validation and unit handling. |
| `batch_number` | text | Parsed from QR or manual entry. |
| `pallet_number` | text | FP-specific uniqueness check. |
| `stock_code` | text | RM/FP product code. |
| `description` | text | Human readable description. |
| `unit_type` | text | Defaults to `cases`; RM scans may set `kg`. |
| `cases_on_pallet` | integer | Encoded count from QR (FP). |
| `actual_cases` | integer/decimal | Operator-entered quantity. |
| `expiry_date` | date | Required for RM entries by trigger. |
| `location` | text | Free-form notes (legacy). |
| `site` / `aisle` / `rack` | text | Structured location hierarchy. |
| `location_zone_id` | uuid | Optional FK to `location_zones`. |
| `raw_code` | text | Original QR payload (FP requires 13 digits). |
| `device_id` | text | Client-generated identifier. |
| `scanned_by` | text | Operator name. |
| `created_by` | text | Reserved for service integrations. |
| `scanned_at` | timestamptz | Defaults to `now()`. |
| `updated_at` | timestamptz | Maintained by trigger. |

Indexes: `idx_stock_scans_session_id`, `idx_stock_scans_session_type`, `idx_stock_scans_batch_pallet`, `idx_stock_scans_location_zone`.

### `stock_takes`
Represents a logical session/day/type grouping that multiple devices can join.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | Format `YYYY-MM-DD-<TYPE>-<N>` generated client-side. |
| `session_type` | text | Mirrors `stock_scans.session_type`. |
| `session_number` | integer | Daily incremental counter per type. |
| `take_date` | date | Calendar date. Indexed (`idx_stock_takes_date_type`). |
| `status` | text | `active`, `paused`, `completed`. |
| `started_by` | text | Creator name. |
| `started_at` / `paused_at` / `resumed_at` / `completed_at` | timestamptz | Lifecycle timestamps. |
| `metadata` | jsonb | Stores client-side device payloads, last update info, etc. |

### `session_devices`
Tracks each device participating in a session along with heartbeat info.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | Generated automatically. |
| `session_id` | text FK | References `stock_takes(id)` with cascade delete. |
| `device_id` | text | Client identifier; unique per session. |
| `user_name` | text | Latest supplied operator name. |
| `role` | text | `operator`, `supervisor`, `admin` (default `operator`). |
| `status` | text | `active`, `paused`, `completed`, `offline`, etc. |
| `last_seen` | timestamptz | Updated by `upsert_session_device`. |
| `joined_at` / `left_at` | timestamptz | Participation window. |

Unique constraint: `(session_id, device_id)`.

### `session_status_events`
Lifecycle audit log for session-level actions (pause/resume/complete).

| Column | Type | Notes |
| --- | --- | --- |
| `session_id` | text FK | References `stock_takes`. |
| `previous_status` | text | Snapshot before change. |
| `next_status` | text | Required. |
| `reason` | text | Optional operator-provided detail. |
| `actor` | text | Operator name. |
| `actor_device_id` | text | Device responsible. |
| `metadata` | jsonb | Flexible payload (e.g., UI context). |
| `created_at` | timestamptz | Default `now()`. |

### `location_zones`
Normalized reference table for structured locations.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `site` | text | Required. |
| `aisle` | text | Required. |
| `rack` | text | Optional. |
| `description` | text | Display text. |
| `metadata` | jsonb | Additional attributes (e.g., capacity). |
| `created_at` | timestamptz | Default `now()`. |

### `scan_audit_logs`
Immutable change history for `stock_scans` updates/deletes via trigger.

| Column | Type | Notes |
| --- | --- | --- |
| `scan_id` | text | Source row ID. |
| `action` | text | `update` or `delete`. |
| `actor` / `actor_device_id` | text | Derived from JWT claims. |
| `previous_data` | jsonb | Full row before change. |
| `new_data` | jsonb | Row after update (null for delete). |
| `created_at` | timestamptz | Default `now()`. |

### `event_logs`
General-purpose structured log for client/server events.

| Column | Type | Notes |
| --- | --- | --- |
| `event_type` | text | e.g., `heartbeat-failed`, `duplicate-detected`. |
| `severity` | text | Defaults to `info` (`warning` / `error` encouraged). |
| `session_id` / `device_id` | text | Optional references. |
| `payload` | jsonb | Arbitrary metadata (API responses, counts, etc.). |
| `created_at` | timestamptz | Default `now()`. |

### `app_roles`
Manual override for user->role mapping when JWT claim is absent.

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | uuid PK | Matches `auth.users.id`. |
| `email` | text | Convenience lookup. |
| `role` | text | Enum-enforced (`operator`, `supervisor`, `admin`). |
| `created_at` | timestamptz | Default `now()`. |

## Helper Functions & Triggers

### `current_app_role()`
Determines the effective role:
1. Checks `auth.jwt()->>'app_role'` claim.
2. Falls back to `app_roles` by `auth.uid()`.
3. Defaults to `'operator'`.

### `validate_stock_scan()` trigger
- Runs before insert/update on `stock_scans`.
- Enforces 13-digit `raw_code` for FP scans.
- Requires `expiry_date` for RM scans.
- Updates `updated_at` timestamp.

### `log_scan_audit()` trigger
- Runs after update/delete on `stock_scans`.
- Captures both old/new row images and actor metadata in `scan_audit_logs`.

### `upsert_session_device()` RPC
Signature:
```sql
upsert_session_device(
    p_session_id text,
    p_device_id text,
    p_user_name text,
    p_role text DEFAULT 'operator',
    p_status text DEFAULT 'active'
) RETURNS session_devices;
```
Behavior:
- Inserts or updates a `session_devices` row.
- Refreshes `last_seen`, `status`, `user_name`, `role`.
- Sets `left_at` when `p_status = 'completed'`.

### `log_event()` RPC
Signature:
```sql
log_event(
    p_event_type text,
    p_severity text,
    p_session_id text,
    p_device_id text,
    p_payload jsonb
) RETURNS event_logs;
```
Used by the client to persist telemetry (duplicate detection, Supabase errors, etc.).

## Row-Level Security (RLS)
All new tables have RLS enabled.

- `stock_scans`: operators can select/insert; supervisors/admins can update/delete.
- `stock_takes`: `FOR ALL` policy allows any authenticated role (operator+) to read/write.
- `session_devices`: `FOR ALL` policy restricted to operator+ roles.
- `scan_audit_logs` and `event_logs`: read-only access for supervisors/admins; no write policy (only triggers/RPCs insert).

> _Note:_ Anonymous usage relies on Supabase policies that treat the anon key as `operator`. For higher security, wire Supabase Auth (email OTP or magic links) so roles can be scoped per user.

## Client Responsibilities

The PWA coordinates with Supabase as follows:

1. **Session Lifecycle**
   - Creates `stock_takes` records (via upsert) when starting sessions.
   - Calls `upsert_session_device` on heartbeat to keep `session_devices.last_seen` current.
   - Records lifecycle transitions with `changeSessionStatusSupabase`, which writes to both `stock_takes` and `session_status_events`.

2. **Scanning Flow**
   - Inserts `stock_scans` with structured location data (`site`/`aisle`/`rack`).
   - Uses `checkDuplicateInSupabase` to query existing `stock_scans` for conflicts across devices.
   - Deletes and exports via Supabase whenever online; otherwise falls back to localStorage.

3. **Event Logging**
   - Calls `log_event` on notable client-side events (heartbeat failures, duplicate detection, Supabase RPC errors) so supervisors have an audit trail.

4. **Offline Support**
   - When `navigator.onLine` flips to `false`, heartbeats stop and the UI enters “Offline cache” mode. Once connectivity returns, sessions and scans resync automatically.

## Future Extensions

- **Supervision console:** `event_logs`, `session_devices`, and `session_status_events` provide a foundation for a dashboard showing live presence, idle devices, and lifecycle history.
- **Structured Locations:** Populate `location_zones` and leverage `location_zone_id` for validation (e.g., limiting a session to a specific zone).
- **Server-side exports:** Build Postgres functions or Edge Functions that consolidate `stock_scans` per session with metadata and serve downloadable files.

For questions or schema change proposals, update this document alongside the migration scripts so client and backend expectations stay aligned.
