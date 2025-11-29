const { neon } = require('@neondatabase/serverless');

// Database connection - hardcoded for drag-and-drop deployment
const DATABASE_URL = 'postgresql://neondb_owner:npg_ZgY7c2jDrizh@ep-restless-river-aey5vyvy-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require';
const sql = neon(DATABASE_URL);

// CORS headers for browser requests
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action, date, scan, id, batchNumber, palletNumber } = body;
    
    switch (action) {
      case 'init':
        // Create tables if they don't exist
        await sql`
          CREATE TABLE IF NOT EXISTS stock_takes (
            take_date DATE PRIMARY KEY,
            status VARCHAR(20) DEFAULT 'active',
            created_at TIMESTAMP DEFAULT NOW()
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS stock_scans (
            id BIGSERIAL PRIMARY KEY,
            take_date DATE NOT NULL,
            batch_number VARCHAR(5),
            pallet_number VARCHAR(2),
            cases_on_pallet INT,
            actual_cases INT,
            stock_code VARCHAR(50),
            description TEXT,
            raw_code VARCHAR(20),
            scanned_at TIMESTAMP DEFAULT NOW(),
            device_id VARCHAR(100),
            scanned_by VARCHAR(100)
          )
        `;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, message: 'Tables initialized' })
        };

      case 'insertStockTake':
        await sql`
          INSERT INTO stock_takes (take_date, status)
          VALUES (${date}, 'active')
          ON CONFLICT (take_date) DO NOTHING
        `;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true })
        };

      case 'getStockScans':
        const scans = await sql`
          SELECT * FROM stock_scans 
          WHERE take_date = ${date}
          ORDER BY scanned_at DESC
        `;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, rows: scans })
        };

      case 'insertStockScan':
        const result = await sql`
          INSERT INTO stock_scans (
            take_date, batch_number, pallet_number, cases_on_pallet,
            actual_cases, stock_code, description, raw_code, device_id, scanned_by
          ) VALUES (
            ${scan.take_date}, ${scan.batch_number}, ${scan.pallet_number},
            ${scan.cases_on_pallet}, ${scan.actual_cases}, ${scan.stock_code},
            ${scan.description}, ${scan.raw_code}, ${scan.device_id}, ${scan.scanned_by || 'Unknown'}
          )
          RETURNING *
        `;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, data: result[0] })
        };

      case 'checkDuplicate':
        const duplicate = await sql`
          SELECT * FROM stock_scans
          WHERE take_date = ${date}
            AND batch_number = ${batchNumber}
            AND pallet_number = ${palletNumber}
          LIMIT 1
        `;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            success: true, 
            duplicate: duplicate.length > 0 ? duplicate[0] : null 
          })
        };

      case 'deleteStockScan':
        await sql`DELETE FROM stock_scans WHERE id = ${id}`;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true })
        };

      default:
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Unknown action' })
        };
    }
  } catch (error) {
    console.error('Database error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
