<!--
  Component gallery (dev/QA only): every design-system component (docs/DESIGN.md §10) on one page, wired to a visible
  event log so scripts/visual-qa.mjs can drive each keyboard path in a real browser and check what happened.
-->
<script lang="ts">
  import Archive from '@lucide/svelte/icons/archive';
  import Copy from '@lucide/svelte/icons/copy';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import FolderInput from '@lucide/svelte/icons/folder-input';
  import Gamepad2 from '@lucide/svelte/icons/gamepad-2';
  import Globe from '@lucide/svelte/icons/globe';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Pin from '@lucide/svelte/icons/pin';
  import Plus from '@lucide/svelte/icons/plus';
  import Search from '@lucide/svelte/icons/search';
  import Star from '@lucide/svelte/icons/star';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Wifi from '@lucide/svelte/icons/wifi';
  import Badge from '../src/components/Badge.svelte';
  import Button from '../src/components/Button.svelte';
  import Checkbox from '../src/components/Checkbox.svelte';
  import Chip from '../src/components/Chip.svelte';
  import ColorPicker from '../src/components/ColorPicker.svelte';
  import Combobox from '../src/components/Combobox.svelte';
  import ConfirmDialog from '../src/components/ConfirmDialog.svelte';
  import Dialog from '../src/components/Dialog.svelte';
  import Divider from '../src/components/Divider.svelte';
  import EmptyState from '../src/components/EmptyState.svelte';
  import Field from '../src/components/Field.svelte';
  import IconButton from '../src/components/IconButton.svelte';
  import Input from '../src/components/Input.svelte';
  import Kbd from '../src/components/Kbd.svelte';
  import ListRow from '../src/components/ListRow.svelte';
  import Logo from '../src/components/Logo.svelte';
  import Menu from '../src/components/Menu.svelte';
  import type { MenuItem } from '../src/components/menu';
  import PageHeader from '../src/components/PageHeader.svelte';
  import Popover from '../src/components/Popover.svelte';
  import ProgressBar from '../src/components/ProgressBar.svelte';
  import RadioGroup from '../src/components/RadioGroup.svelte';
  import ScrollArea from '../src/components/ScrollArea.svelte';
  import SearchInput from '../src/components/SearchInput.svelte';
  import SectionHeader from '../src/components/SectionHeader.svelte';
  import SegmentedControl from '../src/components/SegmentedControl.svelte';
  import Select from '../src/components/Select.svelte';
  import SettingRow from '../src/components/SettingRow.svelte';
  import Sheet from '../src/components/Sheet.svelte';
  import Skeleton from '../src/components/Skeleton.svelte';
  import Slider from '../src/components/Slider.svelte';
  import Spinner from '../src/components/Spinner.svelte';
  import Switch from '../src/components/Switch.svelte';
  import Tabs from '../src/components/Tabs.svelte';
  import Tag from '../src/components/Tag.svelte';
  import Textarea from '../src/components/Textarea.svelte';
  import Tooltip from '../src/components/Tooltip.svelte';
  import { tooltip } from '../src/components/tooltip.svelte';
  import VirtualGrid from '../src/components/VirtualGrid.svelte';
  import VirtualList from '../src/components/VirtualList.svelte';
  import Announcer from '../src/app/overlays/Announcer.svelte';
  import ContextMenuHost from '../src/app/overlays/ContextMenuHost.svelte';
  import { isContextMenuKey, openContextMenu } from '../src/app/overlays/contextmenu.svelte';
  import DialogHost from '../src/app/overlays/DialogHost.svelte';
  import { confirm, prompt } from '../src/app/overlays/dialogs.svelte';
  import ToastHost from '../src/app/overlays/ToastHost.svelte';
  import { toast } from '../src/app/overlays/toast.svelte';
  import { ACCENT_PRESETS, accentTokens, TEXT_SURFACES } from '../src/settings/apply';
  import { createDefaultSettings, SEARCH_ENGINES } from '../src/settings/defaults';
  import type { Motion, Theme } from '../src/settings/schema';
  import { applyGalleryAppearance } from './appearance';

  interface Props {
    theme: Theme;
    motion: Motion;
    /** Accent preset id or hex from `?accent=` (review only; the picker below does not change the page). */
    accent?: string;
  }

  let { theme: initialTheme, motion, accent: pageAccent }: Props = $props();

  // ── Event log (read by the QA harness) ──────────────────────────────────────────────────────────────────────────
  let events = $state<string[]>([]);
  function log(msg: string): void {
    events = [...events.slice(-19), msg];
  }
  const last = $derived(events.at(-1) ?? '');

  // ── Appearance (live) ───────────────────────────────────────────────────────────────────────────────────────────
  // svelte-ignore state_referenced_locally
  let theme = $state<Theme>(initialTheme);
  $effect(() => applyGalleryAppearance(theme, motion, pageAccent));

  // ── Controls ────────────────────────────────────────────────────────────────────────────────────────────────────
  let name = $state('');
  let nameError = $derived(name.length > 0 && name.trim().length < 3 ? 'Use at least 3 characters.' : null);
  let query = $state('');
  let notes = $state('');
  type Engine = keyof typeof SEARCH_ENGINES | 'custom';
  let engine = $state<Engine>('duckduckgo');
  const engineOptions = [
    ...Object.entries(SEARCH_ENGINES).map(([value, e]) => ({ value: value as Engine, label: e.label })),
    { value: 'custom' as Engine, label: 'Custom (disabled here)', disabled: true },
  ];
  let wifi = $state(true);
  let agree = $state(false);
  let partial = $state(false);
  let partialIndeterminate = $state(true);
  let density = $state<'compact' | 'comfortable' | 'spacious'>('comfortable');
  let fontSize = $state(14);
  let accent = $state('#9ff0c8');
  let accentPreset = $state<string | null>('mint');
  // The picker shows the values of the theme on screen, like Settings → Appearance (light presets are deep enough to be
  // text on paper; the keyboard QA runs in the dark theme and expects the dark values).
  const lightTheme = $derived(theme === 'light' || (theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches));
  const presetValue = (id: keyof typeof ACCENT_PRESETS): string =>
    lightTheme ? accentTokens({ ...createDefaultSettings().appearance, accentPreset: id }).light.accent : ACCENT_PRESETS[id].dark;
  const presets = $derived(
    (Object.keys(ACCENT_PRESETS) as (keyof typeof ACCENT_PRESETS)[]).map((id) => ({ id, label: ACCENT_PRESETS[id].label, value: presetValue(id) })),
  );
  // A selected preset follows the theme switch; a custom color stays as typed.
  $effect.pre(() => {
    const p = presets.find((x) => x.id === accentPreset);
    if (p) accent = p.value;
  });
  let pinned = $state(false);
  let tab = $state<'general' | 'privacy' | 'advanced'>('general');
  let chipA = $state(true);
  let chipB = $state(false);
  let chipRemoved = $state(false);
  let cardEmail = $state('');
  let cardCode = $state('');
  let cardRemember = $state(true);

  const COUNTRIES = [
    'Argentina', 'Australia', 'Austria', 'Belgium', 'Brazil', 'Canada', 'Chile', 'Denmark', 'Estonia', 'Finland', 'France',
    'Germany', 'Greece', 'Iceland', 'Ireland', 'Italy', 'Japan', 'Netherlands', 'New Zealand', 'Norway', 'Poland',
    'Portugal', 'Spain', 'Sweden', 'Switzerland', 'United Kingdom', 'United States',
  ];
  let country = $state('');
  let countryOpen = $state(false);
  const countryOptions = $derived(
    country.trim() ? COUNTRIES.filter((c) => c.toLowerCase().includes(country.trim().toLowerCase())) : COUNTRIES.slice(0, 8),
  );

  // ── Menus ───────────────────────────────────────────────────────────────────────────────────────────────────────
  let showHidden = $state(false);
  let sort = $state<'name' | 'date'>('name');
  const menuItems = $derived<MenuItem[]>([
    { label: 'Rename', icon: Pencil, shortcut: 'Alt+R', onSelect: () => log('menu: Rename') },
    { label: 'Duplicate', icon: Copy, shortcut: 'duplicateTab', onSelect: () => log('menu: Duplicate') },
    { label: 'Archive', icon: Archive, disabled: true, onSelect: () => log('menu: Archive') },
    { kind: 'separator' },
    { kind: 'checkbox', label: 'Show hidden files', checked: showHidden, onToggle: (v) => ((showHidden = v), log(`menu: hidden=${v}`)) },
    { kind: 'label', label: 'Sort by' },
    { kind: 'radio', label: 'Name', checked: sort === 'name', onSelect: () => ((sort = 'name'), log('menu: sort=name')) },
    { kind: 'radio', label: 'Date', checked: sort === 'date', onSelect: () => ((sort = 'date'), log('menu: sort=date')) },
    { kind: 'separator' },
    {
      kind: 'submenu',
      label: 'Move to',
      icon: FolderInput,
      items: ['Inbox', 'Projects', 'Later'].map((f) => ({ label: f, onSelect: () => log(`menu: move=${f}`) })),
    },
    { kind: 'separator' },
    { label: 'Delete', icon: Trash2, danger: true, onSelect: () => log('menu: Delete') },
  ]);

  function areaMenu(ev: MouseEvent | KeyboardEvent): void {
    openContextMenu(ev, [
      { label: 'Open', onSelect: () => log('context: Open') },
      { label: 'Copy link', icon: Copy, onSelect: () => log('context: Copy link') },
      { kind: 'separator' },
      { label: 'Remove', icon: Trash2, danger: true, onSelect: () => log('context: Remove') },
    ], { label: 'Item actions' });
  }

  // ── Overlays ────────────────────────────────────────────────────────────────────────────────────────────────────
  let popoverOpen = $state(false);
  let popoverAnchor = $state<HTMLButtonElement>();
  let dialogOpen = $state(false);
  let dialogName = $state('');
  let confirmOpen = $state(false);
  let sheetOpen = $state(false);
  let bottomSheetOpen = $state(false);

  async function askConfirm(): Promise<void> {
    log(`confirm: ${await confirm({ title: 'Clear history?', message: 'Every visit is removed from this browser.', confirmLabel: 'Clear', danger: true })}`);
  }

  async function askPrompt(): Promise<void> {
    const v = await prompt({ title: 'Rename folder', label: 'Name', initial: 'Reading list', validate: (s) => (s.trim() ? null : 'Enter a name.') });
    log(`prompt: ${v === null ? 'cancelled' : v}`);
  }

  // ── Virtualization ──────────────────────────────────────────────────────────────────────────────────────────────
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: i, title: `Visit ${i + 1}`, url: `https://site-${i % 97}.example/page/${i}` }));
  const cards = Array.from({ length: 2_000 }, (_, i) => ({ id: i, title: `Game ${i + 1}` }));
  let listActive = $state(-1);
  let gridActive = $state(-1);
</script>

<svelte:head><title>Components · GNOME dev</title></svelte:head>

<main class="gallery" id="main">
  <PageHeader title="Components" description="Every design-system component with its keyboard behaviour, for development and QA.">
    {#snippet actions()}
      <SegmentedControl
        label="Theme"
        bind:value={theme}
        options={[
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
          { value: 'system', label: 'System' },
        ]}
        onchange={(v) => log(`theme: ${v}`)}
      />
    {/snippet}
  </PageHeader>

  <p class="log" aria-live="polite">Last event: <output id="log" data-testid="log">{last}</output></p>

  <section id="buttons" aria-labelledby="buttons-h">
    <SectionHeader id="buttons-h" title="Buttons" variant="title" />
    <div class="row">
      <Button variant="primary" icon={Plus} onclick={() => log('button: primary')}>Add link</Button>
      <Button onclick={() => log('button: secondary')}>Secondary</Button>
      <Button variant="ghost" onclick={() => log('button: ghost')}>Ghost</Button>
      <Button variant="danger" icon={Trash2} onclick={() => log('button: danger')}>Delete</Button>
      <Button size="sm" onclick={() => log('button: small')}>Small</Button>
      <Button size="lg" variant="primary" onclick={() => log('button: large')}>Large</Button>
      <Button variant="inverse" onclick={() => log('button: inverse')}>Inverse</Button>
      <Button variant="outline" onclick={() => log('button: outline')}>Outline</Button>
      <Button loading onclick={() => log('button: loading clicked')}>Saving</Button>
      <Button disabled onclick={() => log('button: disabled clicked')}>Disabled</Button>
      <Button href="#tabs" variant="ghost">Link to tabs</Button>
    </div>
    <div class="row">
      <IconButton icon={Search} label="Search" action="commandPalette" onclick={() => log('iconbutton: search')} />
      <IconButton icon={Pin} label="Pin tab" pressed={pinned} onclick={() => ((pinned = !pinned), log(`iconbutton: pinned=${pinned}`))} />
      <IconButton icon={Star} label="Favorite" size="sm" variant="secondary" onclick={() => log('iconbutton: favorite')} />
      <IconButton icon={Trash2} label="Remove" size="lg" variant="danger" onclick={() => log('iconbutton: remove')} />
      <span class="hint" {@attach tooltip({ text: 'Tooltips also work on plain text', describe: true })} tabindex="-1">Hover for a tooltip</span>
    </div>
  </section>

  <section id="fields" aria-labelledby="fields-h">
    <SectionHeader id="fields-h" title="Text fields" variant="title" />
    <div class="grid">
      <Field label="Display name" help="Shown on synced devices." error={nameError}>
        <Input bind:value={name} placeholder="At least 3 characters" />
      </Field>
      <Field label="Filter">
        <SearchInput bind:value={query} placeholder="Filter rows" onclear={() => log('search: cleared')} />
      </Field>
      <Field label="Notes">
        <Textarea bind:value={notes} autosize minRows={2} maxRows={6} placeholder="Grows with its content" />
      </Field>
    </div>
  </section>

  <section id="choices" aria-labelledby="choices-h">
    <SectionHeader id="choices-h" title="Choices" variant="title" />
    <div class="grid">
      <Field label="Search engine">
        <Select bind:value={engine} options={engineOptions} onchange={(v) => log(`select: ${v}`)} />
      </Field>
      <Field label="Country" help="Editable combobox: type to filter, arrows to choose.">
        <Combobox
          bind:value={country}
          bind:open={countryOpen}
          options={countryOptions}
          getKey={(c) => c}
          getLabel={(c) => c}
          onselect={(c) => ((country = c), log(`combobox: ${c}`))}
          onsubmit={(t) => log(`combobox submit: ${t}`)}
          placeholder="Start typing a country"
        >
          {#snippet empty()}<p class="empty">No matching country.</p>{/snippet}
        </Combobox>
      </Field>
      <div class="stack">
        <Switch label="Wi-Fi only" bind:checked={wifi} onchange={(v) => log(`switch: ${v}`)} />
        <Checkbox label="I read the terms" description="Required to continue." bind:checked={agree} onchange={(v) => log(`checkbox: ${v}`)} />
        <Checkbox label="Select all rows" bind:checked={partial} bind:indeterminate={partialIndeterminate} onchange={(v) => log(`checkbox all: ${v}`)} />
      </div>
      <RadioGroup
        label="Density"
        bind:value={density}
        options={[
          { value: 'compact', label: 'Compact' },
          { value: 'comfortable', label: 'Comfortable', description: 'The default' },
          { value: 'spacious', label: 'Spacious' },
        ]}
        onchange={(v) => log(`radio: ${v}`)}
      />
      <Field label="Font size">
        <Slider bind:value={fontSize} min={12} max={20} step={1} format={(v) => `${v} px`} onchange={(v) => log(`slider: ${v}`)} />
      </Field>
      <ColorPicker
        label="Accent color"
        bind:value={accent}
        bind:preset={accentPreset}
        {presets}
        contrastAgainst={TEXT_SURFACES[lightTheme ? 'light' : 'dark'].bg}
        onchange={(v, p) => log(`color: ${v} ${p ?? 'custom'}`)}
      />
    </div>
  </section>

  <section id="card-form" aria-labelledby="card-form-h">
    <SectionHeader id="card-form-h" title="Card form" variant="title" />
    <div class="grid two">
      <form class="glass-card demo-card" aria-label="Card form demo" onsubmit={(ev) => (ev.preventDefault(), log('card: continue'))}>
        <Logo size={30} wordmark />
        <div class="demo-titles">
          <h3 class="demo-title">Sync this browser</h3>
          <p class="demo-sub">Fields inside cards and dialogs are wells.</p>
        </div>
        <Field label="Email address">
          <Input bind:value={cardEmail} size="lg" type="email" placeholder="you@example.org" autocomplete="off" />
        </Field>
        <Field label="Access code">
          {#snippet aside()}<a href="#card-form" class="demo-link">Where is my code?</a>{/snippet}
          <Input bind:value={cardCode} size="lg" placeholder="6 characters" mono autocomplete="off" />
        </Field>
        <Checkbox label="Keep me signed in" bind:checked={cardRemember} />
        <Button type="submit" variant="primary" size="lg" full>Continue</Button>
        <div class="demo-or" aria-hidden="true"><span>or</span></div>
        <Button variant="inverse" size="lg" full onclick={() => log('card: inverse')}>Use a passkey</Button>
        <Button variant="outline" size="lg" full onclick={() => log('card: outline')}>Stay signed out</Button>
      </form>
      <div class="stack">
        <Field label="Well (page)" help="The well prop works outside cards too.">
          <Input well placeholder="A sunken field" />
        </Field>
        <Field label="Invalid field" error="That address is not valid.">
          <Input value="not-an-address" />
        </Field>
        <Field label="Disabled field" disabled>
          <Input value="Read only for now" />
        </Field>
        <div class="row">
          <Switch label="Disabled switch" disabled checked />
          <Checkbox label="Disabled box" disabled />
        </div>
        <div class="row">
          <Tag>neutral</Tag><Tag tone="success">online</Tag><Tag tone="warning">slow</Tag><Badge count={7} label="7 updates" />
          <Kbd combo="Mod+Shift+P" />
        </div>
      </div>
    </div>
  </section>

  <section id="menus" aria-labelledby="menus-h">
    <SectionHeader id="menus-h" title="Menus" variant="title" />
    <div class="row">
      <Menu items={menuItems} label="File actions">
        {#snippet trigger(props)}<Button {...props} iconEnd={Ellipsis}>File actions</Button>{/snippet}
      </Menu>
      <div
        class="context-area"
        role="button"
        tabindex="0"
        aria-label="Right-click here: an item with a context menu (also Shift+F10 or the menu key)"
        oncontextmenu={areaMenu}
        onkeydown={(ev) => {
          if (isContextMenuKey(ev)) areaMenu(ev);
        }}
      >
        Right-click here
      </div>
    </div>
  </section>

  <section id="overlays" aria-labelledby="overlays-h">
    <SectionHeader id="overlays-h" title="Overlays" variant="title" />
    <div class="row">
      <button bind:this={popoverAnchor} class="plain-btn" type="button" aria-expanded={popoverOpen} onclick={() => (popoverOpen = !popoverOpen)}>
        Popover
      </button>
      <!-- Right after its trigger, so Tab continues from the popover into the rest of the page. -->
      {#if popoverOpen}
        <Popover bind:open={popoverOpen} anchor={popoverAnchor} label="Quick rename" onclose={() => log('popover: closed')}>
          <form
            class="pop-form"
            onsubmit={(ev) => {
              ev.preventDefault();
              log('popover: saved');
              popoverOpen = false;
            }}
          >
            <Field label="New name"><Input value="Reading list" /></Field>
            <Button type="submit" variant="primary" size="sm">Save</Button>
          </form>
        </Popover>
      {/if}
      <Button onclick={() => (dialogOpen = true)}>Dialog</Button>
      <Button onclick={() => (confirmOpen = true)}>Confirm dialog</Button>
      <Button onclick={askConfirm}>confirm()</Button>
      <Button onclick={askPrompt}>prompt()</Button>
      <Button onclick={() => (sheetOpen = true)}>Side sheet</Button>
      <Button onclick={() => (bottomSheetOpen = true)}>Bottom sheet</Button>
    </div>
    <div class="row">
      <Button size="sm" onclick={() => toast.info('Synced 12 bookmarks')}>Info toast</Button>
      <Button size="sm" onclick={() => toast.success('Settings exported', { description: 'gnome-settings.json' })}>Success toast</Button>
      <Button size="sm" onclick={() => toast.warning('Gateway slow', { description: 'Responses take more than 2 s.' })}>Warning toast</Button>
      <Button
        size="sm"
        onclick={() => toast.error('Could not reach the server', { actions: [{ label: 'Retry', onClick: () => log('toast: retry') }] })}
      >
        Error toast
      </Button>
    </div>
  </section>

  <section id="tabs" aria-labelledby="tabs-h">
    <SectionHeader id="tabs-h" title="Tabs" variant="title" />
    <Tabs
      label="Settings sections"
      bind:value={tab}
      tabs={[
        { id: 'general', label: 'General' },
        { id: 'privacy', label: 'Privacy', count: 3 },
        { id: 'advanced', label: 'Advanced' },
      ]}
      onchange={(v) => log(`tabs: ${v}`)}
    >
      {#snippet panel(id)}<p class="panel-text">The {id} panel.</p>{/snippet}
    </Tabs>
  </section>

  <section id="display" aria-labelledby="display-h">
    <SectionHeader id="display-h" title="Display" variant="title" />
    <div class="row">
      <Chip selected={chipA} onclick={() => ((chipA = !chipA), log(`chip: ${chipA}`))}>Action</Chip>
      <Chip selected={chipB} icon={Gamepad2} count={128} onclick={() => (chipB = !chipB)}>Arcade</Chip>
      {#if !chipRemoved}<Chip removable removeLabel="Remove filter: Mobile" onremove={() => ((chipRemoved = true), log('chip: removed'))}>Mobile</Chip>{/if}
      <Tag>neutral</Tag>
      <Tag tone="accent">accent</Tag>
      <Tag tone="moss">moss</Tag>
      <Tag tone="slate" mono>SJ</Tag>
      <Tag tone="success">up</Tag>
      <Tag tone="warning">slow</Tag>
      <Tag tone="danger">down</Tag>
      <span class="badge-host">Downloads <Badge count={3} label="3 downloads in progress" /></span>
      <Badge dot tone="success" label="Connected" />
      <Kbd combo="Mod+Shift+P" />
      <Spinner label="Loading" />
    </div>
    <div class="grid">
      <ProgressBar label="Download" value={42} max={100} valueText="42 MB of 100 MB" />
      <ProgressBar label="Connecting" />
      <Skeleton lines={3} delay={0} />
    </div>
    <div class="grid">
      <div>
        <ListRow title="Gnome — Wikipedia" subtitle="en.wikipedia.org/wiki/Gnome" meta="4 min ago" monoSubtitle onclick={() => log('listrow: wikipedia')}>
          {#snippet leading()}<Logo size={20} decorative />{/snippet}
        </ListRow>
        <ListRow title="OpenStreetMap" subtitle="openstreetmap.org" meta="yesterday" href="#display" />
        <ListRow title="Current page" subtitle="gnome://history" meta="now" active onclick={() => log('listrow: current')} />
      </div>
      <div>
        <SettingRow label="Wi-Fi only" description="Sync only on unmetered networks." icon={Wifi} isDefault={wifi} onreset={() => (wifi = true)}>
          {#snippet control()}<Switch bind:checked={wifi} />{/snippet}
        </SettingRow>
        <Divider label="or" />
        <ScrollArea maxHeight="96px" label="Licenses" fade>
          <p class="panel-text">
            Geist, Geist Mono, Inter, Montserrat, Fraunces and Atkinson Hyperlegible Next are licensed under the SIL Open Font License 1.1.
            Lucide icons are ISC licensed. This text scrolls inside a ScrollArea with edge fades so long content stays
            reachable with the keyboard and the wheel.
          </p>
        </ScrollArea>
      </div>
      <EmptyState title="No downloads yet" description="Files you save from pages appear here." size="sm" headingLevel={3}>
        {#snippet actions()}<Button size="sm" icon={Globe} onclick={() => log('empty: browse')}>Open the browser</Button>{/snippet}
      </EmptyState>
    </div>
  </section>

  <section id="virtual" aria-labelledby="virtual-h">
    <SectionHeader id="virtual-h" title="Virtualized" variant="title" description="10,000 rows and 2,000 cards; only the visible ones are in the DOM." />
    <div class="grid two">
      <div class="vbox">
        <VirtualList
          items={rows}
          itemHeight={44}
          getKey={(r) => r.id}
          label="Visits"
          bind:activeIndex={listActive}
          onactivate={(r) => log(`vlist: ${r.title}`)}
        >
          {#snippet item(r, s)}
            <div class="vrow" class:active={s.active}><span>{r.title}</span><span class="mono subtle">{r.url}</span></div>
          {/snippet}
        </VirtualList>
      </div>
      <div class="vbox">
        <VirtualGrid
          items={cards}
          minItemWidth={120}
          itemHeight={(w) => Math.round(w * 0.5625) + 28}
          gap={12}
          scroller="self"
          getKey={(c) => c.id}
          label="Games"
          bind:activeIndex={gridActive}
          onactivate={(c) => log(`vgrid: ${c.title}`)}
        >
          {#snippet item(c, s)}
            <div class="vcard" class:active={s.active}><div class="thumb"></div><span>{c.title}</span></div>
          {/snippet}
        </VirtualGrid>
      </div>
    </div>
  </section>
</main>

<Dialog bind:open={dialogOpen} title="Add quick link" description="Pages open in the browser through GNOME." onclose={() => log('dialog: closed')}>
  <Field label="Name"><Input bind:value={dialogName} placeholder="Optional" /></Field>
  <div class="dialog-extra">
    <Button
      size="sm"
      variant="outline"
      onclick={() => toast.error('Could not save the link', { actions: [{ label: 'Try again', onClick: () => log('toast: retry over dialog') }] })}
    >
      Error toast over this dialog
    </Button>
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (dialogOpen = false)}>Cancel</Button>
    <Button variant="primary" onclick={() => ((dialogOpen = false), log(`dialog: saved ${dialogName}`))}>Add</Button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={confirmOpen}
  title="Remove this link?"
  message="It disappears from Home on this device."
  confirmLabel="Remove"
  danger
  onconfirm={() => {
    confirmOpen = false;
    log('confirmdialog: confirmed');
  }}
  oncancel={() => log('confirmdialog: cancelled')}
/>

<Sheet bind:open={sheetOpen} title="Downloads" onclose={() => log('sheet: closed')}>
  <p class="panel-text">A side sheet slides in from the edge and traps focus like a dialog.</p>
  <Button onclick={() => (sheetOpen = false)}>Done</Button>
</Sheet>

<Sheet bind:open={bottomSheetOpen} side="bottom" title="Tabs" onclose={() => log('bottom sheet: closed')}>
  <p class="panel-text">Bottom sheets can be dragged down to dismiss.</p>
</Sheet>

<Tooltip />
<ToastHost />
<DialogHost />
<ContextMenuHost />
<Announcer />

<style>
  .gallery {
    max-width: 1180px;
    margin: 0 auto;
    padding: var(--space-8) var(--page-pad-x) var(--space-16);
    height: 100dvh;
    overflow-y: auto;
  }

  :global(body) {
    overflow: hidden;
  }

  section {
    padding: var(--space-6) 0;
    border-bottom: 1px solid var(--hairline);
  }

  .log {
    margin: var(--space-4) 0 0;
    color: var(--text-2);
    font-size: var(--text-sm);
  }

  .log output {
    font-family: var(--font-mono);
    color: var(--text);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-4);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: var(--space-6);
    margin-top: var(--space-4);
    align-items: start;
  }

  .grid.two {
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  }

  .demo-card {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 400px;
    padding: 32px 28px 26px;
  }

  .demo-titles {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .demo-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 1.7rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1.15;
  }

  .demo-sub {
    margin: 0;
    color: var(--text-3);
    font-size: 0.9286rem;
    font-weight: 500;
  }

  .demo-link {
    position: relative;
    color: var(--accent);
    text-decoration: none;
  }

  /* Invisible hit area of at least --hit-min around the small inline link. */
  .demo-link::after {
    content: '';
    position: absolute;
    inset: -14px -4px;
  }

  .demo-link:hover {
    text-decoration: underline;
  }

  .demo-or {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-3);
    font-size: var(--text-sm);
  }

  .demo-or::before,
  .demo-or::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--hairline);
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .hint {
    color: var(--text-2);
    font-size: var(--text-sm);
    text-decoration: underline dotted;
  }

  .context-area {
    display: grid;
    place-items: center;
    width: 220px;
    height: 72px;
    border: 1px dashed var(--hairline-strong);
    border-radius: var(--radius);
    color: var(--text-2);
    font-size: var(--text-sm);
  }

  /* A native button (the popover needs its element as the anchor) drawn like a secondary Button. */
  .dialog-extra {
    margin-top: var(--space-3);
  }

  .plain-btn {
    height: var(--control-h);
    padding: 0 calc(var(--control-px) + 2px);
    border: 1px solid var(--hairline-strong);
    border-radius: var(--radius);
    background: var(--surface-1);
    color: var(--text);
    font-size: 0.9286rem;
    font-weight: 600;
    letter-spacing: -0.005em;
    cursor: pointer;
    transition:
      background-color var(--t-1) var(--ease-out),
      border-color var(--t-1) var(--ease-out);
  }

  .plain-btn:hover,
  .plain-btn[aria-expanded='true'] {
    background: var(--surface-2);
    border-color: var(--field-border-hover);
  }

  .badge-host {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-2);
  }

  .panel-text {
    color: var(--text-2);
    padding: var(--space-3) 0;
  }

  .empty {
    padding: 10px;
    color: var(--text-3);
  }

  .pop-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
  }

  .vbox {
    height: 360px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
  }

  .vrow {
    display: flex;
    flex-direction: column;
    justify-content: center;
    height: 44px;
    padding: 0 12px;
    border-bottom: 1px solid var(--hairline);
    font-size: var(--text-sm);
  }

  .vrow.active {
    background: var(--hover);
  }

  .vcard {
    display: flex;
    flex-direction: column;
    gap: 6px;
    height: 100%;
    font-size: var(--text-sm);
    color: var(--text-2);
  }

  .vcard .thumb {
    flex: 1;
    border-radius: var(--radius);
    background: var(--surface-2);
    border: 1px solid var(--hairline);
  }

  .vcard.active .thumb {
    border-color: var(--accent);
  }
</style>
