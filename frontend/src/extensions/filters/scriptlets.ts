/**
 * GNOME's scriptlet assembly (WAVE-B3 D11, §4.2, §11.4). Pure, DOM-free; unit-tested with the real library.
 */

/** The argument tail of Ghostery 2.20.3's assembleScript() (resources.js); a unit test pins it against getScriptlet(). */
export const GHOSTERY_ARGS_TAIL =
  ")(...[`{{1}}`,`{{2}}`,`{{3}}`,`{{4}}`,`{{5}}`,`{{6}}`,`{{7}}`,`{{8}}`,`{{9}}`,`{{10}}`].filter((a,i) => a !== '{{'+(i+1)+'}}').map((a) => decodeURIComponent(a)))";

/**
 * One scriptlet call with its arguments as data: `template` is `engine.resources.getScriptlet(name)` and `args` the
 * filter's `parseScript().args`. Ghostery's own CosmeticFilter.getScript() pastes each argument into a template
 * literal with String.prototype.replace, so a backtick ends the literal and `$'`/`` $` ``/`$&` splice script text in
 * (WAVE-B3 §11.4); here the arguments become one JSON array (the same values after decodeURIComponent, as Ghostery
 * intends). null = refuse (a surrogate script with arguments, or a template this library version does not produce).
 */
export function scriptletCall(template: string, args: readonly string[]): string | null {
  if (template.endsWith(GHOSTERY_ARGS_TAIL)) {
    return `${template.slice(0, -GHOSTERY_ARGS_TAIL.length)})(...${JSON.stringify(args.slice(0, 10))}.map((a) => decodeURIComponent(a)))`;
  }
  return args.length === 0 ? template : null;
}
