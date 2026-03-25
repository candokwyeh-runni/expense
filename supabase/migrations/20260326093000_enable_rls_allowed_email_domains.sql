-- Security Advisor fix:
-- public.allowed_email_domains is exposed via PostgREST but had RLS disabled.
ALTER TABLE IF EXISTS public.allowed_email_domains
ENABLE ROW LEVEL SECURITY;

