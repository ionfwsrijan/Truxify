import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/db.js', () => ({
  supabase: { from: vi.fn() },
  redisClient: vi.fn(),
}));

describe('ShardManager - Cross-Shard Query Engine', () => {
  let ShardManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ShardManager = (await import('../../src/services/sharding/ShardManager.js')).default;
  });

  it('runs queries across all initialized shards', async () => {
    const mockQuery = vi.fn().mockImplementation(() => {
      return Promise.resolve({ rows: [{ id: 1, val: 'foo' }] });
    });

    for (const [_, shard] of ShardManager.shards) {
      shard.pool = { query: mockQuery };
    }

    const { results, failed, partial } = await ShardManager.executeCrossShardQuery({ query: 'SELECT * FROM test' });

    const activeShardsCount = Array.from(ShardManager.shards.values()).filter(s => s.pool).length;
    expect(mockQuery).toHaveBeenCalledTimes(activeShardsCount);

    expect(results).toHaveLength(activeShardsCount);
    expect(results[0]).toHaveProperty('shard');
    expect(results[0]).toHaveProperty('data');
    expect(results[0].data).toEqual([{ id: 1, val: 'foo' }]);
    expect(failed).toEqual([]);
    expect(partial).toBe(false);
  });

  it('surfaces failed shards instead of silently swallowing them', async () => {
    ShardManager.shards.get('north').pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ total: 4 }] }),
    };
    ShardManager.shards.get('south').pool = {
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    ShardManager.shards.get('east').pool = null;
    ShardManager.shards.get('west').pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ total: 6 }] }),
    };

    const { results, failed, partial } = await ShardManager.executeCrossShardQuery(
      { query: 'SELECT COUNT(*) as total FROM orders' }
    );

    expect(results).toHaveLength(2);
    expect(results.map(r => r.shard)).toEqual(['north', 'west']);
    expect(failed).toEqual(['south', 'east']);
    expect(partial).toBe(true);
  });
});
