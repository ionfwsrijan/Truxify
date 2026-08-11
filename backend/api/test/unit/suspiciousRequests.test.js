import { describe, it, expect, vi } from 'vitest';
import suspiciousRequests from '../../src/middleware/suspiciousRequests.js';

function makeRes() {
  const res = { statusCode: 200 };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe('suspiciousRequests Middleware', () => {
  it('calls next() for normal requests', () => {
    const req = { headers: {}, query: {}, body: {}, originalUrl: '/api/orders' };
    const res = {};
    const next = vi.fn();

    suspiciousRequests(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('does not block a body value containing a SQL comment marker', () => {
    const req = {
      headers: {},
      query: {},
      body: { note: 'Main St -- Building C' },
      originalUrl: '/api/orders',
    };
    const res = makeRes();
    const next = vi.fn();

    suspiciousRequests(req, res, next);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalled();
    expect(req.threatFindings).toEqual(['SQL Comment Marker']);
  });

  it('does not block a query string containing a leading SQL comment marker', () => {
    const req = {
      headers: {},
      query: { q: '--foo' },
      body: {},
      originalUrl: '/api/search?q=--foo',
    };
    const res = makeRes();
    const next = vi.fn();

    suspiciousRequests(req, res, next);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalled();
  });

  it('still blocks strong SQLi keyword payloads with 403', () => {
    const req = {
      headers: {},
      query: {},
      body: { q: '1 UNION SELECT * FROM users' },
      originalUrl: '/api/search',
    };
    const res = makeRes();
    const next = vi.fn();

    suspiciousRequests(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Request blocked: suspicious content detected' });
    expect(next).not.toHaveBeenCalled();
  });

  it('still blocks path traversal in the URL with 403', () => {
    const req = {
      headers: {},
      query: {},
      body: {},
      originalUrl: '/api/../../etc/passwd',
    };
    const res = makeRes();
    const next = vi.fn();

    suspiciousRequests(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('keeps XSS patterns warn-only', () => {
    const req = {
      headers: {},
      query: {},
      body: { url: 'javascript:alert(1)' },
      originalUrl: '/api/orders',
    };
    const res = makeRes();
    const next = vi.fn();

    suspiciousRequests(req, res, next);
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(next).toHaveBeenCalled();
    expect(req.threatFindings).toEqual(['Cross-Site Scripting']);
  });
});
