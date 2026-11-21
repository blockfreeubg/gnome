import { describe, expect, it } from 'vitest';
import { hasLoneSurrogate, MAX_TITLE_LENGTH, MAX_URL_LENGTH, storableTitle, storableUrl } from './match';

/**
 * The sync server's URL check (backend/src/api/validate.rs `is_http_url`), ported line by line: whatever the library
 * stores must pass it, or one record would make the server refuse every upload batch it is in (422) for good.
 */
function serverAcceptsUrl(s: string): boolean {
  if (new TextEncoder().encode(s).length > 4096 || [...s].some((c) => /\s/u.test(c) || /\p{Cc}/u.test(c))) return false;
  const scheme = /^https?:\/\//i.exec(s);
  if (!scheme) return false;
  const authority = s.slice(scheme[0].length).split(/[/?#]/)[0] ?? '';
  const at = authority.lastIndexOf('@');
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  let host: string;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close < 0) return false;
    const after = hostPort.slice(close + 1);
    if (!(after === '' || (after.startsWith(':') && /^\d*$/.test(after.slice(1))))) return false;
    host = hostPort.slice(1, close);
  } else {
    const i = hostPort.lastIndexOf(':');
    if (i >= 0 && !/^\d*$/.test(hostPort.slice(i + 1))) return false;
    host = i >= 0 ? hostPort.slice(0, i) : hostPort;
  }
  return host.length > 0 && [...host].every((c) => /[\p{L}\p{N}]/u.test(c) || '-._%:~'.includes(c));
}

/** validate.rs `check_title`: at most 512 characters (Unicode scalar values), no NUL; JSON must encode it. */
function serverAcceptsTitle(s: string): boolean {
  return [...s].length <= 512 && !s.includes('\0') && !hasLoneSurrogate(s);
}

describe('storableUrl', () => {
  it('keeps http(s) URLs the way the URL parser serializes them', () => {
    expect(storableUrl('HTTPS://Example.COM')).toBe('https://example.com/');
    expect(storableUrl('http://example.com:8080/path?q=1#frag')).toBe('http://example.com:8080/path?q=1#frag');
    expect(storableUrl('https://[2001:db8::1]:8443/')).toBe('https://[2001:db8::1]:8443/');
    expect(storableUrl('https://bücher.example/straße')).toBe('https://xn--bcher-kva.example/stra%C3%9Fe');
    expect(storableUrl('http://my_host.example/')).toBe('http://my_host.example/');
    expect(storableUrl('http://0x7f.1/')).toBe('http://127.0.0.1/');
    expect(storableUrl('https://example.com/a b')).toBe('https://example.com/a%20b');
  });

  it('refuses other schemes, credentials and URLs over the size limit', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://example.com/', 'https://user:pw@example.com/', '//example.com', 'about:blank', '']) {
      expect(storableUrl(bad), bad).toBeNull();
    }
    expect(storableUrl(`https://e.com/${'a'.repeat(MAX_URL_LENGTH)}`)).toBeNull();
    // Within the limit as typed, over it once serialized (each é becomes %C3%A9).
    expect(storableUrl(`https://e.com/${'é'.repeat(1500)}`)).toBeNull();
  });

  it('refuses hosts the URL parser allows but the sync server does not', () => {
    for (const c of '$!\'()*+,;=&`{}"') {
      const url = `http://a${c}b.example/`;
      expect(serverAcceptsUrl(new URL(url).href), url).toBe(false);
      expect(storableUrl(url), url).toBeNull();
    }
  });

  it('only ever returns URLs the sync server accepts', () => {
    const corpus = [
      'https://example.com/?q=<script>',
      'https://example.com/#café',
      'https://example.com/　x',
      'https://example.com/%zz',
      'http://localhost',
      'http://localhost:/x',
      'http://[::1]/',
      'http://[::ffff:1.2.3.4]/',
      'https://xn--n3h.example/',
      'https://☃.example/',
      'https://example.com./',
      'https://a..b/',
      'https://例子.测试/路径?查询=值#片段',
      `https://example.com/${'a'.repeat(4070)}`,
      'https://exa\tmple.com/',
      'https://example.com/\u0000',
      'http://%41.example/',
      'http://a%2Cb.example/',
      'http://1.2.3/',
      'http://[fe80::1%25eth0]/',
    ];
    for (const c of '$!\'()*+,;=&`{}"_~-.') corpus.push(`http://h${c}h.example/p`);
    for (const url of corpus) {
      const stored = storableUrl(url);
      if (stored !== null) expect(serverAcceptsUrl(stored), `${url} → ${stored}`).toBe(true);
    }
    expect(storableUrl('https://例子.测试/路径?查询=值#片段')).not.toBeNull();
  });
});

describe('storableTitle', () => {
  it('collapses whitespace, strips control and bidi-override characters, replaces lone surrogates', () => {
    expect(storableTitle('  Example \n\t Domain ')).toBe('Example Domain');
    expect(storableTitle('a\u0000b\u0007c')).toBe('a b c');
    expect(storableTitle('‮gpj.exe')).toBe('gpj.exe');
    expect(storableTitle('broken \ud800 pair')).toBe('broken � pair');
    expect(storableTitle('   ')).toBeNull();
    expect(storableTitle(42)).toBeNull();
  });

  it('cuts at 512 code points without splitting a pair, also for huge input', () => {
    const emoji = storableTitle('😀'.repeat(600))!;
    expect([...emoji]).toHaveLength(MAX_TITLE_LENGTH);
    expect(hasLoneSurrogate(emoji)).toBe(false);
    const mixed = storableTitle(`a${'😀'.repeat(600)}`)!;
    expect([...mixed]).toHaveLength(MAX_TITLE_LENGTH);
    expect(hasLoneSurrogate(mixed)).toBe(false);
    const huge = storableTitle('中'.repeat(8_000_000))!;
    expect([...huge]).toHaveLength(MAX_TITLE_LENGTH);
  });

  it('only ever returns titles the sync server accepts', () => {
    const corpus = ['\ud83d', '\udc00x', 'x\ud83d', `${'é'.repeat(513)}`, `${'😀'.repeat(513)}`, '\u0000\u0000a', 'a b c', '﻿BOM'];
    for (const t of corpus) {
      const stored = storableTitle(t);
      if (stored !== null) expect(serverAcceptsTitle(stored), JSON.stringify(t)).toBe(true);
    }
  });
});
