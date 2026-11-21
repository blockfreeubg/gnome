/**
 * Items of GNOME's own context menu for a proxied page (ENGINE-PROTOCOL §6.8). Every item is a click in GNOME's UI;
 * items whose capability the engine host did not report are left out, and a truncated selection offers no Copy
 * (it would copy a prefix; the page's own copy, with Shift+right-click, still works).
 */
import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import ArrowRight from '@lucide/svelte/icons/arrow-right';
import Bookmark from '@lucide/svelte/icons/bookmark';
import Copy from '@lucide/svelte/icons/copy';
import Download from '@lucide/svelte/icons/download';
import ExternalLink from '@lucide/svelte/icons/external-link';
import Link from '@lucide/svelte/icons/link';
import Printer from '@lucide/svelte/icons/printer';
import RotateCw from '@lucide/svelte/icons/rotate-cw';
import Search from '@lucide/svelte/icons/search';
import TextSelect from '@lucide/svelte/icons/text-select';
import type { MenuItem } from '../components/menu';
import { toast } from '../app/overlays/toast.svelte';
import { settings } from '../settings/store.svelte';
import type { EventMap } from '../shared/engine-protocol';
import { searchUrl } from '../lib/url';
import type { Browser } from './browser.svelte';

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}`, { description: 'The browser did not allow access to the clipboard.' });
  }
}

const shorten = (s: string, n = 32): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function contextMenuItems(b: Browser, e: EventMap['tab.contextMenu']): MenuItem[] {
  const t = b.model.get(e.tabId);
  if (!t) return [];
  const target = e.target;
  const items: MenuItem[] = [];
  const sep = (): void => {
    if (items.length && items.at(-1)?.kind !== 'separator') items.push({ kind: 'separator' });
  };

  if (target.linkUrl) {
    const link = target.linkUrl;
    items.push(
      // The page's link: its new tab loads as the page's navigation (start.opener), as in a browser.
      { label: 'Open link in new tab', icon: ExternalLink, onSelect: () => void b.openUrl(link, { newTab: true, openerId: t.id, fromPage: true }) },
      { label: 'Open link in background tab', onSelect: () => void b.openUrl(link, { newTab: true, background: true, openerId: t.id, fromPage: true }) },
      { label: 'Copy link address', icon: Link, onSelect: () => void copyText(link, 'Link address') },
    );
    if (b.hasCapability('saveLink')) items.push({ label: 'Save link as…', icon: Download, onSelect: () => b.saveUrl(link, 'link', t.id) });
    items.push({ label: 'Bookmark link', icon: Bookmark, onSelect: () => b.editBookmark(link, target.selectionText && target.kind === 'link' ? shorten(target.selectionText, 120) : '') });
  }
  if (target.srcUrl && (target.kind === 'image' || !target.linkUrl)) {
    const src = target.srcUrl;
    sep();
    items.push(
      { label: 'Open image in new tab', icon: ExternalLink, onSelect: () => void b.openUrl(src, { newTab: true, openerId: t.id, fromPage: true }) },
      { label: 'Copy image address', icon: Link, onSelect: () => void copyText(src, 'Image address') },
    );
    if (b.hasCapability('saveImage')) items.push({ label: 'Save image as…', icon: Download, onSelect: () => b.saveUrl(src, 'image', t.id) });
  }
  if (target.selectionText && target.kind !== 'editable') {
    const sel = target.selectionText;
    sep();
    if (!target.selectionTruncated) items.push({ label: 'Copy', icon: Copy, onSelect: () => void copyText(sel, 'Text') });
    const s = settings.value.browser;
    items.push({
      label: `Search for “${shorten(sel)}”`,
      icon: Search,
      onSelect: () => void b.openUrl(searchUrl(sel.slice(0, 1000), { searchEngine: s.searchEngine, customSearchUrl: s.customSearchUrl }), { newTab: true, openerId: t.id }),
    });
  }
  if (target.kind === 'editable') {
    sep();
    items.push({ kind: 'label', label: 'Shift+right-click for cut, copy and paste' });
  }
  if (target.kind === 'page' || target.kind === 'editable' || (!target.linkUrl && !target.srcUrl && !target.selectionText)) {
    sep();
    items.push(
      { label: 'Back', icon: ArrowLeft, disabled: !t.canGoBack, shortcut: 'back', onSelect: () => b.go(-1, t.id) },
      { label: 'Forward', icon: ArrowRight, disabled: !t.canGoForward, shortcut: 'forward', onSelect: () => b.go(1, t.id) },
      { label: 'Reload', icon: RotateCw, shortcut: 'reload', onSelect: () => b.reload(t.id) },
    );
    if (b.hasCapability('selectAll') || b.hasCapability('print')) sep();
    if (b.hasCapability('selectAll')) items.push({ label: 'Select all', icon: TextSelect, onSelect: () => b.action('selectAll', t.id) });
    if (b.hasCapability('print')) items.push({ label: 'Print…', icon: Printer, onSelect: () => b.action('print', t.id) });
    if (t.url) {
      const url = t.url;
      sep();
      items.push({ label: 'Bookmark page', icon: Bookmark, shortcut: 'bookmarkPage', onSelect: () => b.editBookmark(url, t.title) });
    }
  }
  return items;
}
