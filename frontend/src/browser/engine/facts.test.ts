import { describe, expect, it } from 'vitest';
import type { InitResult } from '../../shared/engine-protocol';
import { engineFacts, rememberEngineFacts } from './facts.svelte';

const init = (enforcedPermissions: InitResult['enforcedPermissions']): InitResult =>
  ({
    instance: 'abcd1234efgh',
    status: null,
    versions: {
      build: 'b1',
      scramjet: '2.0.67-alpha.2',
      scramjetController: '0.0.14',
      ultraviolet: '3.2.10',
      bareMux: '2.1.9',
      transports: { scramjet: { libcurl: '2.0.6', epoxy: '3.0.2' }, ultraviolet: { libcurl: '1.5.2', epoxy: '2.1.29' } },
    },
    capabilities: ['zoom'],
    enforcedPermissions,
    timings: {},
  }) as unknown as InitResult;

describe('rememberEngineFacts', () => {
  it("offers only what this browser can enforce, whatever the engine host claims (security review)", () => {
    rememberEngineFacts(init(['autoplay', 'fullscreen', 'clipboard']), 'gecko');
    expect(engineFacts.enforcedPermissions).toEqual(['fullscreen']);
    const stored = JSON.parse(globalThis.localStorage?.getItem('gnome:engine:v1') ?? 'null') as { enforcedPermissions?: string[] } | null;
    if (stored) expect(stored.enforcedPermissions).toEqual(['fullscreen']);
    rememberEngineFacts(init(['autoplay', 'fullscreen', 'clipboard']), 'chromium');
    expect(engineFacts.enforcedPermissions).toEqual(['autoplay', 'fullscreen']);
    rememberEngineFacts(init(['fullscreen']), 'chromium');
    expect(engineFacts.enforcedPermissions).toEqual(['fullscreen']);
  });
});
