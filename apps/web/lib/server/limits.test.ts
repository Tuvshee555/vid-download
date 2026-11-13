// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireConversionSlot, allow, clientIp } from './limits';

afterEach(() => vi.unstubAllEnvs());

describe('rate limiting for the open site', () => {
  it('allows up to the limit per window, per visitor', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) expect(allow('k1', 3, 60_000, t0 + i)).toBe(true);
    expect(allow('k1', 3, 60_000, t0 + 10)).toBe(false);
    expect(allow('k2', 3, 60_000, t0 + 10)).toBe(true); // other visitors are unaffected
    expect(allow('k1', 3, 60_000, t0 + 61_000)).toBe(true); // window passed
  });

  it('reads the visitor IP from the proxy header', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
    expect(clientIp(new Headers())).toBe('unknown');
  });

  it('caps simultaneous conversions and frees the slot when done', () => {
    vi.stubEnv('MAX_CONCURRENT_CONVERSIONS', '2');
    const a = acquireConversionSlot();
    const b = acquireConversionSlot();
    expect(a && b).toBeTruthy();
    expect(acquireConversionSlot()).toBeNull();
    a?.();
    a?.(); // releasing twice must not free two slots
    const c = acquireConversionSlot();
    expect(c).toBeTruthy();
    expect(acquireConversionSlot()).toBeNull();
    b?.();
    c?.();
  });
});
