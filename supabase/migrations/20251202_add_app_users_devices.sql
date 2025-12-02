-- Migration: Add app_users and app_devices tables for persistent user/device management
-- Created: 2025-12-02

BEGIN;

-- =============================================================================
-- APP_USERS TABLE
-- Stores user profiles with roles and warehouse assignments
-- =============================================================================
CREATE TABLE IF NOT EXISTS app_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    display_name text NOT NULL,
    role text NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'supervisor', 'admin')),
    warehouse text CHECK (warehouse IS NULL OR warehouse IN ('PSA', 'PML')),
    email text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint on name (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_users_name_lower ON app_users (lower(name));

-- Index for active user lookups
CREATE INDEX IF NOT EXISTS idx_app_users_active ON app_users (is_active) WHERE is_active = true;

-- Index for warehouse filtering
CREATE INDEX IF NOT EXISTS idx_app_users_warehouse ON app_users (warehouse) WHERE warehouse IS NOT NULL;

COMMENT ON TABLE app_users IS 'Registered users with role and warehouse assignments';
COMMENT ON COLUMN app_users.name IS 'Full username as entered (used for login matching)';
COMMENT ON COLUMN app_users.display_name IS 'Name shown in UI (without role suffixes)';
COMMENT ON COLUMN app_users.role IS 'Access level: operator, supervisor, or admin';
COMMENT ON COLUMN app_users.warehouse IS 'Assigned warehouse (PSA/PML), null for admins';

-- =============================================================================
-- APP_DEVICES TABLE
-- Stores device information linked to users
-- =============================================================================
CREATE TABLE IF NOT EXISTS app_devices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id text NOT NULL UNIQUE,
    device_name text,
    user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
    user_name text,
    last_user_name text,
    platform text,
    user_agent text,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    is_active boolean NOT NULL DEFAULT true,
    metadata jsonb DEFAULT '{}'::jsonb
);

-- Index for device lookups
CREATE INDEX IF NOT EXISTS idx_app_devices_device_id ON app_devices (device_id);

-- Index for user's devices
CREATE INDEX IF NOT EXISTS idx_app_devices_user_id ON app_devices (user_id) WHERE user_id IS NOT NULL;

-- Index for active devices
CREATE INDEX IF NOT EXISTS idx_app_devices_active ON app_devices (is_active) WHERE is_active = true;

COMMENT ON TABLE app_devices IS 'Registered devices with their current/last user associations';
COMMENT ON COLUMN app_devices.device_id IS 'Client-generated unique device identifier';
COMMENT ON COLUMN app_devices.device_name IS 'Optional friendly name for the device';
COMMENT ON COLUMN app_devices.user_id IS 'Current associated user (FK to app_users)';
COMMENT ON COLUMN app_devices.user_name IS 'Current user name (denormalized for quick access)';
COMMENT ON COLUMN app_devices.last_user_name IS 'Previous user name before current login';
COMMENT ON COLUMN app_devices.platform IS 'Detected platform (iOS, Android, Windows, etc.)';

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Function to get or create a user by name
CREATE OR REPLACE FUNCTION upsert_app_user(
    p_name text,
    p_display_name text DEFAULT NULL,
    p_role text DEFAULT 'operator',
    p_warehouse text DEFAULT NULL
) RETURNS app_users AS $$
DECLARE
    v_user app_users;
    v_display text;
BEGIN
    -- Use provided display name or derive from name
    v_display := COALESCE(p_display_name, regexp_replace(p_name, '\*+$', '', 'g'));
    
    -- Try to find existing user (case-insensitive)
    SELECT * INTO v_user FROM app_users WHERE lower(name) = lower(p_name);
    
    IF v_user.id IS NOT NULL THEN
        -- Update existing user
        UPDATE app_users SET
            display_name = v_display,
            role = p_role,
            warehouse = p_warehouse,
            updated_at = now()
        WHERE id = v_user.id
        RETURNING * INTO v_user;
    ELSE
        -- Insert new user
        INSERT INTO app_users (name, display_name, role, warehouse)
        VALUES (p_name, v_display, p_role, p_warehouse)
        RETURNING * INTO v_user;
    END IF;
    
    RETURN v_user;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to register/update a device
CREATE OR REPLACE FUNCTION upsert_app_device(
    p_device_id text,
    p_user_name text DEFAULT NULL,
    p_device_name text DEFAULT NULL,
    p_platform text DEFAULT NULL,
    p_user_agent text DEFAULT NULL,
    p_metadata jsonb DEFAULT NULL
) RETURNS app_devices AS $$
DECLARE
    v_device app_devices;
    v_user_id uuid;
    v_last_user text;
BEGIN
    -- Look up user ID if name provided
    IF p_user_name IS NOT NULL THEN
        SELECT id INTO v_user_id FROM app_users WHERE lower(name) = lower(p_user_name);
    END IF;
    
    -- Try to find existing device
    SELECT * INTO v_device FROM app_devices WHERE device_id = p_device_id;
    
    IF v_device.id IS NOT NULL THEN
        -- Capture previous user before update
        v_last_user := v_device.user_name;
        
        -- Update existing device
        UPDATE app_devices SET
            user_id = COALESCE(v_user_id, user_id),
            user_name = COALESCE(p_user_name, user_name),
            last_user_name = CASE WHEN p_user_name IS NOT NULL AND v_last_user != p_user_name THEN v_last_user ELSE last_user_name END,
            device_name = COALESCE(p_device_name, device_name),
            platform = COALESCE(p_platform, platform),
            user_agent = COALESCE(p_user_agent, user_agent),
            last_seen_at = now(),
            metadata = COALESCE(p_metadata, metadata)
        WHERE id = v_device.id
        RETURNING * INTO v_device;
    ELSE
        -- Insert new device
        INSERT INTO app_devices (device_id, user_id, user_name, device_name, platform, user_agent, metadata)
        VALUES (p_device_id, v_user_id, p_user_name, p_device_name, p_platform, p_user_agent, COALESCE(p_metadata, '{}'::jsonb))
        RETURNING * INTO v_device;
    END IF;
    
    RETURN v_device;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get user role by name (for client-side lookups)
CREATE OR REPLACE FUNCTION get_user_role(p_name text)
RETURNS text AS $$
DECLARE
    v_role text;
BEGIN
    SELECT role INTO v_role FROM app_users WHERE lower(name) = lower(p_name) AND is_active = true;
    RETURN COALESCE(v_role, 'operator');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get full user info by name
CREATE OR REPLACE FUNCTION get_user_by_name(p_name text)
RETURNS app_users AS $$
BEGIN
    RETURN (SELECT * FROM app_users WHERE lower(name) = lower(p_name) AND is_active = true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to list all active users (for admin)
CREATE OR REPLACE FUNCTION list_app_users(p_warehouse text DEFAULT NULL)
RETURNS SETOF app_users AS $$
BEGIN
    IF p_warehouse IS NOT NULL THEN
        RETURN QUERY SELECT * FROM app_users WHERE is_active = true AND warehouse = p_warehouse ORDER BY role, name;
    ELSE
        RETURN QUERY SELECT * FROM app_users WHERE is_active = true ORDER BY role, name;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to list all devices (for admin)
CREATE OR REPLACE FUNCTION list_app_devices(p_active_only boolean DEFAULT true)
RETURNS SETOF app_devices AS $$
BEGIN
    IF p_active_only THEN
        RETURN QUERY SELECT * FROM app_devices WHERE is_active = true ORDER BY last_seen_at DESC;
    ELSE
        RETURN QUERY SELECT * FROM app_devices ORDER BY last_seen_at DESC;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_devices ENABLE ROW LEVEL SECURITY;

-- Users table: anyone can read active users, only admins can modify
CREATE POLICY app_users_select ON app_users FOR SELECT USING (true);
CREATE POLICY app_users_insert ON app_users FOR INSERT WITH CHECK (true);
CREATE POLICY app_users_update ON app_users FOR UPDATE USING (true);

-- Devices table: anyone can read/write their device
CREATE POLICY app_devices_select ON app_devices FOR SELECT USING (true);
CREATE POLICY app_devices_insert ON app_devices FOR INSERT WITH CHECK (true);
CREATE POLICY app_devices_update ON app_devices FOR UPDATE USING (true);

-- =============================================================================
-- TRIGGERS
-- =============================================================================

-- Trigger to update updated_at on app_users
CREATE OR REPLACE FUNCTION update_app_users_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_app_users_updated_at ON app_users;
CREATE TRIGGER trg_app_users_updated_at
    BEFORE UPDATE ON app_users
    FOR EACH ROW
    EXECUTE FUNCTION update_app_users_timestamp();

-- =============================================================================
-- LIVE SESSIONS VIEW & FUNCTIONS
-- Provides easy access to active/live sessions with device counts
-- =============================================================================

-- View for live sessions with aggregated device info
CREATE OR REPLACE VIEW live_sessions AS
SELECT 
    st.id,
    st.session_type,
    st.session_number,
    st.take_date,
    st.status,
    st.started_by,
    st.started_at,
    st.paused_at,
    st.resumed_at,
    st.metadata,
    st.metadata->>'warehouse' as warehouse,
    (SELECT COUNT(*) FROM session_devices sd WHERE sd.session_id = st.id AND sd.status = 'active') as active_device_count,
    (SELECT COUNT(*) FROM session_devices sd WHERE sd.session_id = st.id) as total_device_count,
    (SELECT json_agg(json_build_object(
        'device_id', sd.device_id,
        'user_name', sd.user_name,
        'status', sd.status,
        'last_seen', sd.last_seen
    )) FROM session_devices sd WHERE sd.session_id = st.id AND sd.status = 'active') as active_devices
FROM stock_takes st
WHERE st.status IN ('active', 'paused');

COMMENT ON VIEW live_sessions IS 'Active and paused sessions with device counts';

-- Function to get live sessions (optionally filtered by warehouse)
CREATE OR REPLACE FUNCTION get_live_sessions(p_warehouse text DEFAULT NULL)
RETURNS TABLE (
    id text,
    session_type text,
    session_number integer,
    take_date date,
    status text,
    started_by text,
    started_at timestamptz,
    warehouse text,
    active_device_count bigint,
    total_device_count bigint,
    active_devices json
) AS $$
BEGIN
    IF p_warehouse IS NOT NULL THEN
        RETURN QUERY 
        SELECT ls.id, ls.session_type, ls.session_number, ls.take_date, ls.status, 
               ls.started_by, ls.started_at, ls.warehouse, ls.active_device_count, 
               ls.total_device_count, ls.active_devices
        FROM live_sessions ls
        WHERE ls.warehouse = p_warehouse
        ORDER BY ls.started_at DESC;
    ELSE
        RETURN QUERY 
        SELECT ls.id, ls.session_type, ls.session_number, ls.take_date, ls.status, 
               ls.started_by, ls.started_at, ls.warehouse, ls.active_device_count, 
               ls.total_device_count, ls.active_devices
        FROM live_sessions ls
        ORDER BY ls.started_at DESC;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get session summary by ID
CREATE OR REPLACE FUNCTION get_session_summary(p_session_id text)
RETURNS TABLE (
    id text,
    session_type text,
    status text,
    started_by text,
    started_at timestamptz,
    warehouse text,
    active_device_count bigint,
    total_scan_count bigint,
    devices json
) AS $$
BEGIN
    RETURN QUERY 
    SELECT 
        st.id,
        st.session_type,
        st.status,
        st.started_by,
        st.started_at,
        st.metadata->>'warehouse' as warehouse,
        (SELECT COUNT(*) FROM session_devices sd WHERE sd.session_id = st.id AND sd.status = 'active') as active_device_count,
        (SELECT COUNT(*) FROM stock_scans ss WHERE ss.session_id = st.id) as total_scan_count,
        (SELECT json_agg(json_build_object(
            'device_id', sd.device_id,
            'user_name', sd.user_name,
            'role', sd.role,
            'status', sd.status,
            'last_seen', sd.last_seen,
            'joined_at', sd.joined_at
        )) FROM session_devices sd WHERE sd.session_id = st.id) as devices
    FROM stock_takes st
    WHERE st.id = p_session_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to end a session (supervisor action)
CREATE OR REPLACE FUNCTION end_session(
    p_session_id text,
    p_ended_by text DEFAULT NULL,
    p_device_id text DEFAULT NULL
) RETURNS stock_takes AS $$
DECLARE
    v_session stock_takes;
    v_previous_status text;
BEGIN
    -- Get current session
    SELECT * INTO v_session FROM stock_takes WHERE id = p_session_id;
    
    IF v_session.id IS NULL THEN
        RAISE EXCEPTION 'Session not found: %', p_session_id;
    END IF;
    
    v_previous_status := v_session.status;
    
    -- Update session to completed
    UPDATE stock_takes SET
        status = 'completed',
        completed_at = now(),
        metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{endedBy}',
            to_jsonb(COALESCE(p_ended_by, 'system'))
        )
    WHERE id = p_session_id
    RETURNING * INTO v_session;
    
    -- Mark all devices as completed
    UPDATE session_devices SET
        status = 'completed',
        left_at = now()
    WHERE session_id = p_session_id AND status != 'completed';
    
    -- Log the status change
    INSERT INTO session_status_events (session_id, previous_status, next_status, actor, actor_device_id)
    VALUES (p_session_id, v_previous_status, 'completed', COALESCE(p_ended_by, 'system'), p_device_id);
    
    RETURN v_session;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;
