-- Migration: Warehouse Locations for QR Code Scanning System
-- Stores valid pallet rack and floor locations for scanning

BEGIN;

-- ==========================================
-- Warehouse Locations Table
-- ==========================================
CREATE TABLE IF NOT EXISTS public.warehouse_locations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_code text NOT NULL UNIQUE,  -- e.g., RACK-01-F-A-3, FLOOR-A1
    location_type text NOT NULL CHECK (location_type IN ('rack', 'floor')),
    
    -- Rack-specific fields (null for floor locations)
    rack_number text,                    -- e.g., '01', '02'
    rack_face text CHECK (rack_face IN ('F', 'B') OR rack_face IS NULL),  -- Front or Back
    rack_row text,                       -- e.g., 'A', 'B', 'C'
    rack_column integer,                 -- e.g., 1, 2, 3
    
    -- Floor-specific fields (null for rack locations)
    floor_zone text,                     -- e.g., 'A1', 'B2'
    
    -- Common fields
    warehouse text,                      -- 'PSA' or 'PML'
    description text,
    is_active boolean DEFAULT true,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by text
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_code ON public.warehouse_locations(location_code);
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_type ON public.warehouse_locations(location_type);
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_warehouse ON public.warehouse_locations(warehouse);
CREATE INDEX IF NOT EXISTS idx_warehouse_locations_active ON public.warehouse_locations(is_active) WHERE is_active = true;

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_warehouse_locations_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_warehouse_locations_updated ON public.warehouse_locations;
CREATE TRIGGER trg_warehouse_locations_updated
BEFORE UPDATE ON public.warehouse_locations
FOR EACH ROW EXECUTE FUNCTION update_warehouse_locations_timestamp();

-- ==========================================
-- RLS Policies for warehouse_locations
-- ==========================================
ALTER TABLE public.warehouse_locations ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read locations
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'warehouse_locations' AND policyname = 'warehouse_locations_select') THEN
        CREATE POLICY warehouse_locations_select ON public.warehouse_locations
            FOR SELECT USING (current_app_role() IN ('operator','supervisor','admin'));
    END IF;
END $$;

-- Only supervisors and admins can insert
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'warehouse_locations' AND policyname = 'warehouse_locations_insert') THEN
        CREATE POLICY warehouse_locations_insert ON public.warehouse_locations
            FOR INSERT WITH CHECK (current_app_role() IN ('supervisor','admin'));
    END IF;
END $$;

-- Only supervisors and admins can update
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'warehouse_locations' AND policyname = 'warehouse_locations_update') THEN
        CREATE POLICY warehouse_locations_update ON public.warehouse_locations
            FOR UPDATE USING (current_app_role() IN ('supervisor','admin')) WITH CHECK (current_app_role() IN ('supervisor','admin'));
    END IF;
END $$;

-- Only admins can delete
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'warehouse_locations' AND policyname = 'warehouse_locations_delete') THEN
        CREATE POLICY warehouse_locations_delete ON public.warehouse_locations
            FOR DELETE USING (current_app_role() = 'admin');
    END IF;
END $$;

COMMIT;
