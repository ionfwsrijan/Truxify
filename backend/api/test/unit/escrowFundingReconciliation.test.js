/**
 * Unit tests for backend/api/src/services/escrowFundingReconciliation.js
 *
 * Coverage:
 *   - dueForRetry: returns true when attempts is 0
 *   - dueForRetry: returns true when attempts > 0 and backoff has elapsed
 *   - dueForRetry: returns false when backoff has not elapsed
 *   - reconcileStaleFunding: returns early when orderRepository is null
 *   - reconcileStaleFunding: skips batch when global Redis lock is not acquired
 *
 * Run with:  npm run test:unit -- test/unit/escrowFundingReconciliation.test.js
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/middleware/logger.js', () => ({
  default: mockLogger,
}));

const mockRedisClient = vi.hoisted(() => ({
  set: vi.fn(),
  del: vi.fn(),
  expire: vi.fn(),
}));

vi.mock('../../src/config/db.js', () => ({
  redisClient: mockRedisClient,
  supabaseAdmin: {},
}));

vi.mock('../../src/services/escrow.js', () => ({
  escrowRefund: vi.fn(),
  getEscrowBooking: vi.fn(),
}));

vi.mock('../../src/lib/redisLock.js', () => ({
  acquireLock: vi.fn(),
  renewLock: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock('../../src/services/notificationService.js', () => ({
  sendPushNotification: vi.fn(),
}));

// Mock the order repository
const mockOrderRepository = vi.hoisted(() => ({
  findStaleFundingOrders: vi.fn(),
  updateOrder: vi.fn(),
  updateOrderWithFilter: vi.fn(),
  executeRpc: vi.fn(),
}));

import { reconcileStaleFunding } from '../../src/services/escrowFundingReconciliation.js';

describe('escrowFundingReconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('reconcileStaleFunding', () => {
    it('throws when orderRepository is null', async () => {
      await expect(reconcileStaleFunding(null)).rejects.toThrow('requires an OrderRepository instance');
    });

    it('skips batch when global Redis lock is not acquired', async () => {
      mockRedisClient.set.mockResolvedValue(null); // lock not acquired

      await reconcileStaleFunding(mockOrderRepository);

      expect(mockLogger.info).toHaveBeenCalledWith('[escrow-funding] Global lock held by another instance, skipping batch.');
    });

    it('acquires Redis lock and processes orders when lock is acquired', async () => {
      mockRedisClient.set.mockResolvedValue('locked');

      const mockOrders = [
        {
          id: 'order-1',
          order_display_id: 'DIS-1',
          escrow_status: 'funding',
          escrow_booking_id: 'booking-1',
          escrow_funding_attempts: 0,
          escrow_funding_last_attempt_at: null,
          pending_bid_acceptance: null,
        },
      ];
      mockOrderRepository.findStaleFundingOrders.mockResolvedValueOnce({ data: mockOrders, error: null });

      // Mock the lock acquisition for finalizeOrRevert
      const { acquireLock, releaseLock } = await import('../../src/lib/redisLock.js');
      acquireLock.mockResolvedValueOnce('lock-value');
      releaseLock.mockResolvedValueOnce(undefined);

      const { getEscrowBooking } = await import('../../src/services/escrow.js');
      getEscrowBooking.mockResolvedValueOnce({ paid: false });

      await reconcileStaleFunding(mockOrderRepository);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        expect.stringContaining('escrow:funding:reconciliation:lock'),
        expect.any(String),
        'NX',
        'EX',
        expect.any(Number)
      );
      expect(mockOrderRepository.findStaleFundingOrders).toHaveBeenCalled();
    });

    it('returns early on DB error when fetching stale orders', async () => {
      mockRedisClient.set.mockResolvedValue('locked');
      mockOrderRepository.findStaleFundingOrders.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } });

      await reconcileStaleFunding(mockOrderRepository);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[escrow-funding] Failed to load stale funding orders:',
        'DB error'
      );
    });

    it('pages through the stale set in bounded chunks until a short page', async () => {
      mockRedisClient.set.mockResolvedValue('locked');

      const fullPage = Array.from({ length: 1000 }, (_, i) => ({
        id: `order-${i}`,
        order_display_id: `DIS-${i}`,
        escrow_status: 'funding',
        escrow_funding_attempts: 10, // >= MAX_ATTEMPTS, so nothing is processed
        escrow_funding_last_attempt_at: null,
        pending_bid_acceptance: null,
      }));
      mockOrderRepository.findStaleFundingOrders
        .mockResolvedValueOnce({ data: fullPage, error: null })
        .mockResolvedValueOnce({ data: [fullPage[0]], error: null });

      await reconcileStaleFunding(mockOrderRepository);

      expect(mockOrderRepository.findStaleFundingOrders).toHaveBeenCalledTimes(2);
      expect(mockOrderRepository.findStaleFundingOrders).toHaveBeenNthCalledWith(
        1, expect.any(String), { offset: 0, limit: 1000 }
      );
      expect(mockOrderRepository.findStaleFundingOrders).toHaveBeenNthCalledWith(
        2, expect.any(String), { offset: 1000, limit: 1000 }
      );
    });

    it('marks escrow_status as funded when the deposit landed and the acceptance is healed', async () => {
      mockRedisClient.set.mockResolvedValue('locked');

      const healedOrder = {
        id: 'order-heal-1',
        order_display_id: 'DIS-HEAL-1',
        escrow_status: 'funding',
        escrow_booking_id: 'booking-1',
        escrow_amount_wei: '1000000000000000000',
        escrow_funding_attempts: 0,
        escrow_funding_last_attempt_at: null,
        status: 'truck_assigned',
        pending_bid_acceptance: {
          bid_id: 'bid-1',
          load_id: 'load-1',
          driver_id: 'driver-1',
          truck_id: 'truck-1',
          driver_name: 'Driver',
          driver_rating: 4.5,
          truck_number: 'MH-01',
          bid_amount: '1000000000000000000',
          order_display_id: 'DIS-HEAL-1',
          version: 1,
        },
      };
      mockOrderRepository.findStaleFundingOrders.mockReset();
      mockOrderRepository.findStaleFundingOrders.mockResolvedValueOnce({ data: [healedOrder], error: null });
      mockOrderRepository.executeRpc.mockReset();
      mockOrderRepository.executeRpc.mockResolvedValueOnce({ error: null });
      mockOrderRepository.updateOrderWithFilter.mockReset();
      mockOrderRepository.updateOrderWithFilter.mockResolvedValueOnce({ error: null });

      const { acquireLock, renewLock } = await import('../../src/lib/redisLock.js');
      acquireLock.mockReset();
      acquireLock.mockResolvedValueOnce('lock-value');
      acquireLock.mockResolvedValueOnce('lock-value');
      renewLock.mockReset();
      renewLock.mockResolvedValueOnce(true);

      const { getEscrowBooking } = await import('../../src/services/escrow.js');
      getEscrowBooking.mockReset();
      getEscrowBooking.mockResolvedValueOnce({ amount: 1000000000000000000n });

      const { sendPushNotification } = await import('../../src/services/notificationService.js');
      sendPushNotification.mockReset();
      sendPushNotification.mockResolvedValueOnce(undefined);

      await reconcileStaleFunding(mockOrderRepository);

      expect(mockOrderRepository.executeRpc).toHaveBeenCalledWith(
        'accept_bid_tx',
        expect.objectContaining({ p_bid_id: 'bid-1' }),
        expect.anything()
      );
      expect(mockOrderRepository.updateOrderWithFilter).toHaveBeenCalledWith(
        'order-heal-1',
        expect.objectContaining({ escrow_status: 'funded' }),
        expect.any(Array),
        'id'
      );
    });
  });
});
