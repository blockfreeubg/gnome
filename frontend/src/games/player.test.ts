import { beforeEach, describe, expect, it } from 'vitest';
import { allowedNetworks, allowNetwork, forgetNetworks, NETWORKS_KEY } from './networks';
import { frameAttributes, noticeNetwork, OUTER_ALLOW, stageAspect } from './player';
import { createFakeGamesApi } from './testing/fake-api';
import type { GameDetail } from './types';

const fake = createFakeGamesApi();
const bySource = (s: GameDetail['source']): GameDetail => structuredClone(fake.games.find((g) => g.source === s && (g.embed_allowed || !g.playable))!);

describe('frameAttributes (D2)', () => {
  it('frames only /play-frame/<slug>, byte for byte', () => {
    const g = { ...bySource('gamepix'), slug: 'a b/c?d', title: 'Prism <3D>' };
    expect(frameAttributes(g)).toEqual({ src: '/play-frame/a%20b%2Fc%3Fd', title: 'Prism <3D> (game)', allow: OUTER_ALLOW, allowfullscreen: true });
    expect(OUTER_ALLOW).toBe('fullscreen; autoplay; gamepad; accelerometer; gyroscope');
  });
  it('is null for link-outs and games this server does not frame', () => {
    expect(frameAttributes(bySource('itchio'))).toBeNull();
    expect(frameAttributes({ ...bySource('gamepix'), embed_allowed: false })).toBeNull();
    expect(frameAttributes({ ...bySource('gamepix'), embed_kind: 'link' })).toBeNull();
    expect(frameAttributes({ ...bySource('gamepix'), playable: false })).toBeNull();
    expect(frameAttributes(bySource('oss'))?.src).toBe('/play-frame/2048');
  });
});

describe('noticeNetwork (D24)', () => {
  it('names the network, none for OSS', () => {
    expect(noticeNetwork(bySource('gamepix'))).toBe('gamepix');
    expect(noticeNetwork(bySource('gamedistribution'))).toBe('gamedistribution');
    expect(noticeNetwork(bySource('oss'))).toBeNull();
    expect(noticeNetwork(bySource('itchio'))).toBeNull();
  });
});

describe('stageAspect', () => {
  it('uses the size, else the orientation', () => {
    expect(stageAspect({ width: 800, height: 600, orientation: null })).toBeCloseTo(4 / 3);
    expect(stageAspect({ width: null, height: 600, orientation: 'portrait' })).toBeCloseTo(9 / 16);
    expect(stageAspect({ width: null, height: null, orientation: 'any' })).toBeCloseTo(16 / 9);
    expect(stageAspect({ width: 0, height: 0, orientation: null })).toBeCloseTo(16 / 9);
  });
});

describe('networks.ts (D24)', () => {
  beforeEach(() => localStorage.clear());
  it('allows, dedups and forgets', () => {
    expect(allowedNetworks()).toEqual([]);
    allowNetwork('gamepix');
    allowNetwork('gamepix');
    allowNetwork('playgama');
    expect(allowedNetworks()).toEqual(['gamepix', 'playgama']);
    expect(JSON.parse(localStorage.getItem(NETWORKS_KEY)!)).toEqual(['gamepix', 'playgama']);
    forgetNetworks();
    expect(allowedNetworks()).toEqual([]);
    expect(localStorage.getItem(NETWORKS_KEY)).toBeNull();
  });
  it('treats a corrupt value as none and drops unknown ids', () => {
    localStorage.setItem(NETWORKS_KEY, '{oops');
    expect(allowedNetworks()).toEqual([]);
    localStorage.setItem(NETWORKS_KEY, JSON.stringify(['oss', 'gamepix', 7, 'itchio']));
    expect(allowedNetworks()).toEqual(['gamepix']);
  });
});
