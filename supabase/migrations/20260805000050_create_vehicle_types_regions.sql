-- Migration: create vehicle_types and regions reference tables
-- Backs backend/api/src/routes/lookupRoutes.js which serves GET /vehicle-types
-- and GET /regions from `.from('vehicle_types').select('*')` and
-- `.from('regions').select('*')`. The base tables are created by
-- 20260804101000_create_lookup_tables.sql; this migration enriches them with
-- the columns the seed data and frontend/matching features expect.
-- The RLS policies below use the exact names asserted by
-- backend/api/test/unit/rlsSecurity.test.js.

-- ============ vehicle_types ============
-- Base schema (id, name, capacity_tonnes, created_at) comes from
-- 20260804101000_create_lookup_tables.sql, so enrich in place instead of a
-- no-op create table if not exists with a divergent schema.
alter table vehicle_types add column if not exists max_capacity_tons numeric(8,2);
alter table vehicle_types add column if not exists min_capacity_tons numeric(8,2);
alter table vehicle_types add column if not exists length_ft numeric(6,2);
alter table vehicle_types add column if not exists is_active boolean not null default true;
alter table vehicle_types add column if not exists sort_order int not null default 0;

create index if not exists idx_vehicle_types_active on vehicle_types (is_active, sort_order);

-- Seed with the same truck_type values the trucks table accepts.
insert into vehicle_types (name, is_active, sort_order)
select v.name, true, v.sort_order
from (values
  ('Open Body', 1),
  ('Closed Body', 2),
  ('Container', 3),
  ('Refrigerated', 4)
) as v(name, sort_order)
where not exists (select 1 from vehicle_types where vehicle_types.name = v.name);

-- ============ regions ============
-- Base schema (id, name, code, created_at) comes from
-- 20260804101000_create_lookup_tables.sql; add the geo/filter columns here.
alter table regions add column if not exists state text;
alter table regions add column if not exists country text not null default 'IN';
alter table regions add column if not exists latitude double precision;
alter table regions add column if not exists longitude double precision;
alter table regions add column if not exists radius_km double precision not null default 50;
alter table regions add column if not exists is_active boolean not null default true;

create index if not exists idx_regions_active on regions (is_active);

-- ============ RLS: anon + authenticated can read reference data ============
alter table vehicle_types enable row level security;
alter table regions enable row level security;

create policy "Anyone can view vehicle types"
  on vehicle_types for select
  to anon, authenticated
  using (is_active = true);

create policy "Anyone can view regions"
  on regions for select
  to anon, authenticated
  using (is_active = true);
