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
    const { action, data } = JSON.parse(event.body || '{}');
    
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
          VALUES (${data.take_date}, 'active')
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
          WHERE take_date = ${data.take_date}
          ORDER BY scanned_at DESC
        `;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, data: scans })
        };

      case 'insertStockScan':
        const result = await sql`
          INSERT INTO stock_scans (
            take_date, batch_number, pallet_number, cases_on_pallet,
            actual_cases, stock_code, description, raw_code, device_id, scanned_by
          ) VALUES (
            ${data.take_date}, ${data.batch_number}, ${data.pallet_number},
            ${data.cases_on_pallet}, ${data.actual_cases}, ${data.stock_code},
            ${data.description}, ${data.raw_code}, ${data.device_id}, ${data.scanned_by || 'Unknown'}
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
          WHERE take_date = ${data.take_date}
            AND batch_number = ${data.batch_number}
            AND pallet_number = ${data.pallet_number}
          LIMIT 1
        `;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            success: true, 
            data: duplicate.length > 0 ? duplicate[0] : null 
          })
        };

      case 'deleteStockScan':
        await sql`DELETE FROM stock_scans WHERE id = ${data.id}`;
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
