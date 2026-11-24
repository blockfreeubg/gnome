import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { postbuild, siblingKinds, compressOne, MIN_SIZE } from './postbuild.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const text = (n: number) => 'export const gnome = "abcdefghij";\n'.repeat(Math.ceil(n / 36)).slice(0, n);

function fixture(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gnome-postbuild-'));
  dirs.push(d);
  const w = (rel: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), data);
  };
  w('index.html', `<!doctype html><script type="module" src="/assets/app.js"></script>${'<!-- pad -->'.repeat(200)}`);
  w('engine/index.html', `<!doctype html>${'x'.repeat(4000)}`);
  w('assets/app.js', text(8000));
  w('assets/small.js', text(500));
  w('assets/random.wasm', Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 2654435761) >>> 24)));
  w('vendor/eng/eng.js', text(6000));
  w('vendor/eng/eng.js.map', '{}');
  w('vendor/eng/LICENSE', text(2000));
  w('.vite/gnome-chunks.json', '{}');
  w('package.json', '{}');
  return d;
}

const quiet = () => {};

describe('siblingKinds', () => {
  it('applies the eligibility rules of D8', () => {
    expect(siblingKinds('assets/a.js', 2000)).toEqual(['br', 'gz']);
    expect(siblingKinds('assets/a.js', MIN_SIZE - 1)).toEqual([]);
    expect(siblingKinds('engine/index.html', 9000)).toEqual([]);
    expect(siblingKinds('vendor/x/a.js.map', 9000)).toEqual([]);
    expect(siblingKinds('assets/a.js.br', 9000)).toEqual([]);
    expect(siblingKinds('assets/a.png', 9000)).toEqual([]);
    expect(siblingKinds('vendor/x/LICENSE', 9000)).toEqual(['br', 'gz']);
    expect(siblingKinds('vendor/x/a.js', 9000, { release: true })).toEqual(['br']);
  });
  it('keeps a sibling only when it saves at least 10 %', () => {
    const noise = crypto.randomBytes(4096);
    expect(Object.keys(compressOne(noise, ['br', 'gz']))).toEqual([]);
    expect(Object.keys(compressOne(Buffer.from(text(4096)), ['br', 'gz']))).toEqual(['br', 'gz']);
  });
});

describe('postbuild', () => {
  it('keeps maps without --release and removes only vendor maps with it', async () => {
    const d = fixture();
    expect((await postbuild({ dist: d, log: quiet })).removedMaps).toEqual([]);
    expect(fs.existsSync(path.join(d, 'vendor/eng/eng.js.map'))).toBe(true);
    const d2 = fixture();
    const r = await postbuild({ dist: d2, release: true, log: quiet });
    expect(r.ok).toBe(true);
    expect(r.removedMaps).toEqual(['vendor/eng/eng.js.map']);
    expect(fs.existsSync(path.join(d2, 'vendor/eng/eng.js.gz'))).toBe(false);
    expect(fs.existsSync(path.join(d2, 'vendor/eng/eng.js.br'))).toBe(true);
    expect(zlib.brotliDecompressSync(fs.readFileSync(path.join(d2, 'assets/app.js.br'))).toString()).toBe(text(8000));
    expect(fs.existsSync(path.join(d2, 'assets/small.js.br'))).toBe(false);
    expect(fs.existsSync(path.join(d2, 'engine/index.html.br'))).toBe(false);
    expect((await postbuild({ dist: d2, check: true, log: quiet })).ok).toBe(true);
  });

  it('fails on a map of GNOME code and on a corrupted sibling', async () => {
    const d = fixture();
    fs.writeFileSync(path.join(d, 'assets/app.js.map'), '{}');
    expect((await postbuild({ dist: d, release: true, log: quiet })).problems.join()).toMatch(/source map of GNOME/);
    const d2 = fixture();
    await postbuild({ dist: d2, release: true, log: quiet });
    fs.writeFileSync(path.join(d2, 'assets/app.js.br'), zlib.brotliCompressSync(Buffer.from('old build')));
    const r = await postbuild({ dist: d2, check: true, log: quiet });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/stale or corrupt sibling: assets\/app.js.br/);
  });

  it('is deterministic with SOURCE_DATE_EPOCH', async () => {
    process.env.SOURCE_DATE_EPOCH = '1700000000';
    try {
      const a = fixture();
      const b = fixture();
      await postbuild({ dist: a, release: true, log: quiet });
      await postbuild({ dist: b, release: true, log: quiet });
      expect(fs.readFileSync(path.join(a, '.gnome/files.json'), 'utf8')).toBe(fs.readFileSync(path.join(b, '.gnome/files.json'), 'utf8'));
      expect(fs.statSync(path.join(a, 'assets/app.js.br')).mtimeMs).toBe(1700000000 * 1000);
    } finally {
      delete process.env.SOURCE_DATE_EPOCH;
    }
  });
});
