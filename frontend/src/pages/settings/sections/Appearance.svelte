<script lang="ts">
  import ImageUp from '@lucide/svelte/icons/image-up';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Sun from '@lucide/svelte/icons/sun';
  import Button from '../../../components/Button.svelte';
  import ColorPicker from '../../../components/ColorPicker.svelte';
  import Field from '../../../components/Field.svelte';
  import Input from '../../../components/Input.svelte';
  import SegmentedControl from '../../../components/SegmentedControl.svelte';
  import Select from '../../../components/Select.svelte';
  import Slider from '../../../components/Slider.svelte';
  import Switch from '../../../components/Switch.svelte';
  import { toast } from '../../../app/overlays/toast.svelte';
  import { kvDelete, kvSet, uuid } from '../../../lib/idb';
  import { ACCENT_PRESETS, accentTokens, TEXT_SURFACES, THEME_COLORS } from '../../../settings/apply';
  import { appearance as resolved } from '../../../settings/appearance.svelte';
  import { contrastRatio } from '../../../settings/color';
  import type { Settings } from '../../../settings/schema';
  import { settings } from '../../../settings/store.svelte';
  import { UI_FONTS } from '../../../styles/fonts';
  import { DEFAULT_WALLPAPER } from '../../../styles/wallpapers';
  import { imageSource, isSafeGradient } from '../../home/background';
  import ColorSlot from '../ColorSlot.svelte';
  import Group from '../Group.svelte';
  import Row from '../Row.svelte';

  type Appearance = Settings['appearance'];
  const S = 'appearance' as const;
  const a = $derived(settings.value.appearance);
  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]): void => void settings.set(S, k, v);

  /** Each preset as it actually renders in the current theme (light uses its tuned or derived jade-side value). */
  const presetColor = (id: Exclude<Appearance['accentPreset'], 'custom'>): string =>
    resolved.theme === 'light' ? accentTokens({ ...a, accentPreset: id }).light.accent : ACCENT_PRESETS[id].dark;
  const accentPresets = $derived(
    (Object.keys(ACCENT_PRESETS) as Exclude<Appearance['accentPreset'], 'custom'>[]).map((id) => ({
      id,
      label: ACCENT_PRESETS[id].label,
      value: presetColor(id),
    })),
  );
  const accentValue = $derived(a.accentPreset === 'custom' ? a.accent : presetColor(a.accentPreset));

  function onAccent(value: string, preset: string | null): void {
    if (preset) settings.patch({ appearance: { accentPreset: preset as Appearance['accentPreset'] } });
    else settings.patch({ appearance: { accentPreset: 'custom', accent: value } });
  }

  /** Theme colors shown while no override is set (tokens.css, via THEME_COLORS). */
  const themeColors = $derived(THEME_COLORS[resolved.theme]);
  const COLOR_SLOTS: ReadonlyArray<{ key: keyof Appearance['colors']; label: string }> = [
    { key: 'background', label: 'Background' },
    { key: 'surface', label: 'Surface' },
    { key: 'text', label: 'Text' },
    { key: 'mutedText', label: 'Secondary text' },
    { key: 'border', label: 'Border' },
  ];

  function setColor(key: keyof Appearance['colors'], value: string | null): void {
    set('colors', { ...a.colors, [key]: value });
  }

  function contrastWarning(key: 'text' | 'mutedText'): string | null {
    const fg = a.colors[key] ?? themeColors[key];
    const bg = a.colors.background ?? TEXT_SURFACES[resolved.theme].bg;
    if (!a.colors[key] && !a.colors.background) return null;
    const ratio = contrastRatio(fg, bg);
    return ratio < 4.5 ? `Contrast with the background is ${ratio.toFixed(1)}:1; 4.5:1 or more keeps text readable.` : null;
  }

  const FONTS: ReadonlyArray<{ value: Appearance['fontFamily']; label: string; description: string }> = Object.values(UI_FONTS).map(
    (f) => ({ value: f.id, label: f.label, description: f.description }),
  );

  // ── Home background ──
  const bg = $derived(a.homeBackground);
  const setBg = (patch: Partial<Appearance['homeBackground']>): void => set('homeBackground', { ...bg, ...patch });
  const BG_KINDS: ReadonlyArray<{ value: Appearance['homeBackground']['kind']; label: string }> = [
    { value: 'wallpaper', label: 'Wallpaper' },
    { value: 'glow', label: 'Glow' },
    { value: 'none', label: 'Plain' },
    { value: 'color', label: 'Color' },
    { value: 'gradient', label: 'Gradient' },
    { value: 'image', label: 'Image' },
  ];
  let gradientDraft = $derived(bg.kind === 'gradient' ? bg.value : '');
  let gradientError = $state<string | null>(null);
  let imageUrlDraft = $derived(bg.kind === 'image' && !bg.value.startsWith('idb:') ? bg.value : '');
  let imageError = $state<string | null>(null);
  const storedImage = $derived(bg.kind === 'image' && bg.value.startsWith('idb:'));
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  function changeKind(kind: Appearance['homeBackground']['kind']): void {
    const value =
      kind === bg.kind
        ? bg.value
        : kind === 'wallpaper'
          ? DEFAULT_WALLPAPER
          : kind === 'color'
            ? (a.colors.background ?? themeColors.background)
            : kind === 'gradient'
              ? 'linear-gradient(160deg, #1d2622 0%, #0a0a0a 70%)'
              : '';
    setBg({ kind, value });
  }

  function commitGradient(): void {
    if (!isSafeGradient(gradientDraft)) {
      gradientError = 'Use a CSS gradient such as linear-gradient(160deg, #1d2622, #0a0a0a).';
      return;
    }
    gradientError = null;
    setBg({ value: gradientDraft.trim() });
  }

  function commitImageUrl(): void {
    const src = imageSource(imageUrlDraft);
    if (!src || src.kind !== 'url') {
      imageError = 'Use an https:// image address, or upload a picture.';
      return;
    }
    imageError = null;
    void replaceStored(src.url);
  }

  async function replaceStored(value: string): Promise<void> {
    const old = bg.value.startsWith('idb:') ? bg.value.slice(4) : null;
    setBg({ value });
    if (old && old !== value.slice(4)) await kvDelete(old).catch(() => undefined);
  }

  function upload(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/avif,image/gif';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        toast.error('That file is not an image');
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error('Image too large', { description: 'Choose a picture under 8 MB.' });
        return;
      }
      const key = `home-bg:${uuid()}`;
      try {
        await kvSet(key, file);
        imageError = null;
        await replaceStored(`idb:${key}`);
      } catch {
        toast.error('Could not save the image', { description: 'This browser’s storage is unavailable.' });
      }
    };
    input.click();
  }
</script>

<Group title="Theme">
  <Row section={S} id="theme">
    {#snippet control()}
      <SegmentedControl
        label="Theme"
        value={a.theme}
        options={[
          { value: 'dark', label: 'Dark', icon: Moon },
          { value: 'light', label: 'Light', icon: Sun },
          { value: 'system', label: 'System', icon: Monitor },
        ]}
        onchange={(v) => set('theme', v)}
      />
    {/snippet}
  </Row>
  <Row section={S} id="accent" stacked>
    {#snippet control()}
      <ColorPicker
        label="Accent color"
        value={accentValue}
        preset={a.accentPreset === 'custom' ? null : a.accentPreset}
        presets={accentPresets}
        contrastAgainst={TEXT_SURFACES[resolved.theme].bg}
        onchange={onAccent}
      />
    {/snippet}
  </Row>
  <Row section={S} id="colors" stacked>
    {#snippet control()}
      <div class="color-grid">
        {#each COLOR_SLOTS as slot (slot.key)}
          <ColorSlot
            label={slot.label}
            value={a.colors[slot.key]}
            fallback={themeColors[slot.key]}
            warning={slot.key === 'text' || slot.key === 'mutedText' ? contrastWarning(slot.key) : null}
            onchange={(v) => setColor(slot.key, v)}
          />
        {/each}
      </div>
    {/snippet}
  </Row>
</Group>

<Group title="Text and spacing">
  <Row section={S} id="fontFamily">
    {#snippet control()}
      <Select value={a.fontFamily} options={FONTS} onchange={(v) => set('fontFamily', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="fontSize">
    {#snippet control()}
      <Slider value={a.fontSize} min={12} max={20} step={1} format={(v) => `${v} px`} onchange={(v) => set('fontSize', v)} class="slider" />
    {/snippet}
  </Row>
  <Row section={S} id="density">
    {#snippet control()}
      <SegmentedControl
        label="Density"
        value={a.density}
        options={[
          { value: 'compact', label: 'Compact' },
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'spacious', label: 'Spacious' },
        ]}
        onchange={(v) => set('density', v)}
      />
    {/snippet}
  </Row>
  <Row section={S} id="radius">
    {#snippet control()}
      <Slider value={a.radius} min={0} max={16} step={1} format={(v) => `${v} px`} oninput={(v) => set('radius', v)} class="slider" />
    {/snippet}
  </Row>
  <Row section={S} id="animation">
    {#snippet control()}
      <Select
        value={a.animation}
        options={[
          { value: 'none', label: 'None' },
          { value: 'reduced', label: 'Reduced', description: 'Fades only' },
          { value: 'normal', label: 'Normal' },
          { value: 'expressive', label: 'Expressive', description: 'A little slower and livelier' },
        ]}
        onchange={(v) => set('animation', v)}
      />
    {/snippet}
  </Row>
</Group>

<Group title="Glass">
  <Row section={S} id="transparency">
    {#snippet control()}
      <Slider
        value={a.transparency}
        min={0.55}
        max={1}
        step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        oninput={(v) => set('transparency', Math.round(v * 100) / 100)}
        disabled={a.reduceTransparency}
        class="slider"
      />
    {/snippet}
  </Row>
  <Row section={S} id="blur">
    {#snippet control()}
      <Slider value={a.blur} min={0} max={40} step={1} format={(v) => (v ? `${v} px` : 'Off')} oninput={(v) => set('blur', v)} disabled={a.reduceTransparency} class="slider" />
    {/snippet}
  </Row>
  <Row section={S} id="reduceTransparency">
    {#snippet control()}
      <Switch checked={a.reduceTransparency} onchange={(v) => set('reduceTransparency', v)} />
    {/snippet}
  </Row>
</Group>

<Group title="Layout">
  <Row section={S} id="sidebar">
    {#snippet control()}
      <Select
        value={a.sidebar}
        options={[
          { value: 'auto', label: 'Automatic' },
          { value: 'expanded', label: 'Expanded' },
          { value: 'compact', label: 'Compact', description: 'Icons only' },
          { value: 'hidden', label: 'Hidden', description: 'Reveal at the screen edge' },
        ]}
        onchange={(v) => set('sidebar', v)}
      />
    {/snippet}
  </Row>
  <Row section={S} id="sidebarPosition">
    {#snippet control()}
      <SegmentedControl
        label="Sidebar position"
        value={a.sidebarPosition}
        options={[
          { value: 'left', label: 'Left' },
          { value: 'right', label: 'Right' },
        ]}
        onchange={(v) => set('sidebarPosition', v)}
      />
    {/snippet}
  </Row>
  <Row section={S} id="toolbar">
    {#snippet control()}
      <SegmentedControl
        label="Browser toolbar"
        value={a.toolbar}
        options={[
          { value: 'full', label: 'Full' },
          { value: 'compact', label: 'Compact' },
        ]}
        onchange={(v) => set('toolbar', v)}
      />
    {/snippet}
  </Row>
  <Row section={S} id="tabStrip">
    {#snippet control()}
      <Select
        value={a.tabStrip}
        options={[
          { value: 'top', label: 'Always show' },
          { value: 'hidden-when-single', label: 'Hide with one tab' },
        ]}
        onchange={(v) => set('tabStrip', v)}
      />
    {/snippet}
  </Row>
  <Row section={S} id="showBookmarksBar">
    {#snippet control()}
      <Switch checked={a.showBookmarksBar} onchange={(v) => set('showBookmarksBar', v)} />
    {/snippet}
  </Row>
  <Row section={S} id="homeBackground" stacked>
    {#snippet control()}
      <div class="bg-editor">
        <SegmentedControl label="Home background" value={bg.kind} options={BG_KINDS} onchange={changeKind} class="bg-kind" />
        {#if bg.kind === 'color'}
          <ColorSlot label="Background color" value={bg.value || null} fallback={themeColors.background} onchange={(v) => setBg({ value: v ?? '' })} />
        {:else if bg.kind === 'gradient'}
          <Field label="CSS gradient" error={gradientError}>
            <Input bind:value={gradientDraft} mono size="sm" spellcheck={false} onchange={commitGradient} onkeydown={(e) => e.key === 'Enter' && commitGradient()} />
          </Field>
        {:else if bg.kind === 'image'}
          <div class="image-row">
            <Button size="sm" icon={ImageUp} onclick={upload}>{storedImage ? 'Replace picture' : 'Upload a picture'}</Button>
            <span class="subtle text-sm">{storedImage ? 'Stored in this browser only.' : 'Or use an address:'}</span>
          </div>
          {#if !storedImage}
            <Field
              label="Image address"
              error={imageError}
              help="An https:// address loads directly from that host, which then sees your IP address. Uploaded pictures stay in this browser."
            >
              <Input bind:value={imageUrlDraft} placeholder="https://" mono size="sm" spellcheck={false} onchange={commitImageUrl} onkeydown={(e) => e.key === 'Enter' && commitImageUrl()} />
            </Field>
          {/if}
        {/if}
        {#if bg.kind === 'color' || bg.kind === 'gradient' || bg.kind === 'image'}
          <div class="pair">
            <Field label="Dim">
              <Slider value={bg.dim} min={0} max={0.9} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onchange={(v) => setBg({ dim: Math.round(v * 100) / 100 })} />
            </Field>
            <Field label="Blur">
              <Slider value={bg.blur} min={0} max={40} step={1} format={(v) => (v ? `${v} px` : 'Off')} onchange={(v) => setBg({ blur: v })} />
            </Field>
          </div>
        {/if}
      </div>
    {/snippet}
  </Row>
</Group>

<style>
  :global(.setting-row .slider) {
    width: min(240px, 60vw);
  }

  .color-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr));
    gap: var(--space-3) var(--space-5);
    width: 100%;
  }

  .bg-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 100%;
    max-width: 560px;
  }

  /* The kind picker hugs its options like every other segmented control (the editor column is wider). */
  .bg-editor > :global(.bg-kind) {
    align-self: flex-start;
    max-width: 100%;
  }

  .image-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-5);
  }

  @media (max-width: 640px) {
    .pair {
      grid-template-columns: 1fr;
    }
  }
</style>
