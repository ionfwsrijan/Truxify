-- Migration: fix gps_offline_data_service_policy RLS scope
--
-- 20260805000060_create_gps_offline_data.sql originally created
-- gps_offline_data_service_policy with no TO <role> clause, so it applied to
-- PUBLIC (all roles, including unauthenticated/anon). Combined with the
-- owner-scoped policy from 20260804100500_create_gps_offline_data.sql, any
-- client that can reach PostgREST could SELECT/UPDATE/DELETE every driver's
-- offline GPS backlog, defeating the fix from #6244/#6249.
--
-- Restrict the policy to the service role explicitly. The WebRTC service
-- persists the backlog through the service-role admin client, so access
-- remains functional while row-level requests are locked down.

drop policy if exists gps_offline_data_service_policy on gps_offline_data;
create policy gps_offline_data_service_policy on gps_offline_data
  for all to service_role using (true) with check (true);
