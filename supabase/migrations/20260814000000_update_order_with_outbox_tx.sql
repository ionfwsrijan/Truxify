-- =============================================================================
-- Migration: update_order_with_outbox_tx — atomic order update + outbox event
-- (Issue #11215: outbox writeEvent was NOT atomic with the order mutation)
-- =============================================================================
-- Problem:
--   orderRepository.updateOrder() updated `orders` through PostgREST and then
--   inserted the `outbox_events` row through a SECOND PostgREST call
--   (outboxService.writeEvent). Two separate HTTP/DB round-trips = two
--   separate transactions. If the process crashed between them, the order was
--   mutated but no event was ever enqueued — read model, notifications,
--   timeline and fraud checks diverged permanently, with no outbox retry
--   because the event never existed.
--
-- Fix:
--   `update_order_with_outbox_tx` performs the order UPDATE and the
--   `outbox_events` INSERT in ONE atomic SQL function, mirroring the existing
--   SECURITY DEFINER transaction pattern (cancel_stale_order_tx /
--   complete_trip_tx). Both writes commit or roll back together, so the event
--   can never be missing once the order change is durable. The `orders`
--   trigger `trg_orders_event_outbox` (the event_outbox pipeline) fires
--   inside the same transaction too.
--
--   SECURITY DEFINER bypasses RLS, so only the backend (service_role) may run
--   this — same grant model as cancel_stale_order_tx.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.update_order_with_outbox_tx(
  p_order_id   UUID,
  p_updates    JSONB,
  p_event_type TEXT
)
RETURNS SETOF orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_set   text;
  v_order orders%ROWTYPE;
  v_key   text;
BEGIN
  -- SECURITY DEFINER bypasses RLS, so only the backend (service_role) may run
  -- this. Matches the cancel_stale_order_tx guard.
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Only the backend service can update orders with an outbox event';
  END IF;

  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'object' THEN
    RAISE EXCEPTION 'p_updates must be a JSON object';
  END IF;

  -- Reject unknown keys up front so a typo can never be silently dropped
  -- (PostgREST would reject them too, but here we control the SET clause).
  FOR v_key IN SELECT jsonb_object_keys(p_updates) LOOP
    IF v_key <> 'id'
       AND NOT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = v_key
       ) THEN
      RAISE EXCEPTION 'Unknown order column in p_updates: %', v_key;
    END IF;
  END LOOP;

  -- Build the SET clause from the caller's JSON. jsonb scalars are rendered
  -- as quoted/typed literals via format(); JSON null becomes SQL NULL.
  SELECT string_agg(format('%I = %L', u.key, u.value #>> '{}'), ', ')
    INTO v_set
    FROM jsonb_each(p_updates) AS u(key, value)
   WHERE u.key <> 'id';

  IF v_set IS NULL OR v_set = '' THEN
    RAISE EXCEPTION 'No writable order columns provided in p_updates';
  END IF;

  EXECUTE 'UPDATE orders SET ' || v_set || ' WHERE id = $1 RETURNING *'
    INTO v_order
    USING p_order_id;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  -- Durable outbox event written in the SAME transaction as the mutation.
  IF p_event_type IS NOT NULL AND p_event_type <> '' THEN
    INSERT INTO outbox_events (
      aggregate_id,
      aggregate_type,
      event_type,
      payload,
      status,
      retry_count
    ) VALUES (
      COALESCE(v_order.order_display_id, p_order_id::text),
      'order',
      p_event_type,
      jsonb_build_object(
        'orderId', p_order_id,
        'orderDisplayId', v_order.order_display_id,
        'status', v_order.status,
        'updates', p_updates
      ),
      'pending',
      0
    );
  END IF;

  RETURN NEXT v_order;
END;
$$;

-- SECURITY DEFINER functions bypass RLS; default PUBLIC EXECUTE must be
-- revoked so only the backend (service_role) can update orders with outbox
-- events. Matches complete_trip_tx / cancel_stale_order_tx.
REVOKE EXECUTE ON FUNCTION public.update_order_with_outbox_tx(UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_with_outbox_tx(UUID, JSONB, TEXT) TO service_role;

COMMIT;
