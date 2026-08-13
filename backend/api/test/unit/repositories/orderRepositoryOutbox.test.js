import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSupabaseMock } from '../../helpers/supabaseMock.js';

// updateOrder's atomic path resolves the service-role client from db.js
// (supabaseAdmin). Mirror the outboxService.test.js mock pattern so the
// repository test never touches the real clients.
const mocks = createSupabaseMock();

vi.mock('../../../src/config/db.js', () => ({
  supabaseAdmin: mocks.supabase,
}));

const { OrderRepository } = await import('../../../src/repositories/orderRepository.js');

describe('OrderRepository.updateOrder atomic outbox write', () => {
  beforeEach(() => {
    mocks.reset();
  });

  it('routes an eventType update through update_order_with_outbox_tx in a single RPC', async () => {
    const updatedOrder = { id: 'order-1', order_display_id: '#FF1', status: 'active' };
    mocks.programData([updatedOrder]);

    const orderRepository = new OrderRepository(mocks.supabase);
    const result = await orderRepository.updateOrder('order-1', { status: 'active' }, 'order.status_changed');

    const rpcCall = mocks.calls.find((c) => c.rpc === 'update_order_with_outbox_tx');
    expect(rpcCall).toBeTruthy();
    expect(rpcCall.args).toEqual({
      p_order_id: 'order-1',
      p_updates: { status: 'active' },
      p_event_type: 'order.status_changed',
    });
    expect(result.error).toBeNull();
    expect(result.data).toEqual(updatedOrder);
  });

  it('surfaces the transaction failure instead of writing the event best-effort', async () => {
    mocks.programRpcError('update failed');

    const orderRepository = new OrderRepository(mocks.supabase);
    const result = await orderRepository.updateOrder('order-1', { status: 'active' }, 'order.status_changed');

    expect(result.error).toEqual({ message: 'update failed' });
    expect(result.data).toBeNull();
  });

  it('keeps the plain PostgREST path when no eventType is supplied', async () => {
    mocks.store.orders = [{ id: 'order-1', status: 'pending' }];

    const orderRepository = new OrderRepository(mocks.supabase);
    const result = await orderRepository.updateOrder('order-1', { status: 'active' });

    expect(mocks.calls.find((c) => c.rpc === 'update_order_with_outbox_tx')).toBeUndefined();
    expect(result.error).toBeNull();
    expect(result.data.status).toBe('active');
  });
});
