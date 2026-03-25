-- Security Advisor warning fix:
-- Function Search Path Mutable
-- Apply explicit search_path to target functions, regardless of signature.

DO $$
DECLARE
    fn record;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure AS fn_signature
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (
              'set_row_updated_at',
              'generate_short_id',
              'sync_payee_editable_account_from_extra_info',
              'hook_restrict_signup_by_email_domains'
          )
    LOOP
        EXECUTE format(
            'ALTER FUNCTION %s SET search_path = public, pg_catalog',
            fn.fn_signature
        );
    END LOOP;
END;
$$;

