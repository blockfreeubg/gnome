<!--
  Content blocking (WAVE-B3 §14 "About"): what GNOME's built-in extensions do not do, in plain words. Shown once the
  built-in extensions are registered (registerFeature('extensions')). The filter engine and the lists are credited
  with their licenses under Licenses (licenses.ts, group `blocking`, and the server's own /api/filters listing).
-->
<script lang="ts">
  import SectionHeader from '../../components/SectionHeader.svelte';

  /**
   * Each item was measured in both engines and browsers (WAVE-B3 §12, rows named in docs/ENGINE-PROTOCOL.md §1.1 and
   * §7); engine-wide limits (CORS, workers, frames) are in the Browser engine section.
   */
  const LIMITS: readonly string[] = [
    'A site built to target GNOME can break out of GNOME’s browser engine, then turn blocking off and read the site rules of the sites you have open and all of your cookie rules: every site opened in GNOME runs inside one shared engine.',
    'In Ultraviolet pages, a site built to target GNOME can open WebSocket connections past GNOME’s blocking (through the proxy’s own transport library). In Scramjet pages, a WebSocket opened past GNOME’s per-page hook is judged without your per-site settings.',
    'Not supported: procedural cosmetic filters, HTML filtering, and the $csp, $popup, $urlskip, $header, $cookie and $removeheader rules, and $removeparam rules written as regular expressions.',
    'Hiding rules that select links by their address (for example a[href^=…]) do not apply in pages opened in GNOME: both proxy engines rewrite link addresses in the page.',
    'Rules that would hide a page’s root or body, or GNOME’s find-in-page highlights, are removed; style rules on the root or body are kept only when they restore the page (scrolling, backgrounds).',
    'A page opened before the filter lists were ready (the first start, or after site data was cleared) gets its hiding rules when they are, but not its scriptlets.',
    'Generic cosmetic filters watch at most 4,096 class names, ids and link addresses and add at most 512 KiB of rules per page, and stop when you leave the page (a page restored from the back/forward cache gets no new generic rules).',
    'Scriptlets meant to run in a separate script world run in the page’s own world.',
    'Tracking parameters are removed from pages you open (tabs and frames), not from requests inside them.',
    'With Scramjet, a page’s <meta name="referrer"> policy does not apply to the images and links in its HTML: they still send the page’s origin, never more, to other sites. In Firefox, Scramjet pages see no document.referrer after a link; GNOME never adds one.',
    'Cookies on WebSocket connections are not controlled, and the storage of embedded sites (localStorage, IndexedDB) is not kept apart per site.',
    'Under Ultraviolet, any page can open the engine’s own cookie store and read or change the cookies of every site, HttpOnly cookies included: the cookie manager cannot stop a page built to target GNOME.',
    'With Scramjet, a cookie without a SameSite attribute is not sent with a form another site posts (browsers allow it for two minutes after it was set), and Scramjet treats sites under shared suffixes such as github.io or co.uk as one site for SameSite; with Block third-party cookies (the default) GNOME keeps them apart.',
    'A cookie a page sets by JavaScript under an “Until GNOME closes” rule keeps its expiry until GNOME’s next fresh start, which deletes the site’s cookies. Setting document.cookie to a value that is not a string is ignored.',
    'Workers and blank frames get the Global Privacy Control header but not navigator.globalPrivacyControl.',
    'Requests whose page GNOME cannot tell are treated as third-party under your global settings, without site rules.',
    'In Firefox, one unexpected restart of GNOME’s browser engine counts as two warning signs, so site rules pause after the first one (in Chromium after the second).',
    'The first start (and the first after site data was cleared) prepares the filter lists inside your browser: about 1.5 seconds for the default lists on a desktop computer in GNOME’s tests, longer on slower devices. Until then, pages are not filtered by the lists; privacy headers and cookie rules apply at once.',
    'There is no “proceed once” on a blocked page, and no custom filters of your own.',
  ];
</script>

<section class="section" aria-labelledby="blocking">
  <SectionHeader id="blocking" variant="title" title="Content blocking" description="What GNOME’s built-in extensions do not do. They run inside GNOME’s browser on the sites you open there; filter lists are mirrored from their publishers by this server." />
  <ul class="list" role="list">
    {#each LIMITS as l (l)}
      <li>{l}</li>
    {/each}
  </ul>
</section>

<style>
  .list {
    margin: var(--space-4) 0 0;
    padding: 0;
    display: grid;
    gap: var(--space-2);
    color: var(--text-2);
    font-size: 13px;
    line-height: 1.6;
    max-width: 76ch;
  }

  .list li {
    padding-left: var(--space-4);
    position: relative;
  }

  .list li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0.7em;
    width: 5px;
    height: 1px;
    background: var(--text-3);
  }
</style>
