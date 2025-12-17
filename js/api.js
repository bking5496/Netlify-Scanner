// ===========================================
// API LOGIC (Logging, Users, Products, Sessions)
// ===========================================

// Log client event to supabaseClient
async function logClientEvent(eventType, severity = 'info', sessionId = null, payload = {}) {
    if (!supabaseClient) return;
    try {
        await supabaseClient.rpc('log_event', {
            p_event_type: eventType,
            p_severity: severity,
            p_session_id: sessionId,
            p_device_id: DEVICE_ID,
            p_payload: payload
        });
    } catch (err) {
        const unauthorized = err?.code === 'PGRST301' || err?.code === '401' || /Unauthorized/i.test(err?.message || '');
        if (unauthorized) {
            console.debug('log_event skipped (unauthorized)');
        } else {
            console.warn('log_event failed', err);
        }
    }
}

// ===========================================
// supabaseClient USER & DEVICE SYNC
// ===========================================

// Cache for user data from supabaseClient
window.cachedUserData = null;
window.userDataLastFetched = null;
const USER_CACHE_TTL_MS = 60000; // 1 minute cache

// Sync current user to supabaseClient
const syncUserToSupabase = async (name, role, warehouse) => {
    if (!supabaseClient || db.mode !== 'supabaseClient') return null;

    try {
        const displayName = name.replace(/\*+$/, '').trim();
        const { data, error } = await supabaseClient.rpc('upsert_app_user', {
            p_name: name,
            p_display_name: displayName,
            p_role: role,
            p_warehouse: warehouse || null
        });

        if (error) {
            console.warn('Failed to sync user to supabaseClient:', error);
            return null;
        }

        // Update cache
        cachedUserData = data;
        userDataLastFetched = Date.now();

        return data;
    } catch (err) {
        console.error('Error syncing user:', err);
        return null;
    }
};

// Sync current device to supabaseClient
const syncDeviceToSupabase = async () => {
    if (!supabaseClient || db.mode !== 'supabaseClient') return null;

    try {
        const userName = getUserName();
        const platform = detectPlatform();
        const userAgent = navigator.userAgent;

        const { data, error } = await supabaseClient.rpc('upsert_app_device', {
            p_device_id: DEVICE_ID,
            p_user_name: userName || null,
            p_platform: platform,
            p_user_agent: userAgent,
            p_metadata: { screenWidth: window.innerWidth, screenHeight: window.innerHeight }
        });

        if (error) {
            console.warn('Failed to sync device to supabaseClient:', error);
            return null;
        }

        return data;
    } catch (err) {
        console.error('Error syncing device:', err);
        return null;
    }
};

// Detect platform from user agent
const detectPlatform = () => {
    const ua = navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua)) return 'iOS';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Mac/.test(ua)) return 'macOS';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Unknown';
};

// Get user data from supabaseClient (with caching)
const getUserFromSupabase = async (name) => {
    if (!supabaseClient || db.mode !== 'supabaseClient') return null;

    // Check cache
    if (cachedUserData && userDataLastFetched &&
        (Date.now() - userDataLastFetched) < USER_CACHE_TTL_MS &&
        cachedUserData.name?.toLowerCase() === name?.toLowerCase()) {
        return cachedUserData;
    }

    try {
        const { data, error } = await supabaseClient.rpc('get_user_by_name', { p_name: name });

        if (error) {
            console.warn('Failed to get user from supabaseClient:', error);
            return null;
        }

        // Update cache
        cachedUserData = data;
        userDataLastFetched = Date.now();

        return data;
    } catch (err) {
        console.error('Error getting user:', err);
        return null;
    }
};

// Get user role from supabaseClient (fallback to name suffix)
const getUserRoleFromSupabase = async (name) => {
    if (!name) return 'operator';

    // Try supabaseClient first
    const userData = await getUserFromSupabase(name);
    if (userData?.role) {
        return userData.role;
    }

    // Fallback to name suffix detection
    if (name.endsWith('***')) return 'admin';
    if (name.endsWith('*')) return 'supervisor';
    return 'operator';
};

// List all users from supabaseClient (for admin)
const listUsersFromSupabase = async (warehouse = null) => {
    if (!supabaseClient || db.mode !== 'supabaseClient') return [];

    try {
        const { data, error } = await supabaseClient.rpc('list_app_users', {
            p_warehouse: warehouse
        });

        if (error) {
            console.warn('Failed to list users from supabaseClient:', error);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error('Error listing users:', err);
        return [];
    }
};

// List all devices from supabaseClient (for admin)
const listDevicesFromSupabase = async (activeOnly = true) => {
    if (!supabaseClient || db.mode !== 'supabaseClient') return [];

    try {
        const { data, error } = await supabaseClient.rpc('list_app_devices', {
            p_active_only: activeOnly
        });

        if (error) {
            console.warn('Failed to list devices from supabaseClient:', error);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error('Error listing devices:', err);
        return [];
    }
};

// ===========================================
// PRODUCT DATA
// ===========================================

// Local Caches (globals)
window.productDatabase = JSON.parse(localStorage.getItem('productDatabase') || '{}');
window.productsLoadedFromDB = false;
window.rawMaterialsDatabase = JSON.parse(localStorage.getItem('rawMaterialsDatabase') || '{}');
window.rmProductsLoadedFromDB = false;
window.productTypeDatabase = JSON.parse(localStorage.getItem('productTypeDatabase') || '{}');
window.productTypesLoadedFromDB = false;

// Load FP products from supabaseClient
let _productsLoadPromise = null;
async function loadProductsFromSupabase(forceReload = false) {
    if (_productsLoadPromise && !forceReload) return _productsLoadPromise;
    if (productsLoadedFromDB && !forceReload) return true;
    if (!supabaseClient) {
        console.log('supabaseClient not available, using cached products');
        return false;
    }

    _productsLoadPromise = (async () => {
        try {
            console.log('Loading FP products from supabaseClient...');
            const { data, error } = await supabaseClient
                .from('products')
                .select('batch_number,stock_code,description');

            if (error) {
                console.error('Error loading products:', error);
                return false;
            }

            if (data && data.length > 0) {
                productDatabase = {};
                data.forEach(product => {
                    const batchNum = product.batch_number;
                    const stockCode = product.stock_code;
                    const description = product.description;
                    if (batchNum) {
                        productDatabase[batchNum] = {
                            stockCode: stockCode || '',
                            description: description || ''
                        };
                    }
                });
                localStorage.setItem('productDatabase', JSON.stringify(productDatabase));
                productsLoadedFromDB = true;
                console.log(`Loaded ${Object.keys(productDatabase).length} FP products from supabaseClient`);
                return true;
            }
            return false;
        } catch (err) {
            console.error('Failed to load products from supabaseClient:', err);
            return false;
        }
    })();
    return _productsLoadPromise;
}

// Load RM products from supabaseClient
let _rmProductsLoadPromise = null;
async function loadRawMaterialsFromSupabase(forceReload = false) {
    if (_rmProductsLoadPromise && !forceReload) return _rmProductsLoadPromise;
    if (rmProductsLoadedFromDB && !forceReload) return true;
    if (!supabaseClient) {
        console.log('supabaseClient not available, using cached raw materials');
        return false;
    }

    _rmProductsLoadPromise = (async () => {
        try {
            console.log('Loading RM products from supabaseClient...');
            const { data, error } = await supabaseClient.from('raw_materials').select('*');

            if (error) {
                console.error('Error loading raw materials:', error);
                return false;
            }

            if (data && data.length > 0) {
                rawMaterialsDatabase = {};
                data.forEach(product => {
                    const stockCode = product.stock_code;
                    const description = product.description;
                    const batchNumber = product.batch_number;
                    const expiryDate = product.expiry_date;

                    if (stockCode) {
                        if (!rawMaterialsDatabase[stockCode]) {
                            rawMaterialsDatabase[stockCode] = {
                                description: description || '',
                                batches: {}
                            };
                        }
                        if (batchNumber) {
                            if (!rawMaterialsDatabase[stockCode].batches[batchNumber]) {
                                rawMaterialsDatabase[stockCode].batches[batchNumber] = {
                                    expiryDates: []
                                };
                            }
                            if (expiryDate && !rawMaterialsDatabase[stockCode].batches[batchNumber].expiryDates.includes(expiryDate)) {
                                rawMaterialsDatabase[stockCode].batches[batchNumber].expiryDates.push(expiryDate);
                            }
                        }
                    }
                });
                localStorage.setItem('rawMaterialsDatabase', JSON.stringify(rawMaterialsDatabase));
                rmProductsLoadedFromDB = true;
                console.log(`Loaded ${Object.keys(rawMaterialsDatabase).length} RM products from supabaseClient`);
                return true;
            }
            return false;
        } catch (err) {
            console.error('Failed to load raw materials from supabaseClient:', err);
            return false;
        }
    })();
    return _rmProductsLoadPromise;
}

// Load product types from supabaseClient
let _productTypesLoadPromise = null;
async function loadProductTypesFromSupabase(forceReload = false) {
    if (_productTypesLoadPromise && !forceReload) return _productTypesLoadPromise;
    if (productTypesLoadedFromDB && !forceReload) return true;
    if (!supabaseClient) {
        console.log('supabaseClient not available, using cached product types');
        return false;
    }

    _productTypesLoadPromise = (async () => {
        try {
            console.log('Loading product types from supabaseClient...');
            const { data, error } = await supabaseClient
                .from('product_types')
                .select('type,stock_code,description');

            if (error) {
                console.error('Error loading product types:', error);
                return false;
            }

            if (data && data.length > 0) {
                productTypeDatabase = {};
                data.forEach(item => {
                    const stockCode = (item.stock_code || '').toUpperCase();
                    const productType = item.type || 'Non-Ingredient';
                    const description = item.description || '';
                    if (stockCode) {
                        const isIngredient = productType.toLowerCase().startsWith('ingredient');
                        productTypeDatabase[stockCode] = {
                            productType: productType,
                            description: description,
                            unitType: isIngredient ? 'kg' : 'units'
                        };
                    }
                });
                localStorage.setItem('productTypeDatabase', JSON.stringify(productTypeDatabase));
                productTypesLoadedFromDB = true;
                console.log(`Loaded ${Object.keys(productTypeDatabase).length} product types from supabaseClient`);
                return true;
            }
            return false;
        } catch (err) {
            console.error('Failed to load product types from supabaseClient:', err);
            return false;
        }
    })();
    return _productTypesLoadPromise;
}

// Live duplicate check against supabaseClient
async function checkDuplicateInSupabase(sessionId, sessionType, batchNumber, stockCode, expiryDate = null, palletNumber = null) {
    if (!supabaseClient || !sessionId) return null;

    try {
        const cleanBatch = String(batchNumber).trim();
        let query = supabaseClient
            .from('stock_scans')
            .select('id,scanned_at,scanned_by,device_id,actual_cases')
            .eq('session_id', sessionId)
            .eq('batch_number', cleanBatch);

        if (sessionType === 'RM') {
            query = query.eq('stock_code', stockCode);
            if (expiryDate) {
                query = query.eq('expiry_date', expiryDate);
            }
        } else {
            if (palletNumber) {
                const cleanPallet = String(palletNumber).trim();
                query = query.eq('pallet_number', cleanPallet);
            }
        }

        const { data, error } = await query.limit(1);

        if (error) {
            console.error('Error checking duplicate:', error);
            return null;
        }
        if (data && data.length > 0) {
            await logClientEvent('duplicate-detected', 'warning', sessionId, {
                batchNumber,
                stockCode,
                sessionType
            });
            return data[0];
        }
        return null;
    } catch (err) {
        console.error('Failed to check duplicate in supabaseClient:', err);
        return null;
    }
}

async function checkRMDuplicateQuantity(sessionId, stockCode, batchNumber, expiryDate, quantity) {
    if (!supabaseClient || !sessionId) return null;

    try {
        let query = supabaseClient
            .from('stock_scans')
            .select('id,scanned_at,scanned_by,device_id,actual_cases,location')
            .eq('session_id', sessionId)
            .eq('stock_code', stockCode)
            .eq('batch_number', batchNumber)
            .eq('actual_cases', quantity);

        if (expiryDate) {
            query = query.eq('expiry_date', expiryDate);
        }

        const { data, error } = await query.limit(1);

        if (error) {
            console.error('Error checking RM duplicate quantity:', error);
            return null;
        }

        if (data && data.length > 0) {
            return data[0];
        }
        return null;
    } catch (err) {
        console.error('Failed to check RM duplicate quantity:', err);
        return null;
    }
}

async function checkFPManualDuplicateQuantity(sessionId, batchNumber, quantity) {
    if (!supabaseClient || !sessionId) return null;

    try {
        const cleanBatch = String(batchNumber).trim();
        const { data, error } = await supabaseClient
            .from('stock_scans')
            .select('id,scanned_at,scanned_by,device_id,actual_cases,pallet_number')
            .eq('session_id', sessionId)
            .eq('batch_number', cleanBatch)
            .eq('actual_cases', quantity)
            .is('pallet_number', null)
            .limit(1);

        if (error) {
            console.error('Error checking FP manual duplicate quantity:', error);
            return null;
        }

        if (data && data.length > 0) {
            return data[0];
        }
        return null;
    } catch (err) {
        console.error('Failed to check FP manual duplicate quantity:', err);
        return null;
    }
}

function saveProductDatabase() {
    localStorage.setItem('productDatabase', JSON.stringify(productDatabase));
    if (supabaseClient && productsLoadedFromDB) {
        console.log('Product database saved locally');
    }
}

function saveRawMaterialsDatabase() {
    localStorage.setItem('rawMaterialsDatabase', JSON.stringify(rawMaterialsDatabase));
    if (supabaseClient && rmProductsLoadedFromDB) {
        console.log('Raw materials database saved locally');
    }
}

async function addProductToSupabase(batchNumber, stockCode, description) {
    if (!supabaseClient) return false;
    try {
        const { error } = await supabaseClient
            .from('products')
            .upsert({
                batch_number: batchNumber,
                stock_code: stockCode,
                description: description
            }, { onConflict: 'batch_number' });
        return !error;
    } catch (err) {
        console.error('Failed to add product to supabaseClient:', err);
        return false;
    }
}

async function addRawMaterialToSupabase(stockCode, description, batchNumber, expiryDate) {
    if (!supabaseClient) return false;
    const formattedExpiry = convertDMYtoYMD(expiryDate);
    try {
        const { data: existing } = await supabaseClient
            .from('raw_materials')
            .select('id')
            .eq('stock_code', stockCode)
            .eq('batch_number', batchNumber || '')
            .eq('expiry_date', formattedExpiry || null)
            .maybeSingle();

        if (existing) return true;

        const { error } = await supabaseClient
            .from('raw_materials')
            .insert({
                stock_code: stockCode,
                description: description,
                batch_number: batchNumber || null,
                expiry_date: formattedExpiry || null
            });
        return !error;
    } catch (err) {
        console.error('Failed to add raw material to supabaseClient:', err);
        return false;
    }
}

async function addProductTypeToSupabase(stockCode, productType, description) {
    if (!supabaseClient) return { success: false, error: 'supabaseClient not available' };
    try {
        const { data: existing, error: checkError } = await supabaseClient
            .from('product_types')
            .select('stock_code')
            .eq('stock_code', stockCode.toUpperCase())
            .maybeSingle();

        if (checkError) return { success: false, error: checkError.message };
        if (existing) return { success: false, error: 'Product already exists', exists: true };

        const { error } = await supabaseClient
            .from('product_types')
            .insert({
                stock_code: stockCode.toUpperCase(),
                type: productType,
                description: description
            });

        if (error) return { success: false, error: error.message };

        productTypeDatabase[stockCode.toUpperCase()] = {
            productType: productType,
            description: description,
            unitType: productType.toLowerCase() === 'ingredient' ? 'kg' : 'units'
        };
        localStorage.setItem('productTypeDatabase', JSON.stringify(productTypeDatabase));

        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function bulkAddProductTypesToSupabase(products) {
    if (!supabaseClient) return { success: false, error: 'supabaseClient not available', added: 0, skipped: 0 };

    try {
        const { data: existing, error: fetchError } = await supabaseClient.from('product_types').select('stock_code');
        if (fetchError) return { success: false, error: fetchError.message, added: 0, skipped: 0 };

        const existingCodes = new Set((existing || []).map(p => p.stock_code?.toUpperCase()));
        const newProducts = products.filter(p => !existingCodes.has(p.stock_code?.toUpperCase()));
        const skippedCount = products.length - newProducts.length;

        if (newProducts.length === 0) return { success: true, added: 0, skipped: skippedCount, message: 'All products already exist' };

        const { error: insertError } = await supabaseClient
            .from('product_types')
            .insert(newProducts.map(p => ({
                stock_code: p.stock_code?.toUpperCase(),
                type: p.type || 'Non-Ingredient',
                description: p.description || ''
            })));

        if (insertError) return { success: false, error: insertError.message, added: 0, skipped: skippedCount };

        newProducts.forEach(p => {
            const stockCode = p.stock_code?.toUpperCase();
            productTypeDatabase[stockCode] = {
                productType: p.type || 'Non-Ingredient',
                description: p.description || '',
                unitType: (p.type || '').toLowerCase() === 'ingredient' ? 'kg' : 'units'
            };
        });
        localStorage.setItem('productTypeDatabase', JSON.stringify(productTypeDatabase));
        await loadProductTypesFromSupabase(true);
        return { success: true, added: newProducts.length, skipped: skippedCount };
    } catch (err) {
        return { success: false, error: err.message, added: 0, skipped: 0 };
    }
}


// ===========================================
// LIVE SESSIONS FROM supabaseClient
// ===========================================

// Get all live (active/paused) sessions from supabaseClient
const getLiveSessionsFromSupabase = async (warehouse = null) => {
    if (!supabaseClient || db.mode !== 'supabaseClient') return [];

    try {
        const { data, error } = await supabaseClient.rpc('get_live_sessions', {
            p_warehouse: warehouse
        });

        if (error) {
            console.warn('Failed to get live sessions from supabaseClient:', error);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error('Error getting live sessions:', err);
        return [];
    }
};

// Get session summary with device info and scan counts
const getSessionSummaryFromSupabase = async (sessionId) => {
    if (!supabaseClient || db.mode !== 'supabaseClient' || !sessionId) return null;

    try {
        const { data, error } = await supabaseClient.rpc('get_session_summary', {
            p_session_id: sessionId
        });

        if (error) {
            console.warn('Failed to get session summary from supabaseClient:', error);
            return null;
        }

        return data?.[0] || null;
    } catch (err) {
        console.error('Error getting session summary:', err);
        return null;
    }
};

// End a session via supabaseClient (supervisor action)
const endSessionInSupabase = async (sessionId, endedBy = null) => {
    if (!supabaseClient || db.mode !== 'supabaseClient' || !sessionId) return null;

    try {
        const { data, error } = await supabaseClient.rpc('end_session', {
            p_session_id: sessionId,
            p_ended_by: endedBy || getUserName(),
            p_device_id: DEVICE_ID
        });

        if (error) {
            console.warn('Failed to end session in supabaseClient:', error);
            return null;
        }

        return data;
    } catch (err) {
        console.error('Error ending session:', err);
        return null;
    }
};
