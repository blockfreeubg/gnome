import { describe, expect, it } from 'vitest';
import { ALLOW_ALL } from '../shared/engine-hooks';
import type { EngineHooks } from '../shared/engine-hooks';
import { engineHooks, onEngineHooksChange, registerEngineHooks } from './hooks';

const mk = (name: string): EngineHooks => ({ ...ALLOW_ALL, status: () => ({ state: 'ready', lists: name.length, detail: null }) });

describe('registerEngineHooks (a stack, WAVE-B3 §4.4)', () => {
  it('unregistering restores the hooks that were current before', () => {
    const seen: EngineHooks[] = [];
    const off = onEngineHooksChange((h) => seen.push(h));
    const blocker = mk('blocker');
    const test = mk('t');
    const offBlocker = registerEngineHooks(blocker);
    const offTest = registerEngineHooks(test);
    expect(engineHooks()).toBe(test);
    offTest();
    expect(engineHooks()).toBe(blocker);
    offTest(); // twice: nothing
    expect(engineHooks()).toBe(blocker);
    offBlocker();
    expect(engineHooks()).toBe(ALLOW_ALL);
    expect(seen).toEqual([blocker, test, blocker, ALLOW_ALL]);
    off();
  });

  it('removing a lower registration keeps the top one in force without a change event', () => {
    const seen: EngineHooks[] = [];
    const off = onEngineHooksChange((h) => seen.push(h));
    const a = mk('a');
    const b = mk('bb');
    const offA = registerEngineHooks(a);
    const offB = registerEngineHooks(b);
    offA();
    expect(engineHooks()).toBe(b);
    expect(seen).toEqual([a, b]);
    offB();
    off();
  });
});
