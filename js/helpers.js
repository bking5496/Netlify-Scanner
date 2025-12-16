// Helper to convert DD/MM/YY to YYYY-MM-DD
function convertDMYtoYMD(dateStr) {
    if (!dateStr) return null;
    // Check if already in YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;

    // Check if in DD/MM/YY or DD/MM/YYYY format
    const match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (match) {
        let [_, day, month, year] = match;
        if (year.length === 2) year = '20' + year;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return dateStr; // Return original if format unknown
}

// Get unit type for a stock code from product_types table
// If type is "ingredients" -> KG, otherwise -> UN (units)
function getUnitTypeForStockCode(stockCode) {
    if (!stockCode) return 'units';
    const upperCode = stockCode.toUpperCase();

    // Check product_types database (assumed global from state.js/app.js)
    if (window.productTypeDatabase && window.productTypeDatabase[upperCode]) {
        return window.productTypeDatabase[upperCode].unitType; // 'kg' or 'units'
    }

    // Default to units for unknown stock codes
    return 'units';
}

// Parse location code (e.g., RACK-01-F-A-3 or FLOOR-A1)
function parseLocationCode(code) {
    if (!code || typeof code !== 'string') return null;
    code = code.trim().toUpperCase();

    if (code.startsWith('RACK-')) {
        // Format: RACK-{##}-{F/B}-{ROW}-{COL}
        const parts = code.split('-');
        if (parts.length === 5) {
            return {
                type: 'rack',
                rackNumber: parts[1],
                face: parts[2],      // F or B
                row: parts[3],       // A, B, C...
                column: parseInt(parts[4])
            };
        }
    } else if (code.startsWith('FLOOR-')) {
        // Format: FLOOR-{ZONE}
        const zone = code.replace('FLOOR-', '');
        if (zone) {
            return {
                type: 'floor',
                zone: zone
            };
        }
    }
    return null;
}

// Check if a scanned code is a location code
function isLocationCode(code) {
    if (!code || typeof code !== 'string') return false;
    const upper = code.trim().toUpperCase();
    return upper.startsWith('RACK-') || upper.startsWith('FLOOR-');
}

// Generate location code from components
function buildLocationCode(type, data) {
    if (type === 'rack') {
        const { rackNumber, face, row, column } = data;
        const paddedRack = String(rackNumber).padStart(2, '0');
        return `RACK-${paddedRack}-${face}-${row}-${column}`;
    } else if (type === 'floor') {
        return `FLOOR-${data.zone}`;
    }
    return '';
}
