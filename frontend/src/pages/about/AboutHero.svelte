<!--
  About hero (DESIGN.md §12): one glass card with the monochrome mark + wordmark, the lede and version facts from the
  app build and GET /api/config, beside the original artwork (logo.png, shown as-is on a white mat so its white JPEG
  background reads as a mounted print) and the original colored mark.
-->
<script lang="ts">
  import Logo from '../../components/Logo.svelte';
  import { server } from '../../app/server.svelte';
  import { ACCESS_MODE_LABELS, engineSummary, isolationStatus } from './about';

  const appVersion = __GNOME_VERSION__;
  const buildKind = import.meta.env.PROD ? 'production build' : 'development build';

  const config = $derived(server.config);
  const isolation = $derived(isolationStatus(config, server.reachable));
  const serverLine = $derived(
    config ? config.version : server.reachable === null ? 'Checking…' : 'Not reachable',
  );
</script>

<section class="hero" aria-labelledby="about-overview">
  <div class="intro">
    <div class="brand">
      <Logo size={64} decorative priority />
      <h2 id="about-overview" class="wordmark name">GNOME</h2>
    </div>
    <p class="lede">
      A self-hostable web proxy, a browser that runs inside your browser, and a library of games. It is a website:
      nothing is installed on your device.
    </p>

    <dl class="facts">
      <div class="fact">
        <dt>App</dt>
        <dd><span class="mono tabular">{appVersion}</span> <span class="subtle">· {buildKind}</span></dd>
      </div>
      <div class="fact">
        <dt>Server</dt>
        <dd>
          <span class:mono={!!config} class="tabular">{serverLine}</span>
          {#if config}<span class="subtle">· {ACCESS_MODE_LABELS[config.access_mode]}</span>{/if}
        </dd>
      </div>
      <div class="fact">
        <dt>Engines</dt>
        <dd>{config ? engineSummary(config) : 'Scramjet · Ultraviolet'}</dd>
      </div>
      <div class="fact">
        <dt>Proxy isolation</dt>
        <dd>
          <a class="state {isolation.state}" href="#isolation">
            <span class="dot" aria-hidden="true"></span>{isolation.title}
          </a>
        </dd>
      </div>
    </dl>
  </div>

  <div class="art">
    <figure class="piece original">
      <div class="mat">
        <img
          src="/logo.png"
          width="392"
          height="510"
          alt="The original GNOME artwork: a hand-made felt gnome with a tall olive hat, a long wheat-coloured beard, a twig staff and a small spotted mushroom."
          decoding="async"
          fetchpriority="high"
          draggable="false"
        />
      </div>
      <figcaption>Original artwork</figcaption>
    </figure>
    <figure class="piece cutout">
      <div class="plinth">
        <Logo variant="color" size={192} decorative />
      </div>
      <figcaption>Original mark</figcaption>
    </figure>
  </div>
</section>

<style>
  /* One glass card (DESIGN.md §9.4): text and facts on the left, the original artwork on the right. */
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--space-10);
    align-items: center;
    padding: var(--space-8) var(--space-8) var(--space-8) var(--space-10);
    background: var(--glass-bg-card);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-2xl);
    box-shadow: var(--glass-inset), var(--shadow-raise);
  }

  .brand {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    color: var(--text);
  }

  .name {
    margin: 0;
    font-size: clamp(2.6rem, 4.6vw, 3.43rem);
    color: var(--text);
    transform: translateY(0.06em);
  }

  .intro {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-width: 0;
  }

  .lede {
    max-width: 52ch;
    font-size: 15px;
    line-height: 1.6;
    color: var(--text-2);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-2);
    margin: var(--space-2) 0 0;
  }

  .fact {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    background: var(--field-bg);
    min-width: 0;
  }

  dt {
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: var(--tracking-eyebrow);
    text-transform: uppercase;
    color: var(--text-3);
  }

  dd {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--text);
    text-decoration: none;
    border-radius: var(--radius-sm);
  }

  .state:hover {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-3);
    flex: none;
  }

  .on .dot {
    background: var(--success);
    box-shadow: 0 0 0 3px var(--success-soft);
  }

  .off .dot {
    background: var(--warning);
    box-shadow: 0 0 0 3px var(--warning-soft);
  }

  .art {
    display: flex;
    align-items: flex-end;
    gap: var(--space-4);
  }

  .piece {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    margin: 0;
  }

  figcaption {
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: var(--tracking-eyebrow);
    text-transform: uppercase;
    color: var(--text-3);
  }

  /* A white mat: the JPEG's white ground reads as a mounted print rather than a missing cutout. */
  .mat {
    padding: 12px 12px 14px;
    background: #fff;
    border-radius: var(--radius-lg);
    box-shadow:
      0 0 0 1px var(--hairline-strong),
      0 18px 40px -20px rgba(0, 0, 0, 0.6);
  }

  .mat img {
    display: block;
    width: 150px;
    height: auto;
    border-radius: calc(var(--radius-lg) - 8px);
  }

  .plinth {
    display: grid;
    place-items: end center;
    /* same outer box as the mat (150 + 24 wide, 195 + 26 tall) so the two pieces line up */
    width: 174px;
    height: 221px;
    padding-bottom: 8px;
    border-radius: var(--radius-lg);
    background: var(--field-bg);
    box-shadow: inset 0 0 0 1px var(--hairline);
  }

  @media (max-width: 1100px) {
    .hero {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-8);
      padding: var(--space-8);
    }

    .art {
      justify-content: flex-start;
    }
  }

  @media (max-width: 759px) {
    .hero {
      padding: var(--space-6) var(--space-5);
      border-radius: var(--radius-xl);
    }

    .brand {
      gap: 12px;
    }

    .brand :global(svg) {
      height: 48px;
      width: auto;
    }

    .name {
      font-size: 2.3rem;
    }

    /* One well with hairline rows: label left, value right (two tiles side by side wrap every value at 390px). */
    .facts {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
      border: 1px solid var(--hairline);
      border-radius: var(--radius-lg);
      background: var(--field-bg);
    }

    .fact {
      flex-direction: row;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--space-4);
      padding: 11px 14px;
      border: 0;
      border-radius: 0;
      background: none;
    }

    .fact + .fact {
      border-top: 1px solid var(--hairline);
    }

    .fact dt {
      flex: none;
    }

    .fact dd {
      text-align: right;
    }

    /* Two equal columns, so the print and the cutout keep the same box at every phone width. */
    .art {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 150px));
      justify-content: center;
      align-items: end;
      gap: var(--space-3);
    }

    .piece {
      min-width: 0;
    }

    .mat {
      box-sizing: border-box;
      width: 100%;
      padding: 8px 8px 10px;
    }

    .mat img {
      width: 100%;
    }

    .plinth {
      width: 100%;
      height: auto;
      aspect-ratio: 133 / 170;
      padding-bottom: 6px;
    }

    .plinth :global(.logo) {
      width: 74%;
    }

    .plinth :global(.logo picture),
    .plinth :global(.logo img) {
      width: 100%;
      height: auto;
    }
  }
</style>
