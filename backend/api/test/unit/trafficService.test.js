import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../src/middleware/logger.js', () => ({
  default: mockLogger,
}));

import { getLiveTrafficMultiplier } from '../../src/services/trafficService.js';

describe('trafficService - getLiveTrafficMultiplier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 1.0 when pickupLat is missing', async () => {
    const result = await getLiveTrafficMultiplier(null, 77.5);
    expect(result).toBe(1.0);
  });

  it('returns 1.0 when pickupLng is missing', async () => {
    const result = await getLiveTrafficMultiplier(12.9, null);
    expect(result).toBe(1.0);
  });

  it('returns 1.0 when coordinates are 0,0', async () => {
    const result = await getLiveTrafficMultiplier(0, 0);
    expect(result).toBe(1.0);
  });

  it('returns 1.0 without a traffic API key instead of fabricating a surge', async () => {
    const result = await getLiveTrafficMultiplier(12.9, 77.5);
    expect(result).toBe(1.0);
    expect(mockLogger.info).not.toHaveBeenCalled();
  });

  it('returns 1.0 for the same coordinates on repeat calls', async () => {
    const result1 = await getLiveTrafficMultiplier(12.9716, 77.5946);
    const result2 = await getLiveTrafficMultiplier(12.9716, 77.5946);
    expect(result1).toBe(result2);
  });

  it('returns 1.0 for different coordinates without a traffic API key', async () => {
    const result1 = await getLiveTrafficMultiplier(12.9716, 77.5946);
    const result2 = await getLiveTrafficMultiplier(28.6139, 77.2090);
    expect(result1).toBe(1.0);
    expect(result2).toBe(1.0);
  });

  it('returns a number without throwing', async () => {
    const result = await getLiveTrafficMultiplier(12.9, 77.5);
    expect(typeof result).toBe('number');
  });
});
