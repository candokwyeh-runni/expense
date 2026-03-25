-- Ensure notification_event_types is protected by RLS in all environments
-- (especially environments migrated incrementally before bootstrap SQL existed).
ALTER TABLE IF EXISTS public.notification_event_types
ENABLE ROW LEVEL SECURITY;

