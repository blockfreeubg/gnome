import { describe, expect, it } from 'vitest';
import { BUILTIN_TRACKING_PARAMS, isBuiltinTrackingParam, stripBuiltinParams } from './params';

describe('BUILTIN_TRACKING_PARAMS (research §7.1)', () => {
  it('is the exact table of the plan, without duplicates', () => {
    expect(BUILTIN_TRACKING_PARAMS).toEqual([
      'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'igshid', 'igsh', 'mc_cid',
      'mc_eid', '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsCtaTracking', 'mkt_tok', 'oly_anon_id', 'oly_enc_id',
      'rb_clickid', 's_cid', 'vero_conv', 'vero_id', 'wickedid', '_openstat', 'srsltid',
    ]);
    expect(new Set(BUILTIN_TRACKING_PARAMS).size).toBe(BUILTIN_TRACKING_PARAMS.length);
  });

  it('matches utm_* only by prefix at the start of the name, and exact names only', () => {
    expect(isBuiltinTrackingParam('utm_source')).toBe(true);
    expect(isBuiltinTrackingParam('utm_anything_new')).toBe(true);
    expect(isBuiltinTrackingParam('utm_')).toBe(false);
    expect(isBuiltinTrackingParam('xutm_source')).toBe(false);
    expect(isBuiltinTrackingParam('my_utm_source')).toBe(false);
    expect(isBuiltinTrackingParam('UTM_SOURCE')).toBe(false);
    expect(isBuiltinTrackingParam('fbclid')).toBe(true);
    expect(isBuiltinTrackingParam('fbclid2')).toBe(false);
    expect(isBuiltinTrackingParam('ref')).toBe(false);
    expect(isBuiltinTrackingParam('id')).toBe(false);
    expect(isBuiltinTrackingParam('hsCtaTracking')).toBe(true);
  });
});

describe('stripBuiltinParams', () => {
  it('removes tracking parameters and keeps the order and spelling of the others', () => {
    expect(stripBuiltinParams('https://a.example/p?b=2&utm_source=x&a=1&fbclid=abc&c=%20z')).toBe('https://a.example/p?b=2&a=1&c=%20z');
  });

  it('keeps the fragment', () => {
    expect(stripBuiltinParams('https://a.example/p?id=1&utm_medium=m#section-2')).toBe('https://a.example/p?id=1#section-2');
    expect(stripBuiltinParams('https://a.example/p?gclid=1#utm_source=frag')).toBe('https://a.example/p#utm_source=frag');
  });

  it('drops the ? when nothing is left', () => {
    expect(stripBuiltinParams('https://a.example/?utm_source=x&gclid=y')).toBe('https://a.example/');
  });

  it('returns null when nothing changed', () => {
    expect(stripBuiltinParams('https://a.example/p?id=1&ref=2')).toBeNull();
    expect(stripBuiltinParams('https://a.example/p')).toBeNull();
    expect(stripBuiltinParams('https://a.example/p?')).toBeNull();
    expect(stripBuiltinParams('https://a.example/p#utm_source=x')).toBeNull();
    expect(stripBuiltinParams('not a url')).toBeNull();
    expect(stripBuiltinParams('ftp://a.example/?utm_source=x')).toBeNull();
    expect(stripBuiltinParams('javascript:alert(1)//?utm_source=x')).toBeNull();
  });

  it('decodes names before matching (percent and + encodings)', () => {
    expect(stripBuiltinParams('https://a.example/?utm%5Fsource=x&id=1')).toBe('https://a.example/?id=1');
    expect(stripBuiltinParams('https://a.example/?%66bclid=x&id=1')).toBe('https://a.example/?id=1');
    // `+` is a space in form encoding: "utm source" is not a tracking parameter.
    expect(stripBuiltinParams('https://a.example/?utm+source=x')).toBeNull();
    // A malformed escape is kept as it is (never thrown).
    expect(stripBuiltinParams('https://a.example/?%E0%A4%A=1&fbclid=2')).toBe('https://a.example/?%E0%A4%A=1');
  });

  it('removes a name without a value and repeated names', () => {
    expect(stripBuiltinParams('https://a.example/?fbclid&id=1&fbclid=2')).toBe('https://a.example/?id=1');
  });

  it('keeps empty pieces between other parameters', () => {
    expect(stripBuiltinParams('https://a.example/?a=1&&gclid=2&b=3')).toBe('https://a.example/?a=1&&b=3');
  });

  it('works with IDN hosts and ports (the origin is unchanged)', () => {
    const out = stripBuiltinParams('https://bücher.example:8443/x?utm_campaign=c&q=1');
    expect(out).toBe('https://xn--bcher-kva.example:8443/x?q=1');
    expect(new URL(out ?? '').origin).toBe(new URL('https://bücher.example:8443/').origin);
  });

  it('does not touch values that look like names', () => {
    expect(stripBuiltinParams('https://a.example/?next=utm_source%3Dx&fbclid=1')).toBe('https://a.example/?next=utm_source%3Dx');
  });
});
