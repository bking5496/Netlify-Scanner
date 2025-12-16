// ===========================================
// WAREHOUSE LOCATIONS DATABASE
// ===========================================

// Cache for warehouse locations
let warehouseLocationsCache = JSON.parse(localStorage.getItem('warehouseLocationsCache') || '[]');
let locationsLoadedFromDB = false;

// Load warehouse locations from Supabase
let _locationsLoadPromise = null;
async function loadLocationsFromSupabase(forceReload = false) {
    if (_locationsLoadPromise && !forceReload) return _locationsLoadPromise;
    if (locationsLoadedFromDB && !forceReload) return true;
    if (!supabase) {
        console.log('Supabase not available, using cached locations');
        return false;
    }

    _locationsLoadPromise = (async () => {
        try {
            console.log('Loading warehouse locations from Supabase...');
            const { data, error } = await supabase
                .from('warehouse_locations')
                .select('*')
                .eq('is_active', true)
                .order('location_code', { ascending: true });

            if (error) {
                console.error('Error loading locations:', error);
                return false;
            }

            if (data) {
                warehouseLocationsCache = data;
                localStorage.setItem('warehouseLocationsCache', JSON.stringify(data));
                locationsLoadedFromDB = true;
                console.log(`Loaded ${data.length} warehouse locations from Supabase`);
                return true;
            }
            return false;
        } catch (err) {
            console.error('Failed to load locations from Supabase:', err);
            return false;
        }
    })();

    return _locationsLoadPromise;
}

// Get all locations (from cache)
function getWarehouseLocations(warehouse = null) {
    let locations = warehouseLocationsCache;
    if (warehouse) {
        locations = locations.filter(l => l.warehouse === warehouse || !l.warehouse);
    }
    return locations;
}

// Get location by code
function getLocationByCode(code) {
    return warehouseLocationsCache.find(l => l.location_code === code.toUpperCase());
}

// Add a new warehouse location to Supabase
async function addLocationToSupabase(locationData) {
    if (!supabase) return { success: false, error: 'Supabase not available' };

    try {
        const locationCode = locationData.location_code.toUpperCase();

        // Check if already exists
        const existing = getLocationByCode(locationCode);
        if (existing) {
            return { success: false, error: 'Location already exists', exists: true };
        }

        const { data, error } = await supabase
            .from('warehouse_locations')
            .insert({
                location_code: locationCode,
                location_type: locationData.location_type,
                rack_number: locationData.rack_number || null,
                rack_face: locationData.rack_face || null,
                rack_row: locationData.rack_row || null,
                rack_column: locationData.rack_column || null,
                floor_zone: locationData.floor_zone || null,
                warehouse: locationData.warehouse || null,
                description: locationData.description || null,
                created_by: getUserName() || 'Unknown'
            })
            .select()
            .single();

        if (error) {
            console.error('Error adding location:', error);
            return { success: false, error: error.message };
        }

        // Update cache
        warehouseLocationsCache.push(data);
        localStorage.setItem('warehouseLocationsCache', JSON.stringify(warehouseLocationsCache));

        return { success: true, data };
    } catch (err) {
        console.error('Failed to add location:', err);
        return { success: false, error: err.message };
    }
}

// Update a warehouse location
async function updateLocationInSupabase(id, updates) {
    if (!supabase) return { success: false, error: 'Supabase not available' };

    try {
        const { data, error } = await supabase
            .from('warehouse_locations')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            console.error('Error updating location:', error);
            return { success: false, error: error.message };
        }

        // Update cache
        const idx = warehouseLocationsCache.findIndex(l => l.id === id);
        if (idx >= 0) {
            warehouseLocationsCache[idx] = data;
            localStorage.setItem('warehouseLocationsCache', JSON.stringify(warehouseLocationsCache));
        }

        return { success: true, data };
    } catch (err) {
        console.error('Failed to update location:', err);
        return { success: false, error: err.message };
    }
}

// Delete (deactivate) a warehouse location
async function deleteLocationFromSupabase(id) {
    if (!supabase) return { success: false, error: 'Supabase not available' };

    try {
        // Soft delete by setting is_active to false
        const { error } = await supabase
            .from('warehouse_locations')
            .update({ is_active: false })
            .eq('id', id);

        if (error) {
            console.error('Error deleting location:', error);
            return { success: false, error: error.message };
        }

        // Remove from cache
        warehouseLocationsCache = warehouseLocationsCache.filter(l => l.id !== id);
        localStorage.setItem('warehouseLocationsCache', JSON.stringify(warehouseLocationsCache));

        return { success: true };
    } catch (err) {
        console.error('Failed to delete location:', err);
        return { success: false, error: err.message };
    }
}

// Bulk add locations to Supabase
async function bulkAddLocationsToSupabase(locations) {
    if (!supabase) return { success: false, error: 'Supabase not available', added: 0, skipped: 0 };

    try {
        // Get existing location codes
        const existingCodes = new Set(warehouseLocationsCache.map(l => l.location_code));

        // Filter out duplicates
        const newLocations = locations.filter(l => !existingCodes.has(l.location_code.toUpperCase()));
        const skippedCount = locations.length - newLocations.length;

        if (newLocations.length === 0) {
            return { success: true, added: 0, skipped: skippedCount, message: 'All locations already exist' };
        }

        const { data, error } = await supabase
            .from('warehouse_locations')
            .insert(newLocations.map(l => ({
                location_code: l.location_code.toUpperCase(),
                location_type: l.location_type,
                rack_number: l.rack_number || null,
                rack_face: l.rack_face || null,
                rack_row: l.rack_row || null,
                rack_column: l.rack_column || null,
                floor_zone: l.floor_zone || null,
                warehouse: l.warehouse || null,
                description: l.description || null,
                created_by: getUserName() || 'Unknown'
            })))
            .select();

        if (error) {
            console.error('Error bulk adding locations:', error);
            return { success: false, error: error.message, added: 0, skipped: skippedCount };
        }

        // Update cache
        warehouseLocationsCache.push(...(data || []));
        localStorage.setItem('warehouseLocationsCache', JSON.stringify(warehouseLocationsCache));

        return { success: true, added: newLocations.length, skipped: skippedCount };
    } catch (err) {
        console.error('Failed to bulk add locations:', err);
        return { success: false, error: err.message, added: 0, skipped: 0 };
    }
}
