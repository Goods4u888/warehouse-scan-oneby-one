// Supabase connection — anon/publishable key only, never the service_role key.
// This file is loaded client-side, so nothing in it should be a secret beyond
// what Row Level Security already protects (see supabase/schema.sql).
window.APP_CONFIG = {
  SUPABASE_URL: 'https://zqjogbvjrozpgdrghotv.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_tv67O2bKUjS8T6xbLcb4tw_wehduZeS',
};
