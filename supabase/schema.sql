-- ============================================================================
-- Warehouse Inventory System — v1 schema
-- Construction materials store: receiving (รับของ) + requisition (เบิกของ)
--
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query),
-- or via `supabase db push` if you're using the CLI.
--
-- v2 note on security: the public requester form (request.html) is meant to
-- be reachable by anyone with the link, with no login. Everything else
-- (admin.html — stock, receiving, scanning, requests management, reports)
-- requires signing in through Supabase Auth first. Row Level Security below
-- enforces this at the database level, not just in the UI: the anon key can
-- SELECT active skus (so the request form's item search works) and INSERT
-- into requests (via create_public_request()); every other table, and every
-- other operation on skus/requests, requires the "authenticated" role. See
-- README.md for how to create the shared admin login.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. SKUs — item master
-- ----------------------------------------------------------------------------
create table if not exists skus (
  id               uuid primary key default gen_random_uuid(),
  sku_code         text unique not null,
  name             text not null,
  category         text not null default 'Uncategorized',
  base_uom         text not null,
  alt_uom          text,
  conversion_factor numeric,             -- 1 alt_uom = conversion_factor * base_uom
  min_threshold    numeric not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);

comment on table skus is 'Item master. One row per material type (e.g. "Portland Cement 50kg").';
comment on column skus.conversion_factor is 'How many base_uom in one alt_uom, e.g. 1 pallet = 50 bags -> 50.';

-- Product photos, optional, set from Manage Items — an item can have more
-- than one (v2, see migration below), so these live in their own table
-- rather than a single skus.image_path column. Unlike transaction evidence
-- (private bucket, staff/admin only), item photos live in a PUBLIC bucket
-- (item-photos, below) — they help a requester on the public form
-- recognize what they're picking, and a catalog photo isn't sensitive the
-- way a delivery/damage photo can be. Stores a Storage path, not a full
-- URL, same as transaction_images.storage_path — the app builds the
-- public URL from it (DB.getItemPhotoUrl in js/db.js).
create table if not exists sku_images (
  id            uuid primary key default gen_random_uuid(),
  sku_id        uuid not null references skus(id) on delete cascade,
  storage_path  text not null,
  created_at    timestamptz not null default now()
);
create index if not exists sku_images_sku_id_idx on sku_images(sku_id);

-- v1 (through 2026-09-12): a single skus.image_path text column. Backfill
-- into one sku_images row per item — guarded by information_schema so this
-- is a no-op (and doesn't error trying to read a column that no longer
-- exists) on every re-run after the first. The column itself isn't dropped
-- here: stock_by_sku (section 6 below) still references it at this point
-- in the file, and dropping a column a view depends on fails outright
-- ("cannot drop column ... because other objects depend on it") — the
-- actual `drop column` runs later, right after that view is redefined to
-- stop referencing it. See the matching block below "6. Views".
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'skus' and column_name = 'image_path'
  ) then
    insert into sku_images (sku_id, storage_path)
    select id, image_path from skus where image_path is not null;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1b. Categories — reference table backing the category dropdown in Manage
--     Items. skus.category is a foreign key into this table, matched by
--     name (so renaming a category here cascades to every SKU using it, and
--     a category still in use can't be deleted out from under its SKUs).
--     Staff can add a new category from the app itself (the "+" button next
--     to the category dropdown) — no SQL needed for that going forward.
-- ----------------------------------------------------------------------------
create table if not exists categories (
  id          uuid primary key default gen_random_uuid(),
  name        text unique not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

insert into categories (name, sort_order) values
  ('Cement', 1), ('Steel', 2), ('Aggregate', 3), ('Pipe & Fittings', 4),
  ('Hardware', 5), ('Electrical', 6), ('Sanitary Ware', 7), ('Paint', 8),
  ('Lumber', 9), ('Cleaning Supplies', 10)
on conflict (name) do nothing;

-- Added after the fact (idempotent) so re-running this file against an
-- existing database with SKUs already in it still works, as long as every
-- distinct skus.category value already has a matching row above.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'skus_category_fkey'
  ) then
    alter table skus
      add constraint skus_category_fkey foreign key (category) references categories(name)
      on update cascade on delete restrict;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1c. User profiles — one row per real person, keyed to their Supabase Auth
--     user (auth.users, Supabase's own schema — not created here). Every
--     authenticated caller is expected to have exactly one row here; role
--     drives what the app shows them (js/app.js) and, for requests, what
--     Row Level Security actually lets them see (see section 8 below).
--     Accounts themselves are still created by hand in the Supabase
--     dashboard (Authentication -> Users -> Add user, same mechanism the
--     original single shared admin login already used) — this table is
--     just each person's name/role/department on top of that. See
--     README.md for how to add a person going forward (the in-app Manage
--     Staff screen) and the one-time bootstrap below.
-- ----------------------------------------------------------------------------
create table if not exists user_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  role        text not null check (role in ('requester','staff','admin')),
  department  text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

comment on table user_profiles is 'One row per real person. role drives UI access (app.js) and, for requests, Row Level Security.';

-- Bootstrap: if the original shared admin@warehouse.local account exists
-- and doesn't have a profile yet, give it one automatically — otherwise the
-- moment this file introduces RLS policies that require a user_profiles
-- row to see/manage requests (section 8 below), that account would lose
-- access to its own data until someone manually fixes it up. Safe to
-- re-run: only ever inserts once (on conflict do nothing), and does
-- nothing at all if that account was never created.
do $$
declare
  v_admin_id uuid;
begin
  select id into v_admin_id from auth.users where email = 'admin@warehouse.local';
  if v_admin_id is not null then
    insert into user_profiles (id, name, role)
    values (v_admin_id, 'Admin', 'admin')
    on conflict (id) do nothing;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1d. Departments — reference table backing the department dropdown in
--     Manage Staff. Deliberately NOT a foreign key off user_profiles.department
--     (that column stays free text): department was optional/free-text
--     before this table existed, so a handful of existing profiles could
--     have values that don't line up cleanly, and a hard FK would block
--     re-running this file against that data. This table only exists to
--     give the "+" button in Manage Staff something shared to add to,
--     instead of remembering new department names in one admin's browser
--     only. Admins can add a new one straight from the app — no SQL needed
--     for that going forward.
-- ----------------------------------------------------------------------------
create table if not exists departments (
  id          uuid primary key default gen_random_uuid(),
  name        text unique not null,
  created_at  timestamptz not null default now()
);

-- Backfill: anyone already assigned a department before this table existed
-- shouldn't have that name silently disappear from the dropdown once it
-- switches from "derived from staff" to "read from this table".
insert into departments (name)
select distinct department from user_profiles where department is not null and department <> ''
on conflict (name) do nothing;

-- ----------------------------------------------------------------------------
-- 1e. Buildings — reference table backing the new "Building" dropdown on
--     both request forms (the anonymous public form and the authenticated
--     New Request flow), alongside the work_area detail field (e.g. "3rd
--     floor restroom", itself now similarly backed by work_areas below) —
--     building is the coarser, reportable category ("Building A"),
--     work_area is the finer detail. Feeds building_report (section 6
--     below): count of requests per building, for a "which area needs
--     maintenance most" view. Unlike departments above (staff/admin only),
--     anyone can add a new building from either request form — a building
--     name is no more sensitive than the free text work_area already let
--     anyone type unmoderated before it got this same treatment, and
--     keeping it open means an anonymous requester in a building not yet
--     listed isn't blocked.
-- ----------------------------------------------------------------------------
create table if not exists buildings (
  id          uuid primary key default gen_random_uuid(),
  name        text unique not null,
  created_at  timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 1f. Work areas — reference table backing the "งาน/พื้นที่ที่ต้องการวัสดุ"
--     dropdown on the request forms, same "reference table + inline add"
--     pattern and same open (anon can view+add) reasoning as buildings just
--     above: the field was already free text anyone could type unmoderated,
--     so a shared suggestions list is a data-quality upgrade, not a new
--     exposure. requests.work_area itself stays a plain text column (see
--     section 3 below) — this table only supplies the dropdown's options,
--     it isn't a foreign key.
-- ----------------------------------------------------------------------------
create table if not exists work_areas (
  id          uuid primary key default gen_random_uuid(),
  name        text unique not null,
  created_at  timestamptz not null default now()
);

-- Backfill for work_areas: moved to the end of section 3 below (it reads
-- from requests.work_area, which doesn't exist yet at this point in the
-- file on a fresh install — see the note there).

-- ----------------------------------------------------------------------------
-- 2. Lots — LEGACY as of 2026-09-08. Originally one row per receiving
--    event, with its own QR sticker per batch. The system now uses one
--    permanent QR sticker per ITEM instead (see skus.qty_on_hand and the
--    rewritten receive_stock/return_stock/issue_stock below) — no more
--    per-batch tracking. This table, lot_sequences, and the stock_by_lot
--    view are kept only so pre-migration data isn't destroyed; nothing
--    written after the migration reads or writes them. Safe to ignore.
-- ----------------------------------------------------------------------------
create table if not exists lots (
  id             uuid primary key default gen_random_uuid(),
  lot_code       text unique not null,
  sku_id         uuid not null references skus(id) on delete restrict,
  qty_received   numeric not null check (qty_received > 0),
  balance        numeric not null check (balance >= 0),
  uom            text not null,
  receive_date   date not null default current_date,
  received_by    text,
  supplier_ref   text,
  created_at     timestamptz not null default now()
);

comment on table lots is 'A physical batch received on one date. The QR code printed on its sticker encodes lot_code only — never quantity, which changes after printing.';

create index if not exists lots_sku_id_idx on lots(sku_id);

-- Returns (added 2026-09-07): materials that were issued/taken out coming
-- back into stock go through return_stock() below, which creates a new lot
-- just like receiving does (own lot_code, own QR sticker, scannable back
-- out again) rather than folding the quantity back into whichever lot it
-- originally came from — keeps every other lot's receive_date meaningful
-- for FIFO/aging. `source` tells a return lot apart from a normal purchase
-- receipt; `note` carries the freeform reason/condition a return_stock()
-- call is given (blank for ordinary receiving). received_by is reused to
-- mean "returned by" on a return lot — same column, same "whoever this
-- transaction is associated with" role it already plays for receiving.
alter table lots add column if not exists source text not null default 'purchase';
alter table lots drop constraint if exists lots_source_chk;
alter table lots add constraint lots_source_chk check (source in ('purchase','return'));
alter table lots add column if not exists note text;

-- qty_on_hand (added 2026-09-08): the single running total per item that
-- replaces summing lots.balance — see the "2. Lots" note above. Guarded so
-- the backfill-from-lots runs exactly once, the moment this column is
-- introduced: on every later re-run of this file, `add column if not
-- exists` alone would be a no-op, so the backfill must be skipped too, or a
-- re-run would blow away every receive/issue/return that happened after
-- go-live and reset each item back to its frozen pre-migration lot total.
do $$
declare
  v_col_existed boolean;
begin
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'skus' and column_name = 'qty_on_hand'
  ) into v_col_existed;

  if not v_col_existed then
    alter table skus add column qty_on_hand numeric not null default 0;
    update skus s set qty_on_hand = coalesce(
      (select sum(l.balance) from lots l where l.sku_id = s.id), 0
    );
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3. Requests — a requester's ask, fulfilled by scanning an item
-- ----------------------------------------------------------------------------
create table if not exists requests (
  id              uuid primary key default gen_random_uuid(),
  request_code    text not null,
  requester_name  text not null,
  sku_id          uuid references skus(id) on delete restrict,
  qty_requested   numeric check (qty_requested > 0),
  needed_by       date,
  notes           text,
  status          text not null default 'pending'
                    check (status in ('pending','preparing','ready','fulfilled','cancelled')),
  created_at      timestamptz not null default now()
);

-- request_code was originally UNIQUE (one code = one row). Since v2.2, the
-- public form can submit a *list* of items in one go, and that's stored as
-- one row per item all sharing a single request_code — so the column can
-- no longer be unique. Dropped on a database that still has the old
-- constraint (fresh databases never had it, since the CREATE TABLE above
-- no longer declares it); a plain index replaces it for lookup speed.
alter table requests drop constraint if exists requests_request_code_key;
create index if not exists requests_request_code_idx on requests(request_code);

create index if not exists requests_status_idx on requests(status);
create index if not exists requests_sku_id_idx on requests(sku_id);

-- Who actually picked the order up — set by issue_stock() when the request
-- is closed, from the same name typed into the "picked up by" field on the
-- issue screen. Nullable: only fulfilled requests will have one.
alter table requests add column if not exists picked_up_by text;

-- A staff remark explaining why a line couldn't be delivered — set by
-- decline_request_item() below, distinct from `notes` (the requester's own
-- comment, set at creation and never touched after). Only ever populated
-- when a line is closed out at 0 qty instead of actually issued — see the
-- "fulfill by request code" scan flow (js/app.js) for where this is
-- collected.
alter table requests add column if not exists staff_note text;

-- The public requester form (no login, no item picker — see
-- create_public_request() below) collects who's asking and which
-- department to charge back to, then a free-text description in `notes`.
-- sku_id/qty_requested are nullable so this "general" kind of request can
-- coexist with the original item+quantity kind staff create internally —
-- one requests table, one admin view, told apart by whether sku_id is set.
alter table requests add column if not exists department text;

-- The area/job the materials are actually for (e.g. "Building A, 3rd floor
-- restroom" or "รั้วด้านหลังอาคาร") — modeled on the paper requisition slip
-- this form replaces, which always has a "ระบุงานซ่อม/โซน" line filled in.
-- The public form requires it (see create_public_request below); the
-- column itself stays nullable so rows created before this field existed
-- aren't left with a constraint they can't satisfy.
alter table requests add column if not exists work_area text;

-- The coarser, reportable counterpart to work_area above — picked from the
-- buildings dropdown (see "1e. Buildings"), not typed freely, so it can
-- actually be aggregated (building_report, section 6). Optional on both
-- request forms — unlike work_area, not required, since the report just
-- treats "no building given" as its own bucket rather than blocking
-- submission over it.
alter table requests add column if not exists building text;

-- Real identity, added alongside the role system (see "1c. User profiles"
-- above). Both nullable: neither the anonymous public form nor
-- pre-existing rows ever set them. requester_user_id is which logged-in
-- Requester submitted this — stamped server-side by
-- create_authenticated_request() below, never trusted from the client.
-- approved_by is whichever staff/admin last changed the status, stamped
-- server-side by set_request_status() below. Both reference
-- user_profiles(id) rather than auth.users(id) directly — same underlying
-- identity (user_profiles.id already references auth.users), but this way
-- PostgREST can embed the name in one query (DB.listRequests() in
-- js/db.js), and both RPCs already guarantee a profile exists before they
-- ever set these columns (create_authenticated_request looks its caller's
-- profile up first; set_request_status's RLS requires one to pass at all).
alter table requests add column if not exists requester_user_id uuid references user_profiles(id);
alter table requests add column if not exists approved_by uuid references user_profiles(id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'requests_item_or_note_chk'
  ) then
    alter table requests
      add constraint requests_item_or_note_chk check (sku_id is not null or notes is not null);
  end if;
end $$;

-- Backfill: work_area values typed freely before the work_areas dropdown
-- table existed (section 1f above) shouldn't vanish from its suggestions
-- once it switches over. Placed here, not right after work_areas is
-- created, because it reads requests.work_area — both the table and that
-- column only exist as of this point in the file.
insert into work_areas (name)
select distinct work_area from requests where work_area is not null and work_area <> ''
on conflict (name) do nothing;

-- ----------------------------------------------------------------------------
-- 4. Transactions — every receive / issue / return event (the movement
--    ledger). lot_id is LEGACY (see the "2. Lots" note above) — a fresh
--    install never sets it; it's kept nullable only so pre-migration rows
--    that do have one aren't touched. sku_id is what every row (old and
--    new) is keyed by now.
-- ----------------------------------------------------------------------------
create table if not exists transactions (
  id            uuid primary key default gen_random_uuid(),
  type          text not null check (type in ('receive','issue','return')),
  sku_id        uuid references skus(id) on delete restrict,
  lot_id        uuid references lots(id) on delete restrict,
  request_id    uuid references requests(id) on delete set null,
  qty           numeric not null,
  uom           text not null,
  performed_by  text,
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists transactions_lot_id_idx on transactions(lot_id);
create index if not exists transactions_created_at_idx on transactions(created_at desc);

-- Widen the ledger to admit 'return' events alongside receive/issue (added
-- 2026-09-07 for return_stock() below). Dropped and re-added rather than an
-- "if not exists" guard, same pattern as the request_code migration above —
-- cheap either way, and always ends in the same state.
alter table transactions drop constraint if exists transactions_type_check;
alter table transactions add constraint transactions_type_check check (type in ('receive','issue','return'));

-- Migration for a database created before the item-level QR change
-- (2026-09-08): lot_id used to be required and sku_id/note didn't exist.
-- Add the new columns, relax lot_id, and backfill sku_id from each row's
-- (legacy) lot — safe to re-run, since the backfill only ever fills in
-- rows that are still null. Must run before the sku_id index below: on a
-- pre-existing table `create table if not exists` above is a no-op, so
-- sku_id doesn't exist until this alter adds it.
alter table transactions add column if not exists sku_id uuid references skus(id) on delete restrict;
alter table transactions add column if not exists note text;
alter table transactions alter column lot_id drop not null;
update transactions t set sku_id = l.sku_id
from lots l
where t.lot_id = l.id and t.sku_id is null;

create index if not exists transactions_sku_id_idx on transactions(sku_id);

-- ----------------------------------------------------------------------------
-- 5. Discrepancies — issued qty != requested qty (variance record)
-- ----------------------------------------------------------------------------
create table if not exists discrepancies (
  id              uuid primary key default gen_random_uuid(),
  transaction_id  uuid not null references transactions(id) on delete cascade,
  request_id      uuid not null references requests(id) on delete cascade,
  requested_qty   numeric not null,
  actual_qty      numeric not null,
  variance        numeric generated always as (actual_qty - requested_qty) stored,
  notes           text,
  created_at      timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 5a. Transaction evidence photos — optional, uploaded from the Receive/
--     Return/Issue forms (js/app.js). Images themselves live in Supabase
--     Storage (bucket created below), not in Postgres — this table just
--     links a transaction to the storage path(s) of whatever was attached
--     to it. Populated by receive_stock()/return_stock()/issue_stock()
--     below via insert_transaction_images(), never written directly.
-- ----------------------------------------------------------------------------
create table if not exists transaction_images (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete cascade,
  storage_path   text not null,
  created_at     timestamptz not null default now()
);
create index if not exists transaction_images_transaction_id_idx on transaction_images(transaction_id);

-- A private bucket — these can be photos of a delivery area, a damaged
-- item, etc., so they get the same "staff and admin only" trust boundary
-- as transactions themselves (is_staff_or_admin(), defined in section 8
-- below but callable here since it's created earlier in this file... see
-- note: policies referencing it are added in section 8 alongside every
-- other RLS policy, not here, so the function exists first). Viewing a
-- photo later happens through a short-lived signed URL (DB.getEvidenceUrls
-- in js/db.js) — there is no permanent public link.
insert into storage.buckets (id, name, public)
values ('transaction-evidence', 'transaction-evidence', false)
on conflict (id) do nothing;

-- item-photos: PUBLIC bucket for product photos set from Manage Items
-- (sku_images above) — deliberately the opposite trust boundary from
-- transaction-evidence, since these help anyone on the public request form
-- recognize an item and aren't sensitive. Public means reads need no
-- policy at all (served straight from Storage's public URL endpoint,
-- bypassing RLS entirely) — only writes are gated, staff/admin only, same
-- as everything else that maintains the catalog.
insert into storage.buckets (id, name, public)
values ('item-photos', 'item-photos', true)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- 5b. Lot numbering — a per-SKU, per-day running counter, so lot codes read
--     as SKU-YYMMDD-NNN (e.g. CEM-001-260906-001, then -002 for the next
--     batch of the same item received that same day). The upsert below is
--     one atomic statement, so two staff receiving the same item at the same
--     moment still get distinct, gap-free numbers.
-- ----------------------------------------------------------------------------
create table if not exists lot_sequences (
  sku_id    uuid not null references skus(id) on delete cascade,
  seq_date  date not null,
  last_seq  integer not null default 0,
  primary key (sku_id, seq_date)
);

-- ----------------------------------------------------------------------------
-- 5c. SKU code numbering — new SKU codes are generated by the system, not
--     typed by staff: a random 3-letter prefix plus a running number for
--     that prefix, e.g. "QZT-001". Keyed by prefix (not globally), the same
--     atomic-upsert trick as lot_sequences above, so a repeat of the same
--     random prefix (rare, but possible) just continues its own count
--     instead of colliding. See create_sku() below.
-- ----------------------------------------------------------------------------
create table if not exists sku_sequences (
  prefix    text primary key,
  last_seq  integer not null default 0
);

-- ----------------------------------------------------------------------------
-- 5d. Request numbering — the public requester form's request_code, same
--     per-day running-counter pattern as lot_sequences: REQ-YYMMDD-NNN.
-- ----------------------------------------------------------------------------
create table if not exists request_sequences (
  seq_date  date primary key,
  last_seq  integer not null default 0
);

-- ----------------------------------------------------------------------------
-- 5e. Item units — one row per physical unit, each with its own numbered QR
--     sticker (unit_code, e.g. "CEM-014#0007"), so staff can scan units one
--     by one during fulfillment/return instead of typing a quantity. Rides
--     alongside skus.qty_on_hand as metadata, not a second source of truth
--     for the running total — receive_stock()/issue_stock()/return_stock()
--     below still own the actual stock math; this table just tracks which
--     specific physical unit is in_stock / issued / returned, and (for
--     issued units) which request they were issued against, so a return can
--     reject a unit that wasn't actually issued under that request.
-- ----------------------------------------------------------------------------
create table if not exists item_units (
  id                       uuid primary key default gen_random_uuid(),
  sku_id                   uuid not null references skus(id) on delete restrict,
  unit_no                  integer not null,
  unit_code                text not null unique,
  status                   text not null default 'in_stock' check (status in ('in_stock','issued','returned')),
  received_transaction_id  uuid references transactions(id) on delete set null,
  issued_request_id        uuid references requests(id) on delete set null,
  issued_transaction_id    uuid references transactions(id) on delete set null,
  returned_transaction_id  uuid references transactions(id) on delete set null,
  created_at               timestamptz not null default now()
);
create index if not exists item_units_sku_id_idx on item_units(sku_id);
create index if not exists item_units_status_idx on item_units(sku_id, status);

-- Per-SKU running counter for unit_no, same atomic-upsert idiom as
-- lot_sequences/sku_sequences above — see create_item_units() below.
create table if not exists sku_unit_sequences (
  sku_id    uuid primary key references skus(id) on delete cascade,
  last_seq  integer not null default 0
);

-- Mints p_qty new item_units rows for a SKU, numbered sequentially from
-- that SKU's own counter. Called from receive_stock() below (p_transaction_id
-- set, tying the new units to the receive event that created them) and
-- directly from Manage Items' "Generate missing unit stickers" backfill
-- action for stock received before this table existed (p_transaction_id
-- null — there's no single receive event to point at).
create or replace function create_item_units(p_sku_id uuid, p_qty int, p_transaction_id uuid default null) returns void
language plpgsql
as $$
declare
  v_sku_code text;
  v_seq integer;
  i integer;
begin
  if p_qty is null or p_qty < 1 then
    return;
  end if;

  select sku_code into v_sku_code from skus where id = p_sku_id;
  if v_sku_code is null then
    raise exception 'SKU not found';
  end if;

  for i in 1..p_qty loop
    insert into sku_unit_sequences (sku_id, last_seq) values (p_sku_id, 1)
    on conflict (sku_id) do update set last_seq = sku_unit_sequences.last_seq + 1
    returning last_seq into v_seq;

    insert into item_units (sku_id, unit_no, unit_code, received_transaction_id)
    values (p_sku_id, v_seq, v_sku_code || '#' || lpad(v_seq::text, 4, '0'), p_transaction_id);
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Views — current stock, read straight off skus.qty_on_hand as of
--    2026-09-08 (previously summed from lots — see the "2. Lots" note).
-- ----------------------------------------------------------------------------
-- Dropped and recreated (not create-or-replace): the old image_path column
-- is renamed to image_paths (single photo -> array of photos), and Postgres
-- refuses to CREATE OR REPLACE a view when that changes an existing
-- column's name ("cannot change name of view column ... use ALTER VIEW ...
-- RENAME COLUMN instead") — same reasoning already noted for
-- movement_history above. low_stock depends on stock_by_sku, so it has to
-- be dropped first and recreated after.
drop view if exists low_stock;
drop view if exists stock_by_sku;

create view stock_by_sku as
select
  s.id            as sku_id,
  s.sku_code,
  s.name,
  s.category,
  s.base_uom,
  s.min_threshold,
  s.qty_on_hand                as on_hand,
  s.qty_on_hand < s.min_threshold as is_low,
  coalesce(si.image_paths, array[]::text[]) as image_paths
from skus s
left join lateral (
  select array_agg(storage_path order by created_at) as image_paths
  from sku_images
  where sku_id = s.id
) si on true
where s.is_active;

create view low_stock as
select * from stock_by_sku where is_low order by on_hand asc;

-- Now safe to drop skus.image_path (see the backfill block under "1c" —
-- stock_by_sku no longer references it as of the drop/recreate above, so
-- this can't fail with "cannot drop column ... because other objects
-- depend on it" the way it would if this ran before the view was fixed).
-- Guarded the same way as the backfill: a no-op once the column is gone.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'skus' and column_name = 'image_path'
  ) then
    alter table skus drop column image_path;
  end if;
end $$;

-- LEGACY — kept only so pre-migration batch history is still queryable by
-- hand if ever needed; nothing in the app reads this view anymore (scanning
-- now looks an item up by sku_code directly, not lot_code). Left exactly as
-- it was, unchanged.
drop view if exists stock_by_lot;
create view stock_by_lot as
select
  l.id as lot_id, l.lot_code, l.balance, l.qty_received, l.uom,
  l.receive_date, l.supplier_ref, l.source, l.received_by, l.note,
  s.id as sku_id, s.sku_code, s.name, s.category
from lots l
join skus s on s.id = l.sku_id
order by l.receive_date desc;

-- Dropped and recreated (not create-or-replace): lot_code is gone from the
-- column list (transactions now join straight to skus via sku_id, not via
-- lots), and Postgres only allows CREATE OR REPLACE VIEW to append columns
-- at the end, never remove or reorder them — same reasoning as stock_by_lot
-- above, which is what originally established this pattern in this file.
drop view if exists movement_history;
create view movement_history as
select
  t.id as transaction_id, t.type, t.qty, t.uom, t.performed_by, t.note, t.created_at,
  s.sku_code, s.name as sku_name,
  r.request_code,
  coalesce(ti.image_paths, array[]::text[]) as image_paths
from transactions t
join skus s on s.id = t.sku_id
left join requests r on r.id = t.request_id
left join lateral (
  select array_agg(storage_path order by created_at) as image_paths
  from transaction_images
  where transaction_id = t.id
) ti on true
order by t.created_at desc;

drop view if exists discrepancy_report;
create view discrepancy_report as
select
  d.id, d.requested_qty, d.actual_qty, d.variance, d.notes, d.created_at,
  r.request_code, r.requester_name,
  s.sku_code, s.name as sku_name
from discrepancies d
join requests r on r.id = d.request_id
join transactions t on t.id = d.transaction_id
join skus s on s.id = t.sku_id
order by d.created_at desc;

-- Which building/area asks for maintenance most — counts distinct
-- request_code (a submission), not raw rows, since a multi-item request
-- shares one request_code across several rows and would otherwise be
-- counted once per item instead of once per actual ask.
drop view if exists building_report;
create view building_report as
select
  building,
  count(distinct request_code) as request_count,
  max(created_at) as last_requested_at
from requests
where building is not null
group by building
order by request_count desc;

-- ----------------------------------------------------------------------------
-- 7. RPCs — the two writes that must be atomic
-- ----------------------------------------------------------------------------

-- Shared by receive_stock()/return_stock()/issue_stock() below — one small
-- helper instead of repeating the same loop three times. p_image_paths is
-- the array of Storage paths the client already uploaded to the
-- transaction-evidence bucket before calling the RPC (see js/db.js
-- uploadEvidenceImages) — null/empty is the normal case, since photos are
-- optional.
create or replace function insert_transaction_images(p_transaction_id uuid, p_image_paths text[]) returns void
language plpgsql
as $$
declare
  v_path text;
begin
  if p_image_paths is null then
    return;
  end if;
  foreach v_path in array p_image_paths loop
    if nullif(trim(v_path), '') is not null then
      insert into transaction_images (transaction_id, storage_path) values (p_transaction_id, v_path);
    end if;
  end loop;
end;
$$;

-- Receiving (rewritten 2026-09-08 for the one-QR-per-item model): adds
-- straight onto the item's running total and logs a transaction — no more
-- creating a new lot/QR per receiving event (see the "2. Lots" note above).
-- Returns the updated sku row; the caller already has (or can print) that
-- item's one permanent QR sticker, which encodes sku_code.
-- v1 (through 2026-09-07): (p_sku_id, p_qty, p_uom, p_received_by,
--   p_supplier_ref) returned a new `lots` row.
-- v2 (current): same parameters, but returns `skus` instead of `lots` —
-- dropped and recreated rather than create-or-replace, since Postgres
-- doesn't allow a function's return type to change in place.
drop function if exists receive_stock(uuid, numeric, text, text, text);

-- v3 (current): adds p_image_paths — optional evidence photos, already
-- uploaded to Storage by the caller (see insert_transaction_images above).
-- Now captures the transaction row via `returning` (previously discarded)
-- since it needs the id to link images to.
create or replace function receive_stock(
  p_sku_id uuid, p_qty numeric, p_uom text,
  p_received_by text default null, p_supplier_ref text default null,
  p_image_paths text[] default null
) returns skus
language plpgsql
as $$
declare
  v_sku skus;
  v_txn transactions;
begin
  if p_qty <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;

  update skus set qty_on_hand = qty_on_hand + p_qty
  where id = p_sku_id
  returning * into v_sku;

  if not found then
    raise exception 'SKU not found';
  end if;

  insert into transactions (type, sku_id, qty, uom, performed_by, note)
  values ('receive', p_sku_id, p_qty, p_uom, p_received_by, p_supplier_ref)
  returning * into v_txn;

  perform insert_transaction_images(v_txn.id, p_image_paths);

  -- Mint one numbered item_units row per whole unit received, so this
  -- batch is immediately scannable one-by-one at fulfillment/return. A
  -- fractional qty (e.g. 2.5 cu.m of sand) mints floor(qty) units and
  -- silently leaves the remainder un-stickered — qty_on_hand above already
  -- carries the true total either way, this table is metadata on top.
  perform create_item_units(p_sku_id, floor(p_qty)::int, v_txn.id);

  return v_sku;
end;
$$;

-- Returning (rewritten 2026-09-08, same reasoning as receive_stock above):
-- materials that were issued/taken out come back into stock. Deliberately
-- freeform, like receiving, and not tied to a specific original request —
-- a site return in practice often isn't cleanly one pickup's worth, and
-- staff shouldn't have to hunt down the original request just to log it.
-- Adds straight onto the item's running total, tagged as a 'return'
-- transaction (type alone tells it apart from an ordinary 'receive' now —
-- lots.source is legacy, see above). Admin-only — see grants below, not
-- reachable from the public form.
drop function if exists return_stock(uuid, numeric, text, text, text);
drop function if exists return_stock(uuid, numeric, text, text, text, text[]);
drop function if exists return_stock(uuid, numeric, text, text, text, text[], uuid);

-- v2: adds p_image_paths, same reasoning as receive_stock above.
-- v3: adds p_request_id — still optional/nullable (a return
-- genuinely doesn't always have one, per the "deliberately freeform"
-- reasoning above), but when the Return tab's "return against a request
-- number" screen (js/app.js openReturnByRequestSheet()) already knows
-- which request a return is against, passing it through here is what lets
-- movement_history's request_code column (left join requests r on r.id =
-- t.request_id) show it — before this, every return showed "—" there even
-- when staff had explicitly looked the request up, which is exactly the
-- gap this closes.
-- v4: adds p_unit_codes — when the return was collected by scanning
-- numbered unit stickers one-by-one (js/app.js return-by-request "Scan
-- units" mode) rather than typing a quantity, each code is validated and
-- flipped back to in_stock here, in the same transaction as the qty
-- movement. Only a unit actually issued under *this* request is accepted
-- (issued_request_id must match p_request_id) — scanning some other
-- request's unit, or one that was never issued, is rejected outright
-- rather than silently accepted.
create or replace function return_stock(
  p_sku_id uuid, p_qty numeric, p_uom text,
  p_returned_by text default null, p_note text default null,
  p_image_paths text[] default null, p_request_id uuid default null,
  p_unit_codes text[] default null
) returns skus
language plpgsql
as $$
declare
  v_sku skus;
  v_txn transactions;
  v_unit_code text;
  v_matched integer;
begin
  if p_qty <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;

  update skus set qty_on_hand = qty_on_hand + p_qty
  where id = p_sku_id
  returning * into v_sku;

  if not found then
    raise exception 'SKU not found';
  end if;

  insert into transactions (type, sku_id, qty, uom, performed_by, note, request_id)
  values ('return', p_sku_id, p_qty, p_uom, p_returned_by, p_note, p_request_id)
  returning * into v_txn;

  perform insert_transaction_images(v_txn.id, p_image_paths);

  if p_unit_codes is not null then
    foreach v_unit_code in array p_unit_codes loop
      update item_units
      set status = 'returned', returned_transaction_id = v_txn.id
      where unit_code = v_unit_code
        and sku_id = p_sku_id
        and status = 'issued'
        and issued_request_id is not distinct from p_request_id;
      get diagnostics v_matched = row_count;
      if v_matched = 0 then
        raise exception 'Unit % was not issued under this request (or has already been returned)', v_unit_code;
      end if;
    end loop;
  end if;

  return v_sku;
end;
$$;

-- Issuing: the scan-to-deduct step (rewritten 2026-09-08 for the
-- one-QR-per-item model — was p_lot_id against a lot's balance, now
-- p_sku_id against the item's running total). Locks the sku row so two
-- staff issuing the same item at once cannot both succeed against stock
-- that is no longer there. Branches exactly like the workflow diagram: an
-- exact match closes the request quietly; a mismatch still deducts stock
-- but leaves a discrepancy record rather than silently accepting or
-- blocking it.
drop function if exists issue_stock(uuid, uuid, numeric, text);
drop function if exists issue_stock(uuid, uuid, numeric, text, text[]);

-- v2: adds p_image_paths, same reasoning as receive_stock above — this one
-- already captured the transaction row (v_txn), so it's just a new param
-- + one extra call.
-- v3: adds p_unit_codes (units scanned one-by-one instead of a typed
-- quantity — claimed against this request in the same transaction as the
-- stock deduction below, never a second write) and p_shortfall_note (the
-- "what happened" text captured when actual < requested via scanning,
-- stored on the discrepancy row this function already creates for any
-- mismatch — previously that row's notes column was always left null).
create or replace function issue_stock(
  p_sku_id uuid, p_request_id uuid, p_actual_qty numeric, p_performed_by text default null,
  p_image_paths text[] default null, p_shortfall_note text default null, p_unit_codes text[] default null
) returns jsonb
language plpgsql
as $$
declare
  v_sku skus;
  v_request requests;
  v_txn transactions;
  v_discrepancy discrepancies;
  v_has_discrepancy boolean := false;
  v_unit_code text;
  v_matched integer;
begin
  if p_actual_qty <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;
  -- Client-side already requires this (see the issue-picked-up-by check in
  -- renderScannedItem()'s btn-confirm-issue handler in app.js), but that's
  -- only a UI convenience — anyone with a staff/admin JWT could call this RPC
  -- directly and skip it. Enforcing it here closes the actual gap: without
  -- it, a fulfilled request could carry a null picked_up_by, leaving no way
  -- to tell who physically walked away with the materials, unlike
  -- requester_name on the request side which is already always populated
  -- (see create_public_request()/create_authenticated_request() above).
  if nullif(trim(p_performed_by), '') is null then
    raise exception 'Please enter who picked up the items';
  end if;

  select * into v_sku from skus where id = p_sku_id for update;
  if not found then
    raise exception 'Item not found';
  end if;
  if v_sku.qty_on_hand < p_actual_qty then
    raise exception 'Insufficient stock for %: % available, % requested',
      v_sku.sku_code, v_sku.qty_on_hand, p_actual_qty;
  end if;

  select * into v_request from requests where id = p_request_id for update;
  if not found then
    raise exception 'Request not found';
  end if;
  if v_request.status = 'fulfilled' then
    raise exception 'Request % is already fulfilled', v_request.request_code;
  end if;

  update skus set qty_on_hand = qty_on_hand - p_actual_qty where id = p_sku_id;

  insert into transactions (type, sku_id, request_id, qty, uom, performed_by)
  values ('issue', p_sku_id, p_request_id, p_actual_qty, v_sku.base_uom, p_performed_by)
  returning * into v_txn;

  perform insert_transaction_images(v_txn.id, p_image_paths);

  if p_unit_codes is not null then
    foreach v_unit_code in array p_unit_codes loop
      update item_units
      set status = 'issued', issued_request_id = p_request_id, issued_transaction_id = v_txn.id
      where unit_code = v_unit_code and sku_id = p_sku_id and status = 'in_stock';
      get diagnostics v_matched = row_count;
      if v_matched = 0 then
        raise exception 'Unit % is not available to issue (already issued/returned, or belongs to a different item)', v_unit_code;
      end if;
    end loop;
  end if;

  if p_actual_qty <> v_request.qty_requested then
    v_has_discrepancy := true;
    insert into discrepancies (transaction_id, request_id, requested_qty, actual_qty, notes)
    values (v_txn.id, p_request_id, v_request.qty_requested, p_actual_qty, p_shortfall_note)
    returning * into v_discrepancy;
  end if;

  update requests set status = 'fulfilled', picked_up_by = p_performed_by where id = p_request_id;

  return jsonb_build_object(
    'transaction', to_jsonb(v_txn),
    'has_discrepancy', v_has_discrepancy,
    'discrepancy', to_jsonb(v_discrepancy)
  );
end;
$$;

-- Shared by create_sku() below and available for any future sku-photo
-- write path — same pattern as insert_transaction_images() above, one
-- small helper instead of repeating the loop.
create or replace function insert_sku_images(p_sku_id uuid, p_image_paths text[]) returns void
language plpgsql
as $$
declare
  v_path text;
begin
  if p_image_paths is null then
    return;
  end if;
  foreach v_path in array p_image_paths loop
    if nullif(trim(v_path), '') is not null then
      insert into sku_images (sku_id, storage_path) values (p_sku_id, v_path);
    end if;
  end loop;
end;
$$;

-- Creating a new item: the SKU code is assigned by the system, not typed by
-- staff — a random 3-letter prefix plus a running number for that prefix
-- (see sku_sequences above). The existence check is just a belt-and-braces
-- retry; in practice the sequence table already guarantees no collision.
-- p_image_paths (v2 — an item can now have more than one photo, see
-- sku_images above): the caller already uploaded each photo to the public
-- item-photos bucket before calling this, same "upload first, pass the
-- paths in" order as evidence photos — a new item's id isn't known until
-- this insert runs, so each photo's path is a fresh random name, not keyed
-- off the sku id.
drop function if exists create_sku(text, text, text, text, numeric, numeric);
drop function if exists create_sku(text, text, text, text, numeric, numeric, text);

create or replace function create_sku(
  p_name text, p_category text, p_base_uom text,
  p_alt_uom text default null, p_conversion_factor numeric default null,
  p_min_threshold numeric default 0, p_image_paths text[] default null
) returns skus
language plpgsql
as $$
declare
  v_letters text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  v_prefix text;
  v_seq int;
  v_code text;
  v_sku skus;
begin
  loop
    v_prefix := '';
    for i in 1..3 loop
      v_prefix := v_prefix || substr(v_letters, (floor(random() * 26) + 1)::int, 1);
    end loop;

    insert into sku_sequences (prefix, last_seq)
    values (v_prefix, 1)
    on conflict (prefix) do update set last_seq = sku_sequences.last_seq + 1
    returning last_seq into v_seq;

    v_code := v_prefix || '-' || lpad(v_seq::text, 3, '0');

    exit when not exists (select 1 from skus where sku_code = v_code);
  end loop;

  insert into skus (sku_code, name, category, base_uom, alt_uom, conversion_factor, min_threshold)
  values (v_code, p_name, p_category, p_base_uom, p_alt_uom, p_conversion_factor, p_min_threshold)
  returning * into v_sku;

  perform insert_sku_images(v_sku.id, p_image_paths);

  return v_sku;
end;
$$;

-- Shared by create_public_request() and create_authenticated_request()
-- below: the next REQ-YYMMDD-NNN code, from the same atomic per-day
-- counter both used inline before this was extracted — one place instead
-- of two. Not security definer itself; both callers already are, so it
-- inherits their privileges when they call it.
create or replace function next_request_code() returns text
language plpgsql
as $$
declare
  v_seq int;
begin
  insert into request_sequences (seq_date, last_seq)
  values (current_date, 1)
  on conflict (seq_date) do update set last_seq = request_sequences.last_seq + 1
  returning last_seq into v_seq;

  return 'REQ-' || to_char(current_date, 'YYMMDD') || '-' || lpad(v_seq::text, 3, '0');
end;
$$;

-- The public requester form: no login. A requester can either pick a
-- specific item (searched from the same catalog Stock/Receive use) and say
-- how many, or just describe what they need in free text, or both — the
-- requests_item_or_note_chk constraint only insists on at least one.
-- request_code is assigned the same way lot_code is: an atomic per-day
-- running counter, so concurrent public submissions still get distinct,
-- gap-free numbers.
-- security definer: anon can INSERT into requests but (by design) has no
-- SELECT policy on it, so a plain "returning *" as anon would itself be
-- blocked by RLS (RETURNING acts like a SELECT of the new row). Running as
-- the function owner — who owns the table and so bypasses its RLS — lets
-- this one narrow, parameter-controlled insert hand back the new row
-- (with its request_code) without opening general read access to anon.
-- Dropped and recreated (rather than create-or-replace) each time the
-- parameter list changes — Postgres treats a different argument list as a
-- different function, and this avoids leaving old overloads behind.
-- v2.0: (name, department, comment)
-- v2.1: (name, department, comment, sku_id, qty) — one item + a comment
-- v2.2: (name, department, comment, items jsonb) — a *list* of items (each
-- {"sku_id": "...", "qty": n}) plus a comment. One row is inserted per item,
-- all sharing one request_code — the requests table already allowed
-- sku_id/qty_requested to be null (the comment-only case), so no table
-- change was needed, only this function. Each item still moves through
-- pending -> preparing -> ready -> fulfilled independently, which matches
-- how a warehouse actually picks a multi-item order: one line at a time,
-- not all-or-nothing.
-- v2.3: (name, department, comment, work_area, items jsonb) — adds the
-- required "what area/job is this for" line the printed slip always
-- carries (see the work_area column above and request.html's print
-- layout), copied onto every row the same way the comment already is.
-- v2.4 (current): adds p_building — the coarser, dropdown-picked
-- counterpart to work_area (see "1e. Buildings" above), feeding
-- building_report. Optional: unlike work_area, a missing building doesn't
-- block submission.
drop function if exists create_public_request(text, text, text);
drop function if exists create_public_request(text, text, text, uuid, numeric);
drop function if exists create_public_request(text, text, text, jsonb);
drop function if exists create_public_request(text, text, text, text, jsonb);

create or replace function create_public_request(
  p_requester_name text, p_department text, p_comment text, p_work_area text,
  p_items jsonb default null, p_building text default null
) returns setof requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_row requests;
  v_item jsonb;
  v_sku_id uuid;
  v_qty numeric;
  v_sku_ok boolean;
  v_item_count int;
  v_notes text;
  v_work_area text;
  v_building text;
begin
  if coalesce(trim(p_requester_name), '') = '' then
    raise exception 'Requester name is required';
  end if;

  v_work_area := nullif(trim(p_work_area), '');
  if v_work_area is null then
    raise exception 'Please describe the area or job this is for';
  end if;

  v_building := nullif(trim(p_building), '');

  v_item_count := coalesce(jsonb_array_length(p_items), 0);
  v_notes := nullif(trim(p_comment), '');

  if v_item_count = 0 and v_notes is null then
    raise exception 'Please select at least one item or describe what you need';
  end if;

  -- Validate every item up front, so a bad item anywhere in the list fails
  -- the whole submission before any row is written (no partial requests).
  if v_item_count > 0 then
    for v_item in select * from jsonb_array_elements(p_items) loop
      if v_item->>'sku_id' is null or v_item->>'qty' is null then
        raise exception 'Please enter a quantity for each selected item';
      end if;
      v_sku_id := (v_item->>'sku_id')::uuid;
      v_qty := (v_item->>'qty')::numeric;
      select exists(select 1 from skus where id = v_sku_id and is_active = true) into v_sku_ok;
      if not v_sku_ok then
        raise exception 'Selected item is not available';
      end if;
      if v_qty <= 0 then
        raise exception 'Please enter a quantity for each selected item';
      end if;
    end loop;
  end if;

  v_code := next_request_code();

  if v_item_count = 0 then
    -- comment-only request: a single row, same as before v2.2
    insert into requests (request_code, requester_name, department, notes, work_area, building)
    values (v_code, trim(p_requester_name), nullif(trim(p_department), ''), v_notes, v_work_area, v_building)
    returning * into v_row;
    return next v_row;
  else
    -- one row per item, all sharing v_code; the comment, work_area, and
    -- building (if any) are copied onto every row so they're visible
    -- regardless of which item card staff happen to be looking at.
    for v_item in select * from jsonb_array_elements(p_items) loop
      v_sku_id := (v_item->>'sku_id')::uuid;
      v_qty := (v_item->>'qty')::numeric;
      insert into requests (request_code, requester_name, department, sku_id, qty_requested, notes, work_area, building)
      values (v_code, trim(p_requester_name), nullif(trim(p_department), ''), v_sku_id, v_qty, v_notes, v_work_area, v_building)
      returning * into v_row;
      return next v_row;
    end loop;
  end if;

  return;
end;
$$;

-- Authenticated request creation — the Requester role's own "new request"
-- flow, and also what Staff/Admin's internal "+ New" now calls (one path
-- instead of the old raw insert duplicating this). A Requester's own
-- identity is never overridable — always their own profile, regardless of
-- what's sent. Staff/Admin creating this on someone else's behalf (a
-- walk-in who called it in) may still name who it's actually for via
-- p_requester_name/p_department, same as the old raw-insert flow let
-- them — in that case requester_user_id is left null, since the request
-- doesn't actually belong to a logged-in Requester account. security
-- definer for the same reason as create_public_request() above — a plain
-- insert would need requests INSERT granted to requester-role callers,
-- which section 8's RLS deliberately doesn't do (they only get to SELECT
-- their own rows); running as the function owner lets this one narrow,
-- parameter-controlled insert through without widening that policy.
--
-- v2: p_sku_id/p_qty/p_notes -> p_items jsonb (a *list* of items, each
-- {"sku_id": "...", "qty": n}) + p_comment — same "multiple items plus a
-- shared comment" shape as create_public_request() above, and reuses its
-- exact validation loop and per-item insert pattern (one row per item, all
-- sharing one request_code; a comment-only submission with no items still
-- writes a single row). Deliberately does NOT check current stock
-- quantity/availability anywhere — same as before, and same as
-- create_public_request(): a request never reserves or blocks on stock on
-- hand, a human decides feasibility at fulfillment time.
-- v3: adds p_building, same as create_public_request() above.
-- v4 (current): adds p_work_area, same as create_public_request() above —
-- the authenticated "New Request" flow gets the same Work Area dropdown as
-- the public form (js/app.js openNewRequestSheet()).
drop function if exists create_authenticated_request(uuid, numeric, date, text, text, text);
drop function if exists create_authenticated_request(jsonb, text, date, text, text);
drop function if exists create_authenticated_request(jsonb, text, date, text, text, text);

create or replace function create_authenticated_request(
  p_items jsonb default null, p_comment text default null, p_needed_by date default null,
  p_requester_name text default null, p_department text default null, p_building text default null,
  p_work_area text default null
) returns setof requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile user_profiles;
  v_code text;
  v_row requests;
  v_item jsonb;
  v_sku_id uuid;
  v_qty numeric;
  v_sku_ok boolean;
  v_item_count int;
  v_notes text;
  v_name text;
  v_dept text;
  v_requester_user_id uuid;
  v_building text;
  v_work_area text;
begin
  v_building := nullif(trim(p_building), '');
  v_work_area := nullif(trim(p_work_area), '');
  select * into v_profile from user_profiles where id = auth.uid();
  if not found then
    raise exception 'No profile found for this account';
  end if;

  v_item_count := coalesce(jsonb_array_length(p_items), 0);
  v_notes := nullif(trim(p_comment), '');

  if v_item_count = 0 and v_notes is null then
    raise exception 'Please select at least one item or add a comment';
  end if;

  if v_item_count > 0 then
    for v_item in select * from jsonb_array_elements(p_items) loop
      if v_item->>'sku_id' is null or v_item->>'qty' is null then
        raise exception 'Please enter a quantity for each selected item';
      end if;
      v_sku_id := (v_item->>'sku_id')::uuid;
      v_qty := (v_item->>'qty')::numeric;
      if v_qty <= 0 then
        raise exception 'Please enter a quantity for each selected item';
      end if;
      select exists(select 1 from skus where id = v_sku_id and is_active = true) into v_sku_ok;
      if not v_sku_ok then
        raise exception 'Selected item is not available';
      end if;
    end loop;
  end if;

  if v_profile.role in ('staff','admin') and nullif(trim(p_requester_name), '') is not null then
    v_name := trim(p_requester_name);
    v_dept := nullif(trim(p_department), '');
    v_requester_user_id := null;
  else
    v_name := v_profile.name;
    v_dept := v_profile.department;
    v_requester_user_id := auth.uid();
  end if;

  v_code := next_request_code();

  if v_item_count = 0 then
    insert into requests (request_code, requester_name, department, notes, needed_by, requester_user_id, building, work_area)
    values (v_code, v_name, v_dept, v_notes, p_needed_by, v_requester_user_id, v_building, v_work_area)
    returning * into v_row;
    return next v_row;
  else
    for v_item in select * from jsonb_array_elements(p_items) loop
      v_sku_id := (v_item->>'sku_id')::uuid;
      v_qty := (v_item->>'qty')::numeric;
      insert into requests (request_code, requester_name, department, sku_id, qty_requested, needed_by, notes, requester_user_id, building, work_area)
      values (v_code, v_name, v_dept, v_sku_id, v_qty, p_needed_by, v_notes, v_requester_user_id, v_building, v_work_area)
      returning * into v_row;
      return next v_row;
    end loop;
  end if;

  return;
end;
$$;

-- Moving a request through pending -> preparing -> ready -> fulfilled (or
-- cancelled). Replaces a raw client-side `update requests set status=...`
-- (see DB.setRequestStatus in js/db.js) so approved_by can't be spoofed —
-- it's always auth.uid(), never a parameter the client could hand in. Not
-- security definer: runs as the caller, so section 8's RLS naturally
-- blocks a requester-role account from calling this on anyone's request
-- (including their own) — only staff/admin can actually move a status.
create or replace function set_request_status(p_request_id uuid, p_status text) returns requests
language plpgsql
as $$
declare
  v_row requests;
begin
  if p_status not in ('pending','preparing','ready','fulfilled','cancelled') then
    raise exception 'Invalid status';
  end if;

  update requests set status = p_status, approved_by = auth.uid()
  where id = p_request_id
  returning * into v_row;

  if not found then
    raise exception 'Request not found, or you do not have permission to update it';
  end if;

  return v_row;
end;
$$;

-- Closing out a request line without delivering it — the "cannot deliver"
-- path in the fulfill-by-request-code scan flow (js/app.js), for an item
-- that's out of stock or otherwise can't be handed over right now. Unlike
-- issue_stock() this never touches skus.qty_on_hand and never writes a
-- transactions row — nothing physically moved, so there's nothing to log
-- as a stock movement. It still closes the line out as 'fulfilled' rather
-- than leaving it open indefinitely (see the conversation this came out
-- of: a real "not delivered" outcome shouldn't stay stuck in the open
-- queue forever, and 'cancelled' would misleadingly read as "never
-- processed" when staff actually looked at it and couldn't fulfill it).
-- p_note is mandatory — this function exists specifically to make sure a
-- reason is always on record, not optional the way requester-side notes
-- are. Same non-security-definer reasoning as set_request_status above:
-- runs as the caller, so RLS alone restricts this to staff/admin.
create or replace function decline_request_item(p_request_id uuid, p_note text) returns requests
language plpgsql
as $$
declare
  v_row requests;
begin
  if nullif(trim(p_note), '') is null then
    raise exception 'Please enter a reason';
  end if;

  update requests set status = 'fulfilled', staff_note = trim(p_note)
  where id = p_request_id
  returning * into v_row;

  if not found then
    raise exception 'Request not found, or you do not have permission to update it';
  end if;

  return v_row;
end;
$$;

-- find_auth_user_id() used to be Manage Staff's way of turning "an email an
-- admin already created by hand in the Supabase dashboard" into a uuid to
-- attach a profile to. It's gone: Manage Staff now creates the login
-- itself (see supabase/functions/create-staff-login), which does its own
-- equivalent lookup server-side with the service_role key when the email
-- already has a login — strictly more capable, since it doesn't require
-- the admin to already know a match exists. Dropped rather than left
-- unused, since it's a security definer function able to look up any
-- email in auth.users.
drop function if exists find_auth_user_id(text);

-- Used throughout section 8's policies below: true when the caller has a
-- staff or admin profile. Requester accounts are expected to be a much
-- larger, less-vetted population than staff/admin (anyone across the
-- university who requests materials, not just the warehouse team), so
-- unlike the staff-vs-admin split (deliberately UI-only for now — see
-- Manage Items/Reports), requester-vs-everyone-else is enforced here too:
-- without this, a requester account could write directly to stock/catalog
-- tables through the API even though the app's UI never shows them those
-- screens.
--
-- security definer here is load-bearing, not incidental: this function's
-- own query reads user_profiles, which is itself RLS-protected. Without
-- security definer, that read would run as the calling role and re-trigger
-- user_profiles' own SELECT policies (below) to decide what it can see —
-- and is_admin() (used by one of those policies) would call right back
-- into this same evaluation, which Postgres can't resolve and fails with
-- "infinite recursion detected in policy for relation" (surfaced to the
-- client as a bare 500). Running as the function owner — who owns the
-- table and so bypasses its RLS entirely, same reasoning as
-- create_public_request()'s security definer above — reads the row
-- directly with no policy evaluation at all, breaking the cycle.
create or replace function is_staff_or_admin() returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from user_profiles where id = auth.uid() and role in ('staff','admin'));
$$;

-- Same reasoning as is_staff_or_admin() above, and used the same way by
-- user_profiles' own "admin can ..." policies below — this is the specific
-- function whose non-security-definer version was the actual source of the
-- infinite-recursion error, since (unlike is_staff_or_admin(), only ever
-- used on *other* tables) it's what user_profiles' own policies use to
-- check the caller against user_profiles itself.
create or replace function is_admin() returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from user_profiles where id = auth.uid() and role = 'admin');
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default — revoking
-- from just "anon" is not enough to lock an admin-only function down, since
-- PUBLIC still covers it. Revoke PUBLIC explicitly, then grant only to the
-- roles that should actually have it.
revoke execute on function insert_transaction_images(uuid, text[]) from public;
revoke execute on function insert_sku_images(uuid, text[]) from public;
revoke execute on function receive_stock(uuid, numeric, text, text, text, text[]) from public;
revoke execute on function return_stock(uuid, numeric, text, text, text, text[], uuid, text[]) from public;
revoke execute on function issue_stock(uuid, uuid, numeric, text, text[], text, text[]) from public;
revoke execute on function create_sku(text, text, text, text, numeric, numeric, text[]) from public;
revoke execute on function create_item_units(uuid, int, uuid) from public;
revoke execute on function create_public_request(text, text, text, text, jsonb, text) from public;
revoke execute on function next_request_code() from public;
revoke execute on function create_authenticated_request(jsonb, text, date, text, text, text, text) from public;
revoke execute on function set_request_status(uuid, text) from public;
revoke execute on function decline_request_item(uuid, text) from public;
revoke execute on function is_staff_or_admin() from public;
revoke execute on function is_admin() from public;

grant execute on function insert_transaction_images(uuid, text[]) to authenticated;
grant execute on function insert_sku_images(uuid, text[]) to authenticated;
grant execute on function receive_stock(uuid, numeric, text, text, text, text[]) to authenticated;
grant execute on function return_stock(uuid, numeric, text, text, text, text[], uuid, text[]) to authenticated;
grant execute on function issue_stock(uuid, uuid, numeric, text, text[], text, text[]) to authenticated;
grant execute on function create_sku(text, text, text, text, numeric, numeric, text[]) to authenticated;
grant execute on function create_item_units(uuid, int, uuid) to authenticated;
grant execute on function create_public_request(text, text, text, text, jsonb, text) to anon, authenticated;
grant execute on function next_request_code() to authenticated;
grant execute on function create_authenticated_request(jsonb, text, date, text, text, text, text) to authenticated;
grant execute on function set_request_status(uuid, text) to authenticated;
grant execute on function decline_request_item(uuid, text) to authenticated;
-- Called from inside policy expressions (section 8), evaluated as the
-- querying role — authenticated needs EXECUTE for those policies to work.
grant execute on function is_staff_or_admin() to authenticated;
grant execute on function is_admin() to authenticated;

-- ----------------------------------------------------------------------------
-- 8. Row Level Security
--
-- v2: the requester form is genuinely public (no login), so from here on
-- "anon" means an anonymous member of the public, not trusted staff. Most
-- tables drop anon access entirely and are readable/writable only by
-- "authenticated" — i.e. someone who has signed in through the admin login
-- screen (see js/db.js Auth.signIn / README). Two tables carve out a narrow
-- exception for the public form: skus lets anon SELECT active items only
-- (read-only, so the form's item search works, but no insert/update/delete
-- and no visibility into deactivated items); requests lets anon INSERT
-- (submit a request — always through create_public_request(), never a raw
-- insert with attacker-chosen fields), but only authenticated can
-- SELECT/UPDATE/DELETE, so the public can't browse, search, or edit anyone
-- else's requests. request_sequences is the one sequence table anon still
-- needs, since create_public_request() has to bump it.
-- ----------------------------------------------------------------------------
alter table skus enable row level security;
alter table lots enable row level security;
alter table requests enable row level security;
alter table transactions enable row level security;
alter table discrepancies enable row level security;
alter table lot_sequences enable row level security;
alter table sku_sequences enable row level security;
alter table categories enable row level security;
alter table departments enable row level security;
alter table transaction_images enable row level security;
alter table sku_images enable row level security;
alter table buildings enable row level security;
alter table work_areas enable row level security;
alter table request_sequences enable row level security;
alter table user_profiles enable row level security;
alter table item_units enable row level security;
alter table sku_unit_sequences enable row level security;

-- user_profiles: everyone can read their own row (needed right after login
-- just to know "who am I / what's my role" — see DB.getMyProfile() in
-- js/db.js); admin-role callers can additionally read every row (for the
-- Manage Staff screen) and are the only ones who can create/edit/deactivate
-- one. Every check below looks up the CALLER's own role from this same
-- table by auth.uid() — never anything client-supplied — so a
-- staff/requester account can't grant itself admin by sending a different
-- role in a request body.
drop policy if exists "self can view own profile" on user_profiles;
create policy "self can view own profile" on user_profiles for select to authenticated
  using (id = auth.uid());

drop policy if exists "admin can view all profiles" on user_profiles;
create policy "admin can view all profiles" on user_profiles for select to authenticated
  using (is_admin());

drop policy if exists "admin can insert profiles" on user_profiles;
create policy "admin can insert profiles" on user_profiles for insert to authenticated
  with check (is_admin());

drop policy if exists "admin can update profiles" on user_profiles;
create policy "admin can update profiles" on user_profiles for update to authenticated
  using (is_admin())
  with check (is_admin());

drop policy if exists "admin can delete profiles" on user_profiles;
create policy "admin can delete profiles" on user_profiles for delete to authenticated
  using (is_admin());

-- skus: SELECT stays open to every authenticated role, including
-- requester — they need to search the catalog for their own new-request
-- item picker, same list Stock/Receive already use (DB.listSkus in
-- js/db.js). Writes (insert/update/delete — Manage Items) are staff/admin
-- only via is_staff_or_admin() above; Staff vs Admin itself stays UI-only
-- (Manage Items is hidden from Staff in app.js, not RLS), but a requester
-- account genuinely can't write here even by calling the API directly.
drop policy if exists "anon full access - skus" on skus;
drop policy if exists "authenticated full access - skus" on skus;
drop policy if exists "anon can view active skus" on skus;
drop policy if exists "authenticated can view skus" on skus;
drop policy if exists "staff and admin can insert skus" on skus;
drop policy if exists "staff and admin can update skus" on skus;
drop policy if exists "staff and admin can delete skus" on skus;
create policy "authenticated can view skus" on skus for select to authenticated using (true);
create policy "staff and admin can insert skus" on skus for insert to authenticated with check (is_staff_or_admin());
create policy "staff and admin can update skus" on skus for update to authenticated using (is_staff_or_admin()) with check (is_staff_or_admin());
create policy "staff and admin can delete skus" on skus for delete to authenticated using (is_staff_or_admin());
-- The public request form lets a requester search the catalog and pick an
-- item, so anon needs read access here too — but only to active items, and
-- only SELECT (no insert/update/delete), same "narrow surface" principle as
-- create_public_request() above.
create policy "anon can view active skus" on skus for select to anon using (is_active = true);

-- sku_images: same shape as skus' own split above — anyone signed in can
-- read (the catalog search everyone shares), anon can read only for active
-- items, writes are staff/admin only. No UPDATE policy: the app always
-- replaces an item's photo set by deleting then re-inserting rows
-- (DB.setSkuImages in js/db.js), never updating one in place.
drop policy if exists "authenticated can view sku_images" on sku_images;
drop policy if exists "anon can view images for active skus" on sku_images;
drop policy if exists "staff and admin can insert sku_images" on sku_images;
drop policy if exists "staff and admin can delete sku_images" on sku_images;
create policy "authenticated can view sku_images" on sku_images for select to authenticated using (true);
create policy "anon can view images for active skus" on sku_images for select to anon
  using (exists (select 1 from skus s where s.id = sku_images.sku_id and s.is_active = true));
create policy "staff and admin can insert sku_images" on sku_images for insert to authenticated with check (is_staff_or_admin());
create policy "staff and admin can delete sku_images" on sku_images for delete to authenticated using (is_staff_or_admin());

-- categories: staff/admin only (Manage Items' category dropdown) — nothing
-- a requester does ever reads this table directly; their item search reads
-- skus.category as a plain text column, not a join.
drop policy if exists "anon full access - categories" on categories;
drop policy if exists "authenticated full access - categories" on categories;
drop policy if exists "staff and admin full access - categories" on categories;
create policy "staff and admin full access - categories" on categories for all to authenticated
  using (is_staff_or_admin()) with check (is_staff_or_admin());

-- departments: staff/admin get full access (Manage Staff's department
-- dropdown — including update/delete, which the public form never needs).
-- anon/authenticated also get view+add below: the public request form's
-- own department field used to be free-text, so anon could already submit
-- any department name unmoderated — a shared dropdown is a data-quality
-- upgrade, not a new exposure, same reasoning as buildings just below.
drop policy if exists "staff and admin full access - departments" on departments;
create policy "staff and admin full access - departments" on departments for all to authenticated
  using (is_staff_or_admin()) with check (is_staff_or_admin());
drop policy if exists "anyone can view departments" on departments;
drop policy if exists "anyone can add departments" on departments;
create policy "anyone can view departments" on departments for select to anon, authenticated using (true);
create policy "anyone can add departments" on departments for insert to anon, authenticated with check (true);

-- buildings: deliberately open, unlike departments above — a building name
-- is no more sensitive than the free-text work_area anyone can already
-- type unmoderated on the public request form, and anon needs to both read
-- (populate the dropdown) and add (a requester in a building not yet
-- listed shouldn't be blocked). No update/delete policy: the app never
-- edits or removes a building once added, same as categories.
drop policy if exists "anyone can view buildings" on buildings;
drop policy if exists "anyone can add buildings" on buildings;
create policy "anyone can view buildings" on buildings for select to anon, authenticated using (true);
create policy "anyone can add buildings" on buildings for insert to anon, authenticated with check (true);

-- work_areas: deliberately open, same reasoning as buildings just above.
drop policy if exists "anyone can view work areas" on work_areas;
drop policy if exists "anyone can add work areas" on work_areas;
create policy "anyone can view work areas" on work_areas for select to anon, authenticated using (true);
create policy "anyone can add work areas" on work_areas for insert to anon, authenticated with check (true);

-- transaction_images: evidence photos, written only by
-- insert_transaction_images() (called from receive_stock/return_stock/
-- issue_stock) — same staff/admin boundary as transactions itself.
drop policy if exists "staff and admin full access - transaction_images" on transaction_images;
create policy "staff and admin full access - transaction_images" on transaction_images for all to authenticated
  using (is_staff_or_admin()) with check (is_staff_or_admin());

-- transaction-evidence Storage bucket: the actual image files. storage.objects
-- is Supabase's own table (not one of ours) but takes RLS policies the same
-- way — scoped to this one bucket_id so it can't affect any other bucket
-- this project might add later, reusing the same is_staff_or_admin() check
-- as transaction_images above.
drop policy if exists "staff and admin can manage evidence" on storage.objects;
create policy "staff and admin can manage evidence" on storage.objects for all to authenticated
  using (bucket_id = 'transaction-evidence' and is_staff_or_admin())
  with check (bucket_id = 'transaction-evidence' and is_staff_or_admin());

-- item-photos: public bucket (reads need no policy — see the bucket
-- comment above), but INSERT/UPDATE/DELETE still need the same
-- staff/admin gate as everything else in Manage Items.
drop policy if exists "staff and admin can manage item photos" on storage.objects;
create policy "staff and admin can manage item photos" on storage.objects for all to authenticated
  using (bucket_id = 'item-photos' and is_staff_or_admin())
  with check (bucket_id = 'item-photos' and is_staff_or_admin());

-- lots: legacy (see "2. Lots" above) — nothing writes here anymore for any
-- role, kept staff/admin-only same as before, just via the shared helper.
drop policy if exists "anon full access - lots" on lots;
drop policy if exists "authenticated full access - lots" on lots;
drop policy if exists "staff and admin full access - lots" on lots;
create policy "staff and admin full access - lots" on lots for all to authenticated
  using (is_staff_or_admin()) with check (is_staff_or_admin());

drop policy if exists "anon full access - requests" on requests;
drop policy if exists "anyone can submit requests" on requests;
drop policy if exists "authenticated full access - requests" on requests;
drop policy if exists "staff and admin full access - requests" on requests;
drop policy if exists "requester can view own requests" on requests;
-- Both request-creation paths — create_public_request() for anon,
-- create_authenticated_request() for a logged-in Requester (section 7) —
-- are security definer and so bypass RLS entirely for their own inserts.
-- Deliberately no direct INSERT policy here for anon or requester-role: that
-- closes off raw-inserting a request under a fabricated name/department
-- instead of going through the RPC that pulls those from the caller's own
-- profile. Staff/admin get full access; a requester-role account can only
-- ever see the rows it submitted itself.
create policy "staff and admin full access - requests" on requests for all to authenticated
  using (is_staff_or_admin()) with check (is_staff_or_admin());
create policy "requester can view own requests" on requests for select to authenticated
  using (requester_user_id = auth.uid());

-- transactions/discrepancies/lot_sequences/sku_sequences: staff/admin only
-- — a requester never receives, issues, returns, or reads movement
-- history/discrepancy reports.
drop policy if exists "anon full access - transactions" on transactions;
drop policy if exists "authenticated full access - transactions" on transactions;
drop policy if exists "staff and admin full access - transactions" on transactions;
create policy "staff and admin full access - transactions" on transactions for all to authenticated
  using (is_staff_or_admin()) with check (is_staff_or_admin());

drop policy if exists "anon full access - discrepancies" on discrepancies;
drop policy if exists "authenticated full access - discrepancies" on discrepancies;
drop policy if exists "staff and admin full access - discrepancies" on discrepancies;
create policy "staff and admin full access - discrepancies" on discrepancies for all to authenticated
  using (is_staff_or_admin()) with check (is_staff_or_admin());

drop policy if exists "anon full access - lot_sequences" on lot_sequences;
drop policy if exists "authenticated full access - lot_sequences" on lot_sequences;
drop policy if exists "staff and admin full access - lot_sequences" on lot_sequences;
create policy "staff and admin full access - lot_sequences" on lot_sequences for all to authenticated
  using (is_staff_or_admin()) with check (is_staff_or_admin());

drop policy if exists "anon full access - sku_sequences" on sku_sequences;
drop policy if exists "authenticated full access - sku_sequences" on sku_sequences;
drop policy if exists "staff and admin full access - sku_sequences" on sku_sequences;
create policy "staff and admin full access - sku_sequences" on sku_sequences for all to authenticated
  using (is_staff_or_admin()) with check (is_staff_or_admin());

-- item_units/sku_unit_sequences: same staff/admin-only boundary as
-- transactions/lot_sequences above — a requester never scans or sees units.
drop policy if exists "staff and admin full access - item_units" on item_units;
create policy "staff and admin full access - item_units" on item_units for all to authenticated
  using (is_staff_or_admin()) with check (is_staff_or_admin());

drop policy if exists "staff and admin full access - sku_unit_sequences" on sku_unit_sequences;
create policy "staff and admin full access - sku_unit_sequences" on sku_unit_sequences for all to authenticated
  using (is_staff_or_admin()) with check (is_staff_or_admin());

-- request_sequences: unchanged — both anon (create_public_request) and
-- authenticated (create_authenticated_request) bump this, and both do so
-- only from inside a security-definer function anyway, so this policy is
-- what lets next_request_code() itself succeed when NOT called from
-- within one of those (it isn't, currently, but kept permissive here
-- rather than tightened, since the counter has no sensitive data to leak).
drop policy if exists "anyone can bump request_sequences" on request_sequences;
create policy "anyone can bump request_sequences" on request_sequences for all to anon, authenticated using (true) with check (true);

-- ----------------------------------------------------------------------------
-- 9. Seed data — a handful of construction-material SKUs so the app has
--    something real to show the moment it's wired up. Delete freely.
-- ----------------------------------------------------------------------------
insert into skus (sku_code, name, category, base_uom, alt_uom, conversion_factor, min_threshold) values
  ('CEM-001', 'Portland Cement 50kg', 'Cement', 'bag', 'pallet', 50, 100),
  ('REB-012', 'Rebar 12mm x 6m', 'Steel', 'piece', 'bundle', 20, 200),
  ('SND-001', 'Fine Sand', 'Aggregate', 'cu.m', null, null, 20),
  ('PIP-004', 'PVC Pipe 4in x 4m', 'Pipe & Fittings', 'piece', null, null, 50),
  ('NAI-002', 'Common Nails 3in', 'Hardware', 'kg', 'box', 25, 30)
on conflict (sku_code) do nothing;
