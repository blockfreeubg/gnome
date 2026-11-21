import { describe, expect, it } from 'vitest';
import { siteRuleKeyFromInput } from './hosts';

describe('site-rule editors: a bare host is stored as *.<host> (WAVE-B3 §7.1, §9)', () => {
  it('turns a typed host into a wildcard key unless "only this host"', () => {
    expect(siteRuleKeyFromInput('example.localhost', false)).toBe('*.example.localhost');
    expect(siteRuleKeyFromInput('example.localhost', true)).toBe('example.localhost');
    expect(siteRuleKeyFromInput('https://Example.com/path?q', false)).toBe('*.example.com');
    expect(siteRuleKeyFromInput('www.example.com', false)).toBe('*.www.example.com');
  });

  it('keeps wildcards, ports and IP literals as they are', () => {
    expect(siteRuleKeyFromInput('*.example.com', false)).toBe('*.example.com');
    expect(siteRuleKeyFromInput('example.com:8080', false)).toBe('example.com:8080');
    expect(siteRuleKeyFromInput('192.168.0.10', false)).toBe('192.168.0.10');
    expect(siteRuleKeyFromInput('http://[2001:db8::1]:8080/', false)).toBe('[2001:db8::1]:8080');
    expect(siteRuleKeyFromInput('[2001:db8::1]', false)).toBe('[2001:db8::1]');
  });

  it('refuses what is not a host', () => {
    expect(siteRuleKeyFromInput('', false)).toBeNull();
    expect(siteRuleKeyFromInput('javascript:alert(1)', false)).toBeNull();
    expect(siteRuleKeyFromInput('not a host', false)).toBeNull();
  });
});
