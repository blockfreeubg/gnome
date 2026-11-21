<!--
  The browser engine: the engine and transport versions the engine host reported in its last `init`
  (InitResult.versions), what proxied pages never get (ENGINE-PROTOCOL §6.14), and the known limitations of the
  engines and of GNOME (ARCHITECTURE §5.4). Versions are "not started yet" until the browser has run in this page.
-->
<script lang="ts">
  import SectionHeader from '../../components/SectionHeader.svelte';
  import { engineFacts } from '../../browser/engine/facts.svelte';

  const v = $derived(engineFacts.versions);

  const NEVER: ReadonlyArray<{ what: string; why: string }> = [
    { what: 'Camera, microphone, location and notifications', why: 'A grant would belong to the proxy origin, so every proxied site would share it.' },
    { what: 'Pop-up windows', why: 'Pages open GNOME tabs instead; without a click in the page, the toolbar holds them back.' },
    { what: 'Security keys and passkeys (WebAuthn), payments, MIDI, USB, serial, HID', why: 'Never delegated to the browser engine.' },
    { what: 'Screen capture, wake lock, Web Share and XR', why: 'Never delegated to the browser engine.' },
    { what: 'Their own service workers', why: 'GNOME’s service worker runs the engines, and the engines do not let pages register one (a site built to attack GNOME can get around that).' },
  ];

  const LIMITS: readonly string[] = [
    'Neither engine rewrites every CSS construct; the addresses it misses are blocked by GNOME’s content security policy instead of loading directly (some icons stay blank, e.g. on Wikipedia).',
    'Some sites detect the proxy (its TLS fingerprint) or need a real pop-up with a link back to the opener (some sign-ins and payments): use a full-page sign-in there.',
    'Scramjet: synchronous XMLHttpRequest, WebSockets in workers and localStorage.clear()/key() do not work; in Firefox its blob and URL workers time out.',
    'Ultraviolet: dynamic import() fails, and in Firefox its workers error.',
    'Downloads belong to your browser: GNOME lists them but cannot pause or cancel them, and does not see downloads a page builds itself (blob: and data: links).',
    'Per-site autoplay and fullscreen choices apply from the next page you open in GNOME (address bar, reload, back or forward), only where this browser lets GNOME enforce them, and only for sites that do not attack GNOME: a site built to attack GNOME can lift them for itself.',
    'Pages can always write to the clipboard after a click, as in a normal browser: no browser lets GNOME block every way of copying, so there is no clipboard setting.',
    'Sites you open in GNOME are not kept apart as in a normal browser. Neither engine enforces the cross-origin rules (CORS), and Ultraviolet sends every cookie of a site with every request to it, whatever the site asked for (SameSite). So any site you open in GNOME can read pages of other sites you are signed in to inside GNOME (under Scramjet: those whose sign-in cookie allows cross-site use) and send them forged requests. Do not sign in to sensitive accounts inside GNOME.',
    'Pop-ups and shortcuts that open GNOME’s own pages need a real click or key press inside the page.',
    'Blocking WebRTC stops sites that use it in the usual way. A site built to get around it can still send traffic directly, outside GNOME, and reveal your IP address. GNOME cannot close these gaps from inside a web page.',
    'The address bar and the VPN check show what pages report. A site built to attack GNOME can make them say anything, so neither is proof of a site’s identity or of your route.',
    'A site built to attack GNOME can take over GNOME’s browser engine inside the browser view. From there it can read and change your other GNOME tabs’ pages and their cookies, and use your connection ticket until it expires (an hour by default). It cannot reach your GNOME account, settings, history or bookmarks.',
    'In Chromium, a site built to attack GNOME can also make your browser open a connection to a server of its choice (without sending it a request), which shows that server your IP address.',
    'Ultraviolet: sites cannot use shared workers. GNOME refuses them, because Ultraviolet would run them outside its protection.',
    'SVG, XHTML and XML documents, and pages sent without a content type, open without running their scripts, in both engines. Under Ultraviolet, so do pages whose content type is not exactly text/html. Pages that need those scripts do not work.',
    'Web pages embedded with <object> or <embed> do not load inside GNOME.',
    'In Firefox, GNOME may stop responding while a page’s print dialog is open (a page’s print() blocks the whole browser view). It works again when you close the dialog.',
  ];
</script>

<section class="section" aria-labelledby="engine">
  <SectionHeader id="engine" variant="title" title="Browser engine" description="How pages are proxied, and what proxied pages cannot do." />

  <dl class="versions">
    {#if v}
      <div><dt>Build</dt><dd class="mono">{v.build}</dd></div>
      <div><dt>Scramjet</dt><dd class="mono">{v.scramjet} · controller {v.scramjetController}</dd></div>
      <div><dt>Ultraviolet</dt><dd class="mono">{v.ultraviolet} · bare-mux {v.bareMux}</dd></div>
      <div><dt>Transports</dt><dd class="mono">libcurl {v.transports.scramjet.libcurl} / {v.transports.ultraviolet.libcurl} · epoxy {v.transports.scramjet.epoxy} / {v.transports.ultraviolet.epoxy}</dd></div>
    {:else}
      <div><dt>Versions</dt><dd>Shown once the browser engine has started in this page (open a page in the browser).</dd></div>
    {/if}
  </dl>

  <h3 class="eyebrow">Never available to proxied pages</h3>
  <ul class="list" role="list">
    {#each NEVER as n (n.what)}
      <li><strong>{n.what}.</strong> {n.why}</li>
    {/each}
  </ul>

  <h3 class="eyebrow">Known limitations</h3>
  <ul class="list" role="list">
    {#each LIMITS as l (l)}
      <li>{l}</li>
    {/each}
  </ul>
</section>

<style>
  .versions {
    display: grid;
    gap: 0;
    margin: var(--space-4) 0 var(--space-8);
    border-top: 1px solid var(--hairline);
  }

  .versions div {
    display: grid;
    grid-template-columns: 140px minmax(0, 1fr);
    gap: var(--space-4);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--hairline);
    font-size: var(--text-sm);
  }

  dt {
    color: var(--text-3);
  }

  dd {
    margin: 0;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  h3 {
    margin: var(--space-6) 0 var(--space-3);
  }

  .list {
    margin: 0;
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

  .list strong {
    color: var(--text);
    font-weight: 600;
  }

  @media (max-width: 759px) {
    .versions div {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }
  }
</style>
