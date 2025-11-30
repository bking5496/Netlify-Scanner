-- Migration: Align stock_takes primary key with custom session IDs
-- Purpose: allow per-session-type numbering by making id the sole primary key and
--          enforcing uniqueness on (take_date, session_type, session_number)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE IF EXISTS public.stock_takes
    ADD COLUMN IF NOT EXISTS id text;

DO $$
BEGIN
    UPDATE public.stock_takes
    SET id = gen_random_uuid()::text
    WHERE id IS NULL OR btrim(id) = '';
END $$;

ALTER TABLE IF EXISTS public.stock_takes
    ALTER COLUMN id SET NOT NULL;

DO $$
DECLARE
    pk_def text;
BEGIN
    SELECT pg_get_constraintdef(oid)
    INTO pk_def
    FROM pg_constraint
    WHERE conrelid = 'public.stock_takes'::regclass
      AND conname = 'stock_takes_pkey';

    IF pk_def IS NULL THEN
        EXECUTE 'ALTER TABLE public.stock_takes ADD CONSTRAINT stock_takes_pkey PRIMARY KEY (id)';
    ELSIF pk_def NOT LIKE 'PRIMARY KEY (id%'
    THEN
        EXECUTE 'ALTER TABLE public.stock_takes DROP CONSTRAINT stock_takes_pkey';
        EXECUTE 'ALTER TABLE public.stock_takes ADD CONSTRAINT stock_takes_pkey PRIMARY KEY (id)';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.stock_takes'::regclass
          AND conname = 'stock_takes_take_type_number_key'
    ) THEN
        ALTER TABLE public.stock_takes
            ADD CONSTRAINT stock_takes_take_type_number_key
            UNIQUE (take_date, session_type, session_number);
    END IF;
END $$;

COMMIT;
