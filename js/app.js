class ScannerApp {
    constructor() {
        this.scans = [];
        this.scanner = null;
        this.preferredCameraId = null;
        this.isScanning = false;
        this.currentScan = null;
        this.showingCaseEntry = false;
        this.showingProductDB = false;
        this.showingRMProductDB = false;
        this.showingSettings = false;
        this.showingStartStockTake = false;
        this.showingExpirySelection = false;
        this.showingSessionHistory = false;
        this.showingWarehouseSetup = false;
        this.showingLocationPicker = false;
        this.showingLocationManagement = false; // Location management page
        this.showingQRGenerator = false; // QR code generator page
        this.showingSessionDashboard = false; // Admin session dashboard
        this.dashboardSessions = []; // Sessions data for dashboard
        this.dashboardLoading = false; // Loading state for dashboard
        this.activeLocation = null; // Current scanned location (e.g., RACK-01-F-A-3)
        this.selectedRackForPicker = null;
        this.selectedStockTakeType = null; // 'FP' or 'RM' - selected before session
        this.historySessions = [];
        this.historyScans = [];
        this.historyLoading = false; // Loading state for session history
        this.selectedHistorySession = null;
        this.pendingScan = null;
        this.pendingScanKeys = new Set(); // Track scans being processed to prevent double-capture
        this.currentTakeDate = new Date().toISOString().split('T')[0];
        this.syncInterval = null;
        this.heartbeatInterval = null;
        this.lastHeartbeatAt = 0;
        this.hasPrefetchedReferenceData = false;
        this.activeStockTake = getActiveStockTake();
        this.sessionSettings = getSessionSettings();
        this.lastSessionSync = 0;
        this.isBrowserOnline = navigator.onLine;

        // Modal State
        this.modalState = null; // { title, message, type, fields, onConfirm, onCancel, confirmText, cancelText }

        // Performance optimization
        this._renderScheduled = false;
        this._lastRenderTime = 0;
        this._renderDebounceMs = 16; // ~60fps max
        this._pendingRender = false; // True when render was skipped during input and needs to happen later

        this.init();
    }

    get usingSupabaseDB() {
        return db.mode === 'supabaseClient';
    }

    toggleLocationScanning() {
        this.sessionSettings.locationScanningEnabled = !this.sessionSettings.locationScanningEnabled;
        if (!this.sessionSettings.locationScanningEnabled) {
            this.sessionSettings.currentLocation = '';
            this.sessionSettings.site = '';
            this.sessionSettings.aisle = '';
            this.sessionSettings.rack = '';
        }
        saveSessionSettings(this.sessionSettings);
        this.render();
    }

    setLocation(location) {
        this.sessionSettings.currentLocation = location;
        saveSessionSettings(this.sessionSettings);
        this.render();
    }

    updateLocationHierarchy(level, value) {
        if (!['site', 'aisle', 'rack'].includes(level)) return;
        this.sessionSettings[level] = value;
        saveSessionSettings(this.sessionSettings);
        // Don't re-render here - it causes the input to lose focus
        // The value is already saved, and the UI will update on next render
    }

    // ===== WAREHOUSE LOCATION SYSTEM =====

    showWarehouseSetup() {
        this.showingWarehouseSetup = true;
        this.render();
    }

    hideWarehouseSetup() {
        this.showingWarehouseSetup = false;
        this.render();
    }

    addRack() {
        this.showModal({
            title: '➕ Add New Rack',
            message: 'Configure the rack dimensions:',
            type: 'form',
            fields: [
                { name: 'name', label: 'Rack Name', placeholder: 'e.g., RACK01, A1', required: true },
                { name: 'columns', label: 'Columns (left to right)', type: 'number', value: '5', placeholder: '5', required: true },
                { name: 'levels', label: 'Levels (bottom to top)', type: 'number', value: '4', placeholder: '4', required: true }
            ],
            confirmText: 'Add Rack',
            onConfirm: (data) => {
                const name = data.name?.trim().toUpperCase();
                const columns = parseInt(data.columns) || 5;
                const levels = parseInt(data.levels) || 4;

                if (!name) {
                    alert('Rack name is required');
                    return;
                }

                if (!this.sessionSettings.warehouseConfig) {
                    this.sessionSettings.warehouseConfig = { name: 'Main Warehouse', racks: [], floorLocations: [] };
                }
                if (!this.sessionSettings.warehouseConfig.racks) {
                    this.sessionSettings.warehouseConfig.racks = [];
                }

                // Check for duplicate
                if (this.sessionSettings.warehouseConfig.racks.some(r => r.name === name)) {
                    alert('A rack with this name already exists');
                    return;
                }

                this.sessionSettings.warehouseConfig.racks.push({
                    id: 'rack_' + Date.now(),
                    name: name,
                    columns: columns,
                    levels: levels
                });

                saveSessionSettings(this.sessionSettings);
                this.render();
            }
        });
    }

    deleteRack(rackId) {
        if (!confirm('Delete this rack?')) return;

        if (this.sessionSettings.warehouseConfig?.racks) {
            this.sessionSettings.warehouseConfig.racks = this.sessionSettings.warehouseConfig.racks.filter(r => r.id !== rackId);
            saveSessionSettings(this.sessionSettings);
            this.render();
        }
    }

    editRack(rackId) {
        const rack = this.sessionSettings.warehouseConfig?.racks?.find(r => r.id === rackId);
        if (!rack) return;

        this.showModal({
            title: 'Edit Rack',
            content: `
                <div class="space-y-4">
                    <div>
                        <label class="block text-sm font-medium text-slate-700 mb-1">Rack Name</label>
                        <input type="text" id="edit-rack-name" value="${rack.name}" required maxlength="5" class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all font-bold text-slate-900 placeholder:font-normal uppercase">
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-slate-700 mb-1">Levels (Up)</label>
                            <input type="number" id="edit-rack-levels" value="${rack.levels}" min="1" max="10" required class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all font-bold text-slate-900">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-slate-700 mb-1">Positions (Across)</label>
                            <input type="number" id="edit-rack-columns" value="${rack.columns}" min="1" max="20" required class="w-full px-4 py-3 rounded-xl border border-slate-200 focus:border-blue-500 focus:ring-2 focus:ring-blue-200 transition-all font-bold text-slate-900">
                        </div>
                    </div>
                </div>
            `,
            confirmText: 'Save Changes',
            onConfirm: () => {
                const nameInput = document.getElementById('edit-rack-name');
                const levelsInput = document.getElementById('edit-rack-levels');
                const columnsInput = document.getElementById('edit-rack-columns');

                if (!nameInput || !levelsInput || !columnsInput) return;

                const name = nameInput.value.trim().toUpperCase();
                const levels = parseInt(levelsInput.value);
                const columns = parseInt(columnsInput.value);

                if (name && levels > 0 && columns > 0) {
                    rack.name = name;
                    rack.levels = levels;
                    rack.columns = columns;

                    saveSessionSettings(this.sessionSettings);
                    this.render();
                } else {
                    alert('Please fill in all fields correctly.');
                    return false; // Prevent modal closing
                }
            }
        });
    }

    addFloorLocation() {
        this.showModal({
            title: '➕ Add Floor Location',
            message: 'Enter floor location name:',
            type: 'input',
            confirmText: 'Add',
            onConfirm: (data) => {
                const name = data.value?.trim().toUpperCase();
                if (!name) {
                    alert('Name is required');
                    return;
                }

                if (!this.sessionSettings.warehouseConfig) {
                    this.sessionSettings.warehouseConfig = { name: 'Main Warehouse', racks: [], floorLocations: [] };
                }
                if (!this.sessionSettings.warehouseConfig.floorLocations) {
                    this.sessionSettings.warehouseConfig.floorLocations = [];
                }

                if (this.sessionSettings.warehouseConfig.floorLocations.includes(name)) {
                    alert('This floor location already exists');
                    return;
                }

                this.sessionSettings.warehouseConfig.floorLocations.push(name);
                saveSessionSettings(this.sessionSettings);
                this.render();
            }
        });
    }

    deleteFloorLocation(name) {
        if (!confirm('Delete this floor location?')) return;

        if (this.sessionSettings.warehouseConfig?.floorLocations) {
            this.sessionSettings.warehouseConfig.floorLocations = this.sessionSettings.warehouseConfig.floorLocations.filter(f => f !== name);
            saveSessionSettings(this.sessionSettings);
            this.render();
        }
    }

    showLocationPicker() {
        this.showingLocationPicker = true;
        this.selectedRackForPicker = null;
        this.render();
    }

    hideLocationPicker() {
        this.showingLocationPicker = false;
        this.selectedRackForPicker = null;
        this.render();
    }

    showSettings() {
        this.showingSettings = true;
        this.render();
    }

    hideSettings() {
        this.showingSettings = false;
        this.render();
    }

    selectRackForPicker(rackId) {
        this.selectedRackForPicker = rackId;
        this.render();
    }

    selectRackPosition(rackId, level, position) {
        this.sessionSettings.selectedWarehouseLocation = {
            type: 'rack',
            rackId: rackId,
            level: level,
            position: position
        };
        this.sessionSettings.currentLocation = generateLocationCode(this.sessionSettings);
        saveSessionSettings(this.sessionSettings);
        this.hideLocationPicker();
    }

    selectFloorLocation(floorId) {
        this.sessionSettings.selectedWarehouseLocation = {
            type: 'floor',
            floorId: floorId
        };
        this.sessionSettings.currentLocation = generateLocationCode(this.sessionSettings);
        saveSessionSettings(this.sessionSettings);
        this.hideLocationPicker();
    }

    clearLocation() {
        this.activeLocation = null;
        this.sessionSettings.selectedWarehouseLocation = null;
        this.sessionSettings.currentLocation = '';
        this.sessionSettings.locationScanningEnabled = false;
        saveSessionSettings(this.sessionSettings);
        this.render();
    }

    // Show/hide Location Management page
    showLocationManagement() {
        this.showingLocationManagement = true;
        // Load locations from supabaseClient
        loadLocationsFromSupabase(true).then(() => this.render());
    }

    hideLocationManagement() {
        this.showingLocationManagement = false;
        this.render();
    }

    // Show/hide QR Generator page
    showQRGenerator() {
        this.showingQRGenerator = true;
        this._selectedLocationsForQR = new Set();
        // Ensure locations are loaded
        loadLocationsFromSupabase(true).then(() => this.render());
    }

    hideQRGenerator() {
        this.showingQRGenerator = false;
        this._selectedLocationsForQR = null;
        this.render();
    }

    // Show/hide Session Dashboard page (admin only)
    async showSessionDashboard() {
        this.showingSessionDashboard = true;
        this.dashboardLoading = true;
        this.render();

        // Fetch live sessions data
        await this.refreshDashboard();
    }

    hideSessionDashboard() {
        this.showingSessionDashboard = false;
        this.dashboardSessions = [];
        this.render();
    }

    async loadSessionHistory(sessionId) {
        this.showingSessionHistory = true;
        this.historyLoading = true;

        // Find session in local lists or create a placeholder
        const allSessions = [...(this.liveSessions || []), ...(this.historicalSessions || [])];
        this.selectedHistorySession = allSessions.find(s => s.id === sessionId) || { id: sessionId, warehouse: 'Unknown', sessionType: 'Unknown', date: 'Unknown' };

        this.render();

        try {
            this.historyScans = await this.getScansForSession(sessionId);
        } catch (e) {
            console.error(e);
            this.historyScans = [];
        } finally {
            this.historyLoading = false;
            this.render();
        }
    }

    hideSessionHistory() {
        this.showingSessionHistory = false;
        this.selectedHistorySession = null;
        this.render();
    }

    exportHistorySession() {
        if (!this.selectedHistorySession || !this.historyScans) return;
        this.exportToCSV(this.historyScans, `session_${this.selectedHistorySession.id}_${new Date().toISOString().split('T')[0]}.csv`);
    }

    async getScansForSession(sessionId) {
        if (!supabaseClient) return [];
        const { data, error } = await supabaseClient
            .from('scans')
            .select('*')
            .eq('session_id', sessionId)
            .order('created_at', { ascending: false });

        if (error) {
            console.warn('Error fetching scans:', error);
            return [];
        }
        return data || [];
    }

    exportToCSV(data, filename) {
        if (!data || !data.length) return;
        const headers = Object.keys(data[0]).join(',');
        const rows = data.map(row => Object.values(row).map(v => `"${v}"`).join(',')).join('\n');
        const csv = headers + '\n' + rows;
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
    }

    async refreshDashboard() {
        this.dashboardLoading = true;
        this.render();

        try {
            // Get all live sessions (no warehouse filter for admin view)
            const sessions = await getLiveSessionsFromSupabase(null);
            this.dashboardSessions = sessions || [];
        } catch (err) {
            console.error('Failed to load dashboard sessions:', err);
            this.dashboardSessions = [];
        }

        this.dashboardLoading = false;
        this.render();
    }

    // Toggle location selection for QR generation
    toggleLocationForQR(locationCode) {
        if (!this._selectedLocationsForQR) this._selectedLocationsForQR = new Set();
        if (this._selectedLocationsForQR.has(locationCode)) {
            this._selectedLocationsForQR.delete(locationCode);
        } else {
            this._selectedLocationsForQR.add(locationCode);
        }
        this.render();
    }

    // Select all locations for QR generation
    selectAllLocationsForQR() {
        // Build locations from session settings
        const warehouseConfig = this.sessionSettings.warehouseConfig || { racks: [], floorLocations: [] };
        const racks = warehouseConfig.racks || [];
        const floorLocations = warehouseConfig.floorLocations || [];

        const allCodes = [];

        // Add rack positions
        racks.forEach(rack => {
            const rackName = rack.name || rack.id;
            const columns = rack.columns || 1;
            const levels = rack.levels || 1;

            for (let level = 1; level <= levels; level++) {
                for (let col = 1; col <= columns; col++) {
                    const levelLetter = String.fromCharCode(64 + level);
                    allCodes.push(`${rackName}-${levelLetter}${col}`);
                }
            }
        });

        // Add floor locations
        floorLocations.forEach(floor => {
            allCodes.push(`FLOOR-${floor}`);
        });

        this._selectedLocationsForQR = new Set(allCodes);
        this.render();
    }

    // Clear all location selections
    clearLocationSelections() {
        this._selectedLocationsForQR = new Set();
        this.render();
    }

    // Generate and show QR codes for printing
    async generateQRCodes() {
        const selectedCodes = Array.from(this._selectedLocationsForQR || []);
        if (selectedCodes.length === 0) {
            alert('Please select at least one location');
            return;
        }

        // Generate QR codes and open print window
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            alert('Please allow pop-ups to print QR codes');
            return;
        }

        printWindow.document.write(`
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <title>Location QR Codes</title>
                        <style>
                            * { margin: 0; padding: 0; box-sizing: border-box; }
                            body { font-family: Arial, sans-serif; padding: 20px; }
                            .qr-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
                            .qr-item { 
                                border: 2px solid #333; 
                                padding: 15px; 
                                text-align: center;
                                page-break-inside: avoid;
                            }
                            .qr-code { width: 150px; height: 150px; margin: 0 auto 10px; }
                            .qr-label { font-size: 18px; font-weight: bold; }
                            .qr-type { font-size: 12px; color: #666; }
                            @media print {
                                .no-print { display: none; }
                                .qr-grid { gap: 10px; }
                            }
                        </style>
                        <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"><\/script>
                    </head>
                    <body>
                        <div class="no-print" style="margin-bottom: 20px;">
                            <button onclick="window.print()" style="padding: 10px 20px; font-size: 16px; cursor: pointer;">🖨️ Print QR Codes</button>
                            <button onclick="window.close()" style="padding: 10px 20px; font-size: 16px; cursor: pointer; margin-left: 10px;">Close</button>
                        </div>
                        <div class="qr-grid" id="qr-container"></div>
                        <script>
                            const locations = ${JSON.stringify(selectedCodes)};
                            const container = document.getElementById('qr-container');
                            
                            locations.forEach((code, index) => {
                                const item = document.createElement('div');
                                item.className = 'qr-item';
                                
                                const canvas = document.createElement('canvas');
                                canvas.className = 'qr-code';
                                canvas.id = 'qr-' + index;
                                
                                const label = document.createElement('div');
                                label.className = 'qr-label';
                                label.textContent = code;
                                
                                const type = document.createElement('div');
                                type.className = 'qr-type';
                                type.textContent = code.startsWith('RACK-') ? 'Pallet Rack' : 'Floor Space';
                                
                                item.appendChild(canvas);
                                item.appendChild(label);
                                item.appendChild(type);
                                container.appendChild(item);
                                
                                // Generate QR code
                                QRCode.toCanvas(canvas, code, { 
                                    width: 150,
                                    margin: 1,
                                    errorCorrectionLevel: 'H'
                                });
                            });
                        <\/script>
                    </body>
                    </html>
                `);
        printWindow.document.close();
    }

    // Add a new rack location via modal
    async addRackLocation() {
        this.showModal({
            title: '➕ Add Rack Location',
            message: 'Enter rack location details:',
            type: 'form',
            fields: [
                { name: 'rackNumber', label: 'Rack Number (01-99)', placeholder: '01', required: true },
                { name: 'face', label: 'Face', type: 'select', options: [{ value: 'F', label: 'Front' }, { value: 'B', label: 'Back' }], required: true },
                { name: 'row', label: 'Row (A-Z)', placeholder: 'A', required: true },
                { name: 'column', label: 'Column (1-99)', type: 'number', placeholder: '1', required: true },
                { name: 'warehouse', label: 'Warehouse', type: 'select', options: [{ value: 'PSA', label: 'PSA' }, { value: 'PML', label: 'PML' }] },
                { name: 'description', label: 'Description (optional)', placeholder: 'e.g., Aisle 1 near dock' }
            ],
            confirmText: 'Add Location',
            onConfirm: async (data) => {
                const rackNumber = String(data.rackNumber).padStart(2, '0');
                const face = data.face || 'F';
                const row = (data.row || 'A').toUpperCase();
                const column = parseInt(data.column) || 1;
                const locationCode = buildLocationCode('rack', { rackNumber, face, row, column });

                const result = await addLocationToSupabase({
                    location_code: locationCode,
                    location_type: 'rack',
                    rack_number: rackNumber,
                    rack_face: face,
                    rack_row: row,
                    rack_column: column,
                    warehouse: data.warehouse || null,
                    description: data.description || null
                });

                if (result.success) {
                    this.triggerHaptic('success');
                    this.render();
                } else {
                    alert(result.error || 'Failed to add location');
                }
            }
        });
    }

    // Add a new floor location via modal
    async addFloorLocationDB() {
        this.showModal({
            title: '➕ Add Floor Location',
            message: 'Enter floor location details:',
            type: 'form',
            fields: [
                { name: 'zone', label: 'Zone Code (e.g., A1)', placeholder: 'A1', required: true },
                { name: 'warehouse', label: 'Warehouse', type: 'select', options: [{ value: 'PSA', label: 'PSA' }, { value: 'PML', label: 'PML' }] },
                { name: 'description', label: 'Description (optional)', placeholder: 'e.g., Staging area' }
            ],
            confirmText: 'Add Location',
            onConfirm: async (data) => {
                const zone = (data.zone || '').toUpperCase();
                if (!zone) {
                    alert('Zone code is required');
                    return;
                }
                const locationCode = buildLocationCode('floor', { zone });

                const result = await addLocationToSupabase({
                    location_code: locationCode,
                    location_type: 'floor',
                    floor_zone: zone,
                    warehouse: data.warehouse || null,
                    description: data.description || null
                });

                if (result.success) {
                    this.triggerHaptic('success');
                    this.render();
                } else {
                    alert(result.error || 'Failed to add location');
                }
            }
        });
    }

    // Delete a location from the database
    async deleteLocationDB(id) {
        const confirmed = await new Promise(resolve => {
            this.showModal({
                title: 'Delete Location',
                message: 'Are you sure you want to delete this location?',
                type: 'confirm',
                confirmText: 'Delete',
                cancelText: 'Cancel',
                onConfirm: () => resolve(true),
                onCancel: () => resolve(false)
            });
        });

        if (!confirmed) return;

        const result = await deleteLocationFromSupabase(id);
        if (result.success) {
            this.triggerHaptic('heavy');
            this.render();
        } else {
            alert(result.error || 'Failed to delete location');
        }
    }

    // ===== END WAREHOUSE LOCATION SYSTEM =====

    promptForLocation() {
        // If warehouse config exists with racks or floor locations, use the picker
        const config = this.sessionSettings.warehouseConfig;
        if (config && (config.racks.length > 0 || config.floorLocations.length > 0)) {
            this.showLocationPicker();
        } else {
            // Fall back to manual text entry
            this.showModal({
                title: 'Set Location',
                message: 'Enter current location (e.g., Rack A1, Floor 1):',
                type: 'input',
                confirmText: 'Set Location',
                onConfirm: (data) => {
                    this.setLocation(data.value.trim());
                }
            });
            // Pre-fill value
            setTimeout(() => {
                const input = document.getElementById('modal-input');
                if (input) input.value = this.sessionSettings.currentLocation || '';
            }, 50);
        }
    }

    triggerHaptic(type = 'light') {
        if (!navigator.vibrate) return;
        const patterns = {
            success: [40, 20, 40],
            warning: [100, 50, 100],
            heavy: [200],
            light: [20]
        };
        navigator.vibrate(patterns[type] || patterns.light);
    }

    // Initialize swipe-to-delete on scan list items
    initSwipeToDelete() {
        const containers = document.querySelectorAll('.swipe-container');

        containers.forEach(container => {
            const item = container.querySelector('.swipe-item');
            const deleteAction = container.querySelector('.swipe-delete-action');
            if (!item || !deleteAction) return;

            let startX = 0;
            let currentX = 0;
            let isSwiping = false;
            const threshold = 50; // Minimum swipe distance to trigger
            const maxSwipe = 80; // Maximum swipe distance

            const handleTouchStart = (e) => {
                const touch = e.touches[0];
                startX = touch.clientX;
                currentX = startX;
                isSwiping = true;
                item.classList.add('swiping');
                item.classList.remove('swiped-left');
            };

            const handleTouchMove = (e) => {
                if (!isSwiping) return;

                const touch = e.touches[0];
                currentX = touch.clientX;
                const diff = startX - currentX;

                // Only allow left swipe
                if (diff > 0) {
                    const translateX = Math.min(diff, maxSwipe);
                    item.style.transform = `translateX(-${translateX}px)`;

                    // Prevent vertical scroll while swiping
                    if (diff > 10) {
                        e.preventDefault();
                    }
                }
            };

            const handleTouchEnd = () => {
                if (!isSwiping) return;

                isSwiping = false;
                item.classList.remove('swiping');
                item.style.transform = '';

                const diff = startX - currentX;

                if (diff > threshold) {
                    // Swipe detected - reveal delete button
                    item.classList.add('swiped-left');
                    this.triggerHaptic('light');
                } else {
                    // Reset position
                    item.classList.remove('swiped-left');
                }
            };

            // Reset when clicking elsewhere
            const handleClickOutside = (e) => {
                if (!container.contains(e.target)) {
                    item.classList.remove('swiped-left');
                }
            };

            item.addEventListener('touchstart', handleTouchStart, { passive: true });
            item.addEventListener('touchmove', handleTouchMove, { passive: false });
            item.addEventListener('touchend', handleTouchEnd, { passive: true });
            document.addEventListener('click', handleClickOutside);

            // Handle delete action click
            deleteAction.addEventListener('click', () => {
                const scanId = container.dataset.scanId;
                if (scanId) {
                    // Add exit animation
                    container.classList.add('list-item-exit');
                    setTimeout(() => {
                        this.deleteScan(scanId);
                    }, 200);
                }
            });
        });
    }

    async prefetchReferenceData() {
        if (!supabaseClient) return;
        await Promise.all([
            loadProductsFromSupabase(),
            loadRawMaterialsFromSupabase(),
            loadProductTypesFromSupabase()
        ]);
        this.hasPrefetchedReferenceData = true;
    }

    async refreshSessionsFromSupabase(force = false) {
        if (!supabaseSessionsEnabled || !this.isBrowserOnline) return;
        const now = Date.now();
        // Throttle to once per 10 seconds unless forced
        if (!force && this.lastSessionSync && (now - this.lastSessionSync) < 10000) {
            return;
        }
        await syncSessionsFromSupabase(this.currentTakeDate);
        this.lastSessionSync = Date.now();
    }

    async init() {
        // Initialize database and load data in parallel for speed
        const initPromises = [
            db.init(),
            this.refreshSessionsFromSupabase(true)
        ];

        // Load products in parallel if supabaseClient is available
        if (supabaseClient) {
            initPromises.push(
                loadProductsFromSupabase(),
                loadRawMaterialsFromSupabase(),
                loadProductTypesFromSupabase()
            );
        }

        await Promise.all(initPromises);

        // Sync user and device to supabaseClient after connection is established
        const userName = getUserName();
        if (userName && db.mode === 'supabaseClient') {
            const role = getUserRole();
            const warehouse = getUserWarehouse();
            syncUserToSupabase(userName, role, warehouse);
            syncDeviceToSupabase();
        }

        // Check if there's an active stock take for today
        if (this.activeStockTake && this.activeStockTake.date === this.currentTakeDate) {
            // Continue with existing stock take
            this.startAutoSync();
            await this.loadScans();
            if (supabaseSessionsEnabled) {
                this.startHeartbeat('active');
            }
        } else {
            // Show start stock take screen
            this.showingStartStockTake = true;
        }

        this.render();
    }

    isOfflineMode() {
        if (!this.isBrowserOnline) {
            return true;
        }
        return !(supabaseSessionsEnabled && this.activeStockTake?.id);
    }

    async handleConnectivityChange(isOnline) {
        this.isBrowserOnline = isOnline;
        if (!isOnline) {
            if (supabaseSessionsEnabled && this.activeStockTake?.id) {
                this.stopHeartbeat('offline');
            }
            this.render();
            return;
        }

        // Back online - sync any offline scans first
        const pendingCount = offlineSyncQueue.getPendingCount();
        if (pendingCount > 0) {
            console.log(`Back online! Syncing ${pendingCount} offline scans...`);
            this.showModal({
                title: '🔄 Syncing Offline Data',
                message: `You're back online. Syncing ${pendingCount} offline scan${pendingCount > 1 ? 's' : ''}...`,
                type: 'info'
            });

            const result = await syncOfflineScans();

            // Close info modal and show result
            this.closeModal();

            if (result.synced > 0 || result.failed > 0 || result.skippedDuplicates > 0) {
                let message = `Synced ${result.synced} scan${result.synced !== 1 ? 's' : ''}.`;
                if (result.skippedDuplicates > 0) {
                    message += ` ${result.skippedDuplicates} duplicate${result.skippedDuplicates !== 1 ? 's' : ''} skipped.`;
                }
                if (result.failed > 0) {
                    message += ` ${result.failed} failed (will retry).`;
                }

                this.showModal({
                    title: result.failed > 0 ? '⚠️ Sync Partial' : '✅ Sync Complete',
                    message: message,
                    type: result.failed > 0 ? 'warning' : 'success'
                });

                // Auto-close success modal after 2 seconds
                if (result.failed === 0) {
                    setTimeout(() => this.closeModal(), 2000);
                }
            }
        }

        if (supabaseSessionsEnabled && this.activeStockTake?.id) {
            const hbStatus = this.activeStockTake.status === 'paused' ? 'paused' : 'active';
            this.startHeartbeat(hbStatus);
        }

        await this.refreshSessionsFromSupabase(true);
        await this.loadScans();
        this.render();
    }

    async manualSyncOffline() {
        const pendingCount = offlineSyncQueue.getPendingCount();
        if (pendingCount === 0) {
            this.showModal({
                title: '✅ All Synced',
                message: 'No offline scans to sync.',
                type: 'success'
            });
            setTimeout(() => this.closeModal(), 2000);
            return;
        }

        if (!navigator.onLine) {
            this.showModal({
                title: '📴 Still Offline',
                message: `You have ${pendingCount} scan${pendingCount !== 1 ? 's' : ''} waiting.\n\nThey will sync automatically when you're back online.`,
                type: 'warning'
            });
            return;
        }

        this.showModal({
            title: '🔄 Syncing...',
            message: `Syncing ${pendingCount} offline scan${pendingCount !== 1 ? 's' : ''}...`,
            type: 'info'
        });

        const result = await syncOfflineScans();
        this.closeModal();

        if (result.synced > 0 || result.failed > 0 || result.skippedDuplicates > 0) {
            let message = `Synced ${result.synced} scan${result.synced !== 1 ? 's' : ''}.`;
            if (result.skippedDuplicates > 0) {
                message += ` ${result.skippedDuplicates} duplicate${result.skippedDuplicates !== 1 ? 's' : ''} skipped.`;
            }
            if (result.failed > 0) {
                message += ` ${result.failed} failed (will retry).`;
            }

            this.showModal({
                title: result.failed > 0 ? '⚠️ Sync Partial' : '✅ Sync Complete',
                message: message,
                type: result.failed > 0 ? 'warning' : 'success'
            });

            // Reload scans to show the synced items
            await this.loadScans();

            // Auto-close success modal after 2 seconds
            if (result.failed === 0) {
                setTimeout(() => this.closeModal(), 2000);
            }
        }

        this.render();
    }

    async handleNameChange() {
        const name = getUserName();
        const role = getUserRole();
        const warehouse = getUserWarehouse();

        // Sync user and device to supabaseClient in background
        if (name) {
            syncUserToSupabase(name, role, warehouse);
            syncDeviceToSupabase();
        }

        // Admins don't need warehouse selection
        if (role === 'admin') {
            localStorage.removeItem('userWarehouse');
            this.render();
            return;
        }

        // Prompt all non-admin users for warehouse location if not set
        if (!getUserWarehouse()) {
            const roleLabel = role === 'supervisor' ? 'supervisor' : 'operator';
            this.showModal({
                title: '📍 Select Your Warehouse',
                message: `As ${role === 'supervisor' ? 'a supervisor' : 'an operator'}, please confirm your warehouse location:`,
                type: 'confirm',
                confirmText: 'PSA',
                cancelText: 'PML',
                onConfirm: () => {
                    setUserWarehouse('PSA');
                    // Re-sync user with warehouse
                    syncUserToSupabase(name, role, 'PSA');
                    this.render();
                },
                onCancel: () => {
                    setUserWarehouse('PML');
                    // Re-sync user with warehouse
                    syncUserToSupabase(name, role, 'PML');
                    this.render();
                }
            });
        } else {
            this.render();
        }
    }

    async selectStockTakeType(type, userName) {
        if (!userName || userName.trim() === '') {
            alert('Please enter your name');
            return;
        }
        setUserName(userName.trim());

        // Check if user needs to select warehouse (non-admins)
        const role = getUserRole();
        if (role !== 'admin' && !getUserWarehouse()) {
            this.showModal({
                title: 'Select Your Warehouse',
                message: `Please confirm your warehouse location:`,
                type: 'confirm',
                confirmText: 'PSA',
                cancelText: 'PML',
                onConfirm: async () => {
                    setUserWarehouse('PSA');
                    // Refresh sessions from supabaseClient before showing list
                    await this.refreshSessionsFromSupabase(true);
                    this.selectedStockTakeType = type;
                    this.render();
                },
                onCancel: async () => {
                    setUserWarehouse('PML');
                    // Refresh sessions from supabaseClient before showing list
                    await this.refreshSessionsFromSupabase(true);
                    this.selectedStockTakeType = type;
                    this.render();
                }
            });
            return;
        }

        // Refresh sessions from supabaseClient before showing list
        await this.refreshSessionsFromSupabase(true);
        this.selectedStockTakeType = type;
        this.render();
    }

    async startNewStockTake(userName, sessionType = 'FP') {
        if (!userName || userName.trim() === '') {
            alert('Please enter your name');
            return;
        }

        setUserName(userName.trim());
        await this.refreshSessionsFromSupabase(true);
        if (!this.hasPrefetchedReferenceData) {
            await this.prefetchReferenceData();
        }

        // Get next session number for today (per type)
        const sessionNumber = getNextSessionNumber(this.currentTakeDate, sessionType);
        const sessionId = `${this.currentTakeDate}-${sessionType}-${sessionNumber}`;

        const deviceInfo = {
            deviceId: DEVICE_ID,
            userName: userName.trim(),
            status: 'active',
            joinedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        };

        // Get warehouse for session
        const warehouse = getUserWarehouse() || '';

        this.activeStockTake = {
            id: sessionId,
            sessionNumber: sessionNumber,
            sessionType: sessionType, // 'FP' or 'RM'
            date: this.currentTakeDate,
            startedBy: userName.trim(),
            startedAt: new Date().toISOString(),
            devices: [deviceInfo],
            status: 'active',
            warehouse: warehouse
        };

        // Save session to sessions list (with devices)
        await addSession(this.currentTakeDate, {
            id: sessionId,
            sessionNumber: sessionNumber,
            sessionType: sessionType,
            date: this.currentTakeDate,
            startedBy: userName.trim(),
            startedAt: new Date().toISOString(),
            devices: [deviceInfo],
            status: 'active',
            warehouse: warehouse
        });

        setActiveStockTake(this.activeStockTake);
        this.scans = [];
        clearLocalScanStorage();

        this.showingStartStockTake = false;
        this.selectedStockTakeType = null;

        this.startAutoSync();
        if (supabaseSessionsEnabled) {
            this.startHeartbeat('active');
        }

        this.loadScans();
        this.triggerHaptic('success');
        this.render();
    }

    async joinExistingSession(sessionId, userName) {
        if (!userName || userName.trim() === '') {
            alert('Please enter your name');
            return;
        }

        setUserName(userName.trim());
        await this.refreshSessionsFromSupabase();
        if (!this.hasPrefetchedReferenceData) {
            await this.prefetchReferenceData();
        }

        // Join the session
        const updatedSession = await joinSession(this.currentTakeDate, sessionId, DEVICE_ID, userName.trim());

        if (!updatedSession) {
            alert('Session not found');
            return;
        }

        this.activeStockTake = {
            id: updatedSession.id,
            sessionNumber: updatedSession.sessionNumber,
            sessionType: updatedSession.sessionType,
            date: this.currentTakeDate,
            startedBy: updatedSession.startedBy,
            startedAt: updatedSession.startedAt,
            devices: updatedSession.devices,
            status: updatedSession.status,
            warehouse: updatedSession.warehouse || updatedSession.metadata?.warehouse || '',
            metadata: updatedSession.metadata || {}
        };

        setActiveStockTake(this.activeStockTake);

        // Don't clear scans - we're joining an existing session
        this.showingStartStockTake = false;
        this.selectedStockTakeType = null;

        this.startAutoSync();
        if (supabaseSessionsEnabled) {
            this.startHeartbeat('active');
        }

        this.loadScans();
        this.triggerHaptic('success');
        this.render();
    }

    async endStockTake() {
        const sessionId = this.activeStockTake?.id;
        const sessionDate = this.activeStockTake?.date || this.currentTakeDate;

        if (!sessionId) {
            alert('No active stock take to complete.');
            return;
        }

        const finalizeDeviceWrapUp = async () => {
            const updatedSession = await markDeviceCompleted(sessionDate, sessionId, DEVICE_ID);
            if (supabaseSessionsEnabled) {
                this.stopHeartbeat('inactive');
            }
            if (updatedSession) {
                const remaining = updatedSession.devices?.filter(d => d.status === 'active').length || 0;
                if (remaining > 0) {
                    alert(`You are marked as completed.\n\n${remaining} device(s) are still counting. When everyone finishes, end the stock take from Session History.`);
                } else {
                    alert('All devices are now marked complete. End the entire stock take from Session History when you are ready to finalize.');
                }
            } else {
                alert('You are marked as completed. End the stock take from Session History when ready.');
            }
            this.stopAutoSync();
            clearActiveStockTake();
            this.activeStockTake = null;
            this.scans = [];
            this.selectedStockTakeType = null;
            this.showingStartStockTake = true;
            this.render();
        };

        if (this.scans.length === 0) {
            const confirmDone = confirm('No items were scanned on this device. Mark yourself as completed? This will NOT end the overall stock take.');
            if (!confirmDone) return;
            await finalizeDeviceWrapUp();
            return;
        }

        await this.loadScans();

        const currentSession = getSessionById(sessionDate, sessionId);
        const deviceScanCount = this.scans.filter(s => s.deviceId === DEVICE_ID).length;
        const otherActiveDevices = currentSession?.devices?.filter(d => d.status === 'active' && d.deviceId !== DEVICE_ID) || [];
        const completedDevices = currentSession?.devices?.filter(d => d.status === 'completed') || [];

        let summary = `Mark Your Count Complete\n\n` +
            `Your scans: ${deviceScanCount}\n` +
            `Total session scans: ${this.scans.length}\n\n`;

        if (otherActiveDevices.length > 0) {
            summary += `⚠️ ${otherActiveDevices.length} other device(s) are still active:\n`;
            otherActiveDevices.forEach(d => {
                summary += `  • ${d.userName}\n`;
            });
            summary += `\nThis only marks your device as completed.\nThe stock take stays open until it is ended from Session History.\n\n`;
        } else if (completedDevices.length > 0) {
            summary += `✓ ${completedDevices.length} device(s) already marked done.\n`;
            summary += `Use Session History to end the stock take for everyone.\n\n`;
        } else {
            summary += `This will mark only your device as completed.\nEnd the full stock take from Session History when ready.\n\n`;
        }

        summary += `Proceed with marking yourself done?`;
        const proceed = confirm(summary);
        if (!proceed) return;

        const exportData = confirm('Export your scans before marking done? Click OK to export, or Cancel to skip.');
        if (exportData) {
            this.exportStockCount();
        }

        await finalizeDeviceWrapUp();
    }

    async endSessionFromList(sessionId) {
        // End a session from the session selection list
        this.showModal({
            title: 'End Session',
            message: 'Are you sure you want to end this session? All active devices will be marked as completed.',
            type: 'confirm',
            confirmText: 'End Session',
            cancelText: 'Cancel',
            onConfirm: () => {
                // Execute the async operation after modal closes
                this._executeEndSession(sessionId);
            }
        });
    }

    async _executeEndSession(sessionId) {
        try {
            console.log('Attempting to end session:', sessionId);

            if (supabaseSessionsEnabled && supabaseClient) {
                // First check if the session exists in stock_takes
                const { data: existingSession, error: fetchError } = await supabaseClient
                    .from('stock_takes')
                    .select('id, status')
                    .eq('id', sessionId)
                    .single();

                if (fetchError) {
                    console.error('Error fetching session:', fetchError);
                    // Session might not exist in supabaseClient, just update locally
                    console.log('Session not found in supabaseClient, updating locally only');
                } else if (existingSession) {
                    // Update session status in supabaseClient (use completed_at, not ended_at)
                    const { error: updateError } = await supabaseClient
                        .from('stock_takes')
                        .update({
                            status: 'completed',
                            completed_at: new Date().toISOString()
                        })
                        .eq('id', sessionId);

                    if (updateError) {
                        console.error('Error updating session in supabaseClient:', updateError);
                        // Don't show alert for cloud errors, just log and continue locally
                        console.log('Continuing with local update only');
                    } else {
                        console.log('Session ended in supabaseClient successfully');
                    }
                }
            }

            // Update local storage
            const sessionDate = this.currentTakeDate;
            await updateSession(sessionDate, sessionId, { status: 'completed' });
            console.log('Session ended in local storage');

            // Refresh the session list
            await this.refreshSessionsFromSupabase();
            this.render();

            alert('Session ended successfully.');
        } catch (err) {
            console.error('Error ending session:', err);
            alert('Failed to end session: ' + (err.message || 'Unknown error'));
        }
    }

    async loadScans() {
        const sessionType = this.activeStockTake?.sessionType || 'FP';
        const sessionId = this.activeStockTake?.id;

        if (supabaseClient && sessionId) {
            // Load ALL scans from stock_scans table, filtered by session
            try {
                // Only select fields we actually need for display
                const { data, error } = await supabaseClient
                    .from('stock_scans')
                    .select('id,scanned_at,raw_code,batch_number,pallet_number,cases_on_pallet,actual_cases,stock_code,description,device_id,scanned_by,session_type,expiry_date,location,site,aisle,rack,unit_type')
                    .eq('session_id', sessionId)
                    .order('scanned_at', { ascending: false });

                if (error) {
                    console.error('Error loading scans from supabaseClient:', error);
                    await logClientEvent('scan-load-failed', 'error', sessionId, { message: error.message });
                    this.scans = [];
                    return;
                }

                this.scans = (data || []).map(row => ({
                    id: row.id,
                    timestamp: new Date(row.scanned_at).getTime(),
                    date: new Date(row.scanned_at).toLocaleDateString(),
                    time: new Date(row.scanned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    raw: row.raw_code,
                    batchNumber: row.batch_number,
                    palletNumber: row.pallet_number || '',
                    casesOnPallet: row.cases_on_pallet || 0,
                    actualCases: row.actual_cases,
                    stockCode: row.stock_code,
                    description: row.description,
                    valid: true,
                    deviceId: row.device_id,
                    scannedBy: row.scanned_by || 'Unknown',
                    sessionType: row.session_type || sessionType,
                    expiryDate: row.expiry_date,
                    location: row.location,
                    site: row.site,
                    aisle: row.aisle,
                    rack: row.rack,
                    unitType: row.unit_type || (sessionType === 'RM' ? getUnitTypeForStockCode(row.stock_code) : 'cases')
                }));

                console.log(`Loaded ${this.scans.length} scans from stock_scans for session ${sessionId}`);
            } catch (err) {
                console.error('Failed to load scans from supabaseClient:', err);
                await logClientEvent('scan-load-failed', 'error', sessionId, { message: err.message });
                this.scans = [];
            }
        } else {
            // Fallback to localStorage
            const allScans = localStorage_db.list('scan:');
            // Filter by session type
            this.scans = allScans.filter(s => !s.sessionType || s.sessionType === sessionType);
            this.scans.sort((a, b) => b.timestamp - a.timestamp);
        }
    }

    startAutoSync() {
        this.stopAutoSync();
        const canSync = supabaseSessionsEnabled && this.activeStockTake?.id;
        if (!canSync) {
            return;
        }
        const runSync = async () => {
            if (!this.isBrowserOnline) return;

            try {
                // Always sync data from database - this keeps data in sync
                if (supabaseSessionsEnabled && this.activeStockTake?.id) {
                    await this.refreshSessionsFromSupabase();
                    await this.loadScans();
                }

                // Only render if not in an input state - prevents clearing user input
                // Data is still synced, just UI update is deferred
                if (!this.showingCaseEntry && !this.modalState) {
                    this.render();
                } else {
                    // Mark that we need to render when input is done
                    this._pendingRender = true;
                }
            } catch (err) {
                console.warn('Auto-sync failed', err);
            }
        };
        runSync();
        // Sync every 10 seconds
        this.syncInterval = setInterval(runSync, 10000);
    }

    stopAutoSync() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
    }

    startHeartbeat(status = 'active') {
        if (!supabaseSessionsEnabled || !this.activeStockTake?.id || !this.isBrowserOnline) return;
        this.stopHeartbeat();
        const send = async () => {
            if (!this.isBrowserOnline) return;
            await upsertSessionDevicePresence(this.activeStockTake.id, status, this.activeStockTake);
            this.lastHeartbeatAt = Date.now();
        };
        send();
        this.heartbeatInterval = setInterval(send, HEARTBEAT_INTERVAL_MS);
    }

    stopHeartbeat(status = 'inactive') {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (supabaseSessionsEnabled && this.activeStockTake?.id && status && this.isBrowserOnline) {
            upsertSessionDevicePresence(this.activeStockTake.id, status, this.activeStockTake);
        }
    }

    async getPreferredCameraId() {
        if (this.preferredCameraId) return this.preferredCameraId;
        try {
            const cameras = await Html5Qrcode.getCameras();
            if (!cameras || cameras.length === 0) {
                return null;
            }
            const backCamera = cameras.find(cam => /back|rear|environment/i.test(cam.label));
            this.preferredCameraId = (backCamera || cameras[0]).id;
            return this.preferredCameraId;
        } catch (err) {
            console.warn('Camera enumeration failed', err);
            return null;
        }
    }

    parseQRCode(code) {
        const sessionType = this.activeStockTake?.sessionType || 'FP';

        // FP (Finished Products) - 13 digit numeric code
        // Format: BBBBBPPPPCCCC (5 batch + 4 pallet + 4 cases)
        if (sessionType === 'FP') {
            if (!/^\d{13}$/.test(code)) {
                return {
                    valid: false,
                    raw: code,
                    error: 'Not a valid 13-digit FP code'
                };
            }

            const batchNumber = code.substring(0, 5);    // First 5 digits = batch
            const palletNumber = code.substring(5, 9);   // Next 4 digits = pallet
            const cases = code.substring(9, 13);         // Last 4 digits = cases

            const productInfo = productDatabase[batchNumber];
            const isUnknownProduct = !productInfo;

            return {
                valid: true,
                raw: code,
                batchNumber: batchNumber,
                palletNumber: palletNumber,
                casesOnPallet: parseInt(cases),
                stockCode: productInfo?.stockCode || 'UNKNOWN',
                description: productInfo?.description || 'Unknown Product',
                isUnknownProduct: isUnknownProduct
            };
        }

        // RM (Raw Materials) - starts with a letter
        // Barcode format: STOCKCODE + BATCH + optional EXPIRY (DD/MM/YY)
        // If stock code not in database, user will be prompted to scan stock code first
        if (sessionType === 'RM') {
            // Check if it starts with a letter (RM code)
            if (!/^[A-Za-z]/.test(code)) {
                return {
                    valid: false,
                    raw: code,
                    error: 'RM code must start with a letter'
                };
            }

            // Try to extract expiry date from end of string (format: DD/MM/YY)
            const expiryMatch = code.match(/(\d{2}\/\d{2}\/\d{2})$/);
            let extractedExpiry = null;
            let codeWithoutExpiry = code;

            if (expiryMatch) {
                extractedExpiry = expiryMatch[1];
                codeWithoutExpiry = code.substring(0, code.length - 8).trim(); // Remove expiry and any trailing space
            }

            // Try to find the stock code in database
            let foundStockCode = null;
            let batchNumber = null;
            let batchFromDatabase = false;
            let needsStockCodeScan = false;
            let needsBatchConfirmation = false;
            let needsExpiryConfirmation = false;

            // First, try to match known stock codes
            const knownStockCodes = Object.keys(rawMaterialsDatabase).sort((a, b) => b.length - a.length);

            for (const sc of knownStockCodes) {
                if (code.toUpperCase().startsWith(sc.toUpperCase())) {
                    foundStockCode = sc;
                    // Extract batch number from remaining string
                    const remaining = code.substring(sc.length);
                    const extractedBatch = remaining.replace(/^[\-_\s]+/, '').trim() || null;

                    // Check if this batch exists in the database for this stock code
                    const rmInfo = rawMaterialsDatabase[sc];
                    if (rmInfo && rmInfo.batches && extractedBatch) {
                        // Try to find a matching batch in the database
                        const knownBatches = Object.keys(rmInfo.batches);
                        // Look for exact match first
                        const exactMatch = knownBatches.find(b => extractedBatch.toUpperCase().includes(b.toUpperCase()) || b.toUpperCase().includes(extractedBatch.toUpperCase()));
                        if (exactMatch) {
                            batchNumber = exactMatch;
                            batchFromDatabase = true;
                        } else {
                            // No match found in database - use extracted batch
                            batchNumber = extractedBatch;
                        }
                    } else {
                        batchNumber = extractedBatch;
                    }
                    break;
                }
            }

            // If not found in database, mark as needing stock code scan
            if (!foundStockCode) {
                // Stock code not in database - user needs to scan stock code first
                needsStockCodeScan = true;

                // Try to parse what we can from the code
                const parts = codeWithoutExpiry.split(/[\-_\s]+/);
                if (parts.length >= 1) {
                    foundStockCode = parts[0];
                    // Everything after the first part could be batch
                    const potentialBatch = parts.slice(1).join('-') || null;
                    if (potentialBatch) {
                        batchNumber = potentialBatch;
                        needsBatchConfirmation = true;
                    }
                }
            }

            // If we extracted expiry from end of string, use it but need confirmation
            if (extractedExpiry) {
                needsExpiryConfirmation = true;
            }

            // Also need batch confirmation if batch was extracted but not from database
            if (batchNumber && !batchFromDatabase) {
                needsBatchConfirmation = true;
            }

            if (!foundStockCode) {
                return {
                    valid: false,
                    raw: code,
                    error: 'Could not parse stock code from: ' + code
                };
            }

            // Look up product info
            const rmInfo = rawMaterialsDatabase[foundStockCode] || rawMaterialsDatabase[foundStockCode.toUpperCase()];
            const description = rmInfo?.description || 'Unknown Raw Material';

            // Determine unit type based on stock code prefix
            const unitType = getUnitTypeForStockCode(foundStockCode);

            // Check for expiry dates if batch number is known from database
            let expiryDate = extractedExpiry || null;
            let availableExpiryDates = [];

            if (rmInfo && batchNumber && rmInfo.batches && rmInfo.batches[batchNumber]) {
                const batchInfo = rmInfo.batches[batchNumber];
                // Support both old format (expiryDate) and new format (expiryDates array)
                if (batchInfo.expiryDates && Array.isArray(batchInfo.expiryDates)) {
                    availableExpiryDates = batchInfo.expiryDates.filter(d => d != null);
                    if (availableExpiryDates.length === 1) {
                        expiryDate = availableExpiryDates[0];
                        needsExpiryConfirmation = false; // Found in database
                    } else if (availableExpiryDates.length > 1) {
                        // Multiple expiry dates - need confirmation
                        needsExpiryConfirmation = true;
                    }
                } else if (batchInfo.expiryDate) {
                    // Old format - single expiry date
                    expiryDate = batchInfo.expiryDate;
                    availableExpiryDates = [expiryDate];
                    needsExpiryConfirmation = false; // Found in database
                }
            }

            return {
                valid: true,
                raw: code,
                stockCode: foundStockCode,
                batchNumber: batchNumber || null,
                palletNumber: null, // RM doesn't use pallets
                casesOnPallet: 0, // Will be entered as quantity
                description: description,
                expiryDate: expiryDate,
                extractedExpiry: extractedExpiry, // Keep original extracted value
                availableExpiryDates: availableExpiryDates,
                needsExpiryConfirmation: needsExpiryConfirmation,
                needsBatchConfirmation: needsBatchConfirmation,
                needsStockCodeScan: needsStockCodeScan,
                isRawMaterial: true,
                unitType: unitType // 'kg' or 'units'
            };
        }

        return {
            valid: false,
            raw: code,
            error: 'Unknown session type'
        };
    }

    async checkDuplicate(batchNumber, palletNumber, stockCode = null, expiryDate = null) {
        console.log('checkDuplicate called with:', { batchNumber, palletNumber, stockCode, expiryDate, typeof_pallet: typeof palletNumber });
        if (supabaseClient && this.activeStockTake?.id) {
            // Live check against supabaseClient stock_scans for all devices in this session
            const sessionType = this.activeStockTake?.sessionType || 'FP';
            return await checkDuplicateInSupabase(
                this.activeStockTake.id,
                sessionType,
                batchNumber,
                stockCode,
                expiryDate,
                palletNumber
            );
        } else {
            // Fallback to local check
            if (this.activeStockTake?.sessionType === 'RM') {
                return this.scans.find(s =>
                    s.batchNumber === batchNumber &&
                    s.stockCode === stockCode &&
                    (!expiryDate || s.expiryDate === expiryDate)
                );
            } else {
                return this.scans.find(s =>
                    s.batchNumber === batchNumber &&
                    s.palletNumber === palletNumber
                );
            }
        }
    }

    async startScanning() {
        this.isScanning = true;
        this.render();

        setTimeout(async () => {
            try {
                this.scanner = new Html5Qrcode("scanner", {
                    verbose: false,
                    experimentalFeatures: {
                        useBarCodeDetectorIfSupported: true
                    }
                });

                const config = {
                    fps: 10,
                    qrbox: function (viewfinderWidth, viewfinderHeight) {
                        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
                        const size = Math.floor(minEdge * 0.7);
                        return { width: size, height: size };
                    },
                    aspectRatio: 1.0,
                    showTorchButtonIfSupported: true,
                    showZoomSliderIfSupported: true,
                    defaultZoomValueIfSupported: 2
                };

                await this.scanner.start(
                    { facingMode: "environment" },
                    config,
                    (decodedText, decodedResult) => {
                        console.log('SCAN SUCCESS:', decodedText, decodedResult);
                        this.onScanSuccess(decodedText);
                    },
                    (errorMessage) => {
                        // Silent - no QR in frame
                    }
                );

                // Fix for mobile browsers: force video element attributes
                setTimeout(() => {
                    const videoElement = document.querySelector('#scanner video');
                    if (videoElement) {
                        videoElement.setAttribute('playsinline', '');
                        videoElement.setAttribute('webkit-playsinline', '');
                        videoElement.setAttribute('autoplay', '');
                        videoElement.muted = true;
                        videoElement.playsInline = true;
                    }
                }, 500);

            } catch (err) {
                console.error('Camera error:', err);
                let errorMsg = 'Camera error: ';
                if (err.name === 'NotAllowedError') {
                    errorMsg += 'Camera permission denied. Please allow camera access in your browser settings.';
                } else if (err.name === 'NotFoundError') {
                    errorMsg += 'No camera found on this device.';
                } else if (err.name === 'NotReadableError') {
                    errorMsg += 'Camera is in use by another app.';
                } else {
                    errorMsg += err.message || err;
                }
                alert(errorMsg);
                this.isScanning = false;
                this.render();
            }
        }, 300);
    }

    async stopScanning() {
        if (this.scanner) {
            try {
                await this.scanner.stop();
            } catch (err) {
                console.log('Stop error:', err);
            }
            try {
                this.scanner.clear();
            } catch (err) {
                console.log('Clear error:', err);
            }
            this.scanner = null;
        }
        this.isScanning = false;
        this.render();
    }

    // Generate a unique key for a scan to prevent double-capture
    getScanKey(parsed) {
        const sessionType = this.activeStockTake?.sessionType || 'FP';
        if (sessionType === 'RM') {
            return `${parsed.stockCode}|${parsed.batchNumber}|${parsed.expiryDate || ''}`;
        } else {
            return `${parsed.batchNumber}|${parsed.palletNumber}`;
        }
    }

    async onScanSuccess(code) {
        const cleanedCode = (code || '').trim();
        if (!cleanedCode) {
            return;
        }
        if (navigator.vibrate) navigator.vibrate(200);

        this.stopScanning();

        // ===== LOCATION QR CODE DETECTION =====
        // Check if this is a location QR code (RACK-* or FLOOR-*)
        if (isLocationCode(cleanedCode)) {
            const locationCode = cleanedCode.toUpperCase();
            const parsed = parseLocationCode(locationCode);

            if (parsed) {
                // Set as active location
                this.activeLocation = locationCode;

                // Also update session settings for backward compatibility
                this.sessionSettings.currentLocation = locationCode;
                this.sessionSettings.locationScanningEnabled = true;
                saveSessionSettings(this.sessionSettings);

                // Simple vibrate feedback - no modal, just confirm with haptic
                this.triggerHaptic('success');

                // Log location set for debugging
                console.log('📍 Location set:', locationCode);

                // Immediately restart scanner for continuous scanning
                this.render();
                setTimeout(() => this.startScanning(), 300);

                return;
            }
        }
        // ===== END LOCATION QR CODE DETECTION =====

        // Check if we're waiting for FP stock code scan
        if (this._waitingForFPStockCode && this._unknownFPParsed) {
            this._waitingForFPStockCode = false;
            const stockCode = cleanedCode;
            const parsed = this._unknownFPParsed;

            // Don't accept a 13-digit code (that's a pallet barcode, not stock code)
            if (/^\d{13}$/.test(stockCode)) {
                this.showModal({
                    title: '⚠️ Wrong Barcode',
                    message: 'That looks like a pallet barcode, not a stock code.\n\nPlease scan the STOCK CODE barcode.',
                    type: 'alert',
                    confirmText: 'Try Again',
                    onConfirm: () => {
                        this._waitingForFPStockCode = true;
                        this.startScanning();
                    }
                });
                return;
            }

            // Look up or prompt for product details
            await this._processFPStockCodeScan(stockCode, parsed);
            return;
        }

        // Check if we're waiting for a stock code scan (unknown product flow - RM)
        if (this._waitingForStockCodeScan && this._unknownStockParsed) {
            this._waitingForStockCodeScan = false;
            const stockCode = cleanedCode;

            // Don't accept the same code as the original
            const originalCode = this._unknownStockParsed.raw || '';
            if (stockCode === originalCode) {
                this.showModal({
                    title: '⚠️ Same Barcode',
                    message: 'You scanned the same barcode again.\n\nPlease scan the separate STOCK CODE barcode.',
                    type: 'alert',
                    confirmText: 'Try Again',
                    onConfirm: () => {
                        this._waitingForStockCodeScan = true;
                        this.startScanning();
                    }
                });
                return;
            }

            // Process the stock code
            this.finishUnknownStockScan(stockCode);
            return;
        }

        const parsed = this.parseQRCode(cleanedCode);

        if (!parsed.valid) {
            alert(parsed.error);
            return;
        }

        // Check if this scan is already being processed (prevents rapid double-scan)
        const scanKey = this.getScanKey(parsed);
        if (this.pendingScanKeys.has(scanKey)) {
            console.log('Scan already in progress:', scanKey);
            if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
            alert('This item is already being processed. Please wait.');
            return;
        }

        // Check if expiry date confirmation is needed (multiple dates available)
        if (parsed.needsExpiryConfirmation && parsed.availableExpiryDates && parsed.availableExpiryDates.length > 1) {
            // Show expiry date selection dialog
            this.pendingScan = parsed;
            this.showingExpirySelection = true;
            this.render();
            return;
        }

        const sessionType = this.activeStockTake?.sessionType || 'FP';

        // For FP: Handle unknown product - show search to select product
        if (sessionType === 'FP' && parsed.isUnknownProduct) {
            // Store data for after product selection
            this._unknownFPParsed = parsed;
            this._unknownFPScanKey = scanKey;

            // Show product search modal
            this._showFPProductSearch(parsed, scanKey);
            return;
        }

        // For RM: Handle stock code not found in database
        if (sessionType === 'RM' && parsed.needsStockCodeScan) {
            // Store data for after scan
            this._unknownStockParsed = parsed;
            this._unknownStockScanKey = scanKey;
            this._waitingForStockCodeScan = true;

            // Show message and let user scan stock code with normal scanner
            this.showModal({
                title: '📦 Unknown Product',
                message: `The scanned barcode is not in the database.\n\nOriginal scan:\n${parsed.raw}\n\nPlease scan the STOCK CODE barcode on this product.`,
                type: 'alert',
                confirmText: 'Scan Stock Code',
                onConfirm: () => {
                    // Start normal scanner - it will be handled specially
                    this.startScanning();
                }
            });
            return;
        }

        // For RM: Handle batch confirmation 
        if (sessionType === 'RM' && parsed.needsBatchConfirmation && parsed.batchNumber) {
            this.showModal({
                title: '🏷️ Confirm Batch Number',
                message: `Stock Code: ${parsed.stockCode}\n\nExtracted Batch: ${parsed.batchNumber}\n\nPlease confirm or correct the batch number:`,
                type: 'input',
                confirmText: 'Confirm Batch',
                cancelText: 'Cancel',
                onConfirm: (formData) => {
                    const confirmedBatch = formData.value?.trim() || parsed.batchNumber;
                    parsed.batchNumber = confirmedBatch;
                    parsed.needsBatchConfirmation = false;
                    // Continue to expiry confirmation
                    this._continueRMScan(parsed, scanKey);
                }
            });
            // Pre-fill the input with extracted batch
            setTimeout(() => {
                const input = document.getElementById('modal-input');
                if (input) input.value = parsed.batchNumber;
            }, 100);
            return;
        }

        // For RM: Handle expiry confirmation from barcode
        if (sessionType === 'RM' && parsed.needsExpiryConfirmation && parsed.extractedExpiry) {
            this.showModal({
                title: '📅 Confirm Expiry Date',
                message: `Stock Code: ${parsed.stockCode}\nBatch: ${parsed.batchNumber}\n\nExtracted Expiry: ${parsed.extractedExpiry}\n(Format: DD/MM/YY)\n\nPlease confirm or correct the expiry date:`,
                type: 'input',
                confirmText: 'Confirm Expiry',
                cancelText: 'No Expiry',
                onConfirm: (formData) => {
                    const confirmedExpiry = formData.value?.trim() || parsed.extractedExpiry;
                    // Convert DD/MM/YY to YYYY-MM-DD format
                    parsed.expiryDate = confirmedExpiry ? convertDMYtoYMD(confirmedExpiry) : null;
                    parsed.needsExpiryConfirmation = false;
                    // Continue to duplicate check and case entry
                    this._continueRMScan(parsed, scanKey);
                },
                onCancel: () => {
                    // User said no expiry
                    parsed.expiryDate = null;
                    parsed.needsExpiryConfirmation = false;
                    this._continueRMScan(parsed, scanKey);
                }
            });
            // Pre-fill the input with extracted expiry
            setTimeout(() => {
                const input = document.getElementById('modal-input');
                if (input) input.value = parsed.extractedExpiry;
            }, 100);
            return;
        }

        // For FP 13-digit scans (with pallet number), check for duplicates
        // A pallet with same batch+pallet cannot be scanned twice
        // Note: 5-digit manual entries and RM items allow duplicates
        if (sessionType === 'FP' && parsed.palletNumber) {
            console.log('FP duplicate check - batch:', parsed.batchNumber, 'pallet:', parsed.palletNumber);
            const duplicate = await this.checkDuplicate(
                parsed.batchNumber,
                parsed.palletNumber,
                parsed.stockCode,
                parsed.expiryDate
            );
            console.log('FP duplicate check result:', duplicate);

            if (duplicate) {
                const timestamp = duplicate.scanned_at || duplicate.created_at || duplicate.date + ' ' + duplicate.time;
                const scannedByName = duplicate.scanned_by || duplicate.scannedBy || 'Unknown';
                const existingCases = duplicate.actual_cases || duplicate.actualCases || 0;

                if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

                // Store duplicate info for update flow
                parsed.isDuplicatePallet = true;
                parsed.existingScanId = duplicate.id;
                parsed.existingCases = existingCases;

                // Show modal to notify and confirm update
                this.showModal({
                    title: 'Pallet Already Scanned',
                    message: `This pallet has already been scanned!\n\n` +
                        `Stock Code: ${parsed.stockCode}\n` +
                        `Batch: ${parsed.batchNumber}\n` +
                        `Pallet: ${parsed.palletNumber}\n` +
                        `Current Cases: ${existingCases}\n\n` +
                        `Scanned by: ${scannedByName}\n` +
                        `at ${new Date(timestamp).toLocaleString()}\n\n` +
                        `Would you like to update this pallet's count?`,
                    type: 'confirm',
                    confirmText: 'Update Count',
                    cancelText: 'Cancel',
                    onConfirm: () => {
                        // Proceed to case entry to update
                        this.pendingScanKeys.add(scanKey);
                        this.currentScan = parsed;
                        this.showingCaseEntry = true;
                        this.render();
                    }
                });
                return;
            }
        }

        // Mark this scan as pending to prevent double-capture
        this.pendingScanKeys.add(scanKey);

        this.currentScan = parsed;
        this.showingCaseEntry = true;
        this.render();
    }

    // Continue RM scan after confirmations
    async _continueRMScan(parsed, scanKey) {
        // Check if more confirmations are needed
        if (parsed.needsStockCodeScan) {
            // Re-trigger stock code confirmation
            await this.onScanSuccess(parsed.raw);
            return;
        }

        if (parsed.needsBatchConfirmation) {
            // Re-trigger batch confirmation
            this.showModal({
                title: '🏷️ Confirm Batch Number',
                message: `Stock Code: ${parsed.stockCode}\n\nExtracted Batch: ${parsed.batchNumber}\n\nPlease confirm or correct the batch number:`,
                type: 'input',
                confirmText: 'Confirm Batch',
                cancelText: 'Cancel',
                onConfirm: (formData) => {
                    const confirmedBatch = formData.value?.trim() || parsed.batchNumber;
                    parsed.batchNumber = confirmedBatch;
                    parsed.needsBatchConfirmation = false;
                    this._continueRMScan(parsed, scanKey);
                }
            });
            setTimeout(() => {
                const input = document.getElementById('modal-input');
                if (input) input.value = parsed.batchNumber || '';
            }, 100);
            return;
        }

        if (parsed.needsExpiryConfirmation && parsed.extractedExpiry) {
            // Re-trigger expiry confirmation  
            this.showModal({
                title: '📅 Confirm Expiry Date',
                message: `Stock Code: ${parsed.stockCode}\nBatch: ${parsed.batchNumber}\n\nExtracted Expiry: ${parsed.extractedExpiry}\n(Format: DD/MM/YY)\n\nPlease confirm or correct:`,
                type: 'input',
                confirmText: 'Confirm Expiry',
                cancelText: 'No Expiry',
                onConfirm: (formData) => {
                    const confirmedExpiry = formData.value?.trim() || parsed.extractedExpiry;
                    // Convert DD/MM/YY to YYYY-MM-DD format
                    parsed.expiryDate = confirmedExpiry ? convertDMYtoYMD(confirmedExpiry) : null;
                    parsed.needsExpiryConfirmation = false;
                    this._continueRMScan(parsed, scanKey);
                },
                onCancel: () => {
                    parsed.expiryDate = null;
                    parsed.needsExpiryConfirmation = false;
                    this._continueRMScan(parsed, scanKey);
                }
            });
            setTimeout(() => {
                const input = document.getElementById('modal-input');
                if (input) input.value = parsed.extractedExpiry || '';
            }, 100);
            return;
        }

        // RM items allow duplicates (same item can be in different locations)
        // Proceed directly to case entry
        this.pendingScanKeys.add(scanKey);
        this.currentScan = parsed;
        this.showingCaseEntry = true;
        this.render();
    }

    async saveScan(parsedData, actualCases) {
        const userName = getUserName();
        const sessionType = this.activeStockTake?.sessionType || 'FP';
        const sessionId = this.activeStockTake?.id || null;
        const locationPayload = this.sessionSettings.locationScanningEnabled ? {
            location: this.sessionSettings.currentLocation || null,
            site: this.sessionSettings.site || null,
            aisle: this.sessionSettings.aisle || null,
            rack: this.sessionSettings.rack || null
        } : {
            location: null,
            site: null,
            aisle: null,
            rack: null
        };

        // Check if this is an update to an existing pallet scan
        const isUpdate = parsedData.isDuplicatePallet && parsedData.existingScanId;

        console.log('Saving scan:', { parsedData, actualCases, userName, sessionType, sessionId, supabaseEnabled: !!supabaseClient, isUpdate });

        // For RM items, check if same item+batch+expiry+quantity already exists
        // This catches potential duplicate entries (same count recorded twice)
        if (sessionType === 'RM' && supabaseClient && sessionId && !isUpdate) {
            const rmDuplicate = await checkRMDuplicateQuantity(
                sessionId,
                parsedData.stockCode,
                parsedData.batchNumber,
                parsedData.expiryDate,
                actualCases
            );

            if (rmDuplicate) {
                const timestamp = rmDuplicate.scanned_at || rmDuplicate.created_at;
                const scannedByName = rmDuplicate.scanned_by || 'Unknown';
                const locationInfo = rmDuplicate.location ? `\nLocation: ${rmDuplicate.location}` : '';
                const unitType = parsedData.unitType || getUnitTypeForStockCode(parsedData.stockCode);
                const unitLabel = unitType === 'kg' ? 'KG' : 'units';

                if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

                const confirmed = await new Promise(resolve => {
                    this.showModal({
                        title: 'Possible Duplicate Entry',
                        message: `This exact recording already exists:\n\n` +
                            `Stock Code: ${parsedData.stockCode}\n` +
                            `Batch: ${parsedData.batchNumber}\n` +
                            `Quantity: ${actualCases} ${unitLabel}\n` +
                            (parsedData.expiryDate ? `Expiry: ${parsedData.expiryDate}\n` : '') +
                            locationInfo +
                            `\n\nRecorded by: ${scannedByName}\n` +
                            `at ${new Date(timestamp).toLocaleString()}\n\n` +
                            `Are you sure this is a NEW recording\n(different location/pallet)?`,
                        type: 'confirm',
                        confirmText: 'Yes, Save New',
                        cancelText: 'Cancel',
                        onConfirm: () => resolve(true),
                        onCancel: () => resolve(false)
                    });
                });

                if (!confirmed) {
                    // User cancelled - don't save
                    return;
                }
            }
        }

        // For FP 5-digit manual entries (no pallet number), check if same batch+quantity exists
        // This catches potential duplicate entries where operator enters same count twice
        if (sessionType === 'FP' && !parsedData.palletNumber && supabaseClient && sessionId && !isUpdate) {
            const fpManualDuplicate = await checkFPManualDuplicateQuantity(
                sessionId,
                parsedData.batchNumber,
                actualCases
            );

            if (fpManualDuplicate) {
                const timestamp = fpManualDuplicate.scanned_at;
                const scannedByName = fpManualDuplicate.scanned_by || 'Unknown';

                if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

                const confirmed = await new Promise(resolve => {
                    this.showModal({
                        title: 'Possible Duplicate Entry',
                        message: `This exact recording already exists:\n\n` +
                            `Stock Code: ${parsedData.stockCode}\n` +
                            `Batch: ${parsedData.batchNumber}\n` +
                            `Quantity: ${actualCases} cases\n\n` +
                            `Recorded by: ${scannedByName}\n` +
                            `at ${new Date(timestamp).toLocaleString()}\n\n` +
                            `Are you sure this is a NEW pallet?`,
                        type: 'confirm',
                        confirmText: 'Yes, Save New',
                        cancelText: 'Cancel',
                        onConfirm: () => resolve(true),
                        onCancel: () => resolve(false)
                    });
                });

                if (!confirmed) {
                    // User cancelled - don't save
                    return;
                }
            }
        }

        // Check if we have a valid session for supabaseClient saves
        if (supabaseClient && !sessionId) {
            console.warn('No active session ID - scan will be saved to localStorage only');
            alert('No active session. Please start or join a session first. Scan saved locally.');
        }

        if (supabaseClient && sessionId) {
            // Handle UPDATE for duplicate pallet
            if (isUpdate) {
                console.log('Updating existing pallet scan:', parsedData.existingScanId);
                try {
                    const { data, error } = await supabaseClient
                        .from('stock_scans')
                        .update({
                            actual_cases: actualCases,
                            scanned_by: userName,
                            device_id: DEVICE_ID,
                            scanned_at: new Date().toISOString(),
                            location: locationPayload.location,
                            site: locationPayload.site,
                            aisle: locationPayload.aisle,
                            rack: locationPayload.rack
                        })
                        .eq('id', parsedData.existingScanId)
                        .select();

                    if (error) {
                        console.error('supabaseClient update error:', error);
                        await logClientEvent('scan-update-failed', 'error', sessionId, { error: error.message, scanId: parsedData.existingScanId });
                        throw error;
                    }

                    console.log('Updated pallet scan in supabaseClient:', data);
                    await logClientEvent('scan-update', 'info', sessionId, { scanId: parsedData.existingScanId, newCases: actualCases });
                } catch (err) {
                    console.error('Failed to update scan in supabaseClient:', err);
                    await logClientEvent('scan-update-failed', 'error', sessionId, { message: err.message });
                    alert('Failed to update scan. Please check your connection.');
                    throw err;
                }
            } else {
                // INSERT new scan
                console.log('Saving to supabaseClient with sessionId:', sessionId);
                const record = {
                    session_id: sessionId,
                    take_date: this.currentTakeDate,
                    batch_number: parsedData.batchNumber,
                    stock_code: parsedData.stockCode,
                    description: parsedData.description,
                    scanned_by: userName,
                    device_id: DEVICE_ID,
                    session_type: sessionType,
                    location: locationPayload.location,
                    site: locationPayload.site,
                    aisle: locationPayload.aisle,
                    rack: locationPayload.rack,
                    unit_type: parsedData.unitType || (sessionType === 'RM' ? getUnitTypeForStockCode(parsedData.stockCode) : 'cases'),
                    actual_cases: actualCases,
                    pallet_number: parsedData.palletNumber || null,
                    cases_on_pallet: parsedData.casesOnPallet || null,
                    expiry_date: convertDMYtoYMD(parsedData.expiryDate) || null,
                    raw_code: parsedData.raw
                };

                try {
                    const { data, error } = await supabaseClient
                        .from('stock_scans')
                        .insert([record])
                        .select();

                    if (error) {
                        console.error('supabaseClient insert error:', error);
                        await logClientEvent('scan-insert-failed', 'error', sessionId, { error: error.message, record });
                        throw error;
                    }

                    console.log('Saved to supabaseClient stock_scans:', data);
                    await logClientEvent('scan-insert', 'info', sessionId, { scanId: data?.[0]?.id || null });
                } catch (err) {
                    console.error('Failed to save to supabaseClient:', err);

                    // Save to offline queue instead of losing the scan
                    offlineSyncQueue.addToQueue(record);
                    const pendingCount = offlineSyncQueue.getPendingCount();

                    this.showModal({
                        title: '📴 Saved Offline',
                        message: `Network error - scan saved locally.\n\nIt will sync automatically when you're back online.\n\n(${pendingCount} scan${pendingCount !== 1 ? 's' : ''} pending)`,
                        type: 'warning'
                    });

                    // Trigger haptic feedback for offline save
                    this.triggerHaptic('warning');

                    // Auto-close modal after 3 seconds
                    setTimeout(() => this.closeModal(), 3000);

                    // Don't throw - we've saved it offline
                    return;
                }
            }
        } else {
            // Fallback to localStorage (offline mode)
            console.log('Saving to localStorage (no session or supabaseClient not available)', { supabaseClient: !!supabaseClient, sessionId });
            const scan = {
                id: 'scan:' + Date.now(),
                timestamp: Date.now(),
                date: new Date().toLocaleDateString(),
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                raw: parsedData.raw,
                batchNumber: parsedData.batchNumber,
                palletNumber: parsedData.palletNumber,
                casesOnPallet: parsedData.casesOnPallet,
                actualCases: actualCases,
                scannedBy: userName,
                stockCode: parsedData.stockCode,
                description: parsedData.description,
                valid: parsedData.valid,
                deviceId: DEVICE_ID,
                sessionType: sessionType,
                expiryDate: parsedData.expiryDate || null,
                isRawMaterial: parsedData.isRawMaterial || false,
                location: locationPayload.location,
                site: locationPayload.site,
                aisle: locationPayload.aisle,
                rack: locationPayload.rack,
                unitType: parsedData.unitType || (sessionType === 'RM' ? 'kg' : 'cases')
            };

            localStorage_db.set(scan.id, scan);
        }

        await this.loadScans();

        // Clear the pending scan key now that save is complete
        if (this.currentScan) {
            const scanKey = this.getScanKey(this.currentScan);
            this.pendingScanKeys.delete(scanKey);
        }

        this.currentScan = null;
        this.showingCaseEntry = false;
        // Clear pending render flag since we're rendering now
        this._pendingRender = false;
        this.triggerHaptic('success');
        this.render();
    }

    editScan(id) {
        console.log('editScan called with id:', id, 'type:', typeof id);
        console.log('Available scan IDs:', this.scans.map(s => ({ id: s.id, type: typeof s.id })));

        // Convert both to strings for comparison to handle UUID vs string mismatches
        const scan = this.scans.find(s => String(s.id) === String(id));
        console.log('Found scan:', scan);
        if (!scan) {
            console.error('Scan not found for id:', id);
            alert('Could not find scan to edit');
            return;
        }

        this.showModal({
            title: 'Edit Scan',
            message: `Editing ${scan.stockCode}`,
            type: 'form',
            fields: [
                {
                    name: 'actualCases',
                    label: 'Quantity',
                    type: 'number',
                    value: scan.actualCases,
                    required: true
                },
                {
                    name: 'batchNumber',
                    label: 'Batch Number',
                    type: 'text',
                    value: scan.batchNumber || '',
                    required: true
                }
            ],
            confirmText: 'Save Changes',
            onConfirm: (data) => this.saveEditedScan(id, data)
        });
    }

    async saveEditedScan(id, data) {
        // Convert to string for comparison
        const scanIndex = this.scans.findIndex(s => String(s.id) === String(id));
        if (scanIndex === -1) return;

        const scan = this.scans[scanIndex];
        const oldCases = scan.actualCases;
        const newCases = parseFloat(data.actualCases);
        const newBatch = data.batchNumber;

        if (isNaN(newCases)) {
            alert('Invalid quantity');
            return;
        }

        // Update local state
        scan.actualCases = newCases;
        scan.batchNumber = newBatch;

        // Update supabaseClient if connected
        if (supabaseClient && this.activeStockTake?.id) {
            try {
                const { error } = await supabaseClient
                    .from('stock_scans')
                    .update({
                        actual_cases: newCases,
                        batch_number: newBatch
                    })
                    .eq('id', id);

                if (error) throw error;

                await logClientEvent('scan-edit', 'info', this.activeStockTake.id, {
                    scanId: id,
                    oldCases,
                    newCases,
                    newBatch
                });

            } catch (err) {
                console.error('Failed to update scan in supabaseClient:', err);
                alert('Scan updated locally but failed to sync to supabaseClient.');
            }
        } else {
            // Offline mode - update localStorage
            localStorage_db.set(id, scan);
        }

        this.render();
    }

    async deleteScan(id) {
        // Find the scan to show in confirmation (use string comparison)
        const scan = this.scans.find(s => String(s.id) === String(id));
        const scanInfo = scan ? `${scan.stockCode} - ${scan.description}` : 'this scan';

        // Use custom confirm dialog
        const confirmed = await new Promise(resolve => {
            this.showModal({
                title: 'Delete Scan',
                message: `Are you sure you want to delete ${scanInfo}?`,
                type: 'confirm',
                confirmText: 'Delete',
                cancelText: 'Cancel',
                onConfirm: () => resolve(true),
                onCancel: () => resolve(false)
            });
        });

        if (!confirmed) return;

        if (supabaseClient) {
            // Delete from stock_scans table
            try {
                const { error } = await supabaseClient
                    .from('stock_scans')
                    .delete()
                    .eq('id', id);

                if (error) {
                    console.error('supabaseClient delete error:', error);
                    await logClientEvent('scan-delete-failed', 'error', this.activeStockTake?.id || null, { scanId: id, message: error.message });
                    throw error;
                }

                console.log('Deleted from stock_scans:', id);
                await logClientEvent('scan-delete', 'warning', this.activeStockTake?.id || null, { scanId: id });
            } catch (err) {
                console.error('Failed to delete from supabaseClient:', err);
                alert('Failed to delete scan from database.');
                return;
            }
        } else {
            localStorage_db.delete(id);
        }

        // Remove from local scans array immediately (use string comparison)
        this.scans = this.scans.filter(s => String(s.id) !== String(id));
        this.triggerHaptic('heavy');
        this.render();
    }

    async submitCaseCount() {
        const input = document.getElementById('caseInput');
        const isKg = this.currentScan?.unitType === 'kg';
        const actualCases = isKg ? parseFloat(input.value) : parseInt(input.value);

        console.log('submitCaseCount called:', { value: input?.value, isKg, actualCases, currentScan: this.currentScan });

        if (isNaN(actualCases) || actualCases < 0) {
            alert(isKg ? 'Please enter a valid weight in kg' : 'Please enter a valid quantity');
            return;
        }

        const save = async () => {
            console.log('save() called, about to call saveScan');
            try {
                await this.saveScan(this.currentScan, actualCases);
                console.log('saveScan completed successfully');
            } catch (err) {
                console.error('Save scan error:', err);
                alert('Failed to save scan. Please try again.');
            }
        };

        if ((this.activeStockTake?.sessionType === 'RM' || this.currentScan?.isRawMaterial) && !this.currentScan?.expiryDate) {
            console.log('RM scan without expiry - showing modal');
            this.showModal({
                title: 'Expiry Date Required',
                message: 'Enter expiry date (DD/MM/YY or YYYY-MM-DD) or leave blank:',
                type: 'input',
                confirmText: 'Continue',
                onConfirm: (data) => {
                    console.log('Expiry modal onConfirm called:', data);
                    const manualExpiry = data.value;
                    if (manualExpiry && manualExpiry.trim() !== '') {
                        // Convert DD/MM/YY to YYYY-MM-DD if needed
                        const convertedExpiry = convertDMYtoYMD(manualExpiry.trim());
                        const parsedDate = new Date(convertedExpiry);
                        if (isNaN(parsedDate.getTime())) {
                            alert('Invalid expiry date format. Please use DD/MM/YY or YYYY-MM-DD.');
                            return;
                        }
                        this.currentScan.expiryDate = convertedExpiry;
                        console.log('Calling save with expiry:', this.currentScan.expiryDate);
                        save();
                    } else {
                        console.log('No expiry entered - showing confirmation modal');
                        this.showModal({
                            title: 'Confirm No Expiry',
                            message: 'No expiry date will be recorded. Continue?',
                            type: 'confirm',
                            confirmText: 'Yes, Continue',
                            cancelText: 'Go Back',
                            onConfirm: () => {
                                console.log('No-expiry confirmation - calling save');
                                save();
                            }
                        });
                    }
                }
            });
            return;
        }

        await save();
    }

    cancelCaseEntry() {
        // Clear the pending scan key when cancelling
        if (this.currentScan) {
            const scanKey = this.getScanKey(this.currentScan);
            this.pendingScanKeys.delete(scanKey);
        }

        this.currentScan = null;
        this.showingCaseEntry = false;
        // Check if a render was deferred during sync while case entry was open
        if (this._pendingRender) {
            this._pendingRender = false;
        }
        this.render();
    }

    async toggleSessionPause() {
        if (!this.activeStockTake?.id) return;
        const nextStatus = this.activeStockTake.status === 'paused' ? 'active' : 'paused';

        const processStatusChange = async (reason) => {
            if (supabaseSessionsEnabled) {
                await changeSessionStatusSupabase(this.activeStockTake, nextStatus, reason, {});
            } else {
                await updateSession(this.activeStockTake.date, this.activeStockTake.id, { status: nextStatus });
            }
            this.activeStockTake = { ...this.activeStockTake, status: nextStatus };
            setActiveStockTake(this.activeStockTake);
            if (nextStatus === 'paused') {
                this.stopHeartbeat('paused');
                this.triggerHaptic('warning');
            } else {
                if (supabaseSessionsEnabled) {
                    this.startHeartbeat('active');
                }
                this.triggerHaptic('success');
            }
            this.render();
        };

        if (nextStatus === 'paused') {
            this.showModal({
                title: 'Pause Session',
                message: 'Reason for pausing (optional):',
                type: 'input',
                confirmText: 'Pause',
                onConfirm: (data) => {
                    processStatusChange(data.value || 'Paused manually');
                }
            });
        } else {
            await processStatusChange('Resumed manually');
        }
    }

    selectExpiryDate(expiryDate) {
        if (!this.pendingScan) return;

        // Set the selected expiry date
        this.pendingScan.expiryDate = expiryDate;
        this.pendingScan.needsExpiryConfirmation = false;

        this.showingExpirySelection = false;

        // RM items allow duplicates (same item can be in different locations)
        const parsed = this.pendingScan;
        this.pendingScan = null;

        // Proceed directly to case entry
        this.currentScan = parsed;
        this.showingCaseEntry = true;
        this.render();
    }

    cancelExpirySelection() {
        this.pendingScan = null;
        this.showingExpirySelection = false;
        this.render();
    }

    manualEntry() {
        this.stopScanning();
        const sessionType = this.activeStockTake?.sessionType || 'FP';

        if (sessionType === 'FP') {
            // FP: Allow entering 13-digit full code OR 5-digit batch code
            this.showModal({
                title: 'Type Code',
                message: 'Enter 13-digit barcode OR 5-digit batch number:',
                type: 'input',
                confirmText: 'Process',
                onConfirm: (data) => {
                    const code = (data.value || '').trim();
                    if (!code) return;

                    // Check if it's a full 13-digit code
                    if (/^\d{13}$/.test(code)) {
                        // Process as normal barcode
                        this.onScanSuccess(code);
                        return;
                    }

                    // Check if it's a 5-digit batch code
                    if (/^\d{5}$/.test(code)) {
                        // Lookup product in database
                        const productInfo = productDatabase[code];
                        if (!productInfo || productInfo.stockCode === 'UNKNOWN') {
                            // Product not found - show search to select product
                            // Create a partial parsed object for manual entry
                            const manualParsed = {
                                valid: true,
                                batchNumber: code,
                                palletNumber: 'MANUAL',
                                casesOnPallet: 0,
                                isUnknownProduct: true,
                                isManualEntry: true
                            };

                            // Generate scanKey for duplicate prevention
                            const timestamp = Date.now().toString().slice(-8);
                            const rawCode = code.padStart(5, '0') + timestamp;
                            manualParsed.raw = rawCode;
                            const scanKey = `${code}-MANUAL-${rawCode}`;

                            // Store data for after product selection
                            this._unknownFPParsed = manualParsed;
                            this._unknownFPScanKey = scanKey;

                            // Show product search modal
                            this._showFPProductSearch(manualParsed, scanKey);
                            return;
                        }

                        // Product found - now ask for number of cases
                        this.showModal({
                            title: 'Enter Case Count',
                            message: `Product: ${productInfo.stockCode}\n${productInfo.description}\n\nEnter number of cases:`,
                            type: 'input',
                            confirmText: 'Save',
                            onConfirm: (caseData) => {
                                const cases = parseInt(caseData.value, 10);
                                if (isNaN(cases) || cases < 0) {
                                    alert('Please enter a valid number of cases');
                                    return;
                                }

                                // Generate a 13-digit raw code for manual entry
                                // Format: 5-digit batch + 8-digit timestamp (last 8 chars of epoch)
                                const timestamp = Date.now().toString().slice(-8);
                                const rawCode = code.padStart(5, '0') + timestamp;

                                // Create a manual entry scan object
                                const manualScan = {
                                    valid: true,
                                    raw: rawCode, // 13-digit code for database constraint
                                    batchNumber: code,
                                    palletNumber: 'MANUAL',
                                    casesOnPallet: cases,
                                    stockCode: productInfo.stockCode,
                                    description: productInfo.description,
                                    isManualEntry: true
                                };

                                // Save the scan directly
                                this.saveScan(manualScan, cases).then(() => {
                                    // Show success feedback
                                    if (navigator.vibrate) navigator.vibrate(200);
                                }).catch(err => {
                                    console.error('Failed to save manual entry:', err);
                                    alert('Failed to save. Please try again.');
                                });
                            }
                        });
                        return;
                    }

                    // Invalid format
                    alert('Please enter either:\n• 13 digits (full barcode)\n• 5 digits (batch code only)');
                }
            });
        } else {
            // RM: Keep existing behavior - enter full code
            this.showModal({
                title: 'Manual Entry',
                message: 'Enter the QR code manually:',
                type: 'input',
                confirmText: 'Process',
                onConfirm: (data) => {
                    if (data.value && data.value.trim()) {
                        this.onScanSuccess(data.value.trim());
                    }
                }
            });
        }
    }

    showProductDatabase() {
        // Show appropriate database based on session type
        if (this.activeStockTake?.sessionType === 'RM') {
            this.showingRMProductDB = true;
        } else {
            this.showingProductDB = true;
        }
        this.render();
    }

    hideProductDatabase() {
        this.showingProductDB = false;
        this.showingRMProductDB = false;
        this.render();
    }

    showSettings() {
        this.showingStartStockTake = false;
        this.showingSettings = true;
        this.render();
    }

    hideSettings() {
        this.showingSettings = false;
        this.showingStartStockTake = true;
        this.refreshSessionsFromSupabase(); // Refresh sessions when returning to start screen
        this.render();
    }

    goHome() {
        // Stop current session activities but don't end the session
        this.stopAutoSync();
        this.stopHeartbeat();
        clearActiveStockTake();
        this.activeStockTake = null;
        this.scans = [];
        this.selectedStockTakeType = null;
        this.showingStartStockTake = true;
        this.refreshSessionsFromSupabase(); // Refresh sessions when going home
        this.render();
    }

    // Session History Methods
    showSessionHistory() {
        this.showingStartStockTake = false;
        this.showingSessionHistory = true;
        this.loadAvailableSessions();
        this.render();
    }

    hideSessionHistory() {
        this.showingSessionHistory = false;
        this.historyDate = null;
        this.historySessions = [];
        this.historyScans = [];
        this.showingStartStockTake = true;
        this.render();
    }

    async loadAvailableSessions() {
        // Get all unique sessions from localStorage
        const allSessions = [];
        const seenSessionIds = new Set();
        const activeSessionIds = new Set();
        const today = new Date().toLocaleDateString('en-CA');

        // First, get the current active session from activeStockTake
        const activeStockTake = getActiveStockTake();
        if (activeStockTake && activeStockTake.id) {
            activeSessionIds.add(activeStockTake.id);
        }

        // Also check for any sessions stored with 'active' status in localStorage
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('stocktake_')) {
                try {
                    const session = JSON.parse(localStorage.getItem(key));
                    if (session && session.id && session.status === 'active') {
                        activeSessionIds.add(session.id);
                    }
                } catch (e) {
                    // Ignore parsing errors for this check
                }
            }
        }

        // Now load all sessions from localStorage
        const role = getUserRole();
        const displayName = getDisplayName();
        const userWarehouse = getUserWarehouse();

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('stocktake_')) {
                try {
                    const session = JSON.parse(localStorage.getItem(key));
                    if (session && session.id && !seenSessionIds.has(session.id)) {
                        // Filter by warehouse for non-admin users
                        if (role !== 'admin' && userWarehouse) {
                            const sessionWarehouse = session.warehouse || '';
                            // Only show sessions that match user's warehouse
                            if (sessionWarehouse !== userWarehouse) {
                                continue; // Skip sessions from different warehouse
                            }
                        }

                        seenSessionIds.add(session.id);
                        // Determine if session is active
                        const isActive = activeSessionIds.has(session.id);
                        allSessions.push({
                            id: session.id,
                            date: session.date,
                            sessionType: session.sessionType || 'FP',
                            device: session.device || 'Unknown',
                            startTime: session.startTime,
                            endTime: session.endTime,
                            status: isActive ? 'active' : (session.status || 'completed'),
                            startedBy: session.startedBy || session.userName,
                            warehouse: session.warehouse || '',
                            deviceCount: session.devices?.length || 0,
                            activeDeviceCount: session.devices?.filter(d => d.status === 'active').length || 0,
                            devices: session.devices || []
                        });
                    }
                } catch (e) {
                    console.error('Error parsing session:', e);
                }
            }
        }

        // Also load sessions from supabaseClient if available
        if (supabaseClient && this.isBrowserOnline) {
            try {
                // Get sessions from stock_takes table (has started_by info)
                const { data: stockTakesData, error: stockTakesError } = await supabaseClient
                    .from('stock_takes')
                    .select('id, session_type, take_date, status, started_by, started_at, metadata')
                    .order('take_date', { ascending: false })
                    .order('started_at', { ascending: false });

                if (!stockTakesError && stockTakesData) {
                    const role = getUserRole();
                    const userWarehouse = getUserWarehouse();

                    stockTakesData.forEach(session => {
                        if (session.id && !seenSessionIds.has(session.id)) {
                            // Filter by warehouse for non-admin users
                            if (role !== 'admin' && userWarehouse) {
                                const sessionWarehouse = session.metadata?.warehouse || '';
                                // Only show sessions that match user's warehouse
                                if (sessionWarehouse !== userWarehouse) {
                                    return; // Skip sessions from different warehouse
                                }
                            }

                            const isActive = activeSessionIds.has(session.id);
                            const startTime = session.started_at
                                ? new Date(session.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                : '';

                            // Get creator device from metadata or first device in list
                            const creatorDevice = session.metadata?.devices?.[0]?.deviceId || session.started_by || 'Unknown';

                            allSessions.push({
                                id: session.id,
                                date: session.take_date,
                                sessionType: session.session_type || 'FP',
                                device: creatorDevice,
                                startTime: startTime,
                                status: isActive ? 'active' : (session.status || 'completed'),
                                startedBy: session.started_by,
                                warehouse: session.metadata?.warehouse || '',
                                deviceCount: session.metadata?.devices?.length || 0,
                                devices: session.metadata?.devices || []
                            });
                            seenSessionIds.add(session.id);
                        }
                    });

                    // Fetch device counts from session_devices table for all sessions
                    const sessionIdsToFetch = stockTakesData.map(s => s.id).filter(Boolean);
                    if (sessionIdsToFetch.length > 0) {
                        try {
                            const { data: deviceData, error: deviceError } = await supabaseClient
                                .from('session_devices')
                                .select('session_id, device_id, user_name, status')
                                .in('session_id', sessionIdsToFetch);

                            if (!deviceError && deviceData) {
                                // Group by session_id
                                const devicesBySession = {};
                                deviceData.forEach(d => {
                                    if (!devicesBySession[d.session_id]) {
                                        devicesBySession[d.session_id] = [];
                                    }
                                    devicesBySession[d.session_id].push(d);
                                });

                                // Update session device counts
                                allSessions.forEach(session => {
                                    const sessionDevices = devicesBySession[session.id] || [];
                                    session.deviceCount = sessionDevices.length;
                                    session.activeDeviceCount = sessionDevices.filter(d => d.status === 'active').length;
                                    session.deviceUsers = [...new Set(sessionDevices.map(d => d.user_name).filter(Boolean))];
                                });
                            }
                        } catch (e) {
                            console.warn('Failed to fetch device counts:', e);
                        }
                    }
                }

                // Fallback: also check stock_scans for any sessions not in stock_takes
                const { data, error } = await supabaseClient
                    .from('stock_scans')
                    .select('session_id, session_type, scanned_at, device_id, scanned_by')
                    .order('scanned_at', { ascending: false });

                if (!error && data) {
                    const role = getUserRole();
                    const userWarehouse = getUserWarehouse();

                    // Group by session_id to get unique sessions
                    const sessionMap = new Map();
                    data.forEach(scan => {
                        if (scan.session_id && !sessionMap.has(scan.session_id) && !seenSessionIds.has(scan.session_id)) {
                            const scanDate = new Date(scan.scanned_at);
                            const sessionDate = scanDate.toLocaleDateString('en-CA');
                            // Check if this is an active session
                            const isActive = activeSessionIds.has(scan.session_id);
                            sessionMap.set(scan.session_id, {
                                id: scan.session_id,
                                date: sessionDate,
                                sessionType: scan.session_type || 'FP',
                                device: scan.device_id || 'Unknown',
                                startTime: scanDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                                status: isActive ? 'active' : 'completed',
                                startedBy: scan.scanned_by // Use first scanner as proxy for creator
                            });
                            seenSessionIds.add(scan.session_id);
                        }
                    });

                    // Add sessions to list (stock_scans don't have warehouse info, so include all for fallback)
                    sessionMap.forEach(session => {
                        allSessions.push(session);
                    });
                }
            } catch (e) {
                console.error('Error loading sessions from supabaseClient:', e);
            }
        }

        // Sort by date descending, with active sessions first
        allSessions.sort((a, b) => {
            // Active sessions come first
            if (a.status === 'active' && b.status !== 'active') return -1;
            if (b.status === 'active' && a.status !== 'active') return 1;
            const dateCompare = (b.date || '').localeCompare(a.date || '');
            if (dateCompare !== 0) return dateCompare;
            return (b.startTime || '').localeCompare(a.startTime || '');
        });

        this.historySessions = allSessions;
        this.render(); // Re-render after loading sessions
    }

    async loadSessionHistory(sessionId) {
        // Find the session first
        const session = this.historySessions.find(s => s.id === sessionId);
        if (!session) {
            alert('Session not found');
            return;
        }

        // Set session and show loading state immediately (don't clear scans yet)
        this.selectedHistorySession = session;
        this.historyLoading = true;
        this.render(); // Show loading indicator immediately

        if (!supabaseClient) {
            this.historyLoading = false;
            this.historyScans = [];
            alert('Session history requires supabaseClient connectivity.');
            this.render();
            return;
        }

        if (!this.isBrowserOnline) {
            this.historyLoading = false;
            this.historyScans = [];
            alert('Session history is unavailable while offline.');
            this.render();
            return;
        }

        try {
            const { data, error } = await supabaseClient
                .from('stock_scans')
                .select('id,batch_number,stock_code,description,actual_cases,pallet_number,location,site,aisle,rack,expiry_date,unit_type,scanned_at,scanned_by')
                .eq('session_id', sessionId)
                .order('scanned_at', { ascending: true });

            if (error) throw error;

            this.historyScans = (data || []).map(item => ({
                id: item.id,
                batchNumber: item.batch_number,
                stockCode: item.stock_code,
                description: item.description,
                cases: item.actual_cases,
                palletNumber: item.pallet_number,
                location: item.location,
                site: item.site,
                aisle: item.aisle,
                rack: item.rack,
                expiryDate: item.expiry_date,
                unitType: item.unit_type || (session.sessionType === 'RM' ? 'kg' : 'cases'),
                timestamp: item.scanned_at,
                scannedBy: item.scanned_by
            }));
        } catch (error) {
            console.error('Error loading history scans:', error);
            await logClientEvent('history-load-failed', 'error', sessionId, { message: error.message });
            this.historyScans = [];
            alert('Error loading session scans. Check console for details.');
        }

        this.historyLoading = false;
        this.render();
    }

    exportHistorySession() {
        if (!this.selectedHistorySession || this.historyScans.length === 0) {
            alert('No session data to export');
            return;
        }

        const session = this.selectedHistorySession;

        // Prepare export data
        const exportData = this.historyScans.map(scan => {
            const base = {
                'Stock Code': scan.stockCode,
                'Description': scan.description,
                'Batch Number': scan.batchNumber
            };

            if (session.sessionType === 'RM') {
                base['Quantity'] = scan.cases;
                base['Unit'] = scan.unitType === 'kg' ? 'kg' : 'units';
                base['Location'] = scan.location || '';
                base['Expiry Date'] = scan.expiryDate || '';
            } else {
                base['Cases'] = scan.cases;
                base['Pallet Number'] = scan.palletNumber || '';
                base['Location'] = scan.location || '';
            }
            base['Site'] = scan.site || '';
            base['Aisle'] = scan.aisle || '';
            base['Rack'] = scan.rack || '';

            base['Scanned By'] = scan.scannedBy || '';
            base['Timestamp'] = new Date(scan.timestamp).toLocaleString();

            return base;
        });

        // Create workbook
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(exportData);
        XLSX.utils.book_append_sheet(wb, ws, 'Stock Count');

        // Generate filename
        const sessionTypeLabel = session.sessionType === 'RM' ? 'RawMaterials' : 'FinishedProducts';
        const filename = `StockCount_${sessionTypeLabel}_${session.date}_${session.id.slice(-6)}.xlsx`;

        // Download
        XLSX.writeFile(wb, filename);
    }

    async saveSettings() {
        alert('Database credentials are configured. Use Test Connection to verify.');
    }

    async testConnection() {
        const connected = await db.init();

        if (connected) {
            await this.loadScans();
            if (!this.syncInterval) {
                this.startAutoSync();
            }
            const modeLabel = db.mode === 'supabaseClient' ? 'supabaseClient' : 'local cache';
            if (db.mode === 'localStorage') {
                alert('Connected in offline mode. Data will sync once supabaseClient is reachable.');
            } else {
                alert(`✓ Connected to ${modeLabel} successfully!`);
            }
        } else {
            alert('✗ Connection failed. Check browser console for details.');
        }

        this.render();
    }

    addProduct() {
        this.showModal({
            title: 'Add New Product',
            type: 'form',
            fields: [
                { name: 'batch', label: 'Batch Number', placeholder: '5 digits', required: true },
                { name: 'stockCode', label: 'Stock Code', placeholder: 'e.g. FP123', required: true },
                { name: 'description', label: 'Description', placeholder: 'Product name', required: true }
            ],
            confirmText: 'Add Product',
            onConfirm: async (data) => {
                const { batch, stockCode, description } = data;
                if (!/^\d{5}$/.test(batch)) {
                    alert('Invalid batch number (must be 5 digits)');
                    return;
                }

                productDatabase[batch] = { stockCode, description };
                saveProductDatabase();

                await addProductToSupabase(batch, stockCode, description);

                this.showModal({
                    title: 'Success',
                    message: 'Product added successfully!',
                    type: 'alert'
                });
            }
        });
    }

    addRawMaterial() {
        this.showModal({
            title: 'Add Raw Material',
            type: 'form',
            fields: [
                { name: 'stockCode', label: 'Stock Code', placeholder: 'Starts with letter', required: true },
                { name: 'description', label: 'Description', placeholder: 'Material name', required: true },
                { name: 'batchNumber', label: 'Batch Number (Optional)', placeholder: 'e.g. B123', required: false },
                { name: 'expiryDate', label: 'Expiry Date (Optional)', placeholder: 'YYYY-MM-DD', type: 'date', required: false }
            ],
            confirmText: 'Add Material',
            onConfirm: async (data) => {
                const { stockCode, description, batchNumber, expiryDate } = data;

                if (!/^[A-Za-z]/.test(stockCode)) {
                    alert('Invalid stock code - must start with a letter');
                    return;
                }

                // Add to database
                if (!rawMaterialsDatabase[stockCode]) {
                    rawMaterialsDatabase[stockCode] = { description, batches: {} };
                }
                if (batchNumber) {
                    rawMaterialsDatabase[stockCode].batches[batchNumber] = { expiryDate: expiryDate || null };
                }
                rawMaterialsDatabase[stockCode].description = description;

                saveRawMaterialsDatabase();

                await addRawMaterialToSupabase(stockCode, description, batchNumber, expiryDate);

                this.showModal({
                    title: 'Success',
                    message: 'Raw Material added successfully!',
                    type: 'alert'
                });
            }
        });
    }

    // Quick add unknown scanned item to database - shows scan popup for stock code
    addScannedItemToDatabase(scan) {
        const isRM = scan.sessionType === 'RM';
        const escapedScanId = scan.id.toString().replace(/'/g, "\\'");

        // Show a simple popup with X close, Scan button, and Search button (for FP)
        const popup = document.createElement('div');
        popup.id = 'add-to-db-popup';
        popup.innerHTML = `
                    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[9999]">
                        <div class="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
                            <div class="p-4 border-b border-slate-100 flex items-center justify-between">
                                <h3 class="text-lg font-bold text-slate-900">Add to Database</h3>
                                <button onclick="document.getElementById('add-to-db-popup').remove()" class="p-2 hover:bg-slate-100 rounded-full transition-colors">
                                    <svg class="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                                    </svg>
                                </button>
                            </div>
                            <div class="p-6">
                                <div class="text-center mb-6">
                                    <div class="w-16 h-16 bg-orange-100 rounded-full flex items-center justify-center mx-auto mb-3">
                                        <svg class="w-8 h-8 text-orange-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                                        </svg>
                                    </div>
                                    <p class="text-slate-900 font-medium mb-1">Unknown ${isRM ? 'Material' : 'Product'}</p>
                                    <p class="text-slate-500 text-sm">Batch: <span class="font-mono font-bold">${scan.batchNumber || 'N/A'}</span></p>
                                </div>
                                
                                <div class="space-y-3">
                                    <button onclick="app.scanStockCodeForProduct('${escapedScanId}', ${isRM})" class="w-full bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-xl font-bold shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-3">
                                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/>
                                        </svg>
                                        Scan Stock Code
                                    </button>
                                    
                                    ${!isRM ? `
                                    <button onclick="app.searchProductsForScan('${escapedScanId}')" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-4 rounded-xl font-bold shadow-lg shadow-emerald-200 transition-all flex items-center justify-center gap-3">
                                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                                        </svg>
                                        Search Products
                                    </button>
                                    ` : ''}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
        document.body.appendChild(popup);
    }

    // Search existing products to link to a scan
    searchProductsForScan(scanId) {
        // Close the add-to-db popup
        const popup = document.getElementById('add-to-db-popup');
        if (popup) popup.remove();

        // Find the scan
        const scan = this.scans.find(s => String(s.id) === String(scanId));
        if (!scan) {
            alert('Scan not found');
            return;
        }

        // Store reference for later
        this._searchingScanId = scanId;
        this._searchingScan = scan;

        // Get unique products from database (by stock code)
        const uniqueProducts = {};
        for (const [batch, info] of Object.entries(productDatabase)) {
            if (info.stockCode && !uniqueProducts[info.stockCode]) {
                uniqueProducts[info.stockCode] = {
                    stockCode: info.stockCode,
                    description: info.description || 'No description'
                };
            }
        }
        this._allProducts = Object.values(uniqueProducts).sort((a, b) =>
            a.stockCode.localeCompare(b.stockCode)
        );

        // Create search overlay
        const searchOverlay = document.createElement('div');
        searchOverlay.id = 'product-search-overlay';
        searchOverlay.innerHTML = this._renderProductSearchHTML('');
        document.body.appendChild(searchOverlay);

        // Focus on search input
        setTimeout(() => {
            const input = document.getElementById('product-search-input');
            if (input) input.focus();
        }, 100);
    }

    _renderProductSearchHTML(query) {
        const scan = this._searchingScan;
        const filteredProducts = query.trim() === ''
            ? this._allProducts.slice(0, 20) // Show first 20 if no query
            : this._allProducts.filter(p =>
                p.stockCode.toLowerCase().includes(query.toLowerCase()) ||
                p.description.toLowerCase().includes(query.toLowerCase())
            ).slice(0, 50);

        return `
                    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[9999]">
                        <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col overflow-hidden">
                            <div class="p-4 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
                                <div>
                                    <h3 class="text-lg font-bold text-slate-900">Search Products</h3>
                                    <p class="text-xs text-slate-500">Batch: ${scan?.batchNumber || 'N/A'}</p>
                                </div>
                                <button onclick="app.closeProductSearch()" class="p-2 hover:bg-slate-100 rounded-full transition-colors">
                                    <svg class="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                                    </svg>
                                </button>
                            </div>
                            
                            <div class="p-4 border-b border-slate-100 flex-shrink-0">
                                <div class="relative">
                                    <svg class="w-5 h-5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                                    </svg>
                                    <input 
                                        id="product-search-input"
                                        type="text" 
                                        placeholder="Search by stock code or description..."
                                        value="${query}"
                                        oninput="app.onProductSearchInput(this.value)"
                                        class="w-full pl-10 pr-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                                    />
                                </div>
                            </div>
                            
                            <div class="flex-1 overflow-y-auto p-2">
                                ${filteredProducts.length === 0 ? `
                                    <div class="text-center py-8 text-slate-500">
                                        <svg class="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                        </svg>
                                        <p class="font-medium">No products found</p>
                                        <p class="text-sm mt-1">Try a different search term</p>
                                    </div>
                                ` : filteredProducts.map(product => `
                                    <button 
                                        onclick="app.selectProductForScan('${product.stockCode.replace(/'/g, "\\'")}')"
                                        class="w-full text-left p-3 hover:bg-blue-50 rounded-xl transition-colors flex items-center gap-3 border border-transparent hover:border-blue-200"
                                    >
                                        <div class="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
                                            <span class="text-blue-600 font-bold text-xs">${product.stockCode.substring(0, 3)}</span>
                                        </div>
                                        <div class="flex-1 min-w-0">
                                            <div class="font-bold text-slate-900 text-sm">${product.stockCode}</div>
                                            <div class="text-slate-500 text-xs truncate">${product.description}</div>
                                        </div>
                                        <svg class="w-5 h-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                                        </svg>
                                    </button>
                                `).join('')}
                            </div>
                            
                            <div class="p-4 border-t border-slate-100 flex-shrink-0">
                                <p class="text-xs text-slate-400 text-center">
                                    ${filteredProducts.length} product${filteredProducts.length !== 1 ? 's' : ''} found
                                    ${this._allProducts.length > 0 ? ` (${this._allProducts.length} total)` : ''}
                                </p>
                            </div>
                        </div>
                    </div>
                `;
    }

    onProductSearchInput(query) {
        const overlay = document.getElementById('product-search-overlay');
        if (overlay) {
            overlay.innerHTML = this._renderProductSearchHTML(query);
            // Re-focus input and restore cursor position
            const input = document.getElementById('product-search-input');
            if (input) {
                input.focus();
                input.setSelectionRange(query.length, query.length);
            }
        }
    }

    closeProductSearch() {
        const overlay = document.getElementById('product-search-overlay');
        if (overlay) overlay.remove();
        this._searchingScanId = null;
        this._searchingScan = null;
        this._allProducts = [];
    }

    // FP Product Search during initial scan flow (unknown product)
    _showFPProductSearch(parsed, scanKey) {
        // Get unique products from database (by stock code)
        const uniqueProducts = {};
        for (const [batch, info] of Object.entries(productDatabase)) {
            if (info.stockCode && !uniqueProducts[info.stockCode]) {
                uniqueProducts[info.stockCode] = {
                    stockCode: info.stockCode,
                    description: info.description || 'No description'
                };
            }
        }
        this._fpSearchProducts = Object.values(uniqueProducts).sort((a, b) =>
            a.stockCode.localeCompare(b.stockCode)
        );

        // Create search overlay
        const searchOverlay = document.createElement('div');
        searchOverlay.id = 'fp-product-search-overlay';
        searchOverlay.innerHTML = this._renderFPProductSearchHTML('', parsed);
        document.body.appendChild(searchOverlay);

        // Focus on search input
        setTimeout(() => {
            const input = document.getElementById('fp-product-search-input');
            if (input) input.focus();
        }, 100);
    }

    _renderFPProductSearchHTML(query, parsed) {
        const filteredProducts = query.trim() === ''
            ? this._fpSearchProducts.slice(0, 20)
            : this._fpSearchProducts.filter(p =>
                p.stockCode.toLowerCase().includes(query.toLowerCase()) ||
                p.description.toLowerCase().includes(query.toLowerCase())
            ).slice(0, 50);

        return `
                    <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[9999]">
                        <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col overflow-hidden">
                            <div class="p-4 border-b border-slate-100 flex-shrink-0">
                                <div class="flex items-center justify-between mb-2">
                                    <h3 class="text-lg font-bold text-slate-900">🔍 Select Product</h3>
                                    <button onclick="app._cancelFPProductSearch()" class="p-2 hover:bg-slate-100 rounded-full transition-colors">
                                        <svg class="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                                        </svg>
                                    </button>
                                </div>
                                <div class="bg-orange-50 border border-orange-200 rounded-lg p-3">
                                    <p class="text-orange-800 text-sm font-medium">Unknown Batch: <span class="font-mono">${parsed?.batchNumber || 'N/A'}</span></p>
                                    <p class="text-orange-600 text-xs mt-1">Pallet: ${parsed?.palletNumber || 'N/A'} • Cases: ${parsed?.casesOnPallet || 0}</p>
                                </div>
                            </div>
                            
                            <div class="p-4 border-b border-slate-100 flex-shrink-0">
                                <div class="relative">
                                    <svg class="w-5 h-5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                                    </svg>
                                    <input 
                                        id="fp-product-search-input"
                                        type="text" 
                                        placeholder="Search by stock code or description..."
                                        value="${query}"
                                        oninput="app._onFPProductSearchInput(this.value)"
                                        class="w-full pl-10 pr-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none text-sm"
                                    />
                                </div>
                            </div>
                            
                            <div class="flex-1 overflow-y-auto p-2">
                                ${filteredProducts.length === 0 ? `
                                    <div class="text-center py-8 text-slate-500">
                                        <svg class="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                        </svg>
                                        <p class="font-medium">No products found</p>
                                        <p class="text-sm mt-1">Try a different search term</p>
                                    </div>
                                ` : filteredProducts.map(product => `
                                    <button 
                                        onclick="app._selectFPProduct('${product.stockCode.replace(/'/g, "\\'")}')"
                                        class="w-full text-left p-3 hover:bg-blue-50 rounded-xl transition-colors flex items-center gap-3 border border-transparent hover:border-blue-200"
                                    >
                                        <div class="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
                                            <span class="text-blue-600 font-bold text-xs">${product.stockCode.substring(0, 3)}</span>
                                        </div>
                                        <div class="flex-1 min-w-0">
                                            <div class="font-bold text-slate-900 text-sm">${product.stockCode}</div>
                                            <div class="text-slate-500 text-xs truncate">${product.description}</div>
                                        </div>
                                        <svg class="w-5 h-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                                        </svg>
                                    </button>
                                `).join('')}
                            </div>
                            
                            <div class="p-4 border-t border-slate-100 flex-shrink-0">
                                <p class="text-xs text-slate-400 text-center mb-3">
                                    ${filteredProducts.length} product${filteredProducts.length !== 1 ? 's' : ''} found
                                </p>
                                <button onclick="app._scanStockCodeForFP()" class="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 py-3 rounded-xl font-medium text-sm transition-colors flex items-center justify-center gap-2">
                                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/>
                                    </svg>
                                    Scan Stock Code Instead
                                </button>
                            </div>
                        </div>
                    </div>
                `;
    }

    _onFPProductSearchInput(query) {
        const parsed = this._unknownFPParsed;
        const overlay = document.getElementById('fp-product-search-overlay');
        if (overlay && parsed) {
            overlay.innerHTML = this._renderFPProductSearchHTML(query, parsed);
            const input = document.getElementById('fp-product-search-input');
            if (input) {
                input.focus();
                input.setSelectionRange(query.length, query.length);
            }
        }
    }

    _cancelFPProductSearch() {
        const overlay = document.getElementById('fp-product-search-overlay');
        if (overlay) overlay.remove();
        this._unknownFPParsed = null;
        this._unknownFPScanKey = null;
        this._fpSearchProducts = [];
    }

    _scanStockCodeForFP() {
        // Close search overlay
        const overlay = document.getElementById('fp-product-search-overlay');
        if (overlay) overlay.remove();

        const parsed = this._unknownFPParsed;
        if (!parsed) return;

        // Set up for stock code scan
        this._waitingForFPStockCode = true;

        this.showModal({
            title: '📦 Scan Stock Code',
            message: `Batch: ${parsed.batchNumber}\nPallet: ${parsed.palletNumber}\n\nPlease scan the STOCK CODE barcode on this product.`,
            type: 'alert',
            confirmText: 'Start Scanning',
            onConfirm: () => {
                this.startScanning();
            }
        });
    }

    async _processFPStockCodeScan(stockCode, parsed) {
        // Look for product in database by stock code
        let productInfo = null;
        for (const [batch, info] of Object.entries(productDatabase)) {
            if (info.stockCode === stockCode) {
                productInfo = info;
                break;
            }
        }

        const scanKey = this._unknownFPScanKey;

        if (productInfo) {
            // Found the product - update parsed data
            parsed.stockCode = stockCode;
            parsed.description = productInfo.description;
            parsed.isUnknownProduct = false;

            // Add batch to product database
            productDatabase[parsed.batchNumber] = {
                stockCode: stockCode,
                description: productInfo.description
            };
            saveProductDatabase();

            // Save to supabaseClient products table
            if (supabaseClient) {
                try {
                    await supabaseClient
                        .from('products')
                        .upsert({
                            batch_number: parsed.batchNumber,
                            stock_code: stockCode,
                            description: productInfo.description
                        }, { onConflict: 'batch_number' });
                } catch (err) {
                    console.error('Error adding to supabaseClient:', err);
                }
            }

            // Clear temp storage
            this._unknownFPParsed = null;
            this._unknownFPScanKey = null;

            // Check for duplicate before proceeding to case entry
            const duplicate = await this.checkDuplicate(
                parsed.batchNumber,
                parsed.palletNumber,
                parsed.stockCode,
                parsed.expiryDate
            );

            if (duplicate) {
                const timestamp = duplicate.scanned_at || duplicate.created_at || duplicate.date + ' ' + duplicate.time;
                const scannedByName = duplicate.scanned_by || duplicate.scannedBy || 'Unknown';
                const existingCases = duplicate.actual_cases || duplicate.actualCases || 0;

                if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

                // Store duplicate info for update flow
                parsed.isDuplicatePallet = true;
                parsed.existingScanId = duplicate.id;
                parsed.existingCases = existingCases;

                // Show modal to notify and confirm update
                this.showModal({
                    title: 'Pallet Already Scanned',
                    message: `This pallet has already been scanned!\n\n` +
                        `Stock Code: ${parsed.stockCode}\n` +
                        `Batch: ${parsed.batchNumber}\n` +
                        `Pallet: ${parsed.palletNumber}\n` +
                        `Current Cases: ${existingCases}\n\n` +
                        `Scanned by: ${scannedByName}\n` +
                        `at ${new Date(timestamp).toLocaleString()}\n\n` +
                        `Would you like to update this pallet's count?`,
                    type: 'confirm',
                    confirmText: 'Update Count',
                    cancelText: 'Cancel',
                    onConfirm: () => {
                        // Proceed to case entry to update
                        this.pendingScanKeys.add(scanKey);
                        this.currentScan = parsed;
                        this.showingCaseEntry = true;
                        this.render();
                    }
                });
                return;
            }

            // No duplicate - continue to case entry
            this.pendingScanKeys.add(scanKey);
            this.currentScan = parsed;
            this.showingCaseEntry = true;
            this.render();
        } else {
            // Stock code not in database - ask for description
            this.showModal({
                title: '📝 New Product',
                message: `Stock Code: ${stockCode}\nBatch: ${parsed.batchNumber}\n\nPlease enter the product description:`,
                type: 'confirm',
                fields: [
                    { name: 'description', label: 'Product Description', type: 'text', placeholder: 'e.g., Milk Chocolate 200g' }
                ],
                confirmText: 'Save',
                onConfirm: async (values) => {
                    const description = values.description?.trim();
                    if (!description) {
                        alert('Please enter a description');
                        return;
                    }

                    // Update parsed data
                    parsed.stockCode = stockCode;
                    parsed.description = description;
                    parsed.isUnknownProduct = false;

                    // Add to product database
                    productDatabase[parsed.batchNumber] = {
                        stockCode: stockCode,
                        description: description
                    };
                    saveProductDatabase();

                    // Save to supabaseClient products table
                    if (supabaseClient) {
                        try {
                            await supabaseClient
                                .from('products')
                                .upsert({
                                    batch_number: parsed.batchNumber,
                                    stock_code: stockCode,
                                    description: description
                                }, { onConflict: 'batch_number' });
                        } catch (err) {
                            console.error('Error adding to supabaseClient:', err);
                        }
                    }

                    // Clear temp storage
                    this._unknownFPParsed = null;
                    this._unknownFPScanKey = null;

                    // Check for duplicate before proceeding to case entry
                    const duplicate = await this.checkDuplicate(
                        parsed.batchNumber,
                        parsed.palletNumber,
                        parsed.stockCode,
                        parsed.expiryDate
                    );

                    if (duplicate) {
                        const timestamp = duplicate.scanned_at || duplicate.created_at || duplicate.date + ' ' + duplicate.time;
                        const scannedByName = duplicate.scanned_by || duplicate.scannedBy || 'Unknown';
                        const existingCases = duplicate.actual_cases || duplicate.actualCases || 0;

                        if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

                        // Store duplicate info for update flow
                        parsed.isDuplicatePallet = true;
                        parsed.existingScanId = duplicate.id;
                        parsed.existingCases = existingCases;

                        // Show modal to notify and confirm update
                        this.showModal({
                            title: 'Pallet Already Scanned',
                            message: `This pallet has already been scanned!\n\n` +
                                `Stock Code: ${parsed.stockCode}\n` +
                                `Batch: ${parsed.batchNumber}\n` +
                                `Pallet: ${parsed.palletNumber}\n` +
                                `Current Cases: ${existingCases}\n\n` +
                                `Scanned by: ${scannedByName}\n` +
                                `at ${new Date(timestamp).toLocaleString()}\n\n` +
                                `Would you like to update this pallet's count?`,
                            type: 'confirm',
                            confirmText: 'Update Count',
                            cancelText: 'Cancel',
                            onConfirm: () => {
                                // Proceed to case entry to update
                                this.pendingScanKeys.add(scanKey);
                                this.currentScan = parsed;
                                this.showingCaseEntry = true;
                                this.render();
                            }
                        });
                        return;
                    }

                    // No duplicate - continue to case entry
                    this.pendingScanKeys.add(scanKey);
                    this.currentScan = parsed;
                    this.showingCaseEntry = true;
                    this.render();
                }
            });
        }
    }

    async _selectFPProduct(stockCode) {
        const parsed = this._unknownFPParsed;
        const scanKey = this._unknownFPScanKey;

        // Close search overlay
        const overlay = document.getElementById('fp-product-search-overlay');
        if (overlay) overlay.remove();
        this._fpSearchProducts = [];

        if (!parsed || !scanKey) {
            alert('Scan data lost. Please scan again.');
            this._unknownFPParsed = null;
            this._unknownFPScanKey = null;
            return;
        }

        // Find product info
        let productInfo = null;
        for (const [batch, info] of Object.entries(productDatabase)) {
            if (info.stockCode === stockCode) {
                productInfo = info;
                break;
            }
        }

        if (!productInfo) {
            alert('Product not found');
            return;
        }

        // Update parsed data with product info
        parsed.stockCode = stockCode;
        parsed.description = productInfo.description;
        parsed.isUnknownProduct = false;

        // Add batch to product database
        productDatabase[parsed.batchNumber] = {
            stockCode: stockCode,
            description: productInfo.description
        };
        saveProductDatabase();

        // Save to supabaseClient products table
        if (supabaseClient) {
            try {
                await supabaseClient
                    .from('products')
                    .upsert({
                        batch_number: parsed.batchNumber,
                        stock_code: stockCode,
                        description: productInfo.description
                    }, { onConflict: 'batch_number' });
            } catch (err) {
                console.error('Error adding to supabaseClient:', err);
            }
        }

        // Clear temp storage
        this._unknownFPParsed = null;
        this._unknownFPScanKey = null;

        // Check for duplicate before proceeding to case entry
        const duplicate = await this.checkDuplicate(
            parsed.batchNumber,
            parsed.palletNumber,
            parsed.stockCode,
            parsed.expiryDate
        );

        if (duplicate) {
            const timestamp = duplicate.scanned_at || duplicate.created_at || duplicate.date + ' ' + duplicate.time;
            const scannedByName = duplicate.scanned_by || duplicate.scannedBy || 'Unknown';
            const existingCases = duplicate.actual_cases || duplicate.actualCases || 0;

            if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

            // Store duplicate info for update flow
            parsed.isDuplicatePallet = true;
            parsed.existingScanId = duplicate.id;
            parsed.existingCases = existingCases;

            // Show modal to notify and confirm update
            this.showModal({
                title: 'Pallet Already Scanned',
                message: `This pallet has already been scanned!\n\n` +
                    `Stock Code: ${parsed.stockCode}\n` +
                    `Batch: ${parsed.batchNumber}\n` +
                    `Pallet: ${parsed.palletNumber}\n` +
                    `Current Cases: ${existingCases}\n\n` +
                    `Scanned by: ${scannedByName}\n` +
                    `at ${new Date(timestamp).toLocaleString()}\n\n` +
                    `Would you like to update this pallet's count?`,
                type: 'confirm',
                confirmText: 'Update Count',
                cancelText: 'Cancel',
                onConfirm: () => {
                    // Proceed to case entry to update
                    this.pendingScanKeys.add(scanKey);
                    this.currentScan = parsed;
                    this.showingCaseEntry = true;
                    this.render();
                }
            });
            return;
        }

        // No duplicate - continue to case entry with the updated parsed data
        this.pendingScanKeys.add(scanKey);
        this.currentScan = parsed;
        this.showingCaseEntry = true;
        this.render();
    }

    async selectProductForScan(stockCode) {
        const scanId = this._searchingScanId;
        const scan = this._searchingScan;

        // Close search overlay
        this.closeProductSearch();

        if (!scan || !scanId) {
            alert('Scan reference lost. Please try again.');
            return;
        }

        // Find product info
        let productInfo = null;
        for (const [batch, info] of Object.entries(productDatabase)) {
            if (info.stockCode === stockCode) {
                productInfo = info;
                break;
            }
        }

        if (!productInfo) {
            alert('Product not found');
            return;
        }

        // Add batch to product database
        productDatabase[scan.batchNumber] = {
            stockCode: stockCode,
            description: productInfo.description
        };
        saveProductDatabase();

        // Save to supabaseClient
        if (supabaseClient) {
            try {
                await supabaseClient
                    .from('products')
                    .upsert({
                        batch_number: scan.batchNumber,
                        stock_code: stockCode,
                        description: productInfo.description
                    }, { onConflict: 'batch_number' });
            } catch (err) {
                console.error('Error adding to supabaseClient:', err);
            }
        }

        // Update the scan in local array
        const scanIndex = this.scans.findIndex(s => String(s.id) === String(scanId));
        if (scanIndex >= 0) {
            this.scans[scanIndex].stockCode = stockCode;
            this.scans[scanIndex].description = productInfo.description;
        }

        // Update scan in supabaseClient
        if (supabaseClient && scanId) {
            try {
                await supabaseClient
                    .from('stock_scans')
                    .update({
                        stock_code: stockCode,
                        description: productInfo.description
                    })
                    .eq('id', scanId);
            } catch (err) {
                console.error('Error updating scan in supabaseClient:', err);
            }
        }

        this.showModal({
            title: '✅ Product Linked',
            message: `Batch ${scan.batchNumber} linked to:\n\n${stockCode}\n${productInfo.description}`,
            type: 'alert',
            confirmText: 'OK'
        });

        this.render();
    }

    // Scan stock code and add product to database
    async scanStockCodeForProduct(scanId, isRM) {
        // Close the popup
        const popup = document.getElementById('add-to-db-popup');
        if (popup) popup.remove();

        // Find the scan
        const scan = this.scans.find(s => s.id === scanId);
        if (!scan) {
            alert('Scan not found');
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' }
            });

            // Create scanner overlay
            const overlay = document.createElement('div');
            overlay.id = 'stock-code-scanner';
            overlay.innerHTML = `
                        <div class="fixed inset-0 bg-black z-[10000] flex flex-col">
                            <div class="bg-black/80 p-4 flex items-center justify-between">
                                <span class="text-white font-bold">Scan Stock Code</span>
                                <button onclick="app.cancelStockCodeScan()" class="text-white p-2 hover:bg-white/10 rounded-full">
                                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                                    </svg>
                                </button>
                            </div>
                            <div class="flex-1 relative">
                                <video id="stock-code-video" class="w-full h-full object-cover" autoplay playsinline></video>
                                <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                                    <div class="w-64 h-32 border-2 border-white/50 rounded-lg relative">
                                        <div class="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-blue-400 rounded-tl-lg"></div>
                                        <div class="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-blue-400 rounded-tr-lg"></div>
                                        <div class="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-blue-400 rounded-bl-lg"></div>
                                        <div class="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-blue-400 rounded-br-lg"></div>
                                    </div>
                                </div>
                            </div>
                            <div class="bg-black/80 p-4 text-center text-white text-sm">
                                Point camera at the stock code barcode
                            </div>
                        </div>
                    `;
            document.body.appendChild(overlay);

            const video = document.getElementById('stock-code-video');
            video.srcObject = stream;

            this._stockCodeScannerStream = stream;
            this._stockCodeScanData = { scanId, isRM, scan };

            // Use BarcodeDetector if available
            if ('BarcodeDetector' in window) {
                const detector = new BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code'] });

                const scanFrame = async () => {
                    if (!this._stockCodeScannerStream) return;

                    try {
                        const barcodes = await detector.detect(video);
                        if (barcodes.length > 0) {
                            const stockCode = barcodes[0].rawValue;
                            this.finishStockCodeScan(stockCode);
                            return;
                        }
                    } catch (err) {
                        // Ignore detection errors
                    }

                    if (this._stockCodeScannerStream) {
                        requestAnimationFrame(scanFrame);
                    }
                };

                video.onloadedmetadata = () => {
                    video.play();
                    requestAnimationFrame(scanFrame);
                };
            } else {
                // Fallback: prompt for manual entry
                this.cancelStockCodeScan();
                const stockCode = prompt('BarcodeDetector not supported. Please enter the stock code manually:');
                if (stockCode) {
                    this.processStockCodeScan(stockCode, scan, isRM);
                }
            }
        } catch (err) {
            console.error('Camera access failed:', err);
            alert('Could not access camera. Please check permissions.');
        }
    }

    finishStockCodeScan(stockCode) {
        // Stop scanner
        if (this._stockCodeScannerStream) {
            this._stockCodeScannerStream.getTracks().forEach(track => track.stop());
            this._stockCodeScannerStream = null;
        }

        // Remove overlay
        const overlay = document.getElementById('stock-code-scanner');
        if (overlay) overlay.remove();

        // Process the scanned stock code
        const { scan, isRM } = this._stockCodeScanData || {};
        if (scan && stockCode) {
            this.processStockCodeScan(stockCode, scan, isRM);
        }

        this._stockCodeScanData = null;
    }

    cancelStockCodeScan() {
        // Stop scanner
        if (this._stockCodeScannerStream) {
            this._stockCodeScannerStream.getTracks().forEach(track => track.stop());
            this._stockCodeScannerStream = null;
        }

        // Remove overlay
        const overlay = document.getElementById('stock-code-scanner');
        if (overlay) overlay.remove();

        this._stockCodeScanData = null;
    }

    // Scan stock code for unknown RM product - goes straight into camera
    async scanUnknownStockCode() {
        // Close any popup if exists
        const popup = document.getElementById('unknown-stock-popup');
        if (popup) popup.remove();

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' }
            });

            // Create scanner overlay with message about unknown product
            const overlay = document.createElement('div');
            overlay.id = 'unknown-stock-scanner';
            overlay.innerHTML = `
                        <div class="fixed inset-0 bg-black z-[10000] flex flex-col">
                            <div class="bg-orange-500 p-4 flex items-center justify-between">
                                <div>
                                    <span class="text-white font-bold text-lg">📦 Unknown Product</span>
                                    <p class="text-orange-100 text-sm">Scan the STOCK CODE barcode</p>
                                </div>
                                <button onclick="app.cancelUnknownStockScan()" class="text-white p-2 hover:bg-white/20 rounded-full">
                                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                                    </svg>
                                </button>
                            </div>
                            <div class="flex-1 relative">
                                <video id="unknown-stock-video" class="w-full h-full object-cover" autoplay playsinline></video>
                                <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                                    <div class="w-72 h-36 border-2 border-orange-400/70 rounded-lg relative">
                                        <div class="absolute top-0 left-0 w-10 h-10 border-t-4 border-l-4 border-orange-400 rounded-tl-lg"></div>
                                        <div class="absolute top-0 right-0 w-10 h-10 border-t-4 border-r-4 border-orange-400 rounded-tr-lg"></div>
                                        <div class="absolute bottom-0 left-0 w-10 h-10 border-b-4 border-l-4 border-orange-400 rounded-bl-lg"></div>
                                        <div class="absolute bottom-0 right-0 w-10 h-10 border-b-4 border-r-4 border-orange-400 rounded-br-lg"></div>
                                    </div>
                                </div>
                            </div>
                            <div class="bg-orange-500 p-4 text-center">
                                <p class="text-white font-medium">Point camera at the stock code barcode</p>
                                <p class="text-orange-100 text-sm mt-1">This will confirm the product identity</p>
                            </div>
                        </div>
                    `;
            document.body.appendChild(overlay);

            const video = document.getElementById('unknown-stock-video');
            video.srcObject = stream;

            this._unknownStockScannerStream = stream;

            // Store the original scanned code to ignore it
            const originalCode = this._unknownStockParsed?.raw || '';

            // Use BarcodeDetector if available
            if ('BarcodeDetector' in window) {
                const detector = new BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'qr_code'] });

                const scanFrame = async () => {
                    if (!this._unknownStockScannerStream) return;

                    try {
                        const barcodes = await detector.detect(video);
                        if (barcodes.length > 0) {
                            const stockCode = barcodes[0].rawValue;
                            // Only accept if it's DIFFERENT from the original scan
                            if (stockCode !== originalCode && !originalCode.includes(stockCode) && !stockCode.includes(originalCode)) {
                                this.finishUnknownStockScan(stockCode);
                                return;
                            }
                        }
                    } catch (err) {
                        // Ignore detection errors
                    }

                    if (this._unknownStockScannerStream) {
                        requestAnimationFrame(scanFrame);
                    }
                };

                video.onloadedmetadata = () => {
                    video.play();
                    requestAnimationFrame(scanFrame);
                };
            } else {
                // Fallback: prompt for manual entry
                this.cancelUnknownStockScan();
                const stockCode = prompt('BarcodeDetector not supported. Please enter the stock code manually:');
                if (stockCode) {
                    this.finishUnknownStockScan(stockCode);
                }
            }
        } catch (err) {
            console.error('Camera access failed:', err);
            alert('Could not access camera. Please check permissions.');
            this._unknownStockParsed = null;
            this._unknownStockScanKey = null;
        }
    }

    finishUnknownStockScan(stockCode) {
        // Stop scanner
        if (this._unknownStockScannerStream) {
            this._unknownStockScannerStream.getTracks().forEach(track => track.stop());
            this._unknownStockScannerStream = null;
        }

        // Remove overlay
        const overlay = document.getElementById('unknown-stock-scanner');
        if (overlay) overlay.remove();

        // Process the scanned stock code
        const parsed = this._unknownStockParsed;
        const scanKey = this._unknownStockScanKey;

        if (parsed && stockCode) {
            parsed.stockCode = stockCode.trim();
            parsed.needsStockCodeScan = false;

            // Parse the original string to extract batch, PO, and expiry
            // Format example: "STOCKCODE-BATCH1234-####DD/MM/YY" or "BATCH####DD/MM/YY"
            const rawString = parsed.raw || '';

            // Extract date from end (DD/MM/YY pattern)
            const dateMatch = rawString.match(/(\d{2}\/\d{2}\/\d{2})$/);
            let extractedDate = dateMatch ? dateMatch[1] : null;

            // Extract PO number (4 digits before date)
            let poNumber = null;
            let remainingForBatch = rawString;
            if (extractedDate) {
                const beforeDate = rawString.slice(0, -8); // Remove DD/MM/YY
                const poMatch = beforeDate.match(/(\d{4})$/);
                if (poMatch) {
                    poNumber = poMatch[1];
                    remainingForBatch = beforeDate.slice(0, -4); // Remove PO
                } else {
                    remainingForBatch = beforeDate;
                }
            }

            // The batch is what remains after removing stock code prefix
            let suggestedBatch = remainingForBatch;
            if (remainingForBatch.toUpperCase().startsWith(stockCode.toUpperCase())) {
                suggestedBatch = remainingForBatch.substring(stockCode.length);
            }
            suggestedBatch = suggestedBatch.replace(/^[\-_\s]+/, '').replace(/[\-_\s]+$/, '').trim();

            // Store extracted data
            parsed.extractedExpiry = extractedDate;
            parsed.poNumber = poNumber;
            parsed.suggestedBatch = suggestedBatch;

            // Start the confirmation flow: Batch → Expiry → Description/Type
            this._confirmBatchNumber(parsed, scanKey, stockCode);
        }
    }

    _confirmBatchNumber(parsed, scanKey, stockCode) {
        const suggestedBatch = parsed.suggestedBatch || '';
        const poInfo = parsed.poNumber ? `\nPO Number: ${parsed.poNumber}` : '';

        this.showModal({
            title: '🏷️ Confirm Batch Number',
            message: `Stock Code: ${stockCode}${poInfo}\n\nOriginal scan: ${parsed.raw}\n\nPlease confirm or edit the batch number:`,
            type: 'input',
            confirmText: 'Next',
            cancelText: 'Cancel',
            onConfirm: (formData) => {
                const confirmedBatch = formData.value?.trim() || suggestedBatch;
                if (!confirmedBatch) {
                    alert('Batch number is required');
                    return;
                }
                parsed.batchNumber = confirmedBatch;

                // Next step: Confirm expiry
                this._confirmExpiryDate(parsed, scanKey, stockCode);
            },
            onCancel: () => {
                this._unknownStockParsed = null;
                this._unknownStockScanKey = null;
            }
        });

        // Pre-fill with suggested batch
        setTimeout(() => {
            const input = document.getElementById('modal-input');
            if (input) input.value = suggestedBatch;
        }, 100);
    }

    _confirmExpiryDate(parsed, scanKey, stockCode) {
        const suggestedExpiry = parsed.extractedExpiry || '';

        this.showModal({
            title: '📅 Confirm Expiry Date',
            message: `Stock Code: ${stockCode}\nBatch: ${parsed.batchNumber}\n\nPlease confirm or edit the expiry date (DD/MM/YY):`,
            type: 'input',
            confirmText: 'Next',
            cancelText: 'No Expiry',
            onConfirm: (formData) => {
                const confirmedExpiry = formData.value?.trim() || suggestedExpiry;
                // Convert DD/MM/YY to YYYY-MM-DD format
                parsed.expiryDate = confirmedExpiry ? convertDMYtoYMD(confirmedExpiry) : null;

                // Next step: Description and Type
                this._confirmDescriptionAndType(parsed, scanKey, stockCode);
            },
            onCancel: () => {
                parsed.expiryDate = null;
                // Continue to description
                this._confirmDescriptionAndType(parsed, scanKey, stockCode);
            }
        });

        // Pre-fill with suggested expiry
        setTimeout(() => {
            const input = document.getElementById('modal-input');
            if (input) input.value = suggestedExpiry;
        }, 100);
    }

    _confirmDescriptionAndType(parsed, scanKey, stockCode) {
        // Check if this is a known product with BOTH description AND product type
        const knownRM = rawMaterialsDatabase[parsed.stockCode] || rawMaterialsDatabase[parsed.stockCode.toUpperCase()];
        const knownType = productTypeDatabase[parsed.stockCode.toUpperCase()];

        // Only skip the form if we have BOTH a known type AND description
        if (knownType && knownType.productType && knownRM?.description) {
            // Fully known item - get values from database
            parsed.description = knownRM.description || knownType.description || stockCode;
            parsed.unitType = knownType.productType === 'Ingredient' ? 'kg' : 'units';

            // Skip to quantity entry
            this._finishNewItemFlow(parsed, scanKey);
            return;
        }

        // Get any existing values to pre-fill the form
        const existingDescription = knownRM?.description || knownType?.description || '';
        const existingType = knownType?.productType || 'Ingredient';

        // Unknown or incomplete item - ask for description and type
        this.showModal({
            title: '📝 Product Details',
            message: `Stock Code: ${stockCode}\nBatch: ${parsed.batchNumber}${parsed.expiryDate ? '\nExpiry: ' + parsed.expiryDate : ''}\n\nPlease enter product details:`,
            type: 'form',
            fields: [
                { name: 'description', label: 'Description', placeholder: 'Product Name', value: existingDescription, required: true },
                {
                    name: 'productType',
                    label: 'Product Type',
                    type: 'choice',
                    value: existingType,
                    options: [
                        { label: 'Ingredient', value: 'Ingredient', sublabel: 'Measured in KG' },
                        { label: 'Non-Ingredient', value: 'Non-Ingredient', sublabel: 'Measured in Units' }
                    ]
                }
            ],
            confirmText: 'Save & Continue',
            onConfirm: async (data) => {
                const description = data.description;
                const type = data.productType;
                const isIngredient = type === 'Ingredient';

                if (!description) {
                    alert('Description is required');
                    return;
                }

                // 1. Save Product Type to supabaseClient
                await addProductTypeToSupabase(parsed.stockCode, type, description);

                // 2. Save Raw Material info locally AND to supabaseClient
                if (!rawMaterialsDatabase[parsed.stockCode]) {
                    rawMaterialsDatabase[parsed.stockCode] = { description, batches: {} };
                }
                rawMaterialsDatabase[parsed.stockCode].description = description;
                if (parsed.batchNumber) {
                    if (!rawMaterialsDatabase[parsed.stockCode].batches) {
                        rawMaterialsDatabase[parsed.stockCode].batches = {};
                    }
                    rawMaterialsDatabase[parsed.stockCode].batches[parsed.batchNumber] = {
                        expiryDates: parsed.expiryDate ? [parsed.expiryDate] : []
                    };
                }
                saveRawMaterialsDatabase();

                // 3. Save to supabaseClient raw_materials table
                await addRawMaterialToSupabase(parsed.stockCode, description, parsed.batchNumber, parsed.expiryDate);

                // 4. Update parsed object
                parsed.description = description;
                parsed.unitType = isIngredient ? 'kg' : 'units';

                // 5. Continue to quantity entry
                this._finishNewItemFlow(parsed, scanKey);
            }
        });
    }

    _finishNewItemFlow(parsed, scanKey) {
        // Clear temp storage
        this._unknownStockParsed = null;
        this._unknownStockScanKey = null;

        // RM items allow duplicates (same item can be in different locations)
        // Proceed directly to case entry
        this.pendingScanKeys.add(scanKey);
        this.currentScan = parsed;
        this.showingCaseEntry = true;
        this.render();
    }

    _processBatchAndContinue(parsed, scanKey, stockCode) {
        // Re-extract batch from remaining string
        if (parsed.raw.toUpperCase().startsWith(stockCode.toUpperCase())) {
            const remaining = parsed.raw.substring(stockCode.length);
            // Remove expiry from end if present
            let batchPart = remaining;
            if (parsed.extractedExpiry) {
                batchPart = batchPart.replace(parsed.extractedExpiry, '').trim();
            }
            batchPart = batchPart.replace(/^[\-_\s]+/, '').trim();
            if (batchPart) {
                parsed.batchNumber = batchPart;
                parsed.needsBatchConfirmation = true;
            }
        }

        // Continue to batch confirmation
        this._continueRMScan(parsed, scanKey);
    }

    cancelUnknownStockScan() {
        // Stop scanner
        if (this._unknownStockScannerStream) {
            this._unknownStockScannerStream.getTracks().forEach(track => track.stop());
            this._unknownStockScannerStream = null;
        }

        // Remove overlay
        const overlay = document.getElementById('unknown-stock-scanner');
        if (overlay) overlay.remove();

        // Remove popup if exists
        const popup = document.getElementById('unknown-stock-popup');
        if (popup) popup.remove();

        this._unknownStockParsed = null;
        this._unknownStockScanKey = null;
    }

    async processStockCodeScan(stockCode, scan, isRM) {
        // Look up the stock code in the database to get description and type
        let description = '';
        let productType = 'Non-Ingredient';
        let hasKnownType = false;

        // Check product types database first
        const knownType = productTypeDatabase[stockCode.toUpperCase()];
        if (knownType) {
            productType = knownType.productType || 'Non-Ingredient';
            description = knownType.description || '';
            hasKnownType = true;
        }

        if (isRM) {
            // Check RM database
            if (rawMaterialsDatabase[stockCode]) {
                description = description || rawMaterialsDatabase[stockCode].description || '';
            }
        } else {
            // Check FP database - look for any product with this stock code
            for (const [batch, info] of Object.entries(productDatabase)) {
                if (info.stockCode === stockCode) {
                    description = description || info.description || '';
                    break;
                }
            }
        }

        // If no description or type found, prompt for both
        if (!description || !hasKnownType) {
            // Use modal form to get description and product type
            this.showModal({
                title: '📝 Product Details',
                message: `Adding ${isRM ? 'Raw Material' : 'Product'}: ${stockCode}`,
                type: 'form',
                fields: [
                    { name: 'description', label: 'Description', placeholder: 'Product Name', value: description || '', required: true },
                    {
                        name: 'productType',
                        label: 'Product Type',
                        type: 'choice',
                        value: productType,
                        options: [
                            { label: 'Ingredient', value: 'Ingredient', sublabel: 'Measured in KG' },
                            { label: 'Non-Ingredient', value: 'Non-Ingredient', sublabel: 'Measured in Units' }
                        ]
                    }
                ],
                confirmText: 'Save to Database',
                onConfirm: async (data) => {
                    const finalDescription = data.description;
                    const finalType = data.productType;

                    if (!finalDescription) {
                        alert('Description is required');
                        return;
                    }

                    // Save with description and type
                    await this._saveProductToDatabase(stockCode, finalDescription, finalType, scan, isRM);
                }
            });
            return;
        }

        // Known item - save with existing description and type
        await this._saveProductToDatabase(stockCode, description, productType, scan, isRM);
    }

    async _saveProductToDatabase(stockCode, description, productType, scan, isRM) {
        const isIngredient = productType === 'Ingredient';
        const unitType = isIngredient ? 'kg' : 'units';

        // 1. Save product type to database
        await addProductTypeToSupabase(stockCode, productType, description);

        if (isRM) {
            // Add to RM database
            if (!rawMaterialsDatabase[stockCode]) {
                rawMaterialsDatabase[stockCode] = { description, batches: {} };
            }
            rawMaterialsDatabase[stockCode].description = description;
            if (scan.batchNumber) {
                if (!rawMaterialsDatabase[stockCode].batches) {
                    rawMaterialsDatabase[stockCode].batches = {};
                }
                rawMaterialsDatabase[stockCode].batches[scan.batchNumber] = {
                    expiryDates: scan.expiryDate ? [scan.expiryDate] : []
                };
            }
            saveRawMaterialsDatabase();

            // Add to supabaseClient raw materials
            await addRawMaterialToSupabase(stockCode, description, scan.batchNumber, scan.expiryDate);

            // Update the scan
            const scanIndex = this.scans.findIndex(s => s.id === scan.id);
            if (scanIndex >= 0) {
                this.scans[scanIndex].stockCode = stockCode;
                this.scans[scanIndex].description = description;
                this.scans[scanIndex].unitType = unitType;
            }

            // Update scan in supabaseClient if it exists
            if (supabaseClient && scan.id) {
                try {
                    await supabaseClient
                        .from('stock_scans')
                        .update({
                            stock_code: stockCode,
                            description: description,
                            unit_type: unitType
                        })
                        .eq('id', scan.id);
                } catch (err) {
                    console.error('Error updating scan in supabaseClient:', err);
                }
            }

            this.showModal({
                title: 'Success',
                message: `"${stockCode}" added to database!\nType: ${productType} (${unitType})`,
                type: 'alert',
                confirmText: 'OK'
            });
        } else {
            // Add to FP database
            productDatabase[scan.batchNumber] = { stockCode, description };
            saveProductDatabase();

            // Add to supabaseClient
            if (supabaseClient) {
                try {
                    await supabaseClient
                        .from('products')
                        .upsert({
                            batch_number: scan.batchNumber,
                            stock_code: stockCode,
                            description: description
                        }, { onConflict: 'batch_number' });
                } catch (err) {
                    console.error('Error adding to supabaseClient:', err);
                }
            }

            // Update the scan
            const scanIndex = this.scans.findIndex(s => s.id === scan.id);
            if (scanIndex >= 0) {
                this.scans[scanIndex].stockCode = stockCode;
                this.scans[scanIndex].description = description;
            }

            // Update scan in supabaseClient if it exists
            if (supabaseClient && scan.id) {
                try {
                    await supabaseClient
                        .from('stock_scans')
                        .update({
                            stock_code: stockCode,
                            description: description
                        })
                        .eq('id', scan.id);
                } catch (err) {
                    console.error('Error updating scan in supabaseClient:', err);
                }
            }

            this.showModal({
                title: 'Success',
                message: `Product "${stockCode}" added to database!`,
                type: 'alert',
                confirmText: 'OK'
            });
        }

        this.render();
    }

    addProductType() {
        this.showModal({
            title: 'Add Product Type',
            type: 'form',
            fields: [
                { name: 'stockCode', label: 'Stock Code', placeholder: 'e.g. RM001, FP123', required: true },
                { name: 'type', label: 'Type', placeholder: 'Ingredient or Non-Ingredient', required: true },
                { name: 'description', label: 'Description', placeholder: 'Product description', required: true }
            ],
            confirmText: 'Add Product Type',
            onConfirm: async (data) => {
                const { stockCode, type, description } = data;

                if (!stockCode || !type || !description) {
                    alert('All fields are required');
                    return;
                }

                const result = await addProductTypeToSupabase(stockCode, type, description);

                if (result.success) {
                    this.showModal({
                        title: 'Success',
                        message: 'Product type added successfully!',
                        type: 'alert'
                    });
                } else if (result.exists) {
                    this.showModal({
                        title: 'Already Exists',
                        message: `Product with stock code "${stockCode.toUpperCase()}" already exists in the database.`,
                        type: 'alert'
                    });
                } else {
                    alert('Failed to add product type: ' + result.error);
                }
            }
        });
    }

    async importProductTypes() {
        // Create file input dynamically
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.xlsx,.xls,.csv';
        fileInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            try {
                const data = await file.arrayBuffer();
                const workbook = XLSX.read(data);
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const json = XLSX.utils.sheet_to_json(sheet);

                if (json.length === 0) {
                    alert('No data found in the file');
                    return;
                }

                // Map columns - expect: type, stock_code, description
                // Also support: Type, Stock Code, Description (case insensitive)
                const products = json.map(row => {
                    // Find the columns (case insensitive)
                    const keys = Object.keys(row);
                    const findKey = (names) => keys.find(k => names.includes(k.toLowerCase().replace(/[_\s]/g, '')));

                    const typeKey = findKey(['type', 'producttype']);
                    const stockCodeKey = findKey(['stockcode', 'stock_code', 'code', 'sku']);
                    const descKey = findKey(['description', 'desc', 'name', 'productname']);

                    return {
                        type: row[typeKey] || 'Non-Ingredient',
                        stock_code: row[stockCodeKey] || '',
                        description: row[descKey] || ''
                    };
                }).filter(p => p.stock_code); // Only include rows with stock code

                if (products.length === 0) {
                    alert('No valid products found. Make sure your file has columns: stock_code, type, description');
                    return;
                }

                // Show confirmation
                this.showModal({
                    title: 'Confirm Import',
                    message: `Found ${products.length} products in the file.\n\nOnly NEW products will be added.\nExisting products will be skipped.\n\nProceed with import?`,
                    type: 'confirm',
                    confirmText: 'Import',
                    cancelText: 'Cancel',
                    onConfirm: async () => {
                        const result = await bulkAddProductTypesToSupabase(products);

                        if (result.success) {
                            this.showModal({
                                title: 'Import Complete',
                                message: `Added: ${result.added} products\nSkipped (already exist): ${result.skipped} products`,
                                type: 'alert'
                            });
                            this.render();
                        } else {
                            alert('Import failed: ' + result.error);
                        }
                    }
                });
            } catch (err) {
                console.error('Error reading file:', err);
                alert('Error reading file: ' + err.message);
            }
        };
        fileInput.click();
    }

    async refreshProductsFromCloud() {
        if (!supabaseClient) {
            alert('Cloud sync not available');
            return;
        }

        const btn = event.target;
        const originalText = btn.innerHTML;
        btn.innerHTML = '<span class="animate-spin">↻</span> Loading...';
        btn.disabled = true;

        try {
            // Check which view is active, or fall back to active stock take type
            const isRM = this.showingRMProductDB || this.activeStockTake?.sessionType === 'RM';

            if (isRM) {
                const loaded = await loadRawMaterialsFromSupabase(true); // Force reload
                if (loaded) {
                    alert(`Loaded ${Object.keys(rawMaterialsDatabase).length} raw materials from supabaseClient`);
                } else {
                    alert('No raw materials found in supabaseClient or error occurred');
                }
            } else {
                const loaded = await loadProductsFromSupabase(true); // Force reload
                if (loaded) {
                    alert(`Loaded ${Object.keys(productDatabase).length} products from supabaseClient`);
                } else {
                    alert('No products found in supabaseClient or error occurred');
                }
            }
        } catch (err) {
            alert('Error loading products: ' + err.message);
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
        this.render();
    }

    clearRMDatabase() {
        this.showModal({
            title: 'Clear Raw Materials',
            message: 'Are you sure you want to clear all raw materials? This cannot be undone.',
            type: 'confirm',
            confirmText: 'Clear',
            cancelText: 'Cancel',
            onConfirm: () => {
                rawMaterialsDatabase = {};
                saveRawMaterialsDatabase();
                this.render();
            }
        });
    }

    uploadExcel() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.xlsx,.xls,.csv';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const data = new Uint8Array(event.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                    const jsonData = XLSX.utils.sheet_to_json(firstSheet);

                    let imported = 0;
                    jsonData.forEach(row => {
                        const batch = String(row.BatchNumber || row.batchNumber || row['Batch Number'] || '').padStart(5, '0');
                        const stockCode = row.StockCode || row.stockCode || row['Stock Code'];
                        const description = row.Description || row.description;

                        if (batch && stockCode && description && /^\d{5}$/.test(batch)) {
                            productDatabase[batch] = { stockCode, description };
                            imported++;
                        }
                    });

                    saveProductDatabase();
                    alert(`Imported ${imported} products!`);
                    this.render();
                } catch (err) {
                    alert('Error: ' + err.message);
                }
            };
            reader.readAsArrayBuffer(file);
        };
        input.click();
    }

    uploadRMExcel() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.xlsx,.xls,.csv';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const data = new Uint8Array(event.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                    const jsonData = XLSX.utils.sheet_to_json(firstSheet);

                    let imported = 0;
                    jsonData.forEach(row => {
                        const stockCode = row.StockCode || row.stockCode || row['Stock Code'] || row.stock_code;
                        const description = row.Description || row.description || row['Stock Description'] || '';
                        const batchNumber = row.BatchNumber || row.batchNumber || row['Batch Number'] || row.batch_number || '';
                        const expiryDate = row.ExpiryDate || row.expiryDate || row['Expiry Date'] || row.expiry_date || null;

                        if (stockCode) {
                            if (!rawMaterialsDatabase[stockCode]) {
                                rawMaterialsDatabase[stockCode] = { description, batches: {} };
                            }
                            if (description) {
                                rawMaterialsDatabase[stockCode].description = description;
                            }
                            if (batchNumber) {
                                rawMaterialsDatabase[stockCode].batches[batchNumber] = {
                                    expiryDate: expiryDate || null
                                };
                            }
                            imported++;
                        }
                    });

                    saveRawMaterialsDatabase();
                    alert(`Imported ${imported} raw materials!`);
                    this.render();
                } catch (err) {
                    alert('Error: ' + err.message);
                }
            };
            reader.readAsArrayBuffer(file);
        };
        input.click();
    }

    exportProductDatabase() {
        const data = Object.entries(productDatabase).map(([batch, info]) => ({
            BatchNumber: batch,
            StockCode: info.stockCode,
            Description: info.description
        }));

        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Products");
        XLSX.writeFile(wb, "product_database.xlsx");
    }

    exportRMDatabase() {
        const data = [];
        Object.entries(rawMaterialsDatabase).forEach(([stockCode, info]) => {
            if (Object.keys(info.batches || {}).length === 0) {
                data.push({
                    StockCode: stockCode,
                    Description: info.description,
                    BatchNumber: '',
                    ExpiryDate: ''
                });
            } else {
                Object.entries(info.batches).forEach(([batch, batchInfo]) => {
                    data.push({
                        StockCode: stockCode,
                        Description: info.description,
                        BatchNumber: batch,
                        ExpiryDate: batchInfo.expiryDate || ''
                    });
                });
            }
        });

        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Raw Materials");
        XLSX.writeFile(wb, "raw_materials_database.xlsx");
    }

    exportStockCount() {
        const data = this.scans.map(scan => ({
            'Stock Take Date': this.currentTakeDate,
            'Scanned By': scan.scannedBy || 'Unknown',
            'Batch Number': scan.batchNumber,
            'Pallet Number': scan.palletNumber,
            'Stock Code': scan.stockCode,
            'Description': scan.description,
            'Cases on Pallet': scan.casesOnPallet,
            'Actual Cases': scan.actualCases,
            'Variance': scan.actualCases - scan.casesOnPallet,
            'Site': scan.site || '',
            'Aisle': scan.aisle || '',
            'Rack': scan.rack || '',
            'Location Notes': scan.location || '',
            'Scanned At': scan.date + ' ' + scan.time,
            'Device ID': scan.deviceId,
            'Raw QR Code': scan.raw
        }));

        const ws = XLSX.utils.json_to_sheet(data);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Stock Count");

        const filename = `stock_count_${this.currentTakeDate}.xlsx`;
        XLSX.writeFile(wb, filename);
    }

    clearDatabase() {
        this.showModal({
            title: 'Clear Database',
            message: 'Are you sure you want to clear the entire product database?',
            type: 'confirm',
            confirmText: 'Clear',
            cancelText: 'Cancel',
            onConfirm: () => {
                productDatabase = {};
                saveProductDatabase();
                this.showModal({ title: 'Success', message: 'Database cleared', type: 'alert' });
                this.render();
            }
        });
    }

    showModal(config) {
        this.modalState = {
            title: config.title || 'Alert',
            message: config.message || '',
            type: config.type || 'alert', // alert, confirm, input, form
            fields: config.fields || [], // [{name, label, type, value, placeholder, required}]
            confirmText: config.confirmText || 'OK',
            cancelText: config.cancelText || 'Cancel',
            onConfirm: config.onConfirm || (() => { }),
            onCancel: config.onCancel || (() => { })
        };
        this.render();

        // Focus first input if applicable
        setTimeout(() => {
            const firstInput = document.querySelector('#modal-content input');
            if (firstInput) firstInput.focus();
        }, 100);
    }

    closeModal() {
        // Save callback before clearing modal state
        const onCancelCallback = this.modalState?.onCancel;
        this.modalState = null;

        // Call onCancel callback if provided
        if (onCancelCallback) {
            onCancelCallback();
        }

        // Check if a render was deferred during sync while modal was open
        if (this._pendingRender) {
            this._pendingRender = false;
        }
        this.render();
    }

    handleModalSubmit(e) {
        e.preventDefault();
        if (!this.modalState) return;

        const formData = {};
        if (this.modalState.type === 'input') {
            const input = document.getElementById('modal-input');
            formData.value = input ? input.value : '';
        } else if (this.modalState.type === 'form') {
            this.modalState.fields.forEach(field => {
                const input = document.getElementById(`modal-field-${field.name}`);
                if (input) {
                    formData[field.name] = field.type === 'checkbox' ? input.checked : input.value;
                }
            });
        }

        // Save the callback before closing modal (in case callback shows a new modal)
        const onConfirmCallback = this.modalState.onConfirm;
        this.modalState = null; // Clear modal state first

        if (onConfirmCallback) {
            onConfirmCallback(formData);
        }

        // Only render if no new modal was opened
        if (!this.modalState) {
            // Clear pending render flag since we're rendering now
            this._pendingRender = false;
            this.render();
        }
    }

    selectModalChoice(fieldName, value) {
        // Update hidden input
        const input = document.getElementById(`modal-field-${fieldName}`);
        if (input) input.value = value;

        // Update UI
        const buttons = document.querySelectorAll(`.modal-choice-btn-${fieldName}`);
        buttons.forEach(btn => {
            if (btn.id === `modal-choice-${fieldName}-${value}`) {
                btn.classList.remove('border-slate-200', 'text-slate-600');
                btn.classList.add('border-blue-600', 'bg-blue-50', 'text-blue-700');
            } else {
                btn.classList.add('border-slate-200', 'text-slate-600');
                btn.classList.remove('border-blue-600', 'bg-blue-50', 'text-blue-700');
            }
        });
    }

    renderModal() {
        const root = document.getElementById('modal-root');
        if (!this.modalState) {
            root.innerHTML = '';
            return;
        }

        const { title, message, type, fields, confirmText, cancelText, content: customContent } = this.modalState;

        let content = '';

        if (type === 'input') {
            content = `
                        <input type="text" id="modal-input" class="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:border-blue-500 focus:ring-4 focus:ring-blue-50/50 outline-none transition-all" placeholder="Enter value" autocomplete="off">
                    `;
        } else if (customContent) {
            content = customContent;
        } else if (type === 'form') {
            content = fields.map(field => `
                        <div class="mb-4">
                            <label class="block text-sm font-bold text-slate-700 mb-2">${field.label}</label>
                            ${field.type === 'choice' ? `
                                <div class="grid grid-cols-2 gap-3">
                                    ${field.options.map(opt => `
                                        <button 
                                            type="button"
                                            onclick="app.selectModalChoice('${field.name}', '${opt.value}')"
                                            id="modal-choice-${field.name}-${opt.value}"
                                            class="modal-choice-btn-${field.name} p-4 rounded-xl border-2 text-center transition-all ${field.value === opt.value ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 hover:border-slate-300 text-slate-600'}"
                                        >
                                            <div class="font-bold text-sm">${opt.label}</div>
                                            ${opt.sublabel ? `<div class="text-xs opacity-75 mt-1">${opt.sublabel}</div>` : ''}
                                        </button>
                                    `).join('')}
                                    <input type="hidden" id="modal-field-${field.name}" value="${field.value || ''}">
                                </div>
                            ` : field.type === 'checkbox' ? `
                                <label class="flex items-center gap-3 p-3 border border-slate-200 rounded-xl bg-slate-50">
                                    <input type="checkbox" id="modal-field-${field.name}" ${field.value ? 'checked' : ''} class="w-5 h-5 text-blue-600 rounded focus:ring-blue-500">
                                    <span class="text-slate-700 font-medium">${field.placeholder || ''}</span>
                                </label>
                            ` : `
                                <input 
                                    type="${field.type || 'text'}" 
                                    id="modal-field-${field.name}" 
                                    value="${field.value || ''}" 
                                    class="w-full px-4 py-3 border-2 border-slate-200 rounded-xl focus:border-blue-500 focus:ring-4 focus:ring-blue-50/50 outline-none transition-all" 
                                    placeholder="${field.placeholder || ''}"
                                    ${field.required ? 'required' : ''}
                                >
                            `}
                        </div>
                    `).join('');
        } else if (type === 'loading') {
            content = `
                        <div class="flex flex-col items-center justify-center py-4">
                            <div class="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mb-4"></div>
                            <p class="text-slate-600 font-medium">${message || 'Loading...'}</p>
                        </div>
                    `;
        }

        root.innerHTML = `
            <div class="fixed inset-0 z-[9999] flex items-center justify-center p-4 sm:p-6" role="dialog" aria-modal="true">
                <!-- Backdrop -->
                <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-md transition-opacity animate-fade-in" onclick="${type !== 'loading' ? 'app.closeModal()' : ''}"></div>

                <!-- Modal Content -->
                <div class="relative w-full max-w-sm sm:max-w-md transform overflow-hidden rounded-[2rem] bg-white shadow-2xl transition-all animate-scale-up border border-white/20">
                    <!-- Glass Header Detail -->
                    <div class="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-blue-50/50 to-transparent pointer-events-none"></div>

                    <div class="p-6 sm:p-8 relative">
                        ${type !== 'loading' ? `
                            <div class="text-center mb-6">
                                <h3 class="text-xl sm:text-2xl font-black text-slate-900 mb-2 tracking-tight">${title}</h3>
                                ${message ? `<p class="text-slate-500 font-medium leading-relaxed">${message}</p>` : ''}
                            </div>
                        ` : ''}
                        
                        <form id="modal-form" onsubmit="app.handleModalSubmit(event)">
                            <div id="modal-content" class="mb-8 space-y-4">
                                ${content}
                            </div>
                            
                            ${type !== 'loading' ? `
                            <div class="grid gap-3 ${type !== 'alert' ? 'grid-cols-2' : ''}">
                                ${type !== 'alert' ? `
                                    <button type="button" onclick="app.closeModal()" class="w-full py-3.5 px-4 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold rounded-xl transition-all active:scale-[0.98]">
                                        ${cancelText}
                                    </button>
                                ` : ''}
                                <button type="submit" class="w-full py-3.5 px-4 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white font-bold rounded-xl shadow-lg shadow-blue-200 transition-all transform active:scale-[0.98] flex items-center justify-center gap-2">
                                    ${confirmText}
                                </button>
                            </div>
                            ` : ''}
                        </form>
                    </div>
                </div>
            </div>
        `;
    }

    renderFloatingButtons() {
        const container = document.getElementById('floating-buttons');
        if (!container) return;

        // Only show floating scan button when there's an active session and we're in the main session view
        // (not showing settings, product DB, session history, start screen, or scanning)
        const shouldShow = this.activeStockTake &&
            !this.showingStartStockTake &&
            !this.showingSettings &&
            !this.showingProductDB &&
            !this.showingRMProductDB &&
            !this.showingSessionHistory &&
            !this.showingLocationManagement &&
            !this.showingQRGenerator &&
            !this.showingSessionDashboard &&
            !this.isScanning;

        if (!shouldShow) {
            container.innerHTML = '';
            return;
        }

        const isRM = this.activeStockTake?.sessionType === 'RM';
        const isFP = this.activeStockTake?.sessionType === 'FP';

        // Stack buttons vertically on the right side
        container.innerHTML = `
                    <div class="fixed bottom-6 right-6 z-[9999] flex flex-col items-center gap-3">
                        ${isFP ? `
                        <!-- Manual 5-digit entry button (above scan) -->
                        <button onclick="app.showManual5DigitEntry()" 
                            class="w-12 h-12 bg-amber-500 hover:bg-amber-600 active:scale-95 text-white rounded-full shadow-lg shadow-amber-200/50 flex items-center justify-center transition-all border-2 border-amber-400"
                            title="Manual 5-digit entry">
                            <span class="text-sm font-bold">5#</span>
                        </button>
                        ` : ''}
                        
                        <!-- Main scan button -->
                        <button onclick="app.startScanning()" 
                            class="w-16 h-16 ${isRM ? 'bg-gradient-to-br from-teal-500 to-teal-600 shadow-teal-200/50 border-teal-400' : 'bg-gradient-to-br from-blue-500 to-blue-600 shadow-blue-200/50 border-blue-400'} active:scale-95 text-white rounded-full shadow-xl flex items-center justify-center transition-all border-2"
                            title="Scan barcode">
                            <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/>
                            </svg>
                        </button>
                    </div>
                `;
    }

    // Manual 5-digit batch number entry for FP sessions
    showManual5DigitEntry() {
        this.showModal({
            title: '🔢 Manual Entry',
            message: 'Enter the 5-digit batch number:',
            type: 'input',
            confirmText: 'Continue',
            cancelText: 'Cancel',
            onConfirm: (data) => {
                const batchNumber = (data.value || '').trim();

                // Validate 5-digit format
                if (!/^\d{5}$/.test(batchNumber)) {
                    alert('Please enter exactly 5 digits');
                    return;
                }

                // Look up product info
                const productInfo = productDatabase[batchNumber];

                // Create a synthetic 13-digit raw_code for manual entries
                // Format: 00000 (prefix) + batchNumber (5 digits) + 000 (suffix) = 13 digits
                const syntheticRawCode = '00000' + batchNumber + '000';

                // Create parsed data similar to parseQRCode
                const parsed = {
                    valid: true,
                    raw: syntheticRawCode, // Use 13-digit synthetic code for database
                    batchNumber: batchNumber,
                    palletNumber: null, // No pallet for manual entry
                    casesOnPallet: 0,
                    stockCode: productInfo?.stockCode || 'UNKNOWN',
                    description: productInfo?.description || 'Unknown Product',
                    isUnknownProduct: !productInfo,
                    isManualEntry: true // Flag for manual entry
                };

                // Handle unknown product - show search to select product
                if (parsed.isUnknownProduct) {
                    this._unknownFPParsed = parsed;
                    this._unknownFPScanKey = batchNumber;
                    this._showFPProductSearch(parsed, batchNumber);
                    return;
                }

                // Proceed to case entry
                this.currentScan = parsed;
                this.showingCaseEntry = true;
                this.render();
            }
        });

        // Set input properties for number entry
        setTimeout(() => {
            const input = document.getElementById('modal-input');
            if (input) {
                input.type = 'tel';
                input.pattern = '[0-9]*';
                input.inputMode = 'numeric';
                input.maxLength = 5;
                input.placeholder = '00000';
                input.focus();
            }
        }, 100);
    }

    // Optimized render with debouncing to prevent excessive DOM updates
    render() {
        // Skip if render is already scheduled
        if (this._renderScheduled) return;

        // Debounce rapid render calls
        const now = performance.now();
        const timeSinceLastRender = now - this._lastRenderTime;

        if (timeSinceLastRender < this._renderDebounceMs) {
            this._renderScheduled = true;
            requestAnimationFrame(() => {
                this._renderScheduled = false;
                this._executeRender();
            });
            return;
        }

        this._executeRender();
    }

    // Returns a unique key representing the current view/screen
    // Used to detect actual view changes vs. data refreshes within same view
    _getViewKey() {
        if (this.isScanning) return 'scanning';
        if (this.showingCaseEntry) return 'case-entry';
        if (this.showingExpirySelection) return 'expiry-selection';
        if (this.showingStartStockTake) return 'start-stocktake';
        if (this.showingSettings) return 'settings';
        if (this.showingWarehouseSetup) return 'warehouse-setup';
        if (this.showingLocationPicker) return 'location-picker';
        if (this.showingProductDB) return 'product-db';
        if (this.showingRMProductDB) return 'rm-product-db';
        if (this.showingSessionHistory) return 'session-history';
        if (this.showingQRGenerator) return 'qr-generator';
        if (this.showingSessionDashboard) return 'session-dashboard';
        if (this.activeStockTake) return 'active-session';
        return 'home';
    }
    _executeRender() {
        this._lastRenderTime = performance.now();
        this.renderModal();
        this.renderFloatingButtons();
        const scrollY = window.scrollY;
        const app = document.getElementById('app');

        const updateView = (html) => {
            // Detect if this is a significant view change vs. data refresh
            const currentViewKey = this._getViewKey();
            const isViewChange = this._lastViewKey !== currentViewKey;
            this._lastViewKey = currentViewKey;

            app.innerHTML = html;

            // Only animate on actual view changes, not data refreshes
            if (isViewChange) {
                app.classList.add('animate-fade-in');
                setTimeout(() => app.classList.remove('animate-fade-in'), 200);
            }

            // Initialize swipe-to-delete on scan list items
            requestAnimationFrame(() => this.initSwipeToDelete());

            // Restore scroll position if we are in the main list view
            // (heuristic: if we are not showing a modal or special screen)
            if (!this.showingStartStockTake && !this.showingSettings && !this.showingProductDB && !this.showingRMProductDB && !this.showingSessionHistory) {
                window.scrollTo(0, scrollY);
            } else {
                window.scrollTo(0, 0);
            }
        };

        if (this.isScanning && document.getElementById('scanner-view')) {
            return;
        }
        // Note: Session refresh moved to explicit calls only to avoid blocking render
        // ===== QR CODE GENERATOR PAGE (Admin Only) =====
        if (this.showingQRGenerator) {
            // Get locations from session settings (warehouse setup)
            const warehouseConfig = this.sessionSettings.warehouseConfig || { racks: [], floorLocations: [] };
            const racks = warehouseConfig.racks || [];
            const floorLocations = warehouseConfig.floorLocations || [];

            // Build location list from racks and floor locations
            const locations = [];

            // Add rack locations - generate position codes for each rack
            racks.forEach(rack => {
                const rackName = rack.name || rack.id;
                const rows = rack.rows || 1;
                const columns = rack.columns || 1;
                const levels = rack.levels || 1;

                // Generate location codes for each position in the rack
                for (let level = 1; level <= levels; level++) {
                    for (let col = 1; col <= columns; col++) {
                        const levelLetter = String.fromCharCode(64 + level); // 1=A, 2=B, etc.
                        const locationCode = `${rackName}-${levelLetter}${col}`;
                        locations.push({
                            code: locationCode,
                            type: 'rack',
                            label: `${rackName} Level ${levelLetter} Position ${col}`
                        });
                    }
                }
            });

            // Add floor locations
            floorLocations.forEach(floor => {
                const locationCode = `FLOOR-${floor}`;
                locations.push({
                    code: locationCode,
                    type: 'floor',
                    label: `Floor ${floor}`
                });
            });

            const selectedSet = this._selectedLocationsForQR || new Set();

            updateView(`
                <div class="min-h-screen bg-slate-50 flex items-center justify-center p-4">
                    <div class="w-full max-w-lg bg-white rounded-[2rem] shadow-2xl shadow-slate-200 overflow-hidden animate-fade-up">
                        <!-- Header -->
                        <div class="p-6 bg-gradient-to-br from-purple-600 to-purple-800 text-white relative overflow-hidden">
                            <div class="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGcgb3BhY2l0eT0iMC4xIiBmaWxsPSIjZmZmIj48Y2lyY2xlIGN4PSIxIiBjeT0iMSIgcj0iMSIvPjwvZz48L3N2Zz4=')] opacity-20"></div>
                            
                            <div class="relative flex items-center justify-between">
                                <div class="flex items-center gap-4">
                                    <div class="w-12 h-12 bg-white/20 backdrop-blur-md rounded-2xl flex items-center justify-center border border-white/30">
                                        <span class="text-2xl">📱</span>
                                    </div>
                                    <div>
                                        <h2 class="text-xl font-bold">QR Generator</h2>
                                        <p class="text-purple-100 text-sm font-medium">Select locations to print</p>
                                    </div>
                                </div>
                                <button onclick="app.hideQRGenerator()" class="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl transition-all border border-white/10">
                                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        </div>

                        <div class="p-6 bg-slate-50 max-h-[70vh] overflow-y-auto custom-scrollbar">
                            <!-- Action Buttons -->
                            <div class="grid grid-cols-3 gap-2 mb-6">
                                <button onclick="app.selectAllLocationsForQR()" class="py-2.5 px-3 bg-white border border-slate-200 hover:border-purple-400 text-slate-600 hover:text-purple-600 rounded-xl font-bold text-xs transition-all shadow-sm">
                                    Select All
                                </button>
                                <button onclick="app.clearLocationSelections()" class="py-2.5 px-3 bg-white border border-slate-200 hover:border-red-400 text-slate-600 hover:text-red-500 rounded-xl font-bold text-xs transition-all shadow-sm">
                                    Clear All
                                </button>
                                <button onclick="app.generateQRCodes()" class="py-2.5 px-3 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-bold text-xs transition-all shadow-lg shadow-purple-200 flex items-center justify-center gap-2 ${selectedSet.size === 0 ? 'opacity-50 grayscale cursor-not-allowed' : ''}">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
                                    Print (${selectedSet.size})
                                </button>
                            </div>

                            ${locations.length === 0 ? `
                                <div class="flex flex-col items-center justify-center py-12 text-center">
                                    <div class="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                                        <svg class="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                                    </div>
                                    <h3 class="font-bold text-slate-900 text-lg">No Locations Configured</h3>
                                    <p class="text-slate-500 text-sm mt-2 max-w-xs px-4">Add racks and floor locations in Settings to generate QR codes.</p>
                                    <button onclick="app.hideQRGenerator(); app.showSettings();" class="mt-6 px-6 py-2.5 bg-purple-600 hover:bg-purple-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-purple-200">
                                        Go to Settings
                                    </button>
                                </div>
                            ` : `
                                <div class="space-y-6">
                                    <!-- Rack Locations -->
                                    ${racks.length > 0 ? `
                                    <div>
                                        <h3 class="font-bold text-slate-800 mb-3 flex items-center gap-2 text-xs uppercase tracking-wider pl-1">
                                            <span class="text-base">🏭</span> Rack Locations
                                        </h3>
                                        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                                            <div class="divide-y divide-slate-100 max-h-60 overflow-y-auto custom-scrollbar">
                                                ${locations.filter(l => l.type === 'rack').map(loc => `
                                                    <label class="group p-3 flex items-center gap-3 hover:bg-purple-50 cursor-pointer transition-colors select-none">
                                                        <div class="relative flex items-center justify-center">
                                                            <input type="checkbox" 
                                                                ${selectedSet.has(loc.code) ? 'checked' : ''}
                                                                onchange="app.toggleLocationForQR('${loc.code}')"
                                                                class="peer w-5 h-5 rounded border-slate-300 text-purple-600 focus:ring-purple-500 transition-all checked:bg-purple-600 checked:border-purple-600"
                                                            />
                                                        </div>
                                                        <div class="flex-1">
                                                            <div class="font-bold text-slate-700 group-hover:text-purple-700 text-sm font-mono">${loc.code}</div>
                                                            <div class="text-[10px] text-slate-400 group-hover:text-purple-500 uppercase tracking-wide font-medium">${loc.label}</div>
                                                        </div>
                                                    </label>
                                                `).join('')}
                                            </div>
                                        </div>
                                    </div>
                                    ` : ''}
                                    
                                    <!-- Floor Locations -->
                                    ${floorLocations.length > 0 ? `
                                    <div>
                                        <h3 class="font-bold text-slate-800 mb-3 flex items-center gap-2 text-xs uppercase tracking-wider pl-1">
                                            <span class="text-base">📦</span> Floor Locations
                                        </h3>
                                        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                                            <div class="divide-y divide-slate-100 max-h-60 overflow-y-auto custom-scrollbar">
                                                ${locations.filter(l => l.type === 'floor').map(loc => `
                                                    <label class="group p-3 flex items-center gap-3 hover:bg-purple-50 cursor-pointer transition-colors select-none">
                                                        <div class="relative flex items-center justify-center">
                                                            <input type="checkbox" 
                                                                ${selectedSet.has(loc.code) ? 'checked' : ''}
                                                                onchange="app.toggleLocationForQR('${loc.code}')"
                                                                class="peer w-5 h-5 rounded border-slate-300 text-purple-600 focus:ring-purple-500 transition-all checked:bg-purple-600 checked:border-purple-600"
                                                            />
                                                        </div>
                                                        <div class="flex-1">
                                                            <div class="font-bold text-slate-700 group-hover:text-purple-700 text-sm font-mono">${loc.code}</div>
                                                            <div class="text-[10px] text-slate-400 group-hover:text-purple-500 uppercase tracking-wide font-medium">${loc.label}</div>
                                                        </div>
                                                    </label>
                                                `).join('')}
                                            </div>
                                        </div>
                                    </div>
                                    ` : ''}
                                </div>
                            `}
                        </div>
                    </div>
                </div>
            `);
            return;
        }

        // ===== SESSION DASHBOARD PAGE (Admin Only) =====
        if (this.showingSessionDashboard) {
            const sessions = this.dashboardSessions || [];
            const psaSessions = sessions.filter(s => s.warehouse === 'PSA');
            const pmlSessions = sessions.filter(s => s.warehouse === 'PML');
            const otherSessions = sessions.filter(s => !s.warehouse || (s.warehouse !== 'PSA' && s.warehouse !== 'PML'));

            const renderSessionCard = (session) => {
                const statusColor = session.status === 'active' ? 'green' : session.status === 'paused' ? 'amber' : 'slate';
                const typeColor = session.session_type === 'FP' ? 'blue' : 'teal';
                const deviceCount = session.active_device_count || 0;
                const totalDevices = session.total_device_count || 0;
                const scanCount = session.total_scan_count || 0;

                return `
                    <div class="bg-white rounded-2xl shadow-sm border border-slate-100 hover:shadow-md transition-all duration-300 p-5 group relative overflow-hidden">
                        <!-- Status Bar -->
                        <div class="absolute top-0 left-0 w-1 h-full bg-${typeColor}-500"></div>
                        
                        <div class="flex items-start justify-between mb-4 pl-2">
                            <div>
                                <div class="flex items-center gap-2 mb-2">
                                    <span class="inline-flex items-center px-2 py-1 rounded-md text-[10px] uppercase font-bold tracking-wider bg-${typeColor}-50 text-${typeColor}-600 border border-${typeColor}-100">
                                        ${session.session_type === 'FP' ? '📦 Product' : '🧪 Material'}
                                    </span>
                                    <span class="inline-flex items-center px-2 py-1 rounded-md text-[10px] uppercase font-bold tracking-wider bg-${statusColor}-50 text-${statusColor}-600 border border-${statusColor}-100">
                                        <span class="w-1.5 h-1.5 rounded-full bg-${statusColor}-500 mr-1.5 ${session.status === 'active' ? 'animate-pulse' : ''}"></span>
                                        ${session.status}
                                    </span>
                                </div>
                                <h3 class="font-bold text-lg text-slate-800 flex items-center gap-2">
                                    Session #${session.session_number}
                                </h3>
                                <div class="text-xs font-mono text-slate-400 mt-0.5">${session.take_date}</div>
                            </div>
                            <div class="text-right">
                                <div class="text-2xl font-black text-slate-900 tracking-tight">${scanCount}</div>
                                <div class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Scans</div>
                            </div>
                        </div>

                        <div class="flex items-center justify-between pt-4 border-t border-slate-50 pl-2">
                            <div class="flex items-center gap-4">
                                <div class="flex items-center gap-2" title="Active Devices">
                                    <div class="p-1.5 rounded-lg bg-green-50 text-green-600">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
                                    </div>
                                    <div class="text-sm font-bold text-slate-700">
                                        ${deviceCount}<span class="text-slate-400 font-normal">/${totalDevices}</span>
                                    </div>
                                </div>
                                <div class="flex items-center gap-2" title="Started By">
                                    <div class="p-1.5 rounded-lg bg-slate-50 text-slate-500">
                                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                                    </div>
                                    <div class="text-xs font-medium text-slate-500 truncate max-w-[100px]">
                                        ${session.started_by || 'Unknown'}
                                    </div>
                                </div>
                            </div>
                            
                            <button onclick="app.joinSession('${session.id}')" class="px-3 py-1.5 text-xs font-bold bg-slate-100 hover:bg-indigo-50 text-slate-600 hover:text-indigo-600 rounded-lg transition-colors">
                                View Details
                            </button>
                        </div>
                    </div>
                `;
            };

            updateView(`
                <div class="min-h-screen bg-slate-50 flex flex-col items-center">
                    <!-- Header with Glass Effect -->
                    <div class="sticky top-0 z-30 w-full bg-indigo-900/95 backdrop-blur-xl border-b border-white/10 shadow-lg text-white">
                        <div class="max-w-4xl mx-auto p-4 sm:p-6">
                            <div class="flex items-center justify-between mb-4">
                                <div class="flex items-center gap-4">
                                    <button onclick="app.hideSessionDashboard()" class="p-2 bg-white/10 hover:bg-white/20 rounded-xl transition-all border border-white/10 group">
                                        <svg class="w-5 h-5 text-indigo-100 group-hover:text-white transform group-hover:-translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
                                        </svg>
                                    </button>
                                    <div>
                                        <h1 class="text-2xl font-black tracking-tight">Session Dashboard</h1>
                                        <div class="flex items-center gap-2 mt-0.5">
                                            <span class="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                                            <p class="text-indigo-200 text-xs font-bold uppercase tracking-widest">Real-time Monitor</p>
                                        </div>
                                    </div>
                                </div>
                                <button onclick="app.refreshDashboard()" class="p-2.5 bg-indigo-500 hover:bg-indigo-400 rounded-xl shadow-lg shadow-indigo-900/20 transition-all border border-indigo-400 group">
                                    <svg class="w-5 h-5 ${this.dashboardLoading ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>
                    
                    <div class="w-full max-w-4xl mx-auto p-4 sm:p-6 pb-24">
                        ${this.dashboardLoading ? `
                            <div class="flex flex-col items-center justify-center py-20">
                                <div class="w-16 h-16 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mb-6"></div>
                                <div class="text-slate-900 font-bold text-lg">Loading Mission Control...</div>
                                <div class="text-slate-500 text-sm">Fetching active session telemetry</div>
                            </div>
                        ` : sessions.length === 0 ? `
                            <div class="flex flex-col items-center justify-center py-20 text-center animate-fade-up">
                                <div class="w-24 h-24 bg-indigo-50 rounded-[2rem] flex items-center justify-center mb-6 rotate-3">
                                    <svg class="w-12 h-12 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 002 2h2a2 2 0 002-2z"/></svg>
                                </div>
                                <h3 class="text-xl font-black text-slate-900 mb-2">Systems Idle</h3>
                                <p class="text-slate-500 max-w-xs mx-auto mb-8">There are no active sessions running across any warehouse.</p>
                            </div>
                        ` : `
                            <!-- Summary Stats Cards -->
                            <div class="grid grid-cols-3 gap-3 sm:gap-4 mb-8">
                                <div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex flex-col items-center justify-center">
                                    <div class="text-3xl sm:text-4xl font-black text-indigo-600 mb-1">${sessions.length}</div>
                                    <div class="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest text-center">Active Sessions</div>
                                </div>
                                <div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex flex-col items-center justify-center">
                                    <div class="text-3xl sm:text-4xl font-black text-emerald-500 mb-1">${sessions.reduce((sum, s) => sum + (s.active_device_count || 0), 0)}</div>
                                    <div class="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest text-center">Online Devices</div>
                                </div>
                                <div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex flex-col items-center justify-center">
                                    <div class="text-3xl sm:text-4xl font-black text-slate-700 mb-1">${sessions.reduce((sum, s) => sum + (s.total_scan_count || 0), 0)}</div>
                                    <div class="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest text-center">Total Scans</div>
                                </div>
                            </div>
                            
                            <div class="space-y-8">
                                ${psaSessions.length > 0 ? `
                                <!-- PSA Sessions -->
                                <div class="animate-fade-in-up" style="animation-delay: 0.1s;">
                                    <h2 class="font-bold text-slate-800 mb-4 flex items-center gap-2 pl-1">
                                        <span class="w-3 h-3 bg-blue-500 rounded-full shadow-lg shadow-blue-200"></span>
                                        <span class="text-sm uppercase tracking-wider">PSA Operations</span>
                                        <span class="bg-blue-100 text-blue-700 text-[10px] px-2 py-0.5 rounded-full font-bold">${psaSessions.length}</span>
                                    </h2>
                                    <div class="space-y-4">
                                        ${psaSessions.map(renderSessionCard).join('')}
                                    </div>
                                </div>
                                ` : ''}
                                
                                ${pmlSessions.length > 0 ? `
                                <!-- PML Sessions -->
                                <div class="animate-fade-in-up" style="animation-delay: 0.2s;">
                                    <h2 class="font-bold text-slate-800 mb-4 flex items-center gap-2 pl-1">
                                        <span class="w-3 h-3 bg-teal-500 rounded-full shadow-lg shadow-teal-200"></span>
                                        <span class="text-sm uppercase tracking-wider">PML Operations</span>
                                        <span class="bg-teal-100 text-teal-700 text-[10px] px-2 py-0.5 rounded-full font-bold">${pmlSessions.length}</span>
                                    </h2>
                                    <div class="space-y-4">
                                        ${pmlSessions.map(renderSessionCard).join('')}
                                    </div>
                                </div>
                                ` : ''}

                                    
                                    ${otherSessions.length > 0 ? `
                                    <!-- Other Sessions -->
                                    <div class="mb-6">
                                        <h2 class="font-bold text-slate-800 mb-3 flex items-center gap-2">
                                            <span class="w-3 h-3 bg-slate-400 rounded-full"></span>
                                            Other Sessions (${otherSessions.length})
                                        </h2>
                                        <div class="space-y-3">
                                            ${otherSessions.map(renderSessionCard).join('')}
                                        </div>
                                    </div>
                                    ` : ''}
                                `}
                            </div>
                        </div>
                    `);
            return;
        }

        // Start Stock Take Screen - Step 1: Type Selection
        if (this.showingStartStockTake && !this.selectedStockTakeType) {
            const savedName = getUserName();

            updateView(`
                        <div class="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 sm:p-6 relative overflow-hidden">
                            <!-- Background Decoration -->
                            <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-blue-50 to-slate-50 pointer-events-none"></div>
                            <div class="absolute top-[-10%] right-[-5%] w-64 h-64 bg-blue-100 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-pulse-soft"></div>
                            <div class="absolute bottom-[-10%] left-[-5%] w-64 h-64 bg-teal-100 rounded-full mix-blend-multiply filter blur-3xl opacity-30 animate-pulse-soft delay-300"></div>

                            <div class="w-full max-w-md relative z-10 animate-fade-up">
                                <!-- Logo Area -->
                                <div class="text-center mb-8">
                                    <div class="w-24 h-24 mx-auto mb-6 relative">
                                        <div class="absolute inset-0 bg-blue-600 rounded-[2rem] transform rotate-3 opacity-20"></div>
                                        <div class="absolute inset-0 bg-blue-600 rounded-[2rem] transform -rotate-3 opacity-20"></div>
                                        <div class="relative w-full h-full bg-gradient-to-br from-blue-600 to-blue-700 rounded-[2rem] shadow-xl flex items-center justify-center text-white">
                                            <svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"/>
                                            </svg>
                                        </div>
                                    </div>
                                    <h1 class="text-3xl font-extrabold text-slate-900 tracking-tight mb-2">Stock Intelligence</h1>
                                    <p class="text-slate-500 font-medium">Next Gen Inventory Management</p>
                                </div>
                                
                                <!-- Main Card -->
                                <div class="bg-white/80 backdrop-blur-xl border border-white/50 shadow-xl rounded-[2rem] p-6 sm:p-8">
                                    <div class="space-y-6">
                                        <!-- User Input -->
                                        <div>
                                            <label class="block text-sm font-bold text-slate-700 mb-2 ml-1">Who are you?</label>
                                            <input 
                                                type="text" 
                                                id="userNameInput" 
                                                value="${savedName}"
                                                placeholder="Enter your name"
                                                onchange="setUserName(this.value); app.handleNameChange();"
                                                class="w-full px-5 py-4 text-lg font-medium bg-slate-50 border-2 border-slate-100 rounded-2xl focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/20 outline-none transition-all placeholder:text-slate-400"
                                            />
                                            ${(() => {
                    const role = getUserRole();
                    const warehouse = getUserWarehouse();
                    if (role === 'admin') {
                        return '<div class="mt-3 flex justify-center"><div class="inline-flex items-center gap-1.5 px-3 py-1 bg-purple-50 text-purple-700 border border-purple-100 rounded-full text-xs font-bold shadow-sm">👑 Admin Access</div></div>';
                    } else if (role === 'supervisor') {
                        const warehouseBadge = warehouse ? ` • ${warehouse}` : '';
                        return '<div class="mt-3 flex justify-center"><div class="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-50 text-amber-700 border border-amber-100 rounded-full text-xs font-bold shadow-sm">⭐ Supervisor' + warehouseBadge + '</div></div>';
                    } else {
                        const warehouseBadge = warehouse ? ` • ${warehouse}` : '';
                        return '<div class="mt-3 flex justify-center"><div class="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-50 text-slate-600 border border-slate-200 rounded-full text-xs font-bold shadow-sm">👤 Operator' + warehouseBadge + '</div></div>';
                    }
                })()}
                                        </div>
                                        
                                        <!-- Action Buttons -->
                                        <div>
                                            <label class="block text-sm font-bold text-slate-700 mb-3 ml-1">Start Session Type</label>
                                            <div class="grid grid-cols-2 gap-4">
                                                <button 
                                                    onclick="app.selectStockTakeType('FP', document.getElementById('userNameInput').value)"
                                                    class="group relative overflow-hidden bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white p-5 rounded-2xl transition-all shadow-lg shadow-blue-500/30"
                                                >
                                                    <div class="absolute inset-0 bg-gradient-to-br from-white/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                                                    <div class="relative flex flex-col items-center gap-2">
                                                        <span class="text-2xl font-bold tracking-wider">FP</span>
                                                        <span class="text-xs font-medium text-blue-100 opacity-90">Finished Products</span>
                                                    </div>
                                                </button>

                                                <button 
                                                    onclick="app.selectStockTakeType('RM', document.getElementById('userNameInput').value)"
                                                    class="group relative overflow-hidden bg-teal-600 hover:bg-teal-700 active:scale-[0.98] text-white p-5 rounded-2xl transition-all shadow-lg shadow-teal-500/30"
                                                >
                                                    <div class="absolute inset-0 bg-gradient-to-br from-white/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                                                    <div class="relative flex flex-col items-center gap-2">
                                                        <span class="text-2xl font-bold tracking-wider">RM</span>
                                                        <span class="text-xs font-medium text-teal-100 opacity-90">Raw Materials</span>
                                                    </div>
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Quick Actions (role-based) -->
                            <div class="p-4 sm:p-6 pt-0">
                                <div class="max-w-lg mx-auto">
                                    <div class="flex gap-3 justify-center flex-wrap">
                                        ${canViewHistory() ? `
                                        <button onclick="app.showSessionHistory()" class="w-12 h-12 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-full transition-colors flex items-center justify-center hover-lift" title="History">
                                            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                            </svg>
                                        </button>
                                        ` : ''}
                                        ${canViewSettings() ? `
                                        <button onclick="app.showSettings()" class="w-12 h-12 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-full transition-colors flex items-center justify-center hover-lift" title="Settings">
                                            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                                            </svg>
                                        </button>
                                        ` : ''}
                                        ${getUserRole() === 'admin' ? `
                                        <button onclick="app.showSessionDashboard()" class="w-12 h-12 bg-indigo-100 hover:bg-indigo-200 text-indigo-600 rounded-full transition-colors flex items-center justify-center hover-lift" title="Session Dashboard">
                                            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
                                            </svg>
                                        </button>
                                        <button onclick="app.showQRGenerator()" class="w-12 h-12 bg-purple-100 hover:bg-purple-200 text-purple-600 rounded-full transition-colors flex items-center justify-center hover-lift" title="QR Code Generator">
                                            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/>
                                            </svg>
                                        </button>
                                        ` : ''}
                                    </div>
                                </div>
                            </div>
                            
                            <div class="p-4 sm:p-6 pt-0 text-center">
                                ${supabaseClient && this.isBrowserOnline ? `
                                    <div class="inline-flex items-center gap-2 px-4 py-2 bg-green-50 text-green-700 rounded-full text-xs font-bold border border-green-100">
                                        <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                                        <span>Connected to supabaseClient</span>
                                    </div>
                                ` : `
                                    <div class="inline-flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-600 rounded-full text-xs font-bold border border-slate-200">
                                        <div class="w-2 h-2 bg-slate-400 rounded-full"></div>
                                        <span>Offline Mode</span>
                                    </div>
                                `}
                                <p class="text-xs text-slate-400 mt-4">v1.0.0 • ${this.currentTakeDate}</p>
                            </div>
                        </div>
                    `);
            return;
        }

        // Start Stock Take Screen - Step 2: Session Selection
        if (this.showingStartStockTake && this.selectedStockTakeType) {
            const savedName = getUserName();
            const sessionType = this.selectedStockTakeType;
            const isRM = sessionType === 'RM';
            const activeSessions = getActiveSessionsForDate(this.currentTakeDate).filter(s => s.sessionType === sessionType);

            updateView(`
                        <div class="min-h-screen bg-slate-50 flex flex-col items-center p-4 sm:p-6 relative overflow-hidden">
                            <!-- Background Decoration -->
                            <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-${isRM ? 'teal-50' : 'blue-50'} to-slate-50 pointer-events-none"></div>

                            <!-- Header -->
                            <div class="w-full max-w-2xl mx-auto relative z-10 animate-fade-up">
                                <div class="flex items-center justify-between mb-8">
                                    <button onclick="app.selectedStockTakeType = null; app.render();" class="group flex items-center gap-2 text-slate-500 hover:text-slate-800 transition-colors">
                                        <div class="w-10 h-10 rounded-xl bg-white shadow-sm border border-slate-100 flex items-center justify-center group-hover:scale-105 transition-transform">
                                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
                                            </svg>
                                        </div>
                                        <span class="font-bold text-sm">Back</span>
                                    </button>
                                </div>

                                <div class="bg-white/80 backdrop-blur-xl border border-white/50 shadow-xl rounded-[2rem] p-6 sm:p-8 mb-6">
                                    <div class="flex items-center gap-5 sm:gap-6 mb-8">
                                        <div class="w-16 h-16 sm:w-20 sm:h-20 ${isRM ? 'bg-gradient-to-br from-teal-500 to-teal-600' : 'bg-gradient-to-br from-blue-600 to-blue-700'} rounded-2xl flex items-center justify-center shadow-lg transform -rotate-3 text-white">
                                            ${isRM ? `
                                                <svg class="w-8 h-8 sm:w-10 sm:h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/>
                                                </svg>
                                            ` : `
                                                <svg class="w-8 h-8 sm:w-10 sm:h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                                                </svg>
                                            `}
                                        </div>
                                        <div>
                                            <h1 class="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">${isRM ? 'Raw Materials' : 'Finished Products'}</h1>
                                            <p class="text-slate-500 font-medium mt-1">Select an active session or start new</p>
                                        </div>
                                    </div>

                                    ${activeSessions.length > 0 ? `
                                        <!-- Active Sessions List -->
                                        <div>
                                            <div class="flex items-center justify-between mb-4">
                                                <h2 class="text-sm font-bold text-slate-500 uppercase tracking-wider">Active Sessions Today</h2>
                                                <span class="bg-${isRM ? 'teal' : 'blue'}-100 text-${isRM ? 'teal' : 'blue'}-700 px-3 py-1 rounded-full text-xs font-bold">${activeSessions.length} Available</span>
                                            </div>
                                            
                                            <div class="space-y-4">
                                                ${activeSessions.map(session => {
                const activeCount = session.devices?.filter(d => d.status === 'active').length || 0;
                const completedCount = session.devices?.filter(d => d.status === 'completed').length || 0;
                // Add fallback for invalid/missing dates
                let sessionTime = '';
                try {
                    sessionTime = session.startedAt ? new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
                } catch (e) {
                    sessionTime = '';
                }

                return `
                                                        <div class="group relative bg-white border border-slate-100 hover:border-${isRM ? 'teal' : 'blue'}-200 rounded-2xl p-4 sm:p-5 transition-all shadow-sm hover:shadow-md">
                                                            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                                                                <div>
                                                                    <div class="flex items-center gap-2 mb-2">
                                                                        <span class="px-3 py-1 text-xs font-bold ${isRM ? 'bg-teal-50 text-teal-700 border border-teal-100' : 'bg-blue-50 text-blue-700 border border-blue-100'} rounded-full">
                                                                            Session #${session.sessionNumber}
                                                                        </span>
                                                                        <span class="text-xs font-semibold text-slate-400">started by ${session.startedBy} • ${sessionTime}</span>
                                                                    </div>
                                                                    
                                                                    <div class="flex items-center gap-4 text-sm font-medium">
                                                                        <div class="flex items-center gap-1.5 text-emerald-600">
                                                                            <div class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
                                                                            <span>${activeCount} active</span>
                                                                        </div>
                                                                        ${completedCount > 0 ? `
                                                                            <div class="flex items-center gap-1.5 text-slate-400">
                                                                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                                                                                </svg>
                                                                                <span>${completedCount} done</span>
                                                                            </div>
                                                                        ` : ''}
                                                                    </div>
                                                                </div>

                                                                <div class="flex items-center gap-3">
                                                                    <button 
                                                                        onclick="app.endSessionFromList('${session.id}')"
                                                                        class="px-4 py-2.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-xl font-bold text-sm transition-colors"
                                                                    >
                                                                        End
                                                                    </button>
                                                                    <button 
                                                                        onclick="app.joinExistingSession('${session.id}', '${savedName}')"
                                                                        class="flex-1 sm:flex-none px-6 py-2.5 ${isRM ? 'bg-teal-600 hover:bg-teal-700 shadow-teal-200' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-200'} text-white font-bold rounded-xl shadow-lg transition-all active:scale-[0.98]"
                                                                    >
                                                                        Join Session
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    `;
            }).join('')}
                                            </div>
                                        </div>
                                    ` : `
                                        <div class="py-12 px-6 bg-slate-50 border border-slate-100 rounded-[1.5rem] text-center">
                                            <div class="w-16 h-16 mx-auto bg-white rounded-full shadow-sm flex items-center justify-center mb-4">
                                                <svg class="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                                                </svg>
                                            </div>
                                            <h3 class="text-lg font-bold text-slate-900 mb-1">No Active Sessions</h3>
                                            <p class="text-slate-500 text-sm">There are no internal ${isRM ? 'Raw Material' : 'Finished Product'} sessions running today.</p>
                                        </div>
                                    `}
                                </div>
                            </div>

                            <!-- Footer Info -->
                            <div class="text-center text-xs font-bold text-slate-400 opacity-60 mt-auto pb-4">
                                <p>${this.currentTakeDate}</p>
                            </div>

                            <!-- Floating Action Button -->
                            ${canCreateSession() ? `
                            <div class="fixed bottom-6 right-6 z-50 animate-fade-in-up">
                                <button 
                                    onclick="app.startNewStockTake('${savedName}', '${sessionType}')"
                                    class="${isRM ? 'bg-teal-600 hover:bg-teal-700 shadow-teal-500/30' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-500/30'} text-white px-6 py-4 rounded-full shadow-xl transition-all transform hover:scale-105 active:scale-95 flex items-center gap-3 font-bold text-lg"
                                >
                                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/>
                                    </svg>
                                    Start New Session
                                </button>
                            </div>
                            ` : ''}
                        </div>
                    `);
            return;
        }

        if (this.isScanning) {
            updateView(`
                        <div id="scanner-view" class="fixed inset-0 bg-black z-50 flex flex-col">
                            <!-- Scanner Header -->
                            <div class="absolute top-0 left-0 right-0 z-10 p-4 sm:p-6 flex justify-between items-start">
                                <button onclick="app.stopScanning()" class="group bg-black/40 backdrop-blur-xl border border-white/10 text-white p-3.5 rounded-full hover:bg-black/60 transition-all active:scale-95 shadow-lg">
                                    <svg class="w-6 h-6 group-hover:rotate-90 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                                    </svg>
                                </button>
                                <button onclick="app.manualEntry()" class="bg-black/40 backdrop-blur-xl border border-white/10 text-white px-5 py-3 rounded-full hover:bg-black/60 transition-all font-bold text-sm shadow-lg flex items-center gap-2">
                                    <svg class="w-5 h-5 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                                    </svg>
                                    Type Code
                                </button>
                            </div>

                            <!-- Scanner Viewport -->
                            <div class="flex-1 relative overflow-hidden bg-black">
                                <div id="scanner" class="w-full h-full absolute inset-0"></div>
                                
                                <!-- Overlay Guide -->
                                <div class="absolute inset-0 pointer-events-none flex items-center justify-center">
                                    <div class="w-72 h-72 border-[3px] border-white/80 rounded-[2rem] relative shadow-[0_0_0_2000px_rgba(0,0,0,0.5)]">
                                        <!-- Corners -->
                                        <div class="absolute top-0 left-0 w-12 h-12 border-t-[6px] border-l-[6px] border-blue-500 rounded-tl-2xl -mt-[3px] -ml-[3px]"></div>
                                        <div class="absolute top-0 right-0 w-12 h-12 border-t-[6px] border-r-[6px] border-blue-500 rounded-tr-2xl -mt-[3px] -mr-[3px]"></div>
                                        <div class="absolute bottom-0 left-0 w-12 h-12 border-b-[6px] border-l-[6px] border-blue-500 rounded-bl-2xl -mb-[3px] -ml-[3px]"></div>
                                        <div class="absolute bottom-0 right-0 w-12 h-12 border-b-[6px] border-r-[6px] border-blue-500 rounded-br-2xl -mb-[3px] -mr-[3px]"></div>
                                        
                                        <!-- Scanning Line -->
                                        <div class="absolute top-1/2 left-4 right-4 h-0.5 bg-red-500 shadow-[0_0_20px_rgba(239,68,68,0.8)] animate-scan-line"></div>
                                        
                                        <!-- Status Text inside Frame -->
                                        <div class="absolute -bottom-16 left-0 right-0 text-center">
                                            <div class="inline-flex items-center gap-2 px-4 py-2 bg-black/50 backdrop-blur-md rounded-full border border-white/10 text-white/90 text-sm font-medium">
                                                <div class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                                                Camera Active
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                
                                <!-- Location Indicator (when active) -->
                                ${this.activeLocation ? `
                                <div class="absolute top-24 left-1/2 -translate-x-1/2 z-20 pointer-events-none animate-fade-in-down">
                                    <div class="bg-white/10 backdrop-blur-xl border border-white/20 text-white px-6 py-3 rounded-2xl shadow-xl flex flex-col items-center gap-1 min-w-[120px]">
                                        <span class="text-xs font-bold text-white/60 tracking-wider uppercase">Active Location</span>
                                        <div class="flex items-center gap-2">
                                            <span class="text-2xl">📍</span>
                                            <span class="text-xl font-bold">${this.activeLocation}</span>
                                        </div>
                                    </div>
                                </div>
                                ` : ''}
                                
                                <!-- Hint Text -->
                                <div class="absolute bottom-24 left-0 right-0 text-center pointer-events-none px-6">
                                    <div class="inline-block bg-white/10 backdrop-blur-xl border border-white/10 text-white px-6 py-3 rounded-2xl text-sm font-medium shadow-xl">
                                        ${this.activeLocation ? 'Scan product barcode or QR code' : 'Align code within the frame to scan'}
                                    </div>
                                </div>
                            </div>
                        </div>
                    `);
            return;
        }

        // Expiry Date Selection Screen
        if (this.showingExpirySelection && this.pendingScan) {
            const scan = this.pendingScan;
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            updateView(`
                        <div class="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 sm:p-6 relative overflow-hidden">
                             <!-- Background Decoration -->
                            <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-blue-50 to-slate-50 pointer-events-none"></div>

                            <div class="w-full max-w-md relative z-10 animate-fade-up">
                                <div class="bg-white/80 backdrop-blur-xl border border-white/50 shadow-xl rounded-[2rem] overflow-hidden">
                                    <!-- Header -->
                                    <div class="bg-gradient-to-br from-blue-600 to-blue-700 p-6 sm:p-8 text-white relative overflow-hidden">
                                        <div class="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-2xl -mr-16 -mt-16 pointer-events-none"></div>
                                        <div class="relative z-10 text-center">
                                            <div class="inline-flex items-center gap-2 bg-white/20 backdrop-blur-md px-4 py-1.5 rounded-full text-xs font-bold mb-4 shadow-sm">
                                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                                                </svg>
                                                ACTION REQUIRED
                                            </div>
                                            <h2 class="text-2xl font-extrabold tracking-tight mb-2">Confirm Expiry</h2>
                                            <p class="text-blue-100 text-sm font-medium">Multiple batches found</p>
                                        </div>
                                    </div>
                                    
                                    <div class="p-6 sm:p-8 space-y-6">
                                        <!-- Product Info -->
                                        <div class="text-center relative">
                                            <div class="absolute inset-x-0 top-1/2 h-px bg-slate-100 -z-10"></div>
                                            <span class="bg-white px-4 text-slate-400 text-xs font-bold uppercase tracking-wider">Product Details</span>
                                            
                                            <div class="mt-4">
                                                <div class="inline-block bg-slate-100 text-slate-600 px-4 py-1.5 rounded-lg text-sm font-bold mb-3 font-mono border border-slate-200">
                                                    ${scan.stockCode}
                                                </div>
                                                <h3 class="text-lg font-bold text-slate-900 leading-snug mb-1">${scan.description}</h3>
                                                <div class="text-sm font-medium text-slate-500">Batch: ${scan.batchNumber}</div>
                                            </div>
                                        </div>
                                        
                                        <!-- Expiry Date Options -->
                                        <div class="space-y-3">
                                            <label class="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1 ml-1">
                                                Select Correct Date
                                            </label>
                                            ${scan.availableExpiryDates.map(expDate => {
                const exp = new Date(expDate);
                exp.setHours(0, 0, 0, 0);
                const isExpired = exp <= today;
                const displayDate = exp.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

                return `
                                                    <button 
                                                        onclick="app.selectExpiryDate('${expDate}')"
                                                        class="group w-full p-4 border-2 ${isExpired ? 'border-red-100 bg-red-50/50 hover:border-red-300' : 'border-slate-100 bg-white hover:border-blue-400 hover:shadow-lg hover:shadow-blue-500/10'} rounded-2xl transition-all text-left flex items-center justify-between relative overflow-hidden"
                                                    >
                                                        <div class="flex items-center gap-4 relative z-10">
                                                            <div class="w-10 h-10 ${isExpired ? 'bg-red-100' : 'bg-blue-50 group-hover:bg-blue-600'} rounded-xl flex items-center justify-center transition-colors">
                                                                <svg class="w-5 h-5 ${isExpired ? 'text-red-500' : 'text-blue-600 group-hover:text-white'} transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                                                                </svg>
                                                            </div>
                                                            <div>
                                                                <div class="font-bold text-base ${isExpired ? 'text-red-700' : 'text-slate-900'}">${displayDate}</div>
                                                                ${isExpired ? '<div class="text-xs text-red-500 font-bold mt-0.5">⚠️ EXPIRED</div>' : '<div class="text-xs text-slate-400 font-medium mt-0.5">Valid</div>'}
                                                            </div>
                                                        </div>
                                                        <div class="w-8 h-8 rounded-full border-2 ${isExpired ? 'border-red-200' : 'border-slate-200 group-hover:border-blue-500 group-hover:bg-blue-500'} flex items-center justify-center transition-all">
                                                            <svg class="w-4 h-4 text-white opacity-0 ${!isExpired ? 'group-hover:opacity-100' : ''} transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/>
                                                            </svg>
                                                        </div>
                                                    </button>
                                                `;
            }).join('')}
                                        </div>
                                        
                                        <!-- Cancel Button -->
                                        <button 
                                            onclick="app.cancelExpirySelection()" 
                                            class="w-full py-4 text-slate-500 hover:text-slate-800 font-bold text-sm transition-colors rounded-xl hover:bg-slate-50"
                                        >
                                            Cancel Selection
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `);
            return;
        }

        if (this.showingCaseEntry && this.currentScan) {
            const scan = this.currentScan;
            // Check if expired
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            let isExpired = false;
            let expiryDisplay = '';
            if (scan.expiryDate) {
                const expiry = new Date(scan.expiryDate);
                expiry.setHours(0, 0, 0, 0);
                isExpired = expiry <= today;
                expiryDisplay = expiry.toLocaleDateString();
            }
            updateView(`
                <div class="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 sm:p-6 relative overflow-hidden">
                             <!-- Background Decoration -->
                            <div class="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-${isExpired ? 'red' : 'blue'}-50 to-slate-50 pointer-events-none"></div>

                            <div class="w-full max-w-md relative z-10 animate-fade-up">
                                <div class="bg-white/80 backdrop-blur-xl border border-white/50 shadow-xl rounded-[2rem] overflow-hidden">
                                    <!-- Header -->
                                    <div class="${isExpired ? 'bg-gradient-to-br from-red-600 to-red-700' : 'bg-gradient-to-br from-blue-600 to-blue-700'} p-6 sm:p-8 text-white relative overflow-hidden">
                                        <div class="absolute top-0 right-0 w-32 h-32 bg-white/10 rounded-full blur-2xl -mr-16 -mt-16 pointer-events-none"></div>
                                        <div class="relative z-10 text-center">
                                            ${isExpired ? `
                                            <div class="inline-flex items-center gap-2 bg-red-800/20 backdrop-blur-md px-4 py-1.5 rounded-full text-xs font-bold mb-4 shadow-sm border border-red-400/20">
                                                <svg class="w-4 h-4 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                                                </svg>
                                                EXPIRED PRODUCT
                                            </div>
                                            ` : ''}
                                            <h2 class="text-2xl font-extrabold tracking-tight mb-2">Confirm Count</h2>
                                            <p class="${isExpired ? 'text-red-100' : 'text-blue-100'} text-sm font-medium">Verify stock quantity</p>
                                        </div>
                                    </div>
                                    
                                    ${isExpired ? `
                                        <div class="bg-red-50/50 border-b border-red-100 p-4 flex items-center gap-3">
                                            <div class="flex-shrink-0 w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-sm">
                                                <svg class="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                                </svg>
                                            </div>
                                            <div>
                                                <div class="font-bold text-red-700">Expired: ${expiryDisplay}</div>
                                                <div class="text-xs font-medium text-red-600">Product is past expiry date</div>
                                            </div>
                                        </div>
                                    ` : (scan.expiryDate ? `
                                        <div class="bg-blue-50/50 border-b border-blue-100 p-3 flex items-center justify-center gap-2 text-sm text-blue-700 font-medium">
                                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                                            </svg>
                                            <span>Expires: ${expiryDisplay}</span>
                                        </div>
                                    ` : '')}
                                    
                                    <div class="p-6 sm:p-8 space-y-6">
                                        <!-- Product Info -->
                                        <div class="text-center relative">
                                            <div class="absolute inset-x-0 top-1/2 h-px bg-slate-100 -z-10"></div>
                                            <span class="bg-white px-4 text-slate-400 text-xs font-bold uppercase tracking-wider">Details</span>
                                            
                                            <div class="mt-4">
                                                <div class="inline-block ${isExpired ? 'bg-red-50 text-red-700 border-red-100' : 'bg-slate-100 text-slate-600 border-slate-200'} px-4 py-1.5 rounded-lg text-sm font-bold mb-3 font-mono border">
                                                    ${scan.stockCode}
                                                </div>
                                                <h3 class="text-lg font-bold text-slate-900 leading-snug mb-2 px-4">${scan.description}</h3>
                                                ${scan.isRawMaterial ? `
                                                    <div class="flex flex-wrap justify-center gap-2">
                                                        <span class="px-2 py-1 bg-slate-100 rounded text-xs text-slate-500 font-medium">Batch: ${scan.batchNumber}</span>
                                                        <span class="px-2 py-1 ${scan.unitType === 'kg' ? 'bg-teal-100 text-teal-700' : 'bg-blue-100 text-blue-700'} rounded text-xs font-bold">
                                                            ${scan.unitType === 'kg' ? '⚖️ KG' : '📦 Unit'}
                                                        </span>
                                                    </div>
                                                ` : `
                                                    <div class="flex flex-wrap justify-center gap-2">
                                                        <span class="px-2 py-1 bg-slate-100 rounded text-xs text-slate-500 font-medium">Batch: ${scan.batchNumber}</span>
                                                        <span class="px-2 py-1 bg-slate-100 rounded text-xs text-slate-500 font-medium">Pallet: ${scan.palletNumber}</span>
                                                    </div>
                                                `}
                                            </div>
                                        </div>

                                        <!-- Count Input -->
                                        <div class="bg-slate-50/50 rounded-2xl p-6 border border-slate-100">
                                            ${!scan.isRawMaterial ? `
                                                <div class="flex justify-between items-center mb-4 pb-4 border-b border-slate-200 border-dashed">
                                                    <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">Expected Count</span>
                                                    <span class="text-xl font-bold text-slate-400 font-mono">${scan.casesOnPallet}</span>
                                                </div>
                                            ` : ''}
                                            
                                            <div class="relative">
                                                <label class="block text-xs font-bold ${isExpired ? 'text-red-600' : 'text-blue-600'} uppercase tracking-wider mb-2">
                                                    ${scan.isRawMaterial ? (scan.unitType === 'kg' ? 'Enter Quantity (KG)' : 'Enter Quantity (Units)') : 'Actual Count'}
                                                </label>
                                                <input
                                                    type="number"
                                                    id="caseInput"
                                                    value="${scan.isRawMaterial ? '' : scan.casesOnPallet}"
                                                    min="0"
                                                    ${scan.unitType === 'kg' ? 'step="0.01"' : ''}
                                                    placeholder="${scan.isRawMaterial ? 'Enter ' + scan.unitType : ''}"
                                                    class="w-full px-4 py-4 bg-white border-2 ${isExpired ? 'border-red-100 text-red-900 focus:border-red-500 focus:ring-red-500/20' : 'border-slate-200 text-slate-900 focus:border-blue-500 focus:ring-blue-500/20'} rounded-xl text-3xl font-black text-center focus:ring-4 outline-none transition-all shadow-sm"
                                                    autofocus
                                                    onclick="this.select()"
                                                />
                                                ${scan.isRawMaterial ? `
                                                    <div class="mt-2 text-center text-xs font-medium text-slate-400">${scan.unitType === 'kg' ? 'Precision up to 2 decimals allowed' : 'Whole numbers only'}</div>
                                                ` : ''}
                                            </div>
                                        </div>
                                        
                                        <!-- Actions -->
                                        <div class="grid grid-cols-2 gap-4">
                                            <button onclick="app.cancelCaseEntry()" class="w-full py-4 bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900 hover:border-slate-300 rounded-xl font-bold text-sm transition-all">
                                                Cancel
                                            </button>
                                            <button onclick="app.submitCaseCount()" class="w-full py-4 ${isExpired ? 'bg-red-600 hover:bg-red-700 shadow-red-200' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-200'} text-white rounded-xl font-bold text-sm shadow-xl transition-all transform active:scale-95">
                                                ${isExpired ? 'Confirm (Expired)' : 'Confirm Count'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div >
                `);
            return;
        }

        if (this.showingProductDB) {
            updateView(`
                        <div class="min-h-screen bg-slate-50 flex flex-col items-center">
                            <!-- Header with Glass Effect -->
                            <div class="sticky top-0 z-30 w-full bg-white/80 backdrop-blur-xl border-b border-white/20 shadow-sm">
                                <div class="max-w-4xl mx-auto p-4 sm:p-6">
                                    <div class="flex items-center justify-between mb-4">
                                        <div>
                                            <h1 class="text-2xl font-extrabold text-slate-900 tracking-tight">Product Database</h1>
                                            <div class="flex items-center gap-2 mt-1">
                                                <span class="bg-blue-100 text-blue-700 px-2 py-0.5 rounded text-xs font-bold">${Object.keys(productDatabase).length} Items</span>
                                                <span class="text-xs text-slate-400 font-medium">${productsLoadedFromDB ? '• Synced with Cloud' : '• Local Cache'}</span>
                                            </div>
                                        </div>
                                        <button onclick="app.hideProductDatabase()" class="group bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-800 p-2.5 rounded-xl transition-all">
                                            <svg class="w-6 h-6 transform group-hover:rotate-90 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                                            </svg>
                                        </button>
                                    </div>
                                    
                                    <div class="flex gap-3 overflow-x-auto pb-2 -mb-2 no-scrollbar">
                                        <button onclick="app.refreshProductsFromCloud()" class="flex-none bg-blue-50 hover:bg-blue-100 text-blue-700 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors flex items-center gap-2">
                                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                                            </svg>
                                            <span class="whitespace-nowrap">Sync</span>
                                        </button>
                                        <button onclick="app.uploadExcel()" class="flex-none bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors flex items-center gap-2">
                                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                                            </svg>
                                            <span class="whitespace-nowrap">Import Excel</span>
                                        </button>
                                        <button onclick="app.exportProductDatabase()" class="flex-none bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors flex items-center gap-2">
                                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                                            </svg>
                                            <span class="whitespace-nowrap">Export CSV</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Content Grid -->
                            <div class="w-full max-w-4xl mx-auto p-4 sm:p-6 pb-32">
                                ${Object.keys(productDatabase).length === 0 ? `
                                    <div class="flex flex-col items-center justify-center py-20 text-center">
                                        <div class="w-24 h-24 bg-slate-100 rounded-3xl flex items-center justify-center mb-6 rotate-3">
                                            <svg class="w-12 h-12 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"/>
                                            </svg>
                                        </div>
                                        <h3 class="text-xl font-bold text-slate-900 mb-2">No Products Found</h3>
                                        <p class="text-slate-500 max-w-xs mx-auto">Import an Excel file or add products manually to get started.</p>
                                    </div>
                                ` : `
                                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        ${Object.entries(productDatabase).map(([batch, info]) => `
                                            <div class="group bg-white p-4 rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition-all hover:-translate-y-1">
                                                <div class="flex items-start justify-between mb-3">
                                                    <div class="bg-slate-50 px-2 py-1 rounded-lg text-xs font-mono font-bold text-slate-500 border border-slate-100 group-hover:bg-blue-50 group-hover:text-blue-600 transition-colors">
                                                        ${batch}
                                                    </div>
                                                    <div class="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-full">
                                                        ${info.stockCode}
                                                    </div>
                                                </div>
                                                <div class="text-slate-900 font-medium text-sm leading-snug line-clamp-2" title="${info.description}">
                                                    ${info.description}
                                                </div>
                                            </div>
                                        `).join('')}
                                    </div>
                                `}
                            </div>
                            
                            <!-- Bottom Action Bar -->
                            <div class="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-200 p-4 z-40">
                                <div class="max-w-4xl mx-auto flex flex-col sm:flex-row gap-3">
                                    <button onclick="app.addProduct()" class="flex-1 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white py-3.5 px-6 rounded-xl font-bold text-sm shadow-lg shadow-blue-200 transition-all transform active:scale-[0.98] flex items-center justify-center gap-2">
                                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
                                        </svg>
                                        Add New Product
                                    </button>
                                    ${Object.keys(productDatabase).length > 0 ? `
                                        <button onclick="app.clearDatabase()" class="sm:w-auto px-6 py-3.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-bold text-sm transition-colors">
                                            Clear All
                                        </button>
                                    ` : ''}
                                </div>
                            </div>
                        </div>
                `);
            return;
        }

        if (this.showingRMProductDB) {
            const rmCount = Object.keys(rawMaterialsDatabase).length;
            let totalBatches = 0;
            Object.values(rawMaterialsDatabase).forEach(rm => {
                totalBatches += Object.keys(rm.batches || {}).length;
            });

            updateView(`
                        <div class="min-h-screen bg-slate-50 flex flex-col items-center">
                            <!-- Header with Glass Effect -->
                            <div class="sticky top-0 z-30 w-full bg-white/80 backdrop-blur-xl border-b border-white/20 shadow-sm">
                                <div class="max-w-4xl mx-auto p-4 sm:p-6">
                                    <div class="flex items-center justify-between mb-4">
                                        <div>
                                            <h1 class="text-2xl font-extrabold text-slate-900 tracking-tight">Raw Materials</h1>
                                            <div class="flex items-center gap-2 mt-1">
                                                <span class="bg-teal-100 text-teal-700 px-2 py-0.5 rounded text-xs font-bold">${rmCount} Materials</span>
                                                <span class="text-xs text-slate-400 font-medium">${rmProductsLoadedFromDB ? '• Synced with Cloud' : '• Local Cache'}</span>
                                            </div>
                                        </div>
                                        <button onclick="app.hideProductDatabase()" class="group bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-800 p-2.5 rounded-xl transition-all">
                                            <svg class="w-6 h-6 transform group-hover:rotate-90 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                                            </svg>
                                        </button>
                                    </div>
                                    
                                    <div class="flex gap-3 overflow-x-auto pb-2 -mb-2 no-scrollbar">
                                        <button onclick="app.refreshProductsFromCloud()" class="flex-none bg-blue-50 hover:bg-blue-100 text-blue-700 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors flex items-center gap-2">
                                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                                            </svg>
                                            <span class="whitespace-nowrap">Sync</span>
                                        </button>
                                        <button onclick="app.uploadRMExcel()" class="flex-none bg-teal-50 hover:bg-teal-100 text-teal-700 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors flex items-center gap-2">
                                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                                            </svg>
                                            <span class="whitespace-nowrap">Import Excel</span>
                                        </button>
                                        <button onclick="app.exportRMDatabase()" class="flex-none bg-emerald-50 hover:bg-emerald-100 text-emerald-700 px-4 py-2.5 rounded-xl text-sm font-bold transition-colors flex items-center gap-2">
                                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                                            </svg>
                                            <span class="whitespace-nowrap">Export CSV</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                            
                            <!-- Content Grid -->
                            <div class="w-full max-w-4xl mx-auto p-4 sm:p-6 pb-32">
                                ${rmCount === 0 ? `
                                    <div class="flex flex-col items-center justify-center py-20 text-center">
                                        <div class="w-24 h-24 bg-teal-50 rounded-3xl flex items-center justify-center mb-6 rotate-3">
                                            <svg class="w-12 h-12 text-teal-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"/>
                                            </svg>
                                        </div>
                                        <h3 class="text-xl font-bold text-slate-900 mb-2">No Raw Materials</h3>
                                        <p class="text-slate-500 max-w-xs mx-auto">Import an Excel file or add materials manually to get started.</p>
                                    </div>
                                ` : `
                                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                        ${Object.entries(rawMaterialsDatabase).map(([stockCode, info]) => `
                                            <div class="group bg-white p-4 rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition-all hover:-translate-y-1">
                                                <div class="flex items-start justify-between mb-3">
                                                    <div class="bg-teal-50 px-2 py-1 rounded-lg text-xs font-mono font-bold text-teal-600 border border-teal-100">
                                                        ${stockCode}
                                                    </div>
                                                    <div class="text-xs font-bold text-slate-400">
                                                        ${Object.keys(info.batches || {}).length} batches
                                                    </div>
                                                </div>
                                                <div class="text-slate-900 font-medium text-sm leading-snug line-clamp-2 mb-3" title="${info.description}">
                                                    ${info.description}
                                                </div>
                                                ${Object.keys(info.batches || {}).length > 0 ? `
                                                    <div class="flex flex-wrap gap-1.5">
                                                        ${Object.entries(info.batches).slice(0, 3).map(([batch, batchInfo]) => `
                                                            <span class="text-[0.65rem] bg-slate-50 text-slate-500 border border-slate-100 px-1.5 py-0.5 rounded font-mono ${batchInfo.expiryDate && new Date(batchInfo.expiryDate) < new Date() ? 'bg-red-50 text-red-600 border-red-100' : ''}">
                                                                ${batch}
                                                            </span>
                                                        `).join('')}
                                                        ${Object.keys(info.batches || {}).length > 3 ? `<span class="text-[0.65rem] text-slate-400 px-1">+${Object.keys(info.batches).length - 3}</span>` : ''}
                                                    </div>
                                                ` : ''}
                                            </div>
                                        `).join('')}
                                    </div>
                                `}
                            </div>
                            
                            <!-- Bottom Action Bar -->
                            <div class="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-slate-200 p-4 z-40">
                                <div class="max-w-4xl mx-auto flex flex-col sm:flex-row gap-3">
                                    <button onclick="app.addRawMaterial()" class="flex-1 bg-teal-600 hover:bg-teal-700 text-white py-3.5 px-6 rounded-xl font-bold text-sm shadow-lg shadow-teal-200 transition-all transform active:scale-[0.98] flex items-center justify-center gap-2">
                                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
                                        </svg>
                                        Add Raw Material
                                    </button>
                                    ${rmCount > 0 ? `
                                        <button onclick="app.clearRMDatabase()" class="sm:w-auto px-6 py-3.5 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl font-bold text-sm transition-colors block text-center">
                                            Clear All
                                        </button>
                                    ` : ''}
                                </div>
                            </div>
                        </div>
                `);
            return;
        }

        // Session History Screen
        if (this.showingSessionHistory) {
            const groupedSessions = {};
            const liveSessions = [];
            const historicalSessions = [];
            const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD format

            this.historySessions.forEach(session => {
                const date = session.date || 'Unknown';
                if (!groupedSessions[date]) groupedSessions[date] = [];
                groupedSessions[date].push(session);

                // Separate live (active) from historical
                // A session is live if its status is 'active'
                if (session.status === 'active') {
                    liveSessions.push(session);
                } else {
                    historicalSessions.push(session);
                }
            });

            // Group historical sessions by date
            const groupedHistorical = {};
            historicalSessions.forEach(session => {
                const date = session.date || 'Unknown';
                if (!groupedHistorical[date]) groupedHistorical[date] = [];
                groupedHistorical[date].push(session);
            });

            const historySession = this.selectedHistorySession;
            updateView(`
                        <div class="min-h-screen bg-slate-50 flex flex-col items-center">
                            <!-- Header with Glass Effect -->
                            <div class="sticky top-0 z-30 w-full bg-white/80 backdrop-blur-xl border-b border-white/20 shadow-sm">
                                <div class="max-w-4xl mx-auto p-4 sm:p-6">
                                    <div class="flex items-center justify-between">
                                        <div class="flex items-center gap-3">
                                            <div class="w-10 h-10 sm:w-12 sm:h-12 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-200">
                                                <svg class="w-5 h-5 sm:w-6 sm:h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                                </svg>
                                            </div>
                                            <div>
                                                <h1 class="text-xl sm:text-2xl font-extrabold text-slate-900 tracking-tight">History</h1>
                                                <p class="text-xs sm:text-sm text-slate-500 font-medium">${liveSessions.length} active - ${historicalSessions.length} past</p>
                                            </div>
                                        </div>
                                        <button onclick="app.hideSessionHistory()" class="group bg-white border border-slate-200 hover:border-blue-300 hover:bg-blue-50 p-2.5 rounded-xl transition-all shadow-sm">
                                            <svg class="w-5 h-5 text-slate-400 group-hover:text-blue-600 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                            </div>

                            <div class="w-full max-w-4xl mx-auto p-4 sm:p-6 pb-24">
                                ${historySession ? `
                                    <!-- Selected Session Details -->
                                    <div class="bg-white rounded-[2rem] shadow-xl shadow-slate-200 overflow-hidden border border-slate-100 animate-fade-up">
                                        <div class="p-6 sm:p-8 bg-gradient-to-br from-slate-50 to-white border-b border-slate-100">
                                            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                                                <div class="flex items-start gap-4">
                                                    <div class="w-12 h-12 ${this.selectedHistorySession.sessionType === 'RM' ? 'bg-teal-100 text-teal-600' : 'bg-blue-100 text-blue-600'} rounded-2xl flex items-center justify-center">
                                                        <span class="text-xl">
                                                            ${this.selectedHistorySession.sessionType === 'RM' ? '🧪' : '📦'}
                                                        </span>
                                                    </div>
                                                    <div>
                                                        <div class="flex items-center gap-2 mb-1">
                                                            <span class="${this.selectedHistorySession.sessionType === 'RM' ? 'bg-teal-50 text-teal-700 border-teal-100' : 'bg-blue-50 text-blue-700 border-blue-100'} border text-xs font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wide">
                                                                ${this.selectedHistorySession.sessionType === 'RM' ? 'Raw Materials' : 'Finished Products'}
                                                            </span>
                                                            <span class="text-slate-400 text-xs font-bold">•</span>
                                                            <span class="text-xs font-bold text-slate-500">${this.selectedHistorySession.date}</span>
                                                        </div>
                                                        <h2 class="text-lg font-bold text-slate-900 leading-tight">
                                                            ${this.selectedHistorySession.warehouse || 'Unknown Warehouse'}
                                                        </h2>
                                                        <div class="flex items-center gap-2 mt-1">
                                                            <span class="text-xs font-medium text-slate-500 flex items-center gap-1">
                                                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                                                                ${this.selectedHistorySession.startedBy || 'Unknown supervisor'}
                                                            </span>
                                                            ${this.selectedHistorySession.startTime ? `
                                                                <span class="text-slate-300 text-xs">•</span>
                                                                <span class="text-xs font-medium text-slate-500 flex items-center gap-1">
                                                                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                                                                    ${this.selectedHistorySession.startTime}
                                                                </span>
                                                            ` : ''}
                                                        </div>
                                                    </div>
                                                </div>
                                                
                                                <button onclick="app.exportHistorySession()" class="group flex items-center justify-center gap-2 px-5 py-3 ${this.selectedHistorySession.sessionType === 'RM' ? 'bg-teal-600 hover:bg-teal-700 shadow-teal-200' : 'bg-blue-600 hover:bg-blue-700 shadow-blue-200'} text-white rounded-xl text-sm font-bold shadow-lg transition-all transform active:scale-95">
                                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                                                    </svg>
                                                    Export CSV
                                                </button>
                                            </div>
                                            
                                            <div class="flex items-center gap-2 py-3 px-4 bg-white rounded-xl border border-slate-100 shadow-sm">
                                                <div class="w-2 h-2 rounded-full ${this.historyLoading ? 'bg-amber-400 animate-pulse' : 'bg-emerald-500'}"></div>
                                                <span class="text-sm font-bold text-slate-700">
                                                    ${this.historyLoading ? 'Loading scan data...' : `${this.historyScans.length} Total Scans`}
                                                </span>
                                            </div>
                                        </div>
                                        
                                        <!-- Scans List -->
                                        <div class="bg-white min-h-[300px] max-h-[60vh] overflow-y-auto custom-scrollbar">
                                            ${this.historyLoading ? `
                                                <div class="h-64 flex flex-col items-center justify-center text-center p-8">
                                                    <div class="w-12 h-12 border-4 border-blue-100 border-t-blue-500 rounded-full animate-spin mb-4"></div>
                                                    <p class="text-slate-500 font-medium">Retrieving session data...</p>
                                                </div>
                                            ` : this.historyScans.length > 0 ? `
                                                <div class="divide-y divide-slate-50">
                                                    ${this.historyScans.map((scan, idx) => `
                                                        <div class="p-4 hover:bg-slate-50 transition-colors flex items-center justify-between group">
                                                            <div class="flex-1 min-w-0 pr-4">
                                                                <div class="flex items-center gap-2 mb-1">
                                                                    <span class="font-bold text-slate-900">${scan.stockCode}</span>
                                                                    <span class="text-[10px] uppercase tracking-wider font-bold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">Batch ${scan.batchNumber}</span>
                                                                </div>
                                                                <p class="text-sm text-slate-600 truncate font-medium">${scan.description || 'No description'}</p>
                                                                <div class="flex items-center gap-3 mt-1.5">
                                                                    ${scan.location ? `
                                                                        <span class="inline-flex items-center gap-1 text-xs text-slate-400 font-medium">
                                                                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                                                                            ${scan.location}
                                                                        </span>
                                                                    ` : ''}
                                                                    ${scan.expiryDate ? `
                                                                        <span class="inline-flex items-center gap-1 text-xs text-slate-400 font-medium ${new Date(scan.expiryDate) < new Date() ? 'text-red-400' : ''}">
                                                                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
                                                                            ${scan.expiryDate}
                                                                        </span>
                                                                    ` : ''}
                                                                </div>
                                                            </div>
                                                            <div class="text-right flex flex-col items-end">
                                                                <div class="text-xl font-black ${this.selectedHistorySession.sessionType === 'RM' ? 'text-teal-600' : 'text-blue-600'}">
                                                                    ${scan.cases}
                                                                </div>
                                                                <div class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">${scan.unitType || 'units'}</div>
                                                            </div>
                                                        </div>
                                                    `).join('')}
                                                </div>
                                            ` : `
                                                <div class="h-64 flex flex-col items-center justify-center text-center p-8">
                                                    <div class="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                                                        <svg class="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                                                        </svg>
                                                    </div>
                                                    <p class="text-slate-900 font-bold">No scans recorded</p>
                                                    <p class="text-slate-500 text-sm mt-1">This session is empty</p>
                                                </div>
                                            `}
                                        </div>
                                        
                                        <div class="p-4 bg-slate-50 border-t border-slate-100">
                                            <button onclick="app.selectedHistorySession = null; app.historyScans = []; app.historyLoading = false; app.render();" class="w-full bg-white border border-slate-200 hover:bg-slate-50 hover:border-slate-300 text-slate-600 py-3 rounded-xl text-sm font-bold transition-all shadow-sm">
                                                ← Back to All Sessions
                                            </button>
                                        </div>
                                    </div>
                                ` : `
                                    <!-- Sessions List Card -->
                                    <div class="bg-white rounded-[2rem] shadow-xl shadow-slate-200 overflow-hidden border border-slate-100">
                                        <div class="max-h-[70vh] overflow-y-auto custom-scrollbar">
                                            ${liveSessions.length > 0 ? `
                                                <!-- Live Sessions Section -->
                                                <div class="sticky top-0 z-10 bg-emerald-50/90 backdrop-blur-md border-b border-emerald-100 px-6 py-3 flex items-center gap-2">
                                                    <div class="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]"></div>
                                                    <span class="text-xs font-bold text-emerald-800 uppercase tracking-widest">Live Sessions</span>
                                                    <span class="bg-emerald-200 text-emerald-800 text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-auto">${liveSessions.length} active</span>
                                                </div>
                                                <div class="divide-y divide-emerald-50">
                                                    ${liveSessions.map(session => `
                                                        <button onclick="app.loadSessionHistory('${session.id}')" class="w-full p-4 sm:p-5 hover:bg-emerald-50/50 transition-all text-left group">
                                                            <div class="flex items-center justify-between">
                                                                <div class="flex items-center gap-4">
                                                                    <div class="relative">
                                                                        <div class="w-12 h-12 ${session.sessionType === 'RM' ? 'bg-teal-100 text-teal-600' : 'bg-blue-100 text-blue-600'} rounded-2xl flex items-center justify-center shadow-sm group-hover:scale-105 transition-transform">
                                                                            <span class="text-xl">${session.sessionType === 'RM' ? '🧪' : '📦'}</span>
                                                                        </div>
                                                                        <div class="absolute -bottom-1 -right-1 w-5 h-5 bg-emerald-500 border-2 border-white rounded-full flex items-center justify-center" title="Live">
                                                                            <div class="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></div>
                                                                        </div>
                                                                    </div>
                                                                    <div>
                                                                        <div class="flex items-center gap-2 mb-1">
                                                                            <span class="font-bold text-base text-slate-800 group-hover:text-blue-700 transition-colors">
                                                                                ${session.sessionType === 'RM' ? 'Raw Materials' : 'Finished Products'}
                                                                            </span>
                                                                        </div>
                                                                        <div class="flex flex-col gap-0.5">
                                                                            <span class="text-xs font-medium text-slate-600 flex items-center gap-1.5">
                                                                                <svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                                                                                ${session.warehouse || 'No location set'}
                                                                            </span>
                                                                            <span class="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                                                                                <svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                                                                                Started by ${session.startedBy || 'Unknown'}
                                                                            </span>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <div class="flex flex-col items-end gap-2">
                                                                    ${session.activeDeviceCount > 0 ? `
                                                                        <span class="bg-emerald-100 text-emerald-700 text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1">
                                                                            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
                                                                            ${session.activeDeviceCount} Active
                                                                        </span>
                                                                    ` : ''}
                                                                    <svg class="w-5 h-5 text-slate-300 group-hover:text-blue-500 group-hover:translate-x-1 transition-all" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                                                                    </svg>
                                                                </div>
                                                            </div>
                                                        </button>
                                                    `).join('')}
                                                </div>
                                            ` : ''}

                                            <!-- Historical Sessions -->
                                            ${Object.keys(groupedHistorical).length > 0 ? Object.entries(groupedHistorical).map(([date, sessions]) => `
                                                <div class="sticky top-0 z-10 bg-slate-50/90 backdrop-blur-md border-b border-slate-200 border-t border-t-slate-100 px-6 py-2.5 flex items-center justify-between">
                                                    <span class="text-xs font-bold text-slate-500 uppercase tracking-widest">${date === today ? 'Today' : date}</span>
                                                    <span class="bg-slate-200 text-slate-600 text-[10px] font-bold px-1.5 py-0.5 rounded-full">${sessions.length}</span>
                                                </div>
                                                <div class="divide-y divide-slate-50">
                                                    ${sessions.map(session => `
                                                        <button onclick="app.loadSessionHistory('${session.id}')" class="w-full p-4 sm:p-5 hover:bg-slate-50 transition-all text-left group">
                                                            <div class="flex items-center justify-between">
                                                                <div class="flex items-center gap-4">
                                                                    <div class="w-12 h-12 ${session.sessionType === 'RM' ? 'bg-teal-50 text-teal-600' : 'bg-blue-50 text-blue-600'} rounded-2xl flex items-center justify-center group-hover:scale-105 transition-transform">
                                                                        <span class="text-xl grayscale group-hover:grayscale-0 transition-all">${session.sessionType === 'RM' ? '🧪' : '📦'}</span>
                                                                    </div>
                                                                    <div>
                                                                        <div class="flex items-center gap-2 mb-1">
                                                                            <span class="font-bold text-base text-slate-700 group-hover:text-slate-900 transition-colors">
                                                                                ${session.sessionType === 'RM' ? 'Raw Materials' : 'Finished Products'}
                                                                            </span>
                                                                            ${session.status === 'completed' ? `
                                                                                <span class="bg-slate-100 text-slate-500 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider">Done</span>
                                                                            ` : ''}
                                                                        </div>
                                                                        <div class="text-xs font-medium text-slate-500 flex items-center gap-1.5">
                                                                            <svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                                                                            ${session.startTime || 'No time recorded'}
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                                <svg class="w-5 h-5 text-slate-200 group-hover:text-slate-400 group-hover:translate-x-1 transition-all" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                                                                </svg>
                                                            </div>
                                                        </button>
                                                    `).join('')}
                                                </div>
                                            `).join('') : (liveSessions.length === 0 ? `
                                                <div class="flex flex-col items-center justify-center py-20 text-center">
                                                    <div class="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-6">
                                                        <svg class="w-10 h-10 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                                        </svg>
                                                    </div>
                                                    <h3 class="text-lg font-bold text-slate-900">No sessions found</h3>
                                                    <p class="text-slate-500 text-sm mt-1 max-w-xs mx-auto">Complete a stock count in the main dashboard to see it recorded here.</p>
                                                </div>
                                            ` : '')}
                                        </div>
                    </div>

                <button onclick="app.hideSessionHistory()" class="w-full bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 py-3 rounded-xl text-sm font-bold transition-colors">
                    Close
                </button>
                `}
                        </div>
                `);
            return;
        }

        // Warehouse Setup Screen
        if (this.showingWarehouseSetup) {
            const racks = this.sessionSettings.warehouseConfig?.racks || [];
            const floors = this.sessionSettings.warehouseConfig?.floorLocations || [];

            updateView(`
                < div class= "min-h-screen bg-slate-50 flex items-center justify-center p-4" >
                <div class="w-full max-w-lg bg-white rounded-[2rem] shadow-2xl shadow-slate-200 overflow-hidden animate-fade-up">
                    <!-- Header -->
                    <div class="p-6 bg-gradient-to-br from-blue-600 to-blue-800 text-white relative overflow-hidden">
                        <div class="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGcgb3BhY2l0eT0iMC4xIiBmaWxsPSIjZmZmIj48Y2lyY2xlIGN4PSIxIiBjeT0iMSIgcj0iMSIvPjwvZz48L3N2Zz4=')] opacity-20"></div>

                        <div class="relative flex items-center justify-between">
                            <div class="flex items-center gap-4">
                                <div class="w-12 h-12 bg-white/20 backdrop-blur-md rounded-2xl flex items-center justify-center border border-white/30">
                                    <span class="text-2xl">🏭</span>
                                </div>
                                <div>
                                    <h2 class="text-xl font-bold">Warehouse Setup</h2>
                                    <p class="text-blue-100 text-sm font-medium">Configure racks & floor areas</p>
                                </div>
                            </div>
                            <button onclick="app.hideWarehouseSetup()" class="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl transition-all border border-white/10">
                                <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>

                    <div class="p-6 space-y-8 max-h-[70vh] overflow-y-auto custom-scrollbar">
                        <!-- Racks Section -->
                        <div class="space-y-4">
                            <div class="flex items-center justify-between">
                                <h3 class="font-bold text-slate-800 flex items-center gap-2">
                                    <span class="w-8 h-8 bg-blue-100 text-blue-600 rounded-lg flex items-center justify-center text-lg">📦</span>
                                    Racks
                                </h3>
                                <button onclick="app.addRack()" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold rounded-xl transition-all shadow-lg shadow-blue-200 transform active:scale-95 flex items-center gap-2">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
                                    Add Rack
                                </button>
                            </div>

                            ${racks.length === 0 ? `
                                    <div class="p-8 border-2 border-dashed border-slate-200 rounded-2xl text-center flex flex-col items-center">
                                        <div class="w-12 h-12 bg-slate-50 rounded-full flex items-center justify-center mb-3">
                                            <svg class="w-6 h-6 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16m-7 6h7"/>
                                            </svg>
                                        </div>
                                        <p class="font-bold text-slate-700">No racks configured</p>
                                        <p class="text-sm text-slate-500 mt-1">Add racks to define storage structure</p>
                                    </div>
                                ` : `
                                    <div class="grid gap-3">
                                        ${racks.map(rack => `
                                            <div class="group p-4 border border-slate-200 hover:border-blue-200 rounded-2xl bg-slate-50 hover:bg-white transition-all shadow-sm hover:shadow-md">
                                                <div class="flex items-center justify-between mb-3">
                                                    <div class="flex items-center gap-3">
                                                        <div class="w-10 h-10 bg-white border border-slate-200 rounded-xl flex items-center justify-center font-black text-slate-700 shadow-sm">
                                                            ${rack.name}
                                                        </div>
                                                        <div>
                            <div class="mt-3 text-xs text-blue-600">
                                Levels go A→Z from bottom to top. Positions go 1→N from left to right.
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `}
    </div>

    <div class="p-4 border-t border-slate-100">
        <button onclick="app.hideWarehouseSetup()" class="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-colors">
            Done
        </button>
    </div>
</div>
</div>
`);
            return;
        }

        // Location Picker Screen
        if (this.showingLocationPicker) {
            const racks = this.sessionSettings.warehouseConfig?.racks || [];
            const floors = this.sessionSettings.warehouseConfig?.floorLocations || [];
            const selectedRack = this.selectedRackForPicker ? racks.find(r => r.id === this.selectedRackForPicker) : null;

            updateView(`
                            <div class="min-h-screen bg-slate-50 flex items-center justify-center p-4">
                                <div class="w-full max-w-lg bg-white rounded-[2rem] shadow-2xl shadow-slate-200 overflow-hidden animate-fade-up">
                                    <!-- Header -->
                                    <div class="p-6 bg-gradient-to-br from-blue-600 to-blue-800 text-white relative overflow-hidden">
                                        <div class="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAiIGhlaWdodD0iMjAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGcgb3BhY2l0eT0iMC4xIiBmaWxsPSIjZmZmIj48Y2lyY2xlIGN4PSIxIiBjeT0iMSIgcj0iMSIvPjwvZz48L3N2Zz4=')] opacity-20"></div>

                                        <div class="relative flex items-center justify-between">
                                            <div class="flex items-center gap-4">
                                                <div class="w-12 h-12 bg-white/20 backdrop-blur-md rounded-2xl flex items-center justify-center border border-white/30">
                                                    <span class="text-2xl">📍</span>
                                                </div>
                                                <div>
                                                    <h2 class="text-xl font-bold">Select Location</h2>
                                                    <p class="text-blue-100 text-sm font-medium">${selectedRack ? `Rack: ${selectedRack.name}` : 'Choose a rack or floor area'}</p>
                                                </div>
                                            </div>
                                            <button onclick="app.hideLocationPicker()" class="p-2.5 bg-white/10 hover:bg-white/20 rounded-xl transition-all border border-white/10">
                                                <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                                                </svg>
                                            </button>
                                        </div>
                                    </div>

                                    <div class="p-6 bg-slate-50 min-h-[300px] max-h-[70vh] overflow-y-auto custom-scrollbar">
                                        ${selectedRack ? `
                                <!-- Rack Detail View -->
                                <div class="animate-fade-in-right">
                                    <button onclick="app.selectRackForPicker(null)" class="text-slate-500 hover:text-blue-600 text-sm font-bold flex items-center gap-2 mb-6 group transition-colors">
                                        <div class="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center group-hover:bg-blue-50 group-hover:border-blue-200 transition-colors">
                                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
                                        </div>
                                        Back to all racks
                                    </button>
                                    
                                    <div class="bg-white rounded-2xl p-6 shadow-sm border border-slate-200 mb-6">
                                        <div class="flex items-center justify-between mb-4">
                                            <div>
                                                <div class="text-xs font-bold text-slate-400 uppercase tracking-wider">Rack Configuration</div>
                                                <div class="font-black text-2xl text-slate-800">${selectedRack.name}</div>
                                            </div>
                                            <div class="text-right">
                                                <div class="text-xs font-bold text-slate-400 uppercase tracking-wider">Capacity</div>
                                                <div class="font-bold text-blue-600">${selectedRack.columns} × ${selectedRack.levels} Grid</div>
                                            </div>
                                        </div>
                                        
                                        <!-- Grid Visualization -->
                                        <div class="overflow-x-auto pb-2">
                                            <div class="inline-block min-w-full">
                                                <!-- Column Headers -->
                                                <div class="flex gap-2 mb-2">
                                                    <div class="w-10 flex-shrink-0"></div>
                                                    ${Array.from({ length: selectedRack.columns }, (_, i) => `
                                                        <div class="w-12 flex-shrink-0 text-center text-xs font-bold text-slate-400">${i + 1}</div>
                                                    `).join('')}
                                                </div>
                                                
                                                <!-- Grid Rows (Levels) -->
                                                ${Array.from({ length: selectedRack.levels }, (_, levelIdx) => {
                const level = selectedRack.levels - levelIdx;
                const levelLetter = String.fromCharCode(64 + level);
                return `
                                                        <div class="flex gap-2 mb-2">
                                                            <div class="w-10 flex-shrink-0 flex items-center justify-center text-xs font-bold text-slate-400 bg-slate-100 rounded-lg">${levelLetter}</div>
                                                            ${Array.from({ length: selectedRack.columns }, (_, posIdx) => {
                    const position = posIdx + 1;
                    const locationCode = selectedRack.name + '-' + levelLetter + position;
                    const isSelected = this.sessionSettings.currentLocation === locationCode;
                    return `
                                                                    <button 
                                                                        onclick="app.selectRackPosition('${selectedRack.id}', ${level}, ${position})"
                                                                        class="w-12 h-12 flex-shrink-0 rounded-xl font-bold text-xs transition-all duration-200 transform hover:scale-105 active:scale-95 flex items-center justify-center border-2 
                                                                        ${isSelected
                            ? 'bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-200 z-10'
                            : 'bg-white border-slate-200 text-slate-600 hover:border-blue-400 hover:text-blue-600'}"
                                                                    >
                                                                        ${levelLetter}${position}
                                                                        ${isSelected ? '<span class="absolute -top-1 -right-1 flex h-3 w-3"><span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span><span class="relative inline-flex rounded-full h-3 w-3 bg-white"></span></span>' : ''}
                                                                    </button>
                                                                `;
                }).join('')}
                                                        </div>
                                                    `;
            }).join('')}
                                            </div>
                                        </div>
                                        
                                        <div class="mt-4 pt-4 border-t border-slate-100 flex items-center justify-center gap-4 text-xs text-slate-400 font-medium">
                                            <span class="flex items-center gap-1"><span class="w-3 h-3 bg-white border-2 border-slate-200 rounded"></span> Empty</span>
                                            <span class="flex items-center gap-1"><span class="w-3 h-3 bg-blue-600 rounded"></span> Selected</span>
                                        </div>
                                    </div>
                                </div>
                            ` : `
                                <div class="space-y-6 animate-fade-in-up">
                                    <!-- Rack Selection -->
                                    ${racks.length > 0 ? `
                                        <div>
                                            <h3 class="font-bold text-slate-800 mb-4 flex items-center gap-2 text-sm uppercase tracking-wider">
                                                <span class="text-lg">📦</span> Available Racks
                                            </h3>
                                            <div class="grid grid-cols-2 gap-3">
                                                ${racks.map(rack => `
                                                    <button 
                                                        onclick="app.selectRackForPicker('${rack.id}')"
                                                        class="group p-4 bg-white border border-slate-200 hover:border-blue-400 hover:shadow-lg hover:shadow-blue-50 rounded-2xl text-left transition-all duration-200"
                                                    >
                                                        <div class="flex items-start justify-between mb-2">
                                                            <div class="w-10 h-10 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform font-bold text-lg">R</div>
                                                            <svg class="w-5 h-5 text-slate-300 group-hover:text-blue-400 group-hover:translate-x-1 transition-all" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
                                                        </div>
                                                        <div class="font-bold text-slate-800 group-hover:text-blue-700 transition-colors">${rack.name}</div>
                                                        <div class="text-xs text-slate-500 font-medium mt-1">${rack.columns} cols × ${rack.levels} levels</div>
                                                    </button>
                                                `).join('')}
                                            </div>
                                        </div>
                                    ` : ''}
                                    
                                    <!-- Floor Selection -->
                                    ${floors.length > 0 ? `
                                        <div>
                                            <h3 class="font-bold text-slate-800 mb-4 flex items-center gap-2 text-sm uppercase tracking-wider">
                                                <span class="text-lg">🏷️</span> Floor Locations
                                            </h3>
                                            <div class="grid grid-cols-2 gap-3">
                                                ${floors.map(floor => {
                const locationCode = 'FLOOR-' + floor;
                const isSelected = this.sessionSettings.currentLocation === locationCode;
                return `
                                                        <button 
                                                            onclick="app.selectFloorLocation('${floor}')"
                                                            class="relative p-4 border rounded-2xl text-left transition-all duration-200 hover:shadow-md group overflow-hidden ${isSelected ? 'bg-emerald-50 border-emerald-500 shadow-emerald-100 ring-2 ring-emerald-200' : 'bg-white border-slate-200 hover:border-emerald-400'}"
                                                        >
                                                            <div class="flex items-center gap-3">
                                                                <div class="w-10 h-10 rounded-xl ${isSelected ? 'bg-emerald-100 text-emerald-600' : 'bg-emerald-50 text-emerald-600'} flex items-center justify-center font-bold shadow-sm">
                                                                    ${floor.substring(0, 2)}
                                                                </div>
                                                                <div>
                                                                    <div class="font-bold ${isSelected ? 'text-emerald-800' : 'text-slate-700'}">FLOOR-${floor}</div>
                                                                    ${isSelected ? '<div class="text-[10px] font-bold text-emerald-600 bg-white/50 px-1.5 py-0.5 rounded-full inline-block mt-1">ACTIVE</div>' : '<div class="text-xs text-slate-400 group-hover:text-emerald-500 transition-colors">Select Area</div>'}
                                                                </div>
                                                            </div>
                                                            ${isSelected ? '<div class="absolute top-0 right-0 p-1.5"><div class="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div></div>' : ''}
                                                        </button>
                                                    `;
            }).join('')}
                                            </div>
                                        </div>
                                    ` : ''}
                                    
                                    ${racks.length === 0 && floors.length === 0 ? `
                                        <div class="flex flex-col items-center justify-center py-12 text-center">
                                            <div class="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                                                <svg class="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                                            </div>
                                            <h3 class="font-bold text-slate-900 text-lg">No Locations Found</h3>
                                            <p class="text-slate-500 text-sm mt-2 max-w-xs px-4">You haven't configured any warehouse locations yet.</p>
                                            <button onclick="app.hideLocationPicker(); app.showSettings();" class="mt-6 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl transition-all shadow-lg shadow-blue-200">
                                                Go to Settings
                                            </button>
                                        </div>
                                    ` : ''}
                                </div>
                                `}
                                    </div>
                                </div>
                            </div>
                        `);
            return;
        }

        if (this.showingSettings) {
            updateView(`
                <div class="min-h-screen bg-slate-50 flex items-center justify-center p-4">
                    <div class="w-full max-w-lg bg-white rounded-[2rem] shadow-2xl shadow-slate-200 overflow-hidden animate-fade-up">
                        <div class="p-6 border-b border-slate-100 flex items-center justify-between">
                            <h2 class="text-xl font-bold text-slate-900">Settings</h2>
                            <button onclick="app.hideSettings()" class="w-8 h-8 rounded-full bg-slate-50 text-slate-400 hover:text-slate-600 hover:bg-slate-100 flex items-center justify-center transition-all">
                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
                            </button>
                        </div>

                        <div class="p-6 space-y-6 max-h-[70vh] overflow-y-auto custom-scrollbar">
                            <!-- Device ID -->
                            <div class="bg-slate-50 rounded-2xl p-4 border border-slate-100">
                                <label class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Device ID</label>
                                <div class="flex items-center gap-3">
                                    <div class="w-10 h-10 bg-white rounded-xl flex items-center justify-center border border-slate-200 text-slate-400">
                                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                                    </div>
                                    <code class="text-sm font-mono text-slate-700 bg-white px-3 py-1.5 rounded-lg border border-slate-200">${DEVICE_ID}</code>
                                </div>
                            </div>

                            <!-- Location Scanning -->
                            <div class="space-y-4">
                                <label class="block text-xs font-bold text-slate-500 uppercase tracking-wider">Configuration</label>
                                
                                <div class="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                                    <div class="p-4 flex items-center justify-between bg-slate-50/50">
                                        <div class="flex items-center gap-4">
                                            <div class="w-10 h-10 rounded-xl ${this.sessionSettings.locationScanningEnabled ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-400'} flex items-center justify-center transition-colors">
                                                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                                            </div>
                                            <div>
                                                <div class="font-bold text-slate-800">Track Location</div>
                                                <div class="text-xs text-slate-500">Enable rack & floor tracking</div>
                                            </div>
                                        </div>
                                        
                                        <button onclick="app.toggleLocationScanning()" class="relative w-12 h-7 rounded-full transition-all duration-300 ${this.sessionSettings.locationScanningEnabled ? 'bg-blue-600' : 'bg-slate-200'}">
                                            <span class="absolute top-1 left-1 w-5 h-5 bg-white rounded-full shadow-sm transition-all duration-300 ${this.sessionSettings.locationScanningEnabled ? 'translate-x-5' : 'translate-x-0'}"></span>
                                        </button>
                                    </div>

                                    ${this.sessionSettings.locationScanningEnabled ? `
                                        <div class="p-4 border-t border-slate-100 space-y-4 animate-fade-in-down">
                                            <div>
                                                <label class="block text-xs font-medium text-slate-500 mb-2">Current Location</label>
                                                <div class="flex items-center gap-2">
                                                    <div class="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between">
                                                        <span class="font-bold text-sm ${this.sessionSettings.currentLocation ? 'text-blue-600' : 'text-slate-400 italic'}">
                                                            ${this.sessionSettings.currentLocation || 'No location set'}
                                                        </span>
                                                        ${this.sessionSettings.currentLocation ? `
                                                            <button onclick="app.clearLocation()" class="text-slate-400 hover:text-red-500 transition-colors">
                                                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                                                            </button>
                                                        ` : ''}
                                                    </div>
                                                </div>
                                            </div>

                                            <button onclick="app.showWarehouseSetup()" class="w-full py-3 bg-blue-50 text-blue-600 font-bold rounded-xl border border-blue-100 hover:bg-blue-100 hover:border-blue-200 transition-all flex items-center justify-center gap-2 group">
                                                <span class="group-hover:scale-110 transition-transform">🏭</span>
                                                Configure Warehouse Layout
                                            </button>
                                            
                                            <div class="text-xs text-slate-400 text-center">
                                                Define racks and floor areas to enable precise location tracking during scanning.
                                            </div>
                                        </div>
                                    ` : ''}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            `);
            return;
        }

        // Main screen
        const userName = getUserName();
        updateView(`
                                        <div class="min-h-screen bg-slate-50 pb-24">
                                            <!-- Sticky Header -->
                                            <div class="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-200 px-4 py-3 shadow-sm">
                                                <div class="max-w-4xl mx-auto flex items-center justify-between">
                                                    <div class="flex items-center gap-3">
                                                        <div class="w-10 h-10 sm:w-12 sm:h-12 ${this.activeStockTake?.sessionType === 'RM' ? 'bg-teal-600' : 'bg-blue-600'} rounded-xl flex items-center justify-center shadow-md ${this.activeStockTake?.sessionType === 'RM' ? 'shadow-teal-200' : 'shadow-blue-200'}">
                                                            <span class="text-white font-bold text-lg sm:text-xl">${userName.charAt(0).toUpperCase()}</span>
                                                        </div>
                                                        <div>
                                                            <div class="flex items-center gap-2">
                                                                <h1 class="text-sm sm:text-base font-bold text-slate-900 leading-tight">${this.activeStockTake?.sessionType === 'RM' ? 'Raw Materials' : 'Finished Products'}</h1>
                                                                <span class="${this.activeStockTake?.sessionType === 'RM' ? 'bg-teal-100 text-teal-700' : 'bg-blue-100 text-blue-700'} text-xs font-bold px-2 py-0.5 rounded-full">
                                                                    #${this.activeStockTake?.sessionNumber || 1}
                                                                </span>
                                                            </div>
                                                            <div class="flex items-center gap-2 mt-0.5">
                                                                <p class="text-xs text-slate-500 font-medium">${this.currentTakeDate}</p>
                                                                ${(() => {
                const session = this.activeStockTake?.id ? getSessionById(this.currentTakeDate, this.activeStockTake.id) : null;
                if (session?.devices && session.devices.length > 0) {
                    const now = Date.now();
                    const activeDevices = session.devices.filter(d => d.status === 'active');
                    const staleDevices = activeDevices.filter(d => {
                        if (!d.lastSeen) return false;
                        const last = new Date(d.lastSeen).getTime();
                        return now - last > HEARTBEAT_GRACE_MS;
                    });
                    const liveActive = activeDevices.length - staleDevices.length;
                    const completedCount = session.devices.filter(d => d.status === 'completed').length;
                    return `
                                                        <span class="text-xs text-slate-400">•</span>
                                                        <span class="text-xs text-emerald-600 font-medium flex items-center gap-1">
                                                            <span class="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>
                                                            ${liveActive} active${completedCount > 0 ? `, ${completedCount} done` : ''}
                                                        </span>
                                                        ${staleDevices.length > 0 ? `
                                                            <span class="text-xs text-red-500 font-medium flex items-center gap-1">
                                                                <span class="w-1.5 h-1.5 bg-red-500 rounded-full"></span>
                                                                ${staleDevices.length} idle
                                                            </span>
                                                        ` : ''}
                                                    `;
                }
                return '';
            })()}
                                                                ${(() => {
                const pendingCount = offlineSyncQueue.getPendingCount();
                if (pendingCount > 0) {
                    return `
                                                        <button onclick="app.manualSyncOffline()" class="text-xs font-medium flex items-center gap-1 text-amber-600 hover:text-amber-700 transition-colors">
                                                            <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                                                            ${pendingCount} pending sync
                                                        </button>
                                                    `;
                }
                return `
                                                    <span class="text-xs font-medium flex items-center gap-1 ${this.isOfflineMode() ? 'text-slate-500' : 'text-emerald-600'}">
                                                        <span class="w-1.5 h-1.5 rounded-full ${this.isOfflineMode() ? 'bg-slate-400' : 'bg-emerald-500'} animate-pulse"></span>
                                                        ${this.isOfflineMode() ? 'Offline' : 'Online'}
                                                    </span>
                                                `;
            })()}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div class="flex gap-2">
                                                        ${canViewProductDatabase() ? `
                                    <button onclick="app.showProductDatabase()" class="p-2 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors" title="Products">
                                        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/>
                                        </svg>
                                    </button>
                                    ` : ''}
                                                        <button onclick="app.goHome()" class="p-2 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors" title="Back to Home">
                                                            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                                                            </svg>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>

                                            <!-- Stats Bar -->
                                            <div class="px-4 py-4 max-w-4xl mx-auto">
                                                <div class="bg-white rounded-2xl p-4 sm:p-6 shadow-sm border border-slate-100">
                                                    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                                                        <div>
                                                            <div class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Total Scanned</div>
                                                            <div class="text-3xl sm:text-4xl font-black text-slate-900">${this.scans.length}</div>
                                                        </div>
                                                    </div>
                                                    ${(() => {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const expiredCount = this.scans.filter(s => {
                    if (!s.expiryDate) return false;
                    const exp = new Date(s.expiryDate);
                    exp.setHours(0, 0, 0, 0);
                    return exp <= today;
                }).length;
                return expiredCount > 0 ? `
                                        <div class="mt-3 flex items-center gap-2 p-2 bg-red-50 rounded-lg border border-red-100">
                                            <div class="flex-shrink-0 w-8 h-8 bg-red-500 rounded-full flex items-center justify-center">
                                                <svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                                                </svg>
                                            </div>
                                            <div>
                                                <div class="text-sm font-bold text-red-700">${expiredCount} Expired Item${expiredCount > 1 ? 's' : ''}</div>
                                                <div class="text-xs text-red-500">These items are past their expiry date</div>
                                            </div>
                                        </div>
                                    ` : '';
            })()}
                                                </div>

                                                ${this.sessionSettings.locationScanningEnabled ? `
                                <button onclick="app.promptForLocation()" class="mt-3 w-full flex items-center justify-center gap-2 text-xs font-medium ${this.sessionSettings.currentLocation ? 'text-blue-600 bg-blue-50/50 border-blue-100/50' : 'text-slate-500 bg-slate-50/50 border-slate-200/50'} py-2 rounded-lg border">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
                                    </svg>
                                    <span>${[this.sessionSettings.site, this.sessionSettings.aisle, this.sessionSettings.rack].filter(Boolean).join(' › ') || this.sessionSettings.currentLocation || 'Tap to set location'}</span>
                                </button>
                            ` : ''}
                                            </div>

                                            <!--List -->
                                            <div class="px-4 max-w-4xl mx-auto">
                                                <div class="space-y-3 md:grid md:grid-cols-2 lg:grid-cols-3 md:gap-4 md:space-y-0">
                                                    ${this.scans.length === 0 ? `
                                <div class="md:col-span-2 lg:col-span-3 text-center py-20">
                                    <div class="w-24 h-24 sm:w-32 sm:h-32 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-6">
                                        <svg class="w-10 h-10 sm:w-14 sm:h-14 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/>
                                        </svg>
                                    </div>
                                    <h3 class="text-lg sm:text-xl font-bold text-slate-900">Ready to Scan</h3>
                                    <p class="text-slate-500 mt-1 text-sm sm:text-base">Tap the button below to start counting</p>
                                </div>
                            ` : this.scans.map(scan => {
                // Check if expired
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                let isExpired = false;
                let expiryDisplay = '';
                if (scan.expiryDate) {
                    const expiry = new Date(scan.expiryDate);
                    expiry.setHours(0, 0, 0, 0);
                    isExpired = expiry <= today;
                    expiryDisplay = expiry.toLocaleDateString();
                }
                const borderColor = isExpired ? 'bg-red-500' : (scan.actualCases !== scan.casesOnPallet ? 'bg-yellow-500' : 'bg-emerald-500');
                const escapedId = scan.id.toString().replace(/'/g, "\\'");
                return `
                                <div class="swipe-container" data-scan-id="${escapedId}">
                                    <div class="swipe-delete-action">
                                        <div class="flex flex-col items-center gap-1">
                                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                                            </svg>
                                            <span>Delete</span>
                                        </div>
                                    </div>
                                    <div class="swipe-item" onclick="app.editScan('${escapedId}')">
                                        <div class="cursor-pointer bg-white rounded-2xl p-4 shadow-sm border ${isExpired ? 'border-red-200 bg-red-50' : 'border-slate-100'} relative overflow-hidden group hover-lift transition-all active:scale-[0.98]">
                                    <div class="absolute top-0 left-0 w-1 h-full ${borderColor}"></div>
                                    <div class="pl-3 flex items-start justify-between">
                                        <div class="flex-1 min-w-0">
                                            <div class="flex items-center gap-2 mb-1 flex-wrap">
                                                <span class="font-mono text-xs font-bold text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                                                    ${scan.batchNumber || 'N/A'}
                                                </span>
                                                <span class="text-sm font-bold ${this.activeStockTake?.sessionType === 'RM' ? 'text-teal-600' : 'text-blue-600'} truncate">${scan.stockCode}</span>
                                                ${isExpired ? `
                                                    <span class="px-2 py-0.5 text-xs font-bold bg-red-500 text-white rounded-full animate-pulse">
                                                        EXPIRED
                                                    </span>
                                                ` : ''}
                                                <span class="ml-auto text-xs text-blue-500 font-medium">
                                                    ✏️ Tap to edit
                                                </span>
                                            </div>
                                            
                                            <div class="text-slate-900 font-medium text-sm mb-3 line-clamp-2">${scan.description}</div>
                                            
                                            <div class="flex items-center gap-3 text-xs text-slate-500 flex-wrap">
                                                ${scan.sessionType !== 'RM' && scan.palletNumber ? `
                                                <div class="flex items-center gap-1">
                                                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                                                    </svg>
                                                    <span>Pallet ${scan.palletNumber}</span>
                                                </div>
                                                ` : ''}
                                                ${scan.location ? `
                                                    <div class="flex items-center gap-1 text-blue-600">
                                                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
                                                        </svg>
                                                        <span>${scan.location}</span>
                                                    </div>
                                                ` : ''}
                                                <div class="flex items-center gap-1">
                                                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
                                                    </svg>
                                                    <span>${scan.scannedBy || 'Unknown'}</span>
                                                </div>
                                                <div class="flex items-center gap-1">
                                                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
                                                    </svg>
                                                    <span>${scan.time}</span>
                                                </div>
                                                ${expiryDisplay ? `
                                                    <div class="flex items-center gap-1 ${isExpired ? 'text-red-600 font-bold' : 'text-slate-500'}">
                                                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                                                        </svg>
                                                        <span>Exp: ${expiryDisplay}</span>
                                                    </div>
                                                ` : ''}
                                            </div>
                                        </div>
                                        
                                        <div class="flex flex-col items-end gap-3 ml-3">
                                            <div class="text-right">
                                                <div class="text-2xl font-black ${isExpired ? 'text-red-600' : (scan.actualCases !== scan.casesOnPallet ? 'text-yellow-600' : 'text-emerald-600')}">
                                                    ${scan.actualCases}
                                                </div>
                                                <div class="text-[10px] font-bold text-slate-400 uppercase tracking-wide">${scan.unitType === 'kg' ? 'KG' : (scan.unitType === 'units' ? 'UN' : 'Cases')}</div>
                                            </div>
                                            
                                            <button onclick="event.stopPropagation(); app.deleteScan('${escapedId}')" class="hidden sm:block p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors icon-btn" title="Delete scan">
                                                <svg class="w-5 h-5 action-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                                                </svg>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                                    </div><!-- End swipe-item -->
                                </div><!-- End swipe-container -->
                            `;
            }).join('')}
                                                </div>
                                            </div>
                                        </div>
                                        `);
    }
}

const app = new ScannerApp();
window.app = app;

// On startup, check for pending offline scans and sync if online
(async () => {
    const pendingCount = offlineSyncQueue.getPendingCount();
    if (pendingCount > 0 && navigator.onLine && supabaseClient) {
        console.log(`Found ${pendingCount} offline scans on startup, syncing...`);
        const result = await syncOfflineScans();
        if (result.synced > 0) {
            console.log(`Startup sync: synced ${result.synced} scans`);
            // Reload scans if we're in a session
            if (app.activeStockTake?.id) {
                await app.loadScans();
                app.render();
            }
        }
    }
})();

window.addEventListener('online', () => {
    if (window.app?.handleConnectivityChange) {
        window.app.handleConnectivityChange(true);
    }
});

window.addEventListener('offline', () => {
    if (window.app?.handleConnectivityChange) {
        window.app.handleConnectivityChange(false);
    }
});
