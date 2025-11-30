-- Migration: Allow RM scans without expiry_date while logging a notice
-- Replaces validate_stock_scan trigger to avoid blocking quantity entry when
-- an expiry date is unavailable at scan time.

BEGIN;

CREATE OR REPLACE FUNCTION validate_stock_scan()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    is_fp boolean := coalesce(NEW.session_type, 'FP') = 'FP';
BEGIN
    IF is_fp THEN
        IF NEW.raw_code IS NULL OR length(NEW.raw_code) <> 13 OR NEW.raw_code !~ '^[0-9]{13}$' THEN
            RAISE EXCEPTION 'FP scans must include 13-digit raw_code';
        END IF;
    ELSE
        IF NEW.expiry_date IS NULL THEN
            RAISE NOTICE 'RM scan for % batch % missing expiry date', NEW.stock_code, NEW.batch_number;
        END IF;
    END IF;

    IF NEW.site IS NULL AND NEW.location IS NOT NULL THEN
        -- attempt to split legacy location "Site|Aisle|Rack"
        PERFORM 1;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

COMMIT;
