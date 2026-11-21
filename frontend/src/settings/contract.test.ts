/**
 * Contract test: the settings schema in docs/ARCHITECTURE.md §5.3 is the source of truth. This parses the ```ts block
 * of that section and src/settings/schema.ts with the TypeScript compiler and checks that
 *   - both declare exactly the same keys with the same literal unions (type aliases resolved),
 *   - createDefaultSettings() has exactly those keys (no retired keys such as games.playMode), with documented defaults,
 *   - the validator accepts every documented literal, rejects anything else, and enforces documented number ranges.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from './defaults';
import { validateSettings } from './validate';

type Leaf =
  | { kind: 'union'; values: string[]; comment: string }
  | { kind: 'number'; comment: string }
  | { kind: 'other'; text: string; comment: string };

function architectureBlock(): string {
  const md = readFileSync(new URL('../../../docs/ARCHITECTURE.md', import.meta.url), 'utf8');
  const start = md.indexOf('### 5.3');
  const fence = md.indexOf('```ts', start);
  const end = md.indexOf('```', fence + 5);
  if (start < 0 || fence < 0 || end < 0) throw new Error('ARCHITECTURE.md §5.3 settings block not found');
  return md.slice(fence + 5, end);
}

/** Leaf types of `interface Settings`, keyed by dotted path. Records/arrays/nullable members are leaves. */
function settingsLeaves(source: string, file: string): Map<string, Leaf> {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const aliases = new Map<string, ts.TypeNode>();
  let settings: ts.InterfaceDeclaration | undefined;
  sf.forEachChild((n) => {
    if (ts.isTypeAliasDeclaration(n)) aliases.set(n.name.text, n.type);
    if (ts.isInterfaceDeclaration(n) && n.name.text === 'Settings') settings = n;
  });
  if (!settings) throw new Error(`interface Settings not found in ${file}`);

  const literals = (node: ts.TypeNode): string[] | null => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && aliases.has(node.typeName.text)) {
      return literals(aliases.get(node.typeName.text)!);
    }
    if (ts.isUnionTypeNode(node)) {
      const out: string[] = [];
      for (const t of node.types) {
        const inner = literals(t);
        if (!inner) return null;
        out.push(...inner);
      }
      return out;
    }
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) return [node.literal.text];
    return null;
  };

  const out = new Map<string, Leaf>();
  const comment = (m: ts.Node): string => {
    const text = sf.text.slice(m.getEnd(), sf.text.indexOf('\n', m.getEnd()));
    return /\/\/(.*)$/.exec(text)?.[1]?.trim() ?? '';
  };
  const walk = (members: ts.NodeArray<ts.TypeElement>, prefix: string): void => {
    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.type) continue;
      const name = m.name.getText(sf);
      const path = prefix ? `${prefix}.${name}` : name;
      const type = m.type;
      if (ts.isTypeLiteralNode(type)) {
        walk(type.members, path);
        continue;
      }
      const lits = literals(type);
      if (lits) out.set(path, { kind: 'union', values: [...lits].sort(), comment: comment(m) });
      else if (type.kind === ts.SyntaxKind.NumberKeyword) out.set(path, { kind: 'number', comment: comment(m) });
      else {
        // Normalize alias names that the documentation spells out inline.
        const text = type
          .getText(sf)
          .replace(/\s+/g, ' ')
          .replace(/\/\*.*?\*\//g, '')
          .replace(/\s+/g, ' ')
          .trim();
        out.set(path, { kind: 'other', text, comment: comment(m) });
      }
    }
  };
  walk(settings.members, '');
  return out;
}

function defaultLeaves(value: unknown, prefix = '', out = new Map<string, unknown>(), leafPaths?: Set<string>): Map<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value) && !(leafPaths?.has(prefix) ?? false)) {
    for (const [k, v] of Object.entries(value)) defaultLeaves(v, prefix ? `${prefix}.${k}` : k, out, leafPaths);
  } else {
    out.set(prefix, value);
  }
  return out;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
  cur[parts.at(-1)!] = value;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

const DOC = settingsLeaves(architectureBlock(), 'ARCHITECTURE.md');
const SCHEMA = settingsLeaves(readFileSync(new URL('./schema.ts', import.meta.url), 'utf8'), 'schema.ts');
/** Members typed as records or arrays are leaves even though their default is an object. */
const OBJECT_LEAVES = new Set([...DOC].filter(([, l]) => l.kind === 'other').map(([p]) => p));

describe('settings contract (docs/ARCHITECTURE.md §5.3)', () => {
  it('the documentation block parses into the full schema', () => {
    expect(DOC.size).toBeGreaterThan(80);
    expect(DOC.get('appearance.theme')).toMatchObject({ kind: 'union', values: ['dark', 'light', 'system'] });
    expect(DOC.has('games.playMode')).toBe(false);
  });

  it('schema.ts declares exactly the documented keys and literal unions', () => {
    expect([...SCHEMA.keys()].sort()).toEqual([...DOC.keys()].sort());
    for (const [path, doc] of DOC) {
      const mine = SCHEMA.get(path)!;
      expect(mine.kind, path).toBe(doc.kind);
      if (doc.kind === 'union' && mine.kind === 'union') expect(mine.values, path).toEqual(doc.values);
    }
  });

  it('createDefaultSettings() has exactly the documented keys (nothing retired, nothing missing)', () => {
    const defaults = defaultLeaves(createDefaultSettings(), '', new Map(), OBJECT_LEAVES);
    expect([...defaults.keys()].sort()).toEqual([...DOC.keys()].sort());
    expect(getPath(createDefaultSettings(), 'games.playMode')).toBeUndefined();
  });

  it('defaults sit inside the documented unions and match documented defaults', () => {
    const d = createDefaultSettings();
    for (const [path, leaf] of DOC) {
      const value = getPath(d, path);
      if (leaf.kind === 'union') expect(leaf.values, path).toContain(value);
      const documented = /default\s+'?([\w.-]+)'?/.exec(leaf.comment)?.[1];
      if (documented !== undefined) {
        expect(String(value), `${path} (${leaf.comment})`).toBe(documented);
      }
    }
  });

  it('the validator accepts every documented literal and rejects anything else', () => {
    for (const [path, leaf] of DOC) {
      if (leaf.kind !== 'union') continue;
      for (const v of leaf.values) {
        const input = createDefaultSettings() as unknown as Record<string, unknown>;
        setPath(input, path, v);
        const { settings, issues } = validateSettings(input);
        expect(getPath(settings, path), `${path}=${v}`).toBe(v);
        expect(issues.filter((i) => i.path === path), `${path}=${v}`).toEqual([]);
      }
      const bogus = createDefaultSettings() as unknown as Record<string, unknown>;
      setPath(bogus, path, 'not-a-documented-value');
      const { settings, issues } = validateSettings(bogus);
      expect(getPath(settings, path), path).toBe(getPath(createDefaultSettings(), path));
      expect(issues.some((i) => i.path === path), path).toBe(true);
    }
  });

  it('documented number ranges are enforced (values outside are clamped)', () => {
    let checked = 0;
    for (const [path, leaf] of DOC) {
      if (leaf.kind !== 'number') continue;
      const range = /(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)/.exec(leaf.comment);
      if (!range) continue;
      const [min, max] = [Number(range[1]), Number(range[2])];
      for (const [input, expected] of [
        [min - 1, min],
        [max + 1, max],
        [min, min],
        [max, max],
      ] as const) {
        const s = createDefaultSettings() as unknown as Record<string, unknown>;
        setPath(s, path, input);
        expect(getPath(validateSettings(s).settings, path), `${path}=${input} (${leaf.comment})`).toBe(expected);
      }
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(5); // fontSize, transparency, blur, radius, defaultZoom
  });
});
