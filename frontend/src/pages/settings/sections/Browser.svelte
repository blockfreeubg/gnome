<script lang="ts">
  import Input from '../../../components/Input.svelte';
  import Select from '../../../components/Select.svelte';
  import Slider from '../../../components/Slider.svelte';
  import Switch from '../../../components/Switch.svelte';
  import { SEARCH_ENGINES } from '../../../settings/defaults';
  import { engineFacts } from '../../../browser/engine/facts.svelte';
  import { isFeatureActive } from '../../../settings/features';
  import type { Settings } from '../../../settings/schema';
  import { settings } from '../../../settings/store.svelte';
  import Group from '../Group.svelte';
  import ListEditor from '../ListEditor.svelte';
  import Row from '../Row.svelte';
  import { parseStartUrl, searchTemplateError } from '../urls';

  type Browser = Settings['browser'];
  const S = 'browser' as const;
  const b = $derived(settings.value.browser);
  const set = <K extends keyof Browser>(k: K, v: Browser[K]): void => void settings.set(S, k, v);

  const engines = [
    ...Object.entries(SEARCH_ENGINES).map(([value, e]) => ({ value: value as Browser['searchEngine'], label: e.label })),
    { value: 'custom' as const, label: 'Custom…' },
  ];

  let customDraft = $derived(b.customSearchUrl);
  let customError = $state<string | null>(null);
  function commitCustom(): void {
    customError = searchTemplateError(customDraft);
    if (!customError) set('customSearchUrl', customDraft.trim());
  }

  let homeDraft = $derived(b.homepage);
  let homeError = $state<string | null>(null);
  function commitHome(): void {
    const r = parseStartUrl(homeDraft || 'gnome://home');
    if ('error' in r) {
      homeError = r.error;
      return;
    }
    homeError = null;
    homeDraft = r.value;
    set('homepage', r.value);
  }

  let newTabDraft = $derived(b.newTabUrl);
  let newTabError = $state<string | null>(null);
  function commitNewTab(): void {
    if (!newTabDraft.trim()) {
      newTabError = null;
      set('newTabUrl', '');
      return;
    }
    const r = parseStartUrl(newTabDraft);
    if ('error' in r) {
      newTabError = r.error;
      return;
    }
    newTabError = null;
    newTabDraft = r.value;
    set('newTabUrl', r.value);
  }

  const RETENTION = [
    { value: '7', label: '1 week' },
    { value: '30', label: '30 days' },
    { value: '90', label: '90 days' },
    { value: '365', label: '1 year' },
    { value: '0', label: 'Forever' },
  ];
  const retentionOptions = $derived(
    RETENTION.some((r) => r.value === String(b.history.retentionDays))
      ? RETENTION
      : [...RETENTION, { value: String(b.history.retentionDays), label: `${b.history.retentionDays} days` }],
  );
  const KEEP = [
    { value: '1', label: '1 day' },
    { value: '7', label: '1 week' },
    { value: '30', label: '30 days' },
    { value: '90', label: '90 days' },
    { value: '0', label: 'Until I clear it' },
  ];
  const keepOptions = $derived(
    KEEP.some((r) => r.value === String(b.downloads.keepDays)) ? KEEP : [...KEEP, { value: String(b.downloads.keepDays), label: `${b.downloads.keepDays} days` }],
  );
</script>

<Group title="Search">
  <Row section={S} id="searchEngine">
    {#snippet control()}
      <Select value={b.searchEngine} options={engines} onchange={(v) => set('searchEngine', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="customSearchUrl" stacked error={customError} disabled={b.searchEngine !== 'custom'}>
      {#snippet control()}
        <Input
          bind:value={customDraft}
          placeholder="https://search.example/?q=%s"
          mono
          spellcheck={false}
          autocomplete="off"
          onchange={commitCustom}
          onkeydown={(e) => e.key === 'Enter' && commitCustom()}
          class="wide-input"
        />
      {/snippet}
    </Row>
  <!-- Only where the browser engine fetches suggestions (capability `suggest`): otherwise the switch would do nothing. -->
  {#if engineFacts.capabilities.includes('suggest')}
    <Row section={S} id="searchSuggestions">
      {#snippet control()}
        <Switch checked={b.searchSuggestions} onchange={(v) => set('searchSuggestions', v)} />
      {/snippet}
    </Row>
  {/if}
</Group>

<Group title={isFeatureActive('browser') ? 'Start-up and new tabs' : 'Home page'}>
  <Row section={S} id="homepage" error={homeError}>
    {#snippet control()}
      <Input
        bind:value={homeDraft}
        placeholder="gnome://home"
        mono
        size="sm"
        spellcheck={false}
        autocomplete="off"
        onchange={commitHome}
        onkeydown={(e) => e.key === 'Enter' && commitHome()}
        class="url-input"
      />
    {/snippet}
  </Row>
  <Row section={S} id="startup">
    {#snippet control()}
      <Select
        value={b.startup}
        options={[
          { value: 'home', label: 'Open the home page' },
          { value: 'restore', label: 'Restore the last session' },
          { value: 'urls', label: 'Open specific pages' },
        ]}
        onchange={(v) => set('startup', v)}
      />
    {/snippet}
  </Row>
    <Row section={S} id="startupUrls" stacked disabled={b.startup !== 'urls'}>
      {#snippet control()}
        <ListEditor
          items={b.startupUrls}
          inputLabel="Add a start-up page"
          placeholder="example.com or gnome://games"
          emptyText="No pages yet. GNOME opens the home page until you add one."
          addLabel="Add page"
          max={50}
          parse={parseStartUrl}
          onchange={(items) => set('startupUrls', items)}
        />
      {/snippet}
    </Row>
  <Row section={S} id="newTab">
    {#snippet control()}
      <Select
        value={b.newTab}
        options={[
          { value: 'home', label: 'Home page' },
          { value: 'blank', label: 'Blank page' },
          { value: 'url', label: 'A specific page' },
        ]}
        onchange={(v) => set('newTab', v)}
      />
    {/snippet}
  </Row>
    <Row section={S} id="newTabUrl" error={newTabError} disabled={b.newTab !== 'url'}>
      {#snippet control()}
        <Input
          bind:value={newTabDraft}
          placeholder="example.com"
          mono
          size="sm"
          spellcheck={false}
          autocomplete="off"
          onchange={commitNewTab}
          onkeydown={(e) => e.key === 'Enter' && commitNewTab()}
          class="url-input"
        />
      {/snippet}
    </Row>
</Group>

<Group title="Tabs">
  <Row section={S} id="openLinksInBackground">
    {#snippet control()}
      <Switch checked={b.openLinksInBackground} onchange={(v) => set('openLinksInBackground', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="closeTabActivates">
    {#snippet control()}
      <Select
        value={b.closeTabActivates}
        options={[
          { value: 'right', label: 'The tab to the right' },
          { value: 'left', label: 'The tab to the left' },
          { value: 'last-used', label: 'The last used tab' },
        ]}
        onchange={(v) => set('closeTabActivates', v)}
      />
    {/snippet}
  </Row>
  <Row section={S} id="confirmCloseMultiple">
    {#snippet control()}
      <Switch checked={b.confirmCloseMultiple} onchange={(v) => set('confirmCloseMultiple', v)} />
    {/snippet}
  </Row>
  <!-- Hidden while the browser engine offers no zoom (capability `zoom`, docs/WAVE-B.md §7). -->
  {#if engineFacts.capabilities.includes('zoom')}
    <Row section={S} id="defaultZoom">
      {#snippet control()}
        <Slider value={b.defaultZoom} min={0.5} max={2} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onchange={(v) => set('defaultZoom', Math.round(v * 100) / 100)} class="slider" />
      {/snippet}
    </Row>
  {/if}
</Group>

<Group title="History and downloads">
  <Row section={S} id="history">
    {#snippet control()}
      <Switch checked={b.history.enabled} onchange={(v) => set('history', { ...b.history, enabled: v })} />
    {/snippet}
  </Row>
  <Row section={S} id="historyRetention" disabled={!b.history.enabled}>
    {#snippet control()}
      <Select
        value={String(b.history.retentionDays)}
        options={retentionOptions}
        onchange={(v) => set('history', { ...b.history, retentionDays: Number(v) })}
      />
    {/snippet}
  </Row>
  <Row section={S} id="downloadsTrack">
    {#snippet control()}
      <Switch checked={b.downloads.track} onchange={(v) => set('downloads', { ...b.downloads, track: v })} />
    {/snippet}
  </Row>
  <Row section={S} id="downloadsPanel">
    {#snippet control()}
      <Switch checked={b.downloads.openPanelOnStart} onchange={(v) => set('downloads', { ...b.downloads, openPanelOnStart: v })} />
    {/snippet}
  </Row>
  <Row section={S} id="downloadsKeep" disabled={!b.downloads.track}>
    {#snippet control()}
      <Select value={String(b.downloads.keepDays)} options={keepOptions} onchange={(v) => set('downloads', { ...b.downloads, keepDays: Number(v) })} />
    {/snippet}
  </Row>
</Group>

<style>
  :global(.setting-row .url-input) {
    width: min(300px, 70vw);
  }

  :global(.setting-row .wide-input) {
    width: 100%;
    max-width: 560px;
  }
</style>
