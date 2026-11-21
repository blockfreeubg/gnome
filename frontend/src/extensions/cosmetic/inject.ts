/**
 * Cosmetic CSS into one proxied document (WAVE-B3 §5.1, §11.5, rule R1). The styles go into a constructed stylesheet
 * of the PAGE realm (`kit.sheet` + `kit.adopt`): a sheet constructed in the engine-host realm cannot join another
 * realm's document, and every frame needs its own. Where the page realm has no constructable stylesheets (or the
 * adopt fails), a `<style>` element made by the page document itself (a page-realm element) holds them, its text set
 * and appended with the engine host's natives. Both paths use only functions captured before page code ran (the kit's
 * at document start, the natives at the engine host's start), so they run no page code, also when the styles arrive
 * late. Nothing is ever injected into the engine-host document: the caller hands this only documents in a tab's frame
 * tree.
 */
import type { CosmeticNatives } from './natives';
import type { PageKit } from '../../engine-host/realm';

/** A document's GNOME stylesheet; `set` replaces its text (false when the document no longer takes it). */
export interface InjectedSheet {
  set(css: string): boolean;
}

export function injectStyles(CN: CosmeticNatives, kit: Pick<PageKit, 'sheet' | 'adopt' | 'setSheet'>, doc: Document, css: string): InjectedSheet | null {
  const sheet = kit.sheet(css);
  if (sheet !== null && typeof sheet === 'object' && kit.adopt(doc, sheet)) {
    return { set: (next) => kit.setSheet(sheet, next) };
  }
  return styleElement(CN, doc, css);
}

/** The fallback: a `<style>` of the page document, in its head (or its root element at document start). */
function styleElement(CN: CosmeticNatives, doc: Document, css: string): InjectedSheet | null {
  const parent = CN.docHead.call(doc) ?? CN.docElement.call(doc);
  // A document without a root element would make the style element its root: nothing then.
  if (parent === null) return null;
  const el = CN.createElement.call(doc, 'style');
  CN.textContentSet.call(el, css);
  CN.appendChild.call(parent, el);
  return {
    set: (next) => {
      CN.textContentSet.call(el, next);
      return true;
    },
  };
}
