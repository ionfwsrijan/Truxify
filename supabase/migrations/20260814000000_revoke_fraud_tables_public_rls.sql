-- Migration: Revoke PUBLIC access on fraud table service policies (issue #9865)
-- 20260805000040_create_fraud_tables.sql created behavioral_profiles_service_policy,
-- fraud_risk_scores_service_policy and fraud_review_queue_service_policy without a
-- TO role clause, i.e. FOR ALL ... USING (true) WITH CHECK (true) TO PUBLIC. The
-- hardening migrations (20260805140000, 20260805174232) only dropped the
-- *_authenticated_all policies, so the PUBLIC policies survived and were OR'd with
-- the hardened policies, letting ANY authenticated user read/write every fraud row.
-- Service-role write access is already provided by the "Service role can write ..."
-- policies created in 20260805140000_harden_fraud_tables_rls.sql, so these are
-- dropped outright.

DROP POLICY IF EXISTS behavioral_profiles_service_policy ON public.behavioral_profiles;
DROP POLICY IF EXISTS fraud_risk_scores_service_policy ON public.fraud_risk_scores;
DROP POLICY IF EXISTS fraud_review_queue_service_policy ON public.fraud_review_queue;
