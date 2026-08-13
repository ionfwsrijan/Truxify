import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
const mockRedisGet = vi.fn();
const mockRedisSetex = vi.fn();

vi.mock('../../src/config/db.js', () => ({
  supabase: { from: mockFrom },
  supabaseAdmin: { from: mockFrom },
  redisClient: {
    get: mockRedisGet,
    setex: mockRedisSetex,
  },
}));

function chain(overrides = {}) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnThis(),
    count: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    ...overrides,
  };
}

describe('FraudDetectionService._flushPendingUpserts', () => {
  let FraudDetectionService;

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    FraudDetectionService = (await import('../../src/services/fraud/FraudDetectionService.js')).default;
    // Stop the background intervals so they don't flush/clear state mid-test.
    clearInterval(FraudDetectionService._flushInterval);
    clearInterval(FraudDetectionService._cleanupInterval);
  });

  async function trackOneUser(userId) {
    mockFrom.mockReturnValue(chain({
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    }));
    mockRedisGet.mockResolvedValue(null);
    return FraudDetectionService.trackBehavior(userId, {
      type: 'transaction',
      amount: 100,
      transactionType: 'pay',
    });
  }

  it('retains pending risk-score updates when the DB upsert fails', async () => {
    await trackOneUser('user-flush');
    expect(FraudDetectionService.pendingUpserts.size).toBe(1);

    mockFrom.mockReturnValue(chain({
      upsert: vi.fn().mockResolvedValue({ error: { message: 'db unavailable' } }),
    }));

    await FraudDetectionService._flushPendingUpserts();

    expect(FraudDetectionService.pendingUpserts.size).toBe(1);
    expect(FraudDetectionService.pendingUpserts.has('user-flush')).toBe(true);
  });

  it('retains pending risk-score updates when the DB upsert throws', async () => {
    await trackOneUser('user-throw');
    expect(FraudDetectionService.pendingUpserts.size).toBe(1);

    mockFrom.mockReturnValue(chain({
      upsert: vi.fn().mockRejectedValue(new Error('network down')),
    }));

    await FraudDetectionService._flushPendingUpserts();

    expect(FraudDetectionService.pendingUpserts.size).toBe(1);
    expect(FraudDetectionService.pendingUpserts.has('user-throw')).toBe(true);
  });

  it('clears pending updates only after a successful DB upsert', async () => {
    await trackOneUser('user-ok');
    expect(FraudDetectionService.pendingUpserts.size).toBe(1);

    mockFrom.mockReturnValue(chain({
      upsert: vi.fn().mockResolvedValue({ error: null }),
    }));

    await FraudDetectionService._flushPendingUpserts();

    expect(FraudDetectionService.pendingUpserts.size).toBe(0);
  });

  it('does not run overlapping flushes concurrently', async () => {
    await trackOneUser('user-slow');
    expect(FraudDetectionService.pendingUpserts.size).toBe(1);

    let resolveUpsert;
    const upsert = vi.fn().mockReturnValue(new Promise(resolve => { resolveUpsert = resolve; }));
    mockFrom.mockReturnValue(chain({ upsert }));

    const first = FraudDetectionService._flushPendingUpserts();
    const second = FraudDetectionService._flushPendingUpserts();

    // The second flush must bail out while the first is still in flight.
    expect(upsert).toHaveBeenCalledTimes(1);

    resolveUpsert({ error: null });
    await Promise.all([first, second]);

    expect(FraudDetectionService.pendingUpserts.size).toBe(0);
  });

  it('keeps a record replaced during an in-flight flush for the next batch', async () => {
    await trackOneUser('user-replaced');
    expect(FraudDetectionService.pendingUpserts.size).toBe(1);

    let resolveUpsert;
    const upsert = vi.fn().mockReturnValue(new Promise(resolve => { resolveUpsert = resolve; }));
    mockFrom.mockReturnValue(chain({ upsert }));

    const flush = FraudDetectionService._flushPendingUpserts();

    // A newer event for the same user replaces the queued record mid-flight.
    await trackOneUser('user-replaced');

    resolveUpsert({ error: null });
    await flush;

    // The stale snapshot was persisted, but the newer record must remain queued.
    expect(FraudDetectionService.pendingUpserts.size).toBe(1);
    expect(FraudDetectionService.pendingUpserts.has('user-replaced')).toBe(true);
  });
});
