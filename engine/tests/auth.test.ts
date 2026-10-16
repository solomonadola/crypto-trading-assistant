import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { apiKeyMatches, requireSignIn } from '../src/api/auth';

describe('apiKeyMatches', () => {
  it('matches only the exact key', () => {
    expect(apiKeyMatches('s3cret-key', 's3cret-key')).toBe(true);
    expect(apiKeyMatches('s3cret-ke', 's3cret-key')).toBe(false);
    expect(apiKeyMatches('S3CRET-KEY', 's3cret-key')).toBe(false);
  });

  it('lets nothing in when no key is set or none is sent', () => {
    expect(apiKeyMatches('', null)).toBe(false);
    expect(apiKeyMatches('anything', null)).toBe(false);
    expect(apiKeyMatches(undefined, 's3cret-key')).toBe(false);
    expect(apiKeyMatches(['s3cret-key'], 's3cret-key')).toBe(false);
  });
});

describe('requireSignIn with an API key', () => {
  const guard = requireSignIn({ projectId: 'demo-test', allowed: ['me@example.com'], apiKey: 's3cret-key' });
  const call = async (headers: Record<string, string>) => {
    const next = vi.fn() as unknown as NextFunction;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
    await guard({ path: '/account', headers } as unknown as Request, res, next);
    return { next: next as unknown as ReturnType<typeof vi.fn>, status: (res.status as unknown as ReturnType<typeof vi.fn>) };
  };

  it('lets in a request with the key, without a sign-in', async () => {
    const { next, status } = await call({ 'x-api-key': 's3cret-key' });
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('still asks for a sign-in when the key is wrong or missing', async () => {
    for (const headers of [{ 'x-api-key': 'guess' }, {}] as Record<string, string>[]) {
      const { next, status } = await call(headers);
      expect(next).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledWith(401);
    }
  });
});
