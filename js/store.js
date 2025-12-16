// ===========================================
// SESSION STORE & STATE MANAGEMENT
// ===========================================

// Get/set active stock take
const getActiveStockTake = () => {
    const data = localStorage.getItem('activeStockTake');
    return data ? JSON.parse(data) : null;
};
const setActiveStockTake = (stockTake) => {
    localStorage.setItem('activeStockTake', JSON.stringify(stockTake));
};
const clearActiveStockTake = () => {
    localStorage.removeItem('activeStockTake');
};

// Session settings
const getSessionSettings = () => {
    const defaults = {
        locationScanningEnabled: false,
        currentLocation: '',
        site: '',
        aisle: '',
        rack: '',
        // Warehouse location system
        warehouseConfig: {
            name: 'Main Warehouse',
            racks: [], // Array of rack configs: { id, name, rows, columns, levels }
            floorLocations: [] // Array of floor location names
        },
        selectedWarehouseLocation: null // { type: 'rack' | 'floor', rackId?, level?, position?, floorId? }
    };
    const data = localStorage.getItem('sessionSettings');
    return data ? { ...defaults, ...JSON.parse(data) } : defaults;
};
const saveSessionSettings = (settings) => {
    localStorage.setItem('sessionSettings', JSON.stringify(settings));
};

// Generate location code from selection
const generateLocationCode = (settings) => {
    const loc = settings.selectedWarehouseLocation;
    if (!loc) return '';

    if (loc.type === 'floor') {
        return `FLOOR-${loc.floorId}`;
    } else if (loc.type === 'rack') {
        const rack = settings.warehouseConfig?.racks?.find(r => r.id === loc.rackId);
        const rackName = rack?.name || loc.rackId;
        const level = String.fromCharCode(64 + (loc.level || 1)); // 1=A, 2=B, etc.
        const position = loc.position || 1;
        return `${rackName}-${level}${position}`;
    }
    return '';
};

// Session management - track sessions per day
const getSessionsForDate = (date, sessionType = null) => {
    const data = localStorage.getItem(`sessions_${date}`);
    const sessions = data ? JSON.parse(data) : [];
    if (sessionType) {
        return sessions.filter(s => s.sessionType === sessionType);
    }
    return sessions;
};
const saveSessionsForDate = (date, sessions) => {
    localStorage.setItem(`sessions_${date}`, JSON.stringify(sessions));
};
const getNextSessionNumber = (date, sessionType = 'FP') => {
    const sessions = getSessionsForDate(date, sessionType);
    return sessions.length + 1;
};
const addSession = async (date, session) => {
    session.date = session.date || date;
    const allSessions = getSessionsForDate(date);
    const existingIndex = allSessions.findIndex(s => s.id === session.id);
    if (existingIndex >= 0) {
        allSessions[existingIndex] = session;
    } else {
        allSessions.push(session);
    }
    saveSessionsForDate(date, allSessions);
    await saveSessionToSupabase(session);
};
const updateSession = async (date, sessionId, updates) => {
    const sessions = getSessionsForDate(date);
    const idx = sessions.findIndex(s => s.id === sessionId);
    if (idx >= 0) {
        sessions[idx].date = sessions[idx].date || date;
        sessions[idx] = { ...sessions[idx], ...updates };
        saveSessionsForDate(date, sessions);
        await saveSessionToSupabase(sessions[idx]);
    }
};

// Get active (non-completed) sessions for joining
const getActiveSessionsForDate = (date) => {
    const sessions = getSessionsForDate(date);
    const role = getUserRole();
    const userWarehouse = getUserWarehouse();

    return sessions.filter(s => {
        // Must be active
        if (s.status !== 'active') return false;

        // Admins see all sessions
        if (role === 'admin') return true;

        // Non-admins with a warehouse only see matching sessions
        if (userWarehouse) {
            const sessionWarehouse = s.warehouse || s.metadata?.warehouse || '';
            return sessionWarehouse === userWarehouse;
        }

        return true;
    });
};

// Add a device to an existing session
const joinSession = async (date, sessionId, deviceId, userName) => {
    const sessions = getSessionsForDate(date);
    const idx = sessions.findIndex(s => s.id === sessionId);
    if (idx >= 0) {
        sessions[idx].date = sessions[idx].date || date;
        if (!sessions[idx].devices) {
            sessions[idx].devices = [];
        }
        // Check if device already in session
        const existingDevice = sessions[idx].devices.find(d => d.deviceId === deviceId);
        if (existingDevice) {
            // Reactivate the device
            existingDevice.status = 'active';
            existingDevice.userName = userName;
            existingDevice.rejoinedAt = new Date().toISOString();
            existingDevice.lastSeen = new Date().toISOString();
        } else {
            sessions[idx].devices.push({
                deviceId: deviceId,
                userName: userName,
                status: 'active',
                joinedAt: new Date().toISOString(),
                lastSeen: new Date().toISOString()
            });
        }
        saveSessionsForDate(date, sessions);
        await saveSessionToSupabase(sessions[idx]);
        return sessions[idx];
    }
    return null;
};

// Mark a device as completed in a session (session stays open until ended manually)
const markDeviceCompleted = async (date, sessionId, deviceId) => {
    const sessions = getSessionsForDate(date);
    const idx = sessions.findIndex(s => s.id === sessionId);
    if (idx >= 0) {
        sessions[idx].date = sessions[idx].date || date;
        if (sessions[idx].devices) {
            const device = sessions[idx].devices.find(d => d.deviceId === deviceId);
            if (device) {
                device.status = 'completed';
                device.completedAt = new Date().toISOString();
                device.lastSeen = new Date().toISOString();
            }
        }
        saveSessionsForDate(date, sessions);
        await saveSessionToSupabase(sessions[idx]);
        return sessions[idx];
    }
    return null;
};

// Get session by ID
const getSessionById = (date, sessionId) => {
    const sessions = getSessionsForDate(date);
    return sessions.find(s => s.id === sessionId);
};

// Supabase session helpers
const supabaseSessionsEnabled = Boolean(typeof supabase !== 'undefined' && supabase);

const mapSupabaseSession = (row) => ({
    id: row.id,
    sessionNumber: row.session_number,
    sessionType: row.session_type,
    date: row.take_date,
    startedBy: row.started_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status || 'active',
    devices: (row.metadata && row.metadata.devices) || [],
    warehouse: (row.metadata && row.metadata.warehouse) || '',
    metadata: row.metadata || {}
});

const buildSupabaseSessionPayload = (session) => {
    const fallbackDate = session.startedAt ? new Date(session.startedAt).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    // Preserve warehouse from metadata if session.warehouse is not set
    const warehouse = session.warehouse || session.metadata?.warehouse || null;
    return {
        id: session.id,
        session_type: session.sessionType,
        session_number: session.sessionNumber,
        take_date: session.date || fallbackDate,
        status: session.status || 'active',
        started_by: session.startedBy,
        started_at: session.startedAt,
        completed_at: session.completedAt || null,
        metadata: {
            ...(session.metadata || {}),
            devices: session.devices || [],
            warehouse: warehouse,
            lastUpdatedBy: session.lastUpdatedBy || (session.devices?.find(d => d.deviceId === DEVICE_ID)?.userName || null),
            lastUpdatedAt: new Date().toISOString()
        }
    };
};

async function syncSessionsFromSupabase(date) {
    if (!supabase || !date) return;
    try {
        const { data, error } = await supabase
            .from('stock_takes')
            .select('*')
            .eq('take_date', date)
            .order('session_number', { ascending: true });
        if (error) throw error;
        let mapped = (data || []).map(mapSupabaseSession);
        const sessionIds = mapped.map(s => s.id).filter(Boolean);
        if (sessionIds.length > 0) {
            const devicesBySession = await fetchSessionDevicesMap(sessionIds);
            mapped = mapped.map(session => ({
                ...session,
                devices: devicesBySession[session.id] || session.devices || []
            }));
        }
        saveSessionsForDate(date, mapped);
        return mapped;
    } catch (err) {
        console.error('Failed to sync sessions from Supabase:', err);
        await logClientEvent('session-sync-failed', 'error', null, { date, message: err.message });
        return null;
    }
}

async function saveSessionToSupabase(session) {
    if (!supabase || !session) return true;
    const isDuplicateError = (err) => err?.code === '23505' || /duplicate key value/i.test(err?.message || '');

    try {
        // First, check if session already exists to preserve started_by
        const { data: existing } = await supabase
            .from('stock_takes')
            .select('started_by, started_at, metadata')
            .eq('id', session.id)
            .maybeSingle();

        // Build payload, preserving original started_by and warehouse if they exist
        const payload = buildSupabaseSessionPayload(session);
        if (existing) {
            // Preserve original creator info - never overwrite started_by
            payload.started_by = existing.started_by || payload.started_by;
            payload.started_at = existing.started_at || payload.started_at;
            // Preserve original warehouse if not in current payload
            if (!payload.metadata.warehouse && existing.metadata?.warehouse) {
                payload.metadata.warehouse = existing.metadata.warehouse;
            }
        }

        const { error } = await supabase
            .from('stock_takes')
            .upsert(payload, { onConflict: 'id' });
        if (!error) {
            return true;
        }

        if (isDuplicateError(error)) {
            const { error: updateError } = await supabase
                .from('stock_takes')
                .update(payload)
                .eq('id', session.id);
            if (!updateError) {
                return true;
            }
            throw updateError;
        }

        throw error;
    } catch (err) {
        console.error('Failed to save session to Supabase:', err);
        await logClientEvent('session-save-failed', 'error', session?.id || null, {
            message: err?.message || 'unknown error',
            code: err?.code || null,
            details: err?.details || null
        });
        return false;
    }
}

async function fetchSessionDevicesMap(sessionIds = []) {
    if (!supabase || sessionIds.length === 0) return {};
    try {
        const { data, error } = await supabase
            .from('session_devices')
            .select('*')
            .in('session_id', sessionIds);
        if (error) throw error;
        return (data || []).reduce((acc, device) => {
            if (!acc[device.session_id]) {
                acc[device.session_id] = [];
            }
            acc[device.session_id].push({
                id: device.id,
                sessionId: device.session_id,
                deviceId: device.device_id,
                userName: device.user_name,
                role: device.role,
                status: device.status,
                lastSeen: device.last_seen,
                joinedAt: device.joined_at,
                leftAt: device.left_at
            });
            return acc;
        }, {});
    } catch (err) {
        console.error('Failed to load session devices:', err);
        await logClientEvent('session-devices-failed', 'error', null, { ids: sessionIds, message: err.message });
        return {};
    }
}

async function upsertSessionDevicePresence(sessionId, status = 'active', sessionSnapshot = null) {
    if (!supabase || !sessionId) return;

    const invokeHeartbeat = async () => {
        const { error } = await supabase.rpc('upsert_session_device', {
            p_session_id: sessionId,
            p_device_id: DEVICE_ID,
            p_user_name: getUserName() || 'Unknown',
            p_role: 'operator',
            p_status: status
        });
        if (error) throw error;
    };

    const isMissingSessionError = (err) => {
        if (!err) return false;
        if (err.code === '23503') return true; // foreign key violation
        return typeof err.message === 'string' && err.message.includes('session_devices_session_id_fkey');
    };

    try {
        await invokeHeartbeat();
    } catch (err) {
        if (isMissingSessionError(err) && sessionSnapshot) {
            console.warn('Heartbeat failed because session is missing in Supabase. Attempting to re-save session before retrying.');
            const saved = await saveSessionToSupabase(sessionSnapshot);
            if (saved) {
                await new Promise((resolve) => setTimeout(resolve, 300));
                try {
                    await invokeHeartbeat();
                    return;
                } catch (retryErr) {
                    console.error('Heartbeat retry still failing:', retryErr);
                    await logClientEvent('heartbeat-retry-failed', 'error', sessionId, {
                        status,
                        message: retryErr?.message || 'retry failed',
                        code: retryErr?.code || null
                    });
                    return;
                }
            }
        }

        console.error('Heartbeat failed:', err);
        await logClientEvent('heartbeat-failed', 'warning', sessionId, {
            status,
            message: err?.message || 'unknown error',
            code: err?.code || null,
            details: err?.details || null
        });
    }
}

async function changeSessionStatusSupabase(session, nextStatus, reason = '', metadata = {}) {
    if (!supabase || !session?.id) return null;
    try {
        const { data: existing } = await supabase
            .from('stock_takes')
            .select('status')
            .eq('id', session.id)
            .maybeSingle();
        const timestamps = {
            paused_at: nextStatus === 'paused' ? new Date().toISOString() : session.paused_at,
            resumed_at: nextStatus === 'active' ? new Date().toISOString() : session.resumed_at,
            completed_at: nextStatus === 'completed' ? new Date().toISOString() : session.completed_at
        };
        const { data, error } = await supabase
            .from('stock_takes')
            .update({ status: nextStatus, metadata: { ...(session.metadata || {}), ...metadata }, ...timestamps })
            .eq('id', session.id)
            .select()
            .maybeSingle();
        if (error) throw error;
        await supabase
            .from('session_status_events')
            .insert({
                session_id: session.id,
                previous_status: existing?.status || session.status,
                next_status: nextStatus,
                reason,
                actor: getUserName() || 'Unknown',
                actor_device_id: DEVICE_ID,
                metadata
            });
        await updateSession(session.date, session.id, { status: nextStatus, ...timestamps, metadata: { ...(session.metadata || {}), ...metadata } });
        return data;
    } catch (err) {
        console.error('Failed to update session status:', err);
        await logClientEvent('session-status-failed', 'error', session?.id || null, { nextStatus, reason, message: err.message });
        return null;
    }
}
