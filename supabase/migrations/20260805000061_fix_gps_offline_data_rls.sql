-- Migration: Fix gps_offline_data_service_policy RLS scope (#9876)
-- 20260805000060_create_gps_offline_data.sql created
-- gps_offline_data_service_policy with no TO <role> clause, so it applied to
-- PUBLIC: any client that reaches PostgREST (at least every authenticated
-- user) could SELECT/UPDATE/DELETE every other user's offline GPS payloads.
-- RLS policies are OR'd, so this allow-all policy silently defeated the
-- owner-scoped gps_offline_data_owner policy from
-- 20260804100500_create_gps_offline_data.sql and
-- 20260804232103_secure_gps_offline_data_rls.sql. Drop it and re-assert the
-- owner-scoped policy as the only row-level path. The WebRTC service persists
-- the backlog through the service-role key (which bypasses RLS), so it needs
-- no explicit policy.

DROP POLICY IF EXISTS gps_offline_data_service_policy ON gps_offline_data;

DROP POLICY IF EXISTS gps_offline_data_owner ON gps_offline_data;
CREATE POLICY gps_offline_data_owner
  ON gps_offline_data
  FOR ALL
  TO authenticated
  USING ("peerId" = get_profile_id()::text)
  WITH CHECK ("peerId" = get_profile_id()::text);
