/**
 * Find in page (ENGINE-PROTOCOL §6.10, spike §7.9): the tab's same-origin proxied documents, nested frames included,
 * searched with this realm's DOM functions and highlighted with the CSS Custom Highlight API (`highlights: false`
 * where it is missing). The same query moves to the next (or previous) match. At most LIMITS.findMaxMatches matches
 * (`capped`). Frames that escaped to a real cross-origin URL and shadow roots are not searched, and the page can see
 * the highlight names and the injected style.
 */
import { LIMITS } from '../shared/engine-protocol';
import type { FindResult } from '../shared/engine-protocol';
import type { Natives } from './natives';
import { pageKit } from './realm';

interface Match {
  doc: Document;
  range: Range;
}

export interface FindState {
  query: string;
  caseSensitive: boolean;
  matches: Match[];
  docs: Document[];
  active: number;
  capped: boolean;
}

const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA)$/;
const STYLE_ID = 'gnome-find-style';
const STYLE = '::highlight(gnome-find){background:#ffe066;color:#000}::highlight(gnome-find-active){background:#ff9632;color:#000}';


/** Every same-origin document of a tab, the top one first (depth ≤ 8). */
export function tabDocuments(N: Natives, top: Window | null): Document[] {
  const out: Document[] = [];
  const walk = (win: Window | null, depth: number): void => {
    if (!win || depth > 8) return;
    let doc: Document;
    try {
      doc = N.winDocument.call(win);
    } catch {
      return;
    }
    out.push(doc);
    try {
      const frames = N.querySelectorAll.call(doc, 'iframe, frame');
      const n = N.nodeListLength.call(frames);
      for (let i = 0; i < n; i++) {
        const f = N.nodeListItem.call(frames, i);
        try {
          walk(N.localName.call(f) === 'frame' ? N.frameContentWindow.call(f) : N.contentWindow.call(f), depth + 1);
        } catch {
          /* cross-origin (escaped) frame */
        }
      }
    } catch {
      /* gone */
    }
  };
  walk(top, 0);
  return out;
}

/** The page kit of a document's realm (realm.ts), or null. */
function kitOf(N: Natives, doc: Document) {
  try {
    const w = N.defaultView.call(doc);
    return w ? pageKit(w, N) : null;
  } catch {
    return null;
  }
}

export function clearFind(N: Natives, state: FindState | null): void {
  if (!state) return;
  for (const doc of state.docs) {
    try {
      const kit = kitOf(N, doc);
      kit?.unhighlight('gnome-find');
      kit?.unhighlight('gnome-find-active');
    } catch {
      /* gone */
    }
  }
}

export function find(N: Natives, top: Window | null, prev: FindState | null, q: { query: string; backwards: boolean; caseSensitive: boolean }): { state: FindState | null; result: FindResult } {
  let state = prev;
  // The tab navigated since that search: its matches belong to a document that is gone.
  let topDoc: Document | null = null;
  try {
    topDoc = top ? N.winDocument.call(top) : null;
  } catch {
    topDoc = null;
  }
  if (state && state.docs[0] !== topDoc) {
    clearFind(N, state);
    state = null;
  }
  if (state && state.query === q.query && state.caseSensitive === q.caseSensitive && state.matches.length) {
    const n = state.matches.length;
    state.active = (state.active + (q.backwards ? n - 1 : 1)) % n;
  } else {
    clearFind(N, state);
    state = null;
    if (!q.query) return { state: null, result: { matches: 0, active: 0, highlights: false, capped: false } };
    const needle = q.caseSensitive ? q.query : q.query.toLowerCase();
    const docs = tabDocuments(N, top);
    const matches: Match[] = [];
    let capped = false;
    outer: for (const doc of docs) {
      const root = N.docBody.call(doc) ?? N.docElement.call(doc);
      if (!root) continue;
      // No filter callback: the browser would hand an engine-host callback the page's text nodes, and Blink would
      // then wrap them in this realm (realm.ts observe). The walker's own nodes are wrapped in the page's realm.
      const walker = N.createTreeWalker.call(doc, root, NodeFilter.SHOW_TEXT, null);
      for (let node = N.walkerNextNode.call(walker); node; node = N.walkerNextNode.call(walker)) {
        if (SKIP.test(N.nodeName.call(N.parentNode.call(node) ?? node))) continue;
        const data = N.textData.call(node);
        const hay = q.caseSensitive ? data : data.toLowerCase();
        for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
          if (matches.length >= LIMITS.findMaxMatches) {
            capped = true;
            break outer;
          }
          const r = N.createRange.call(doc);
          N.rangeSetStart.call(r, node, i);
          N.rangeSetEnd.call(r, node, i + needle.length);
          matches.push({ doc, range: r });
        }
      }
    }
    state = { query: q.query, caseSensitive: q.caseSensitive, matches, docs, active: q.backwards ? Math.max(0, matches.length - 1) : 0, capped };
    for (const doc of docs) {
      const kit = kitOf(N, doc);
      if (!kit) continue;
      const mine = matches.filter((m) => m.doc === doc).map((m) => m.range);
      if (mine.length && !kit.highlight('gnome-find', mine)) continue;
      if (!N.getElementById.call(doc, STYLE_ID)) {
        const st = N.createElement.call(doc, 'style');
        N.setAttribute.call(st, 'id', STYLE_ID);
        N.textContentSet.call(st, STYLE);
        const parent = N.docHead.call(doc) ?? N.docElement.call(doc);
        if (parent) N.appendChild.call(parent, st);
      }
    }
  }
  if (!state.matches.length) return { state, result: { matches: 0, active: 0, highlights: false, capped: state.capped } };
  const act = state.matches[state.active];
  let highlights = false;
  if (act) {
    for (const doc of state.docs) {
      try {
        kitOf(N, doc)?.unhighlight('gnome-find-active');
      } catch {
        /* gone */
      }
    }
    highlights = kitOf(N, act.doc)?.highlight('gnome-find-active', [act.range]) ?? false;
    try {
      const el = N.parentElement.call(N.rangeStartContainer.call(act.range));
      if (el) N.scrollIntoView.call(el, { block: 'center' });
    } catch {
      /* detached */
    }
  }
  return { state, result: { matches: state.matches.length, active: state.active + 1, highlights, capped: state.capped } };
}
