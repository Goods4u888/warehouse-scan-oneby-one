// ============================================================================
// Data access layer — every Supabase call the app makes lives here, so the
// view code never touches the client directly.
// ============================================================================

const supabaseClient = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);

// A sku row fetched with the sku_images(storage_path) embed carries a
// nested sku_images: [{storage_path}] array from PostgREST — flatten that
// into a plain image_paths: string[] so every caller (list cards, item
// search, item detail) can read the same shape regardless of whether the
// row came from this embed or from a view that already aggregates it
// (stock_by_sku.image_paths).
function normalizeSkuImages(sku) {
  const { sku_images, ...rest } = sku;
  return { ...rest, image_paths: (sku_images || []).map((si) => si.storage_path) };
}

// ---- Admin auth -----------------------------------------------------------
// admin.html is gated by real per-person Supabase Auth accounts (Requester /
// Staff / Admin — see the user_profiles table in schema.sql), each created
// by hand in the Supabase dashboard and given a matching user_profiles row
// through the in-app Manage Staff screen. See README.md.
const Auth = {
  async signIn(email, password) {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },
  async signOut() {
    await supabaseClient.auth.signOut();
  },
  async getSession() {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    return data.session;
  },
  onChange(cb) {
    supabaseClient.auth.onAuthStateChange((_event, session) => cb(session));
  },
};

const DB = {
  // ---- Profiles / roles ---------------------------------------------------
  // getMyProfile() is called right after every successful sign-in (see
  // initApp() in app.js) to learn the caller's own name/role — RLS lets
  // anyone read their own row (see schema.sql) but not anyone else's, so
  // this is always exactly the signed-in person's profile.
  async getMyProfile() {
    const { data: { user }, error: userErr } = await supabaseClient.auth.getUser();
    if (userErr) throw userErr;
    if (!user) return null;
    const { data, error } = await supabaseClient.from('user_profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) throw error;
    return data;
  },

  // Manage Staff (admin-only — RLS refuses these to anyone else).
  async listStaff() {
    const { data, error } = await supabaseClient.from('user_profiles').select('*').order('name');
    if (error) throw error;
    return data;
  },

  // Creates the person's Auth login (or, if one already exists for that
  // email from before this feature/the original dashboard bootstrap,
  // reuses it) and upserts their user_profiles row, all server-side via
  // the create-staff-login Edge Function (needs the service_role key,
  // which never ships to the browser — see js/config.js). Returns
  // { id, generated_password } — generated_password is null when an
  // existing login was reused instead of a new one being created.
  async createStaffLogin({ email, name, role, department }) {
    const { data, error } = await supabaseClient.functions.invoke('create-staff-login', {
      body: { email, name, role, department },
    });
    if (error) {
      // supabase-js doesn't parse the function's JSON error body into
      // error.message for us — pull the real reason out ourselves,
      // falling back to the generic message if that fails.
      let msg = error.message;
      try {
        const body = await error.context.json();
        if (body?.error) msg = body.error;
      } catch (_) { /* not JSON, or already consumed */ }
      throw new Error(msg);
    }
    return data;
  },

  // Sets a brand-new random password for an existing login, server-side via
  // the reset-staff-password Edge Function — this app's @warehouse.local
  // addresses have no real inbox, so the Dashboard's own email-based
  // "Reset password" can never actually reach anyone. Returns
  // { generated_password }, shown once by showStaffCredentials() in app.js.
  async resetStaffPassword(userId) {
    const { data, error } = await supabaseClient.functions.invoke('reset-staff-password', {
      body: { userId },
    });
    if (error) {
      let msg = error.message;
      try {
        const body = await error.context.json();
        if (body?.error) msg = body.error;
      } catch (_) { /* not JSON, or already consumed */ }
      throw new Error(msg);
    }
    return data;
  },

  // id must already exist as a Supabase Auth user — this only
  // inserts/updates their profile row (used for editing an existing
  // person; new people go through createStaffLogin above).
  async upsertProfile({ id, name, role, department, isActive }) {
    const { data, error } = await supabaseClient
      .from('user_profiles')
      .upsert({ id, name, role, department: department || null, is_active: isActive })
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  // ---- SKUs ---------------------------------------------------------------
  // sku_images(storage_path) is a PostgREST embed over the real FK
  // (sku_images.sku_id references skus.id) — normalized below into a flat
  // image_paths: string[] on every row, so callers never need to know
  // whether a given sku came from this embed or from a view that already
  // aggregates it (like stock_by_sku.image_paths) — both end up the same
  // shape.
  async listSkus({ activeOnly = true } = {}) {
    let q = supabaseClient.from('skus').select('*, sku_images(storage_path)').order('name');
    if (activeOnly) q = q.eq('is_active', true);
    const { data, error } = await q;
    if (error) throw error;
    return data.map(normalizeSkuImages);
  },

  // Used by the public request form's item search. anon can only ever see
  // active items here (see "anon can view active skus" in schema.sql) — this
  // is the same query as listSkus({activeOnly:true}) but named separately
  // since it's called from a page with no login at all.
  async listActiveSkusForRequest() {
    const { data, error } = await supabaseClient
      .from('skus')
      .select('id, sku_code, name, category, base_uom, sku_images(storage_path)')
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    return data.map(normalizeSkuImages);
  },

  // sku_code is assigned by the system (random 3-letter prefix + running
  // number, e.g. "QZT-001") — create_sku() generates it server-side, so it's
  // never part of the payload the caller sends here. imagePaths: already
  // uploaded to the public item-photos bucket by the caller (see
  // uploadItemPhoto below) before this is called — an item can have more
  // than one photo.
  async createSku({ name, category, base_uom, alt_uom, conversion_factor, min_threshold, imagePaths }) {
    const { data, error } = await supabaseClient.rpc('create_sku', {
      p_name: name,
      p_category: category,
      p_base_uom: base_uom,
      p_alt_uom: alt_uom || null,
      p_conversion_factor: conversion_factor ?? null,
      p_min_threshold: min_threshold ?? 0,
      p_image_paths: imagePaths && imagePaths.length ? imagePaths : null,
    });
    if (error) throw error;
    return data;
  },

  // ---- Item photos (Manage Items) ---------------------------------------------
  // Public bucket (unlike transaction evidence) — a product photo isn't
  // sensitive, and showing it on the public request form helps requesters
  // recognize what they're picking. Reuses the same compression helper as
  // evidence photos.
  async uploadItemPhoto(file) {
    const blob = await DB.compressEvidenceImage(file);
    const path = `${crypto.randomUUID()}.jpg`;
    const { error } = await supabaseClient.storage.from('item-photos').upload(path, blob, {
      contentType: 'image/jpeg',
    });
    if (error) throw error;
    return path;
  },

  // Public bucket, so this is just a URL string, no signing/expiry needed —
  // safe to keep around and reuse indefinitely, unlike getEvidenceUrls.
  getItemPhotoUrl(imagePath) {
    if (!imagePath) return null;
    return supabaseClient.storage.from('item-photos').getPublicUrl(imagePath).data.publicUrl;
  },

  // Replaces an existing item's whole photo set — simplest correct
  // semantics for an edit form that shows "here's everything currently
  // attached, add or remove freely": delete every row for this sku, then
  // insert whatever the form's final list was. No UPDATE ever happens on a
  // sku_images row (matches the RLS policy, which only grants insert/delete).
  async setSkuImages(skuId, paths) {
    const { error: delErr } = await supabaseClient.from('sku_images').delete().eq('sku_id', skuId);
    if (delErr) throw delErr;
    if (!paths.length) return;
    const { error: insErr } = await supabaseClient
      .from('sku_images')
      .insert(paths.map((storage_path) => ({ sku_id: skuId, storage_path })));
    if (insErr) throw insErr;
  },

  async updateSku(id, patch) {
    const { data, error } = await supabaseClient.from('skus').update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  },

  async setSkuActive(id, isActive) {
    return DB.updateSku(id, { is_active: isActive });
  },

  // ---- Categories -----------------------------------------------------------
  async listCategories() {
    const { data, error } = await supabaseClient.from('categories').select('*').order('sort_order').order('name');
    if (error) throw error;
    return data;
  },

  async createCategory(name) {
    const { data, error } = await supabaseClient.from('categories').insert({ name }).select().single();
    if (error) throw error;
    return data;
  },

  // ---- Departments -----------------------------------------------------------
  async listDepartments() {
    const { data, error } = await supabaseClient.from('departments').select('*').order('name');
    if (error) throw error;
    return data;
  },

  async createDepartment(name) {
    const { data, error } = await supabaseClient.from('departments').insert({ name }).select().single();
    if (error) throw error;
    return data;
  },

  // ---- Buildings --------------------------------------------------------------
  // Backs the Building dropdown on both request forms — unlike departments
  // above, open to anon too (see "buildings" RLS in schema.sql), since an
  // anonymous requester in a building not yet listed shouldn't be blocked
  // from adding it.
  async listBuildings() {
    const { data, error } = await supabaseClient.from('buildings').select('*').order('name');
    if (error) throw error;
    return data;
  },

  async createBuilding(name) {
    const { data, error } = await supabaseClient.from('buildings').insert({ name }).select().single();
    if (error) throw error;
    return data;
  },

  // ---- Work areas ---------------------------------------------------------
  // Backs the "งาน/พื้นที่ที่ต้องการวัสดุ" dropdown on the request forms —
  // same "reference table + inline add" pattern as buildings above, open to
  // anon for the same reason (the public form's work-area field was already
  // free text, so anon could already submit anything unmoderated).
  async listWorkAreas() {
    const { data, error } = await supabaseClient.from('work_areas').select('*').order('name');
    if (error) throw error;
    return data;
  },

  async createWorkArea(name) {
    const { data, error } = await supabaseClient.from('work_areas').insert({ name }).select().single();
    if (error) throw error;
    return data;
  },

  // ---- Stock (views) -------------------------------------------------------
  async stockBySku() {
    const { data, error } = await supabaseClient.from('stock_by_sku').select('*').order('sku_code');
    if (error) throw error;
    return data;
  },

  async lowStock() {
    const { data, error } = await supabaseClient.from('low_stock').select('*');
    if (error) throw error;
    return data;
  },

  // LEGACY — stock_by_lot still exists purely so pre-migration batch history
  // stays queryable; nothing in the app calls this anymore (scanning looks
  // an item up by sku_code via findSkuByCode below, not by lot_code). Left
  // here in case it's ever useful for a one-off lookup.
  async stockByLot(skuId = null) {
    let q = supabaseClient.from('stock_by_lot').select('*');
    if (skuId) q = q.eq('sku_id', skuId);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  },

  // Every item now has one permanent QR sticker encoding its sku_code —
  // this is what the scan screen calls to look an item up.
  async findSkuByCode(skuCode) {
    const { data, error } = await supabaseClient
      .from('stock_by_sku')
      .select('*')
      .eq('sku_code', skuCode.trim())
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  // A numbered unit sticker (e.g. "CEM-014#0007", minted by
  // create_item_units() in schema.sql) — what the fulfill/return sheets'
  // "Scan units" mode looks up on each scan, as an alternative to typing a
  // quantity. Distinct from findSkuByCode above: this resolves one specific
  // physical unit, not the item type.
  async findUnitByCode(unitCode) {
    const { data, error } = await supabaseClient
      .from('item_units')
      .select('*')
      .eq('unit_code', unitCode.trim())
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  // The units create_item_units() just minted for a receive — fetched right
  // after receiveStock() succeeds so the client can print one sticker per
  // unit (see printUnitStickers() in app.js). Newest first by unit_no, same
  // ordering the numbers were assigned in.
  async listRecentUnits(skuId, limit) {
    const { data, error } = await supabaseClient
      .from('item_units')
      .select('*')
      .eq('sku_id', skuId)
      .order('unit_no', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).slice().reverse();
  },

  // How many of a SKU's units are still unaccounted for — Manage Items'
  // "Generate missing unit stickers" backfill uses this to work out how
  // many new item_units rows a SKU received before this feature (or
  // received in a fractional amount) still needs.
  async countInStockUnits(skuId) {
    const { count, error } = await supabaseClient
      .from('item_units')
      .select('id', { count: 'exact', head: true })
      .eq('sku_id', skuId)
      .eq('status', 'in_stock');
    if (error) throw error;
    return count || 0;
  },

  // Mints p_qty new unit stickers directly (create_item_units() in
  // schema.sql), not tied to any specific receive transaction — used only
  // by the Manage Items backfill action above.
  async createItemUnits(skuId, qty) {
    const { error } = await supabaseClient.rpc('create_item_units', {
      p_sku_id: skuId,
      p_qty: qty,
      p_transaction_id: null,
    });
    if (error) throw error;
  },

  // ---- Receiving ------------------------------------------------------------
  async receiveStock({ skuId, qty, uom, receivedBy, supplierRef, imagePaths }) {
    const { data, error } = await supabaseClient.rpc('receive_stock', {
      p_sku_id: skuId,
      p_qty: qty,
      p_uom: uom,
      p_received_by: receivedBy || null,
      p_supplier_ref: supplierRef || null,
      p_image_paths: imagePaths && imagePaths.length ? imagePaths : null,
    });
    if (error) throw error;
    return data;
  },

  // ---- Returns ----------------------------------------------------------------
  // Materials that were issued/taken out coming back into stock. Adds
  // straight onto the item's qty_on_hand, same as receiving — see
  // return_stock() in schema.sql. Freeform: not tied to a specific original
  // request.
  async returnStock({ skuId, qty, uom, returnedBy, note, imagePaths, requestId, unitCodes }) {
    const { data, error } = await supabaseClient.rpc('return_stock', {
      p_sku_id: skuId,
      p_qty: qty,
      p_uom: uom,
      p_returned_by: returnedBy || null,
      p_note: note || null,
      p_image_paths: imagePaths && imagePaths.length ? imagePaths : null,
      p_request_id: requestId || null,
      p_unit_codes: unitCodes && unitCodes.length ? unitCodes : null,
    });
    if (error) throw error;
    return data;
  },

  // ---- Requests ---------------------------------------------------------------
  // Same select shape as listRequests() below (skus/approver embed
  // included, plus qty_on_hand — needed to cap the adjustable qty inputs
  // in openFulfillRequestSheet()'s per-item rows) but targeted at one
  // request_code regardless of status — used right after a successful
  // submit to fetch the properly-joined rows for the post-submit
  // "Export PDF" confirmation, and by the fulfill-by-request-code scan
  // flow, both independent of whatever status filter the Requests list
  // currently has selected (see openNewRequestSheet()/
  // openFulfillRequestSheet() in app.js).
  async getRequestByCode(code) {
    const { data, error } = await supabaseClient
      .from('requests')
      .select('*, skus(sku_code, name, base_uom, qty_on_hand), approver:user_profiles!approved_by(name)')
      .eq('request_code', code);
    if (error) throw error;
    return data;
  },

  // Backs "return against a request number" (Return tab) — rather than
  // staff free-typing an item + quantity from memory (the exact human-
  // error source this was built to close off), this looks up exactly what
  // was actually issued for that request from the transactions ledger
  // (type='issue'), so the return screen can only ever offer quantities up
  // to what genuinely went out the door. Two queries rather than one
  // PostgREST embed-with-filter call — simpler and safer to get right than
  // guessing at embedded-resource filter syntax for an occasional lookup,
  // not a hot path. Returns { meta, items: [] } — meta is null and items
  // empty if the code doesn't exist or nothing was ever issued against it
  // (a request that's still pending, e.g.).
  async listIssuedItemsForRequest(code) {
    const { data: reqs, error: reqErr } = await supabaseClient
      .from('requests')
      .select('id, requester_name, department, work_area, building')
      .eq('request_code', code);
    if (reqErr) throw reqErr;
    if (!reqs.length) return { meta: null, items: [] };
    const ids = reqs.map((r) => r.id);
    const { data: txns, error: txErr } = await supabaseClient
      .from('transactions')
      .select('id, sku_id, qty, uom, request_id, skus(sku_code, name, base_uom)')
      .eq('type', 'issue')
      .in('request_id', ids);
    if (txErr) throw txErr;
    return { meta: reqs[0], items: txns };
  },

  async listRequests({ status = null } = {}) {
    // approver:user_profiles!approved_by(name) — explicit FK hint since
    // requests has two FKs into user_profiles (approved_by and
    // requester_user_id); without naming which one, PostgREST can't tell
    // which relationship to embed.
    let q = supabaseClient
      .from('requests')
      .select('*, skus(sku_code, name, base_uom), approver:user_profiles!approved_by(name)')
      .order('created_at', { ascending: false });
    if (status) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) throw error;
    return data;
  },

  // Used by both the Requester role's own "new request" form and
  // Staff/Admin's internal "+ New" — one RPC instead of the raw insert this
  // used to be. requesterName/department are a Staff/Admin-only "who this
  // is actually for" override (a walk-in who called it in); the RPC
  // ignores both for a Requester-role caller and always uses their own
  // profile instead, so nobody can submit under someone else's name.
  // items is a list of { skuId, qty } (like createPublicRequest below) — a
  // comment-only submission (no items) is also valid. Returns an array:
  // one row per item, all sharing one request_code.
  async createRequest({ items, comment, neededBy, requesterName, department, building, workArea }) {
    const { data, error } = await supabaseClient.rpc('create_authenticated_request', {
      p_items: items && items.length ? items.map((i) => ({ sku_id: i.skuId, qty: i.qty })) : null,
      p_comment: comment || null,
      p_needed_by: neededBy || null,
      p_requester_name: requesterName || null,
      p_department: department || null,
      p_building: building || null,
      p_work_area: workArea || null,
    });
    if (error) throw error;
    return data;
  },

  // approved_by is stamped server-side from auth.uid() inside the function
  // — never sent from here — so the "who approved this" trail can't be
  // spoofed by the client. Row Level Security also means this simply fails
  // for a requester-role caller, including on their own requests.
  async setRequestStatus(id, status) {
    const { data, error } = await supabaseClient.rpc('set_request_status', {
      p_request_id: id,
      p_status: status,
    });
    if (error) throw error;
    return data;
  },

  // Closes out one request line at 0 qty instead of issuing it — the
  // "cannot deliver" path in the fulfill-by-request-code scan flow
  // (js/app.js). No stock movement, no transactions row — see
  // decline_request_item() in schema.sql. note is mandatory; the RPC
  // itself also enforces this, so a caller bypassing this wrapper can't
  // skip it either.
  async declineRequestItem(id, note) {
    const { data, error } = await supabaseClient.rpc('decline_request_item', {
      p_request_id: id,
      p_note: note,
    });
    if (error) throw error;
    return data;
  },

  // The public requester form (no login) — a list of items (each { skuId,
  // qty }), a free-text comment, or both; request_code is assigned by the
  // system the same way lot/SKU codes are (see schema.sql). Returns an
  // array: one row per item, all sharing one request_code (or a single
  // row for a comment-only submission).
  async createPublicRequest({ requesterName, department, comment, workArea, items, building }) {
    const { data, error } = await supabaseClient.rpc('create_public_request', {
      p_requester_name: requesterName,
      p_department: department || null,
      p_comment: comment || null,
      p_work_area: workArea,
      p_items: items && items.length ? items.map((i) => ({ sku_id: i.skuId, qty: i.qty })) : null,
      p_building: building || null,
    });
    if (error) throw error;
    return data;
  },

  // "Top area needing maintenance" — count of distinct submissions per
  // building, most-requested first. See building_report in schema.sql.
  async buildingReport() {
    const { data, error } = await supabaseClient.from('building_report').select('*');
    if (error) throw error;
    return data;
  },

  // ---- Issuing (scan-to-deduct) -----------------------------------------------
  async issueStock({ skuId, requestId, actualQty, performedBy, imagePaths, shortfallNote, unitCodes }) {
    const { data, error } = await supabaseClient.rpc('issue_stock', {
      p_sku_id: skuId,
      p_request_id: requestId,
      p_actual_qty: actualQty,
      p_performed_by: performedBy || null,
      p_image_paths: imagePaths && imagePaths.length ? imagePaths : null,
      p_shortfall_note: shortfallNote || null,
      p_unit_codes: unitCodes && unitCodes.length ? unitCodes : null,
    });
    if (error) throw error;
    return data;
  },

  // ---- Evidence photos (Receive/Return/Issue) --------------------------------
  // Compresses one image (resize + re-encode as JPEG) so a full-resolution
  // phone photo doesn't turn into a multi-MB upload. Canvas-based, no
  // library. Falls back to the original file if it isn't a decodable image
  // (createImageBitmap throws) or compression somehow produces a larger
  // result than the original. imageOrientation: 'from-image' is load-bearing
  // for phone camera photos specifically — they carry an EXIF orientation
  // tag (e.g. "rotate 90°" for a portrait shot from a landscape sensor),
  // and without this option a canvas-based resize can silently ignore it,
  // producing a sideways/upside-down photo.
  async compressEvidenceImage(file, maxEdge = 1600, quality = 0.8) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      bitmap.close?.();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      return blob && blob.size < file.size ? blob : file;
    } catch (_) {
      return file;
    }
  },

  // Compresses and uploads every file to the private transaction-evidence
  // bucket under a fresh random path, returning the array of storage paths
  // to pass into receiveStock/returnStock/issueStock as imagePaths. type is
  // just a folder prefix ('receive'/'return'/'issue') for browsing the
  // bucket by hand — not read back by anything.
  async uploadEvidenceImages(files, type) {
    const paths = [];
    for (const file of files) {
      const blob = await DB.compressEvidenceImage(file);
      const path = `${type}/${crypto.randomUUID()}.jpg`;
      const { error } = await supabaseClient.storage.from('transaction-evidence').upload(path, blob, {
        contentType: 'image/jpeg',
      });
      if (error) throw error;
      paths.push(path);
    }
    return paths;
  },

  // Private bucket, so viewing a photo later needs a short-lived signed URL
  // rather than a permanent public link — generated on demand (when an
  // admin actually clicks "view photos"), not eagerly for every row in a
  // report. Returns an array of { path, signedUrl } in the same order as
  // the input paths, skipping any that failed to sign.
  async getEvidenceUrls(paths, expiresInSeconds = 3600) {
    if (!paths || !paths.length) return [];
    const { data, error } = await supabaseClient.storage
      .from('transaction-evidence')
      .createSignedUrls(paths, expiresInSeconds);
    if (error) throw error;
    return data
      .map((d, i) => ({ path: paths[i], signedUrl: d.signedUrl }))
      .filter((d) => d.signedUrl);
  },

  // ---- Reports ----------------------------------------------------------------
  async movementHistory(limit = 100) {
    const { data, error } = await supabaseClient
      .from('movement_history')
      .select('*')
      .limit(limit);
    if (error) throw error;
    return data;
  },

  // Recent activity for one item (Stock -> tap a card -> item detail sheet).
  // Same movement_history view as the Reports tab, filtered/limited server-side
  // instead of pulling the whole ledger and filtering client-side.
  async movementHistoryForSku(skuCode, limit = 5) {
    const { data, error } = await supabaseClient
      .from('movement_history')
      .select('*')
      .eq('sku_code', skuCode)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data;
  },

  async discrepancyReport() {
    const { data, error } = await supabaseClient.from('discrepancy_report').select('*');
    if (error) throw error;
    return data;
  },
};
