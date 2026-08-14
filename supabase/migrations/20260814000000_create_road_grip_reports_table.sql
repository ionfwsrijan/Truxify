-- =============================================================================
-- Migration: create the road_grip_reports table
-- =============================================================================
-- Problem:
--   /api/road-conditions (backend/api/src/routes/roadConditionRoutes.js) and
--   its controllers (backend/api/src/controllers/roadConditionController.js)
--   insert into and select from a `road_grip_reports` table that no migration
--   or setup.sql ever creates. POST /api/road-conditions/grip and
--   GET /api/road-conditions/grip/nearby therefore failed on every fresh
--   database with PostgREST PGRST204 ("relation road_grip_reports does not
--   exist"), and both handlers always returned 500.
--
-- Fix:
--   Create road_grip_reports with the exact columns the controllers reference
--   (insert: latitude, longitude, grip_index, slip_events_count, user_id;
--   select: id, latitude, longitude, grip_index, slip_events_count,
--   recorded_at), plus an index on the geofence columns the nearby query
--   filters on. The controllers use the service_role supabaseAdmin client, so
--   RLS grants full access to service_role and denies anon/authenticated,
--   mirroring the wim_measurements/wim_bypass_credentials convention.
-- =============================================================================

begin;

create table if not exists road_grip_reports (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid,
  latitude           double precision not null,
  longitude          double precision not null,
  grip_index         double precision not null,
  slip_events_count  integer not null default 0,
  recorded_at        timestamptz not null default now()
);

create index if not exists idx_road_grip_reports_geofence
  on road_grip_reports (latitude, longitude);
create index if not exists idx_road_grip_reports_recorded_at
  on road_grip_reports (recorded_at desc);

-- The controllers query road_grip_reports exclusively via the service-role
-- supabaseAdmin client, so only service_role needs access.
alter table road_grip_reports enable row level security;

drop policy if exists "Service role full access on road_grip_reports"
  on road_grip_reports;
create policy "Service role full access on road_grip_reports"
  on road_grip_reports
  for all to service_role
  using (true)
  with check (true);

revoke all on table road_grip_reports from anon, authenticated;

commit;
