/**
 * Native DOM functions of the ENGINE-HOST realm (ENGINE-PROTOCOL §6.1, spike §4.10). Proxied documents are
 * same-origin with the engine host, but their own globals and prototypes are hooked by the engines (and by the page),
 * so everything the engine host reads or does inside them goes through these: getters and methods taken from this
 * realm's prototypes and called with the proxied object as `this` (Web IDL brand checks accept same-origin objects
 * of another realm). Captured once, at the engine host's start, before any proxied document exists.
 */

type Getter<T = unknown> = (this: unknown) => T;
type Fn = (this: unknown, ...args: never[]) => unknown;

function getter(proto: object | undefined, key: string): Getter {
  for (let o: object | null | undefined = proto; o; o = Object.getPrototypeOf(o) as object | null) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d?.get) return d.get as Getter;
  }
  return function missing() {
    throw new TypeError(`native getter ${key} is missing in this browser`);
  };
}

function setter(proto: object | undefined, key: string): ((this: unknown, v: unknown) => void) | null {
  for (let o: object | null | undefined = proto; o; o = Object.getPrototypeOf(o) as object | null) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d?.set) return d.set as (this: unknown, v: unknown) => void;
  }
  return null;
}

function method(proto: object | undefined, key: string): Fn {
  const f = proto ? (proto as Record<string, unknown>)[key] : undefined;
  return typeof f === 'function'
    ? (f as Fn)
    : function missing() {
        throw new TypeError(`native method ${key} is missing in this browser`);
      };
}

function capture() {
  const w = window as unknown as Record<string, { prototype: object } | undefined>;
  // Location's members are [LegacyUnforgeable]: own accessors of every Location object, none on Location.prototype.
  // This realm's own location object lends them (the brand check accepts any same-origin Location).
  const loc = location as unknown as object;
  const P = (name: string): object | undefined => w[name]?.prototype;
  const win = (key: string): Getter => {
    const d = Object.getOwnPropertyDescriptor(window, key) ?? Object.getOwnPropertyDescriptor(Window.prototype, key);
    return (d?.get as Getter | undefined) ?? getter(Window.prototype, key);
  };
  return {
    // Events
    on: EventTarget.prototype.addEventListener as (this: unknown, type: string, fn: (ev: never) => void, opts?: boolean | AddEventListenerOptions) => void,
    off: EventTarget.prototype.removeEventListener as (this: unknown, type: string, fn: (ev: never) => void, opts?: boolean | EventListenerOptions) => void,
    preventDefault: Event.prototype.preventDefault as (this: unknown) => void,
    stopImmediatePropagation: Event.prototype.stopImmediatePropagation as (this: unknown) => void,
    stopPropagation: Event.prototype.stopPropagation as (this: unknown) => void,
    eventTarget: getter(Event.prototype, 'target'),
    eventType: getter(Event.prototype, 'type') as Getter<string>,
    defaultPrevented: getter(Event.prototype, 'defaultPrevented') as Getter<boolean>,
    composedPath: Event.prototype.composedPath as (this: unknown) => EventTarget[],
    // Keyboard / mouse
    key: getter(P('KeyboardEvent'), 'key') as Getter<string>,
    code: getter(P('KeyboardEvent'), 'code') as Getter<string>,
    ctrlKey: getter(P('KeyboardEvent'), 'ctrlKey') as Getter<boolean>,
    altKey: getter(P('KeyboardEvent'), 'altKey') as Getter<boolean>,
    shiftKey: getter(P('KeyboardEvent'), 'shiftKey') as Getter<boolean>,
    metaKey: getter(P('KeyboardEvent'), 'metaKey') as Getter<boolean>,
    repeat: getter(P('KeyboardEvent'), 'repeat') as Getter<boolean>,
    isComposing: getter(P('KeyboardEvent'), 'isComposing') as Getter<boolean>,
    clientX: getter(P('MouseEvent'), 'clientX') as Getter<number>,
    clientY: getter(P('MouseEvent'), 'clientY') as Getter<number>,
    button: getter(P('MouseEvent'), 'button') as Getter<number>,
    mouseCtrl: getter(P('MouseEvent'), 'ctrlKey') as Getter<boolean>,
    mouseMeta: getter(P('MouseEvent'), 'metaKey') as Getter<boolean>,
    mouseShift: getter(P('MouseEvent'), 'shiftKey') as Getter<boolean>,
    mouseAlt: getter(P('MouseEvent'), 'altKey') as Getter<boolean>,
    submitter: getter(P('SubmitEvent'), 'submitter'),
    // Window
    frameElement: win('frameElement') as Getter<Element | null>,
    winDocument: win('document') as Getter<Document>,
    winLocation: win('location') as Getter<Location>,
    winNavigator: win('navigator') as Getter<Navigator>,
    winNavigation: win('navigation') as Getter<EventTarget | undefined>,
    winPerformance: win('performance') as Getter<Performance>,
    /** The number of child browsing contexts (`window.length`; the page may replace the property, not this getter). */
    winLength: win('length') as Getter<number>,
    winHistory: win('history') as Getter<History>,
    getSelection: window.getSelection as (this: unknown) => Selection | null,
    getComputedStyle: window.getComputedStyle as (this: unknown, el: Element) => CSSStyleDeclaration,
    print: window.print as (this: unknown) => void,
    focusWindow: window.focus as (this: unknown) => void,
    stopWindow: window.stop as (this: unknown) => void,
    locationHref: getter(loc, 'href') as Getter<string>,
    locationReplace: method(loc, 'replace') as (this: unknown, url: string) => void,
    locationReload: method(loc, 'reload') as (this: unknown) => void,
    locationAssign: method(loc, 'assign') as (this: unknown, url: string) => void,
    // Navigation API (missing where the browser has none)
    hasNavigationApi: typeof (window as { navigation?: unknown }).navigation === 'object',
    navNavigationType: getter(P('NavigateEvent'), 'navigationType') as Getter<string>,
    navDestination: getter(P('NavigateEvent'), 'destination') as Getter<object>,
    navDownloadRequest: getter(P('NavigateEvent'), 'downloadRequest') as Getter<string | null>,
    navFormData: getter(P('NavigateEvent'), 'formData') as Getter<FormData | null>,
    destUrl: getter(P('NavigationDestination'), 'url') as Getter<string>,
    destSameDocument: getter(P('NavigationDestination'), 'sameDocument') as Getter<boolean>,
    entryChangeType: getter(P('NavigationCurrentEntryChangeEvent'), 'navigationType') as Getter<string | null>,
    navCurrentEntry: getter(P('Navigation'), 'currentEntry') as Getter<object | null>,
    entryUrl: getter(P('NavigationHistoryEntry'), 'url') as Getter<string | null>,
    perfGetEntriesByType: method(P('Performance'), 'getEntriesByType') as (this: unknown, t: string) => PerformanceEntry[],
    perfNavType: getter(P('PerformanceNavigationTiming'), 'type') as Getter<string>,
    // User activation
    navUserActivation: getter(P('Navigator'), 'userActivation') as Getter<object | undefined>,
    uaIsActive: getter(P('UserActivation'), 'isActive') as Getter<boolean>,
    navOnLine: getter(P('Navigator'), 'onLine') as Getter<boolean>,
    // Nodes
    ownerDocument: getter(Node.prototype, 'ownerDocument') as Getter<Document | null>,
    parentNode: getter(Node.prototype, 'parentNode') as Getter<Node | null>,
    nodeType: getter(Node.prototype, 'nodeType') as Getter<number>,
    nodeName: getter(Node.prototype, 'nodeName') as Getter<string>,
    parentElement: getter(Node.prototype, 'parentElement') as Getter<Element | null>,
    isConnected: getter(Node.prototype, 'isConnected') as Getter<boolean>,
    contains: Node.prototype.contains as (this: unknown, other: Node | null) => boolean,
    appendChild: Node.prototype.appendChild as (this: unknown, n: Node) => Node,
    removeChild: Node.prototype.removeChild as (this: unknown, n: Node) => Node,
    textData: getter(CharacterData.prototype, 'data') as Getter<string>,
    defaultView: getter(Document.prototype, 'defaultView') as Getter<Window | null>,
    docTitle: getter(Document.prototype, 'title') as Getter<string>,
    docHead: getter(Document.prototype, 'head') as Getter<HTMLHeadElement | null>,
    docBody: getter(Document.prototype, 'body') as Getter<HTMLElement | null>,
    docElement: getter(Document.prototype, 'documentElement') as Getter<Element | null>,
    docContentType: getter(Document.prototype, 'contentType') as Getter<string>,
    docReadyState: getter(Document.prototype, 'readyState') as Getter<string>,
    docUrl: getter(Document.prototype, 'URL') as Getter<string>,
    fullscreenElement: getter(Document.prototype, 'fullscreenElement') as Getter<Element | null>,
    querySelector: Document.prototype.querySelector as (this: unknown, sel: string) => Element | null,
    querySelectorAll: Document.prototype.querySelectorAll as (this: unknown, sel: string) => NodeListOf<Element>,
    getElementById: Document.prototype.getElementById as (this: unknown, id: string) => Element | null,
    createElement: Document.prototype.createElement as (this: unknown, tag: string) => Element,
    createTreeWalker: Document.prototype.createTreeWalker as (this: unknown, root: Node, what: number, filter?: NodeFilter | null) => TreeWalker,
    walkerNextNode: TreeWalker.prototype.nextNode as (this: unknown) => Node | null,
    textContentSet: setter(Node.prototype, 'textContent') as (this: unknown, v: string) => void,
    createRange: Document.prototype.createRange as (this: unknown) => Range,
    fragQuerySelectorAll: DocumentFragment.prototype.querySelectorAll as (this: unknown, sel: string) => NodeListOf<Element>,
    elQuerySelectorAll: Element.prototype.querySelectorAll as (this: unknown, sel: string) => NodeListOf<Element>,
    nodeListLength: getter(NodeList.prototype, 'length') as Getter<number>,
    nodeListItem: NodeList.prototype.item as (this: unknown, i: number) => Node | null,
    shadowRoot: getter(Element.prototype, 'shadowRoot') as Getter<ShadowRoot | null>,
    firstElementChild: getter(Element.prototype, 'firstElementChild') as Getter<Element | null>,
    getAttribute: Element.prototype.getAttribute as (this: unknown, name: string) => string | null,
    setAttribute: Element.prototype.setAttribute as (this: unknown, name: string, value: string) => void,
    removeAttribute: Element.prototype.removeAttribute as (this: unknown, name: string) => void,
    hasAttribute: Element.prototype.hasAttribute as (this: unknown, name: string) => boolean,
    closest: Element.prototype.closest as (this: unknown, sel: string) => Element | null,
    tagName: getter(Element.prototype, 'tagName') as Getter<string>,
    localName: getter(Element.prototype, 'localName') as Getter<string>,
    namespaceURI: getter(Element.prototype, 'namespaceURI') as Getter<string | null>,
    attrOwnerElement: getter(Attr.prototype, 'ownerElement') as Getter<Element | null>,
    attrLocalName: getter(Attr.prototype, 'localName') as Getter<string>,
    rect: Element.prototype.getBoundingClientRect as (this: unknown) => DOMRect,
    rectLeft: getter(DOMRectReadOnly.prototype, 'left') as Getter<number>,
    rectTop: getter(DOMRectReadOnly.prototype, 'top') as Getter<number>,
    clientLeft: getter(Element.prototype, 'clientLeft') as Getter<number>,
    clientTop: getter(Element.prototype, 'clientTop') as Getter<number>,
    scrollIntoView: Element.prototype.scrollIntoView as (this: unknown, opts?: ScrollIntoViewOptions) => void,
    isContentEditable: getter(HTMLElement.prototype, 'isContentEditable') as Getter<boolean>,
    contentWindow: getter(HTMLIFrameElement.prototype, 'contentWindow') as Getter<Window | null>,
    contentDocument: getter(HTMLIFrameElement.prototype, 'contentDocument') as Getter<Document | null>,
    frameContentWindow: getter(P('HTMLFrameElement'), 'contentWindow') as Getter<Window | null>,
    objectContentWindow: getter(P('HTMLObjectElement'), 'contentWindow') as Getter<Window | null>,
    iframeName: getter(HTMLIFrameElement.prototype, 'name') as Getter<string>,
    anchorHref: getter(HTMLAnchorElement.prototype, 'href') as Getter<string>,
    anchorTarget: getter(HTMLAnchorElement.prototype, 'target') as Getter<string>,
    anchorDownload: getter(HTMLAnchorElement.prototype, 'download') as Getter<string>,
    areaHref: getter(HTMLAreaElement.prototype, 'href') as Getter<string>,
    areaTarget: getter(HTMLAreaElement.prototype, 'target') as Getter<string>,
    imgCurrentSrc: getter(HTMLImageElement.prototype, 'currentSrc') as Getter<string>,
    linkHref: getter(HTMLLinkElement.prototype, 'href') as Getter<string>,
    formAction: getter(HTMLFormElement.prototype, 'action') as Getter<string>,
    formMethod: getter(HTMLFormElement.prototype, 'method') as Getter<string>,
    formTarget: getter(HTMLFormElement.prototype, 'target') as Getter<string>,
    formEnctype: getter(HTMLFormElement.prototype, 'enctype') as Getter<string>,
    buttonFormAction: getter(HTMLButtonElement.prototype, 'formAction') as Getter<string>,
    buttonFormMethod: getter(HTMLButtonElement.prototype, 'formMethod') as Getter<string>,
    buttonFormTarget: getter(HTMLButtonElement.prototype, 'formTarget') as Getter<string>,
    inputFormAction: getter(HTMLInputElement.prototype, 'formAction') as Getter<string>,
    inputFormMethod: getter(HTMLInputElement.prototype, 'formMethod') as Getter<string>,
    inputFormTarget: getter(HTMLInputElement.prototype, 'formTarget') as Getter<string>,
    buttonFormEnctype: getter(HTMLButtonElement.prototype, 'formEnctype') as Getter<string>,
    inputFormEnctype: getter(HTMLInputElement.prototype, 'formEnctype') as Getter<string>,
    inputFilesSet: setter(HTMLInputElement.prototype, 'files'),
    formSubmit: HTMLFormElement.prototype.submit as (this: unknown) => void,
    inputType: getter(HTMLInputElement.prototype, 'type') as Getter<string>,
    inputReadOnly: getter(HTMLInputElement.prototype, 'readOnly') as Getter<boolean>,
    textareaReadOnly: getter(HTMLTextAreaElement.prototype, 'readOnly') as Getter<boolean>,
    textareaValue: getter(HTMLTextAreaElement.prototype, 'value') as Getter<string>,
    formTargetSet: setter(HTMLFormElement.prototype, 'target'),
    selectionToString: Selection.prototype.toString as (this: unknown) => string,
    selectAllChildren: Selection.prototype.selectAllChildren as (this: unknown, n: Node) => void,
    rangeSetStart: Range.prototype.setStart as (this: unknown, n: Node, o: number) => void,
    rangeSetEnd: Range.prototype.setEnd as (this: unknown, n: Node, o: number) => void,
    rangeStartContainer: getter(Range.prototype, 'startContainer') as Getter<Node>,
    fileName: getter(P('File'), 'name') as Getter<string>,
    spvDisposition: getter(P('SecurityPolicyViolationEvent'), 'disposition') as Getter<string>,
    spvEffectiveDirective: getter(P('SecurityPolicyViolationEvent'), 'effectiveDirective') as Getter<string>,
    // Misc
    defineProperty: Object.defineProperty,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    getPrototypeOf: Object.getPrototypeOf,
    /** This realm's Proxy and Reflect.apply (realm.ts builds page-realm callables with them). */
    Proxy: window.Proxy,
    apply: Reflect.apply,
    /** Function.prototype.toString: tells a browser native from a page function or Proxy without running either. */
    fnToString: Function.prototype.toString as (this: unknown) => string,
    MutationObserver: window.MutationObserver,
    recordAddedNodes: getter(P('MutationRecord'), 'addedNodes') as Getter<NodeList>,
    recordTarget: getter(P('MutationRecord'), 'target') as Getter<Node>,
    recordType: getter(P('MutationRecord'), 'type') as Getter<string>,
    FormData: window.FormData,
    DataTransfer: window.DataTransfer,
    URLSearchParams: window.URLSearchParams,
    URL: window.URL,
    fetch: window.fetch.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  };
}

export type Natives = ReturnType<typeof capture>;

let captured: Natives | null = null;

/** The engine-host realm's natives (captured on the first call: call it once at startup, before any tab exists). */
export function natives(): Natives {
  captured ??= capture();
  return captured;
}
