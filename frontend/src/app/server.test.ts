import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api';
import { describeServerFailure, RETRY_DELAYS_MS } from './server.svelte';

const err = (status: number, code: ApiError['code'], fromGnome: boolean, message = 'msg'): ApiError =>
  new ApiError({ status, code, message, fromGnome });

describe('describeServerFailure', () => {
  it('calls network errors, timeouts and gateway errors "unreachable"', () => {
    for (const e of [err(0, 'network_error', false), err(0, 'timeout', false), err(502, 'internal', false), err(504, 'internal', false)]) {
      expect(describeServerFailure(e)).toEqual({
        problem: 'unreachable',
        detail: 'The GNOME server is not reachable. Local features keep working.',
      });
    }
  });

  it('recognizes something other than GNOME answering at /api', () => {
    expect(describeServerFailure(err(401, 'unauthorized', false))).toEqual({
      problem: 'not-gnome',
      detail: 'No GNOME server answered at this address (HTTP 401). Local features keep working.',
    });
    expect(describeServerFailure(err(200, 'invalid_response', false)).problem).toBe('not-gnome');
    expect(describeServerFailure(new Error('weird')).problem).toBe('not-gnome');
  });

  it('passes GNOME’s own error message through', () => {
    expect(describeServerFailure(err(500, 'internal', true, 'Database is locked'))).toEqual({
      problem: 'server-error',
      detail: 'The GNOME server answered with an error: Database is locked',
    });
    // The server's own 503 `timeout` envelope: it is up, just slow.
    expect(describeServerFailure(err(503, 'timeout', true, 'the request took too long')).problem).toBe('server-error');
  });

  it('retries a bounded number of times with growing delays', () => {
    expect(RETRY_DELAYS_MS.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < RETRY_DELAYS_MS.length; i++) expect(RETRY_DELAYS_MS[i]!).toBeGreaterThan(RETRY_DELAYS_MS[i - 1]!);
  });
});
