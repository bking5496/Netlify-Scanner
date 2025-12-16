// ===========================================
// DATABASE CONFIGURATION
// ===========================================

// Supabase Configuration
const SUPABASE_URL = 'https://exltxjvzsefmaxlgxyio.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV4bHR4anZ6c2VmbWF4bGd4eWlvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ0NTQ2MjcsImV4cCI6MjA4MDAzMDYyN30.kc5RFVrN5orQ7AqPd51ot-sK1xbWsy_58ToowCvYhZw';
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_GRACE_MS = 45000;

const SUPABASE_PLACEHOLDER_URL = 'https://YOUR_PROJECT_ID.supabase.co';
const SUPABASE_PLACEHOLDER_KEY = 'YOUR_SUPABASE_ANON_KEY';
const supabaseCredentialsConfigured = Boolean(window.supabase?.createClient)
    && Boolean(SUPABASE_URL)
    && Boolean(SUPABASE_ANON_KEY)
    && SUPABASE_URL !== SUPABASE_PLACEHOLDER_URL
    && !SUPABASE_URL.includes('YOUR_PROJECT_ID')
    && SUPABASE_ANON_KEY !== SUPABASE_PLACEHOLDER_KEY
    && !SUPABASE_ANON_KEY.includes('YOUR_SUPABASE_ANON_KEY');

// Initialize Supabase client whenever credentials exist
let supabase = null;
if (supabaseCredentialsConfigured) {
    // Initialize Supabase Client
    if (window.supabase && typeof window.supabase.createClient === 'function') {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                persistSession: true,
                autoRefreshToken: true
            },
            db: {
                schema: 'public'
            }
        });
        // Expose the Supabase client instance globally
        window.supabaseClient = supabase;
    } else {
        console.error('Supabase JS library not loaded or createClient is not a function!');
    }

    try {
        const cachedSession = JSON.parse(localStorage.getItem('supabaseSessionCache') || 'null');
        if (cachedSession?.access_token && cachedSession?.refresh_token) {
            supabase.auth.setSession({
                access_token: cachedSession.access_token,
                refresh_token: cachedSession.refresh_token
            }).catch(() => localStorage.removeItem('supabaseSessionCache'));
        }
        supabase.auth.onAuthStateChange((_event, session) => {
            if (session?.access_token && session?.refresh_token) {
                localStorage.setItem('supabaseSessionCache', JSON.stringify({
                    access_token: session.access_token,
                    refresh_token: session.refresh_token,
                    expires_at: session.expires_at
                }));
            }
        });
    } catch (err) {
        console.warn('Supabase session cache error', err);
    }
}

// Database helper - uses Supabase or localStorage fallback
const db = {
    connected: false,
    mode: 'localStorage', // 'supabase' or 'localStorage'

    async init() {
        // Try Supabase
        if (supabase) {
            try {
                const { error } = await supabase.from('stock_scans').select('id').limit(1);
                if (!error || error.code === 'PGRST116') { // Table might be empty
                    this.connected = true;
                    this.mode = 'supabase';
                    console.log('Connected to Supabase');
                    return true;
                }
                console.log('Supabase error:', error);
            } catch (err) {
                console.log('Supabase not available:', err.message);
            }
        }

        // Fallback to localStorage
        this.connected = false;
        this.mode = 'localStorage';
        console.log('Using localStorage for data storage');
        return false;
    },

    async insertStockTake(date) {
        if (this.mode === 'supabase') {
            const { error } = await supabase.from('stock_takes').upsert({
                take_date: date,
                status: 'active'
            }, { onConflict: 'take_date' });
            return !error;
        }
        return false;
    },

    async getStockScans(date) {
        if (this.mode === 'supabase') {
            const { data, error } = await supabase
                .from('stock_scans')
                .select('*')
                .eq('take_date', date)
                .order('scanned_at', { ascending: false });
            return error ? [] : data;
        }
        return [];
    },

    async insertStockScan(scan) {
        if (this.mode === 'supabase') {
            const { error } = await supabase.from('stock_scans').insert({
                take_date: scan.take_date,
                batch_number: scan.batch_number,
                pallet_number: scan.pallet_number,
                cases_on_pallet: scan.cases_on_pallet,
                actual_cases: scan.actual_cases,
                stock_code: scan.stock_code,
                description: scan.description,
                raw_code: scan.raw_code,
                device_id: scan.device_id,
                scanned_by: scan.scanned_by || 'Unknown'
            });
            return !error;
        }
        return false;
    },

    async checkDuplicate(date, batchNumber, palletNumber) {
        if (this.mode === 'supabase') {
            const { data, error } = await supabase
                .from('stock_scans')
                .select('*')
                .eq('take_date', date)
                .eq('batch_number', batchNumber)
                .eq('pallet_number', palletNumber)
                .limit(1)
                .single();
            return error ? null : data;
        }
        return null;
    },

    async deleteStockScan(id) {
        if (this.mode === 'supabase') {
            const { error } = await supabase.from('stock_scans').delete().eq('id', id);
            return !error;
        }
        return false;
    }
};

// Local storage fallback
const localStorage_db = {
    get: (key) => {
        const value = localStorage.getItem(key);
        return value ? JSON.parse(value) : null;
    },
    set: (key, value) => {
        localStorage.setItem(key, JSON.stringify(value));
    },
    delete: (key) => {
        localStorage.removeItem(key);
    },
    list: (prefix) => {
        return Object.keys(localStorage)
            .filter(k => k.startsWith(prefix))
            .map(k => {
                const val = localStorage.getItem(k);
                return val ? JSON.parse(val) : null;
            })
            .filter(Boolean);
    }
};

const clearLocalScanStorage = () => {
    Object.keys(localStorage)
        .filter(key => key.startsWith('scan:'))
        .forEach(key => localStorage.removeItem(key));
};


// Generate device ID
const DEVICE_ID = localStorage.getItem('deviceId') || (() => {
    const id = 'device_' + Math.random().toString(36).substring(2, 15);
    localStorage.setItem('deviceId', id);
    return id;
})();

// Get/set user name
const getUserName = () => localStorage.getItem('userName') || '';
const setUserName = (name) => localStorage.setItem('userName', name);

// Warehouse location for all users (PSA or PML)
// Checks localStorage first, then Supabase cache
const getUserWarehouse = () => {
    const localWarehouse = localStorage.getItem('userWarehouse');
    if (localWarehouse) return localWarehouse;

    // Check Supabase cached user data
    // Note: cachedUserData is likely defined in another file, but we should probably define it here or handle it
    // For now assuming it's available or we need to move it here
    if (window.cachedUserData && window.cachedUserData.name?.toLowerCase() === getUserName()?.toLowerCase()) {
        return window.cachedUserData.warehouse || '';
    }

    return '';
};
const setUserWarehouse = (warehouse) => localStorage.setItem('userWarehouse', warehouse);

// Role detection based on name suffix (temporary for testing)
// *** = admin (full access)
// * = supervisor (can create sessions, see own session history)
// no suffix = operator (basic scanning only)
const getUserRole = () => {
    const name = getUserName();

    if (window.cachedUserData && window.cachedUserData.name?.toLowerCase() === name?.toLowerCase()) {
        return window.cachedUserData.role || 'operator';
    }

    if (name.endsWith('***')) return 'admin';
    if (name.endsWith('*')) return 'supervisor';
    return 'operator';
};

const getDisplayName = () => {
    const name = getUserName();
    if (window.cachedUserData && window.cachedUserData.name?.toLowerCase() === name?.toLowerCase()) {
        return window.cachedUserData.display_name || name;
    }
    return name.replace(/\*+$/, '').trim();
};

const canCreateSession = () => ['admin', 'supervisor'].includes(getUserRole());
const canViewSettings = () => getUserRole() === 'admin';
const canViewHistory = () => ['admin', 'supervisor'].includes(getUserRole());
const canViewProductDatabase = () => getUserRole() === 'admin';
const userNeedsWarehouse = () => {
    const role = getUserRole();
    if (role === 'admin') return false;
    return !getUserWarehouse();
};
