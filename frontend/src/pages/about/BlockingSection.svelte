<!--
  Content blocking (WAVE-B3 §14 "About"): what GNOME's built-in extensions do not do, in plain words. Shown once the
  built-in extensions are registered (registerFeature('extensions')). The filter engine and the lists are credited
  with their licenses under Licenses (licenses.ts, group `blocking`, and the server's own /api/filters listing).
-->
<script lang="ts">
  import SectionHeader from '../../components/SectionHeader.svelte';

  /** Each item holds in both engines and browsers today; fallbacks the integration step's matrix leaves are added by it. */
  const LIMITS: readonly string[] = [
    'A site built to target GNOME can break out of GNOME’s browser engine, then turn blocking off and read the site rules of the sites you have open and all of your cookie rules: every site opened in GNOME runs inside one shared engine.',
    'Not supported: procedural cosmetic filters, HTML filtering, and the $csp, $popup, $urlskip, $header, $cookie and $removeheader rules, and $removeparam rules written as regular expressions.',
    'Tracking parameters are removed from pages you open, not from requests inside them.',
    'Cookies on WebSocket connections are not controlled, and the storage of third-party frames is not kept apart.',
    'Workers and blank frames get the Global Privacy Control header but not navigator.globalPrivacyControl.',
    'Requests whose page GNOME cannot tell are treated as third-party under your global settings, without site rules.',
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
