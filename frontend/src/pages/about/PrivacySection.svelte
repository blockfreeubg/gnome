<!--
  Privacy: exactly what is stored where (docs/ARCHITECTURE.md §4.3, §5.2; docs/API.md), and the live proxy isolation
  status from GET /api/config → proxy (degrades to "unknown" when the server is offline or does not report it).
-->
<script lang="ts">
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import ShieldOff from '@lucide/svelte/icons/shield-off';
  import Shield from '@lucide/svelte/icons/shield';
  import Icon from '../../components/Icon.svelte';
  import SectionHeader from '../../components/SectionHeader.svelte';
  import { server } from '../../app/server.svelte';
  import { isolationStatus } from './about';

  interface Row {
    what: string;
    where: string;
    server: string;
  }

  const rows: readonly Row[] = [
    {
      what: 'Settings',
      where: 'This browser (IndexedDB, plus a localStorage copy so your theme applies before the page draws)',
      server: 'Only if you sign in and turn on sync',
    },
    { what: 'Bookmarks', where: 'This browser', server: 'Only if you sign in and turn on sync' },
    { what: 'History', where: 'This browser', server: 'Only if you also turn on history sync, which is off by default' },
    { what: 'Open tabs, closed tabs and downloads list', where: 'This browser', server: 'Never' },
    {
      what: 'Cookies and site data of sites you visit',
      where: 'This browser, under the proxy origin',
      server: 'Never stored. For HTTPS sites they travel inside encryption your browser sets up',
    },
    {
      what: 'Account',
      where:
        'The server: your username, an Argon2id password hash and hashed session tokens. While you are signed in, this browser also keeps your username, so it can show it before the server answers',
      server: 'Only if you create an account',
    },
    { what: 'Game plays', where: 'The server: one anonymous counter per game', server: 'No user or session is stored with it' },
    {
      what: 'Server logs',
      where: 'The server: requested paths without query strings',
      server: 'IP addresses only if the operator turns that on; Wisp destinations are never logged',
    },
  ];

  const isolation = $derived(isolationStatus(server.config, server.reachable));
  const isolationIcon = $derived(isolation.state === 'on' ? ShieldCheck : isolation.state === 'off' ? ShieldOff : Shield);
</script>

<section class="section" aria-labelledby="privacy">
  <SectionHeader
    id="privacy"
    variant="title"
    title="Privacy"
    description="Your data stays in this browser unless you choose to sync it."
  />

  <ul class="principles">
    <li><strong>No analytics and no tracking scripts.</strong> Fonts and icons are served by this server.</li>
    <li><strong>The server keeps only what you sync.</strong> Settings, bookmarks and history are local by default.</li>
    <li>
      {#if isolation.state === 'on'}
        <strong>Proxied pages run apart from GNOME.</strong> They get their own origin, so they cannot read your settings,
        history or bookmarks.
      {:else if isolation.state === 'off'}
        <strong>Proxied pages share GNOME’s origin on this server.</strong> Its operator has not given them an origin of
        their own; see proxy isolation below.
      {:else}
        <strong>Proxied pages are meant to run apart from GNOME.</strong> With proxy isolation on, they get their own
        origin and cannot read your settings, history or bookmarks; see its status below.
      {/if}
    </li>
    <li>
      <strong>Games come from their publishers.</strong> Embedded games load directly from the publisher, are not proxied,
      and follow the publisher’s own privacy policy.
    </li>
    <li>
      <strong>You trust whoever runs this server.</strong> GNOME keeps the server’s view small, but like any proxy, its
      operator controls it.
    </li>
  </ul>

  <div class="table-wrap">
    <table class="table">
      <caption class="sr-only">What GNOME stores and where</caption>
      <thead>
        <tr>
          <th scope="col">Data</th>
          <th scope="col">Kept in</th>
          <th scope="col">Sent to the server</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.what)}
          <tr>
            <th scope="row">{row.what}</th>
            <td>{row.where}</td>
            <td>{row.server}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <div class="isolation {isolation.state}" id="isolation" aria-live="polite">
    <span class="iso-icon"><Icon icon={isolationIcon} size={20} /></span>
    <div class="iso-text">
      <p class="iso-title">Proxy isolation: <strong>{isolation.title}</strong></p>
      <p class="iso-detail">{isolation.detail}</p>
      {#if isolation.origin}
        <p class="iso-origin">Proxy origin <span class="mono">{isolation.origin}</span></p>
      {/if}
    </div>
  </div>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .principles {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: var(--space-10);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .principles li {
    position: relative;
    padding: var(--space-3) 0 var(--space-3) var(--space-5);
    border-top: 1px solid var(--hairline);
    color: var(--text-2);
    line-height: 1.55;
  }

  .principles li::before {
    content: '';
    position: absolute;
    left: 2px;
    top: calc(var(--space-3) + 0.62em);
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-3);
  }

  .principles strong {
    color: var(--text);
    font-weight: 600;
  }

  .table-wrap {
    overflow-x: auto;
  }

  .table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-md);
  }

  .table thead th {
    padding: 0 var(--space-4) var(--space-2) 0;
    text-align: left;
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: var(--tracking-eyebrow);
    text-transform: uppercase;
    color: var(--text-3);
    border-bottom: 1px solid var(--hairline-strong);
  }

  .table tbody th,
  .table td {
    padding: var(--space-3) var(--space-4) var(--space-3) 0;
    border-bottom: 1px solid var(--hairline);
    vertical-align: top;
    text-align: left;
    line-height: 1.5;
  }

  .table tbody th {
    width: 24%;
    font-weight: 600;
    color: var(--text);
  }

  .table td {
    color: var(--text-2);
  }

  .table td:last-child {
    width: 34%;
  }

  .isolation {
    display: flex;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-5);
    border: 1px solid var(--field-border);
    border-radius: var(--radius-lg);
    background: var(--field-bg);
  }

  .iso-icon {
    flex: none;
    display: grid;
    place-items: start;
    padding-top: 1px;
    color: var(--text-3);
  }

  .on .iso-icon {
    color: var(--success);
  }

  .off .iso-icon {
    color: var(--warning);
  }

  .iso-text {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .iso-title {
    color: var(--text);
  }

  .iso-title strong {
    font-weight: 600;
  }

  .iso-detail {
    color: var(--text-2);
    line-height: 1.55;
  }

  .iso-origin {
    font-size: var(--text-sm);
    color: var(--text-3);
    overflow-wrap: anywhere;
  }

  .iso-origin .mono {
    color: var(--text-2);
  }

  @media (max-width: 759px) {
    .principles {
      grid-template-columns: minmax(0, 1fr);
    }

    /* Stack each row: the data name as a heading, then where it is kept and what reaches the server. */
    .table thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }

    .table,
    .table tbody,
    .table tr,
    .table th,
    .table td {
      display: block;
      width: auto !important;
    }

    .table tr {
      padding: var(--space-3) 0;
      border-bottom: 1px solid var(--hairline);
    }

    .table tbody th,
    .table td {
      padding: 0;
      border: 0;
    }

    .table tbody th {
      margin-bottom: 4px;
    }

    .table td + td {
      margin-top: 4px;
    }

    .table td:last-child::before {
      content: 'Server: ';
      color: var(--text-3);
    }
  }
</style>
