import { describe, it, expect, vi, beforeEach } from 'vitest';
import securityHeaderDuplicates from '../../src/middleware/securityHeaderDuplicates.js';

vi.mock('../../src/middleware/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let logger;

beforeEach(async () => {
  logger = (await import('../../src/middleware/logger.js')).default;
  vi.clearAllMocks();
  delete process.env.HEADER_MONITOR_ENABLED;
});

function makeReq() {
  return {
    method: 'GET',
    originalUrl: '/api/test',
    headers: {},
  };
}

function makeRes() {
  return { setHeader: vi.fn() };
}

describe('securityHeaderDuplicates', () => {
  it('stays active in production and warns on duplicate security headers', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const req = makeReq();
      const res = makeRes();
      const next = vi.fn();
      securityHeaderDuplicates(req, res, next);
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('x-frame-options', 'SAMEORIGIN');
      expect(next).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: '/api/test',
          header: 'x-frame-options',
        }),
        'Duplicate security header assignment detected'
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('does not warn for distinct security headers', () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    securityHeaderDuplicates(req, res, next);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('ignores non-security headers', () => {
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    securityHeaderDuplicates(req, res, next);
    res.setHeader('Set-Cookie', 'a=1');
    res.setHeader('Set-Cookie', 'b=2');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('skips when HEADER_MONITOR_ENABLED is false', () => {
    process.env.HEADER_MONITOR_ENABLED = 'false';
    const req = makeReq();
    const res = makeRes();
    const next = vi.fn();
    securityHeaderDuplicates(req, res, next);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
