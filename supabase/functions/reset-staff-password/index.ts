// reset-staff-password
//
// Lets an admin set a brand-new random password for an existing person's
// login from Manage Staff (admin.html), without needing the Supabase
// Dashboard. Exists because this app's accounts use fake @warehouse.local
// addresses with no real inbox — the Dashboard's own "Reset password"
// action only offers "send a password recovery email", which can never be
// delivered here. The only real way to set a password directly is the
// Admin API (auth.admin.updateUserById), which needs the service_role key
// — same reasoning as create-staff-login, see that file for the longer
// version of this note.
//
// Deploy: Supabase Dashboard -> Edge Functions -> Create a new function,
// name it exactly "reset-staff-password" (must match the
// supabaseClient.functions.invoke('reset-staff-password', ...) call in
// js/db.js), paste this file in, Deploy.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function generatePassword(length = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Not signed in' }, 401);

    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: callerData, error: callerErr } = await callerClient.auth.getUser(token);
    if (callerErr || !callerData?.user) return json({ error: 'Not signed in' }, 401);

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: callerProfile } = await serviceClient
      .from('user_profiles')
      .select('role, is_active')
      .eq('id', callerData.user.id)
      .maybeSingle();
    if (!callerProfile || callerProfile.role !== 'admin' || !callerProfile.is_active) {
      return json({ error: 'Admin only' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const userId = String(body.userId ?? '').trim();
    if (!userId) return json({ error: 'userId is required' }, 400);

    const password = generatePassword();
    const { data: updated, error: updateErr } = await serviceClient.auth.admin.updateUserById(userId, { password });
    if (updateErr) return json({ error: updateErr.message }, 500);

    // user_profiles carries no email column (see schema.sql) -- the client
    // needs it back here to show which login this new password is for.
    return json({ generated_password: password, email: updated.user?.email ?? null });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Unexpected error' }, 500);
  }
});
