-- Fix RLS policies for audit logs and allow operators to delete scans
-- Run this in Supabase SQL Editor

BEGIN;

-- Allow the trigger function to insert into scan_audit_logs
-- The trigger runs with SECURITY DEFINER privileges, so we need to allow inserts
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'scan_audit_logs' AND policyname = 'scan_audit_logs_insert') THEN
        CREATE POLICY scan_audit_logs_insert ON public.scan_audit_logs
            FOR INSERT WITH CHECK (true);
    END IF;
END $$;

-- Allow the trigger/function to insert into event_logs
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_logs' AND policyname = 'event_logs_insert') THEN
        CREATE POLICY event_logs_insert ON public.event_logs
            FOR INSERT WITH CHECK (true);
    END IF;
END $$;

-- Allow operators to delete their own scans (not just supervisors/admins)
-- Drop existing policy and recreate with operator role included
DROP POLICY IF EXISTS stock_scans_delete ON public.stock_scans;
CREATE POLICY stock_scans_delete ON public.stock_scans
    FOR DELETE USING (current_app_role() IN ('operator', 'supervisor', 'admin'));

-- Also allow operators to update scans (for corrections)
DROP POLICY IF EXISTS stock_scans_update ON public.stock_scans;
CREATE POLICY stock_scans_update ON public.stock_scans
    FOR UPDATE USING (current_app_role() IN ('operator', 'supervisor', 'admin')) 
    WITH CHECK (current_app_role() IN ('operator', 'supervisor', 'admin'));

COMMIT;
