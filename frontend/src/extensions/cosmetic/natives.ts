/**
 * The engine-host natives the generic-rule monitor reads page DOM with, beyond `engine-host/natives.ts` (WAVE-B3
 * §3.3: "x2 captures what it needs beyond natives.ts … in its own src/extensions/cosmetic/natives.ts, the same way").
 * Getters and methods of THIS realm's prototypes, called with page objects as `this`: Web IDL brand checks accept
 * same-origin objects of another realm and run no page code, so a page that replaced `NodeList.prototype.item`,
 * `Element.prototype.getAttribute` or a `MutationRecord` getter in its own realm changes nothing here (rule R1 rule
 * 2, row CS18). Captured on the first call, at the engine host's start, before any proxied document exists.
 */

type Getter<T> = (this: unknown) => T;

export interface CosmeticNatives {
  recordType: Getter<string>;
  recordTarget: Getter<Node>;
  recordAddedNodes: Getter<NodeList>;
  recordAttributeName: Getter<string | null>;
  nodeListLength: Getter<number>;
  nodeListItem: (this: unknown, i: number) => Node | null;
  nodeType: Getter<number>;
  localName: Getter<string>;
  elQuerySelectorAll: (this: unknown, selector: string) => NodeList;
  docQuerySelectorAll: (this: unknown, selector: string) => NodeList;
  getAttribute: (this: unknown, name: string) => string | null;
  docHead: Getter<Element | null>;
  docElement: Getter<Element | null>;
  createElement: (this: unknown, tag: string) => Element;
  appendChild: (this: unknown, node: Node) => Node;
  textContentSet: (this: unknown, text: string) => void;
}

function getter<T>(proto: object | undefined, key: string): Getter<T> {
  for (let o: object | null | undefined = proto; o; o = Object.getPrototypeOf(o) as object | null) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d?.get) return d.get as Getter<T>;
  }
  return function missing(): never {
    throw new TypeError(`native getter ${key} is missing in this browser`);
  };
}

function setter(proto: object | undefined, key: string): (this: unknown, v: string) => void {
  for (let o: object | null | undefined = proto; o; o = Object.getPrototypeOf(o) as object | null) {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d?.set) return d.set as (this: unknown, v: string) => void;
  }
  return function missing(): never {
    throw new TypeError(`native setter ${key} is missing in this browser`);
  };
}

function capture(): CosmeticNatives {
  return {
    recordType: getter(MutationRecord.prototype, 'type'),
    recordTarget: getter(MutationRecord.prototype, 'target'),
    recordAddedNodes: getter(MutationRecord.prototype, 'addedNodes'),
    recordAttributeName: getter(MutationRecord.prototype, 'attributeName'),
    nodeListLength: getter(NodeList.prototype, 'length'),
    nodeListItem: NodeList.prototype.item as CosmeticNatives['nodeListItem'],
    nodeType: getter(Node.prototype, 'nodeType'),
    localName: getter(Element.prototype, 'localName'),
    elQuerySelectorAll: Element.prototype.querySelectorAll as CosmeticNatives['elQuerySelectorAll'],
    docQuerySelectorAll: Document.prototype.querySelectorAll as CosmeticNatives['docQuerySelectorAll'],
    getAttribute: Element.prototype.getAttribute as CosmeticNatives['getAttribute'],
    docHead: getter(Document.prototype, 'head'),
    docElement: getter(Document.prototype, 'documentElement'),
    createElement: Document.prototype.createElement as CosmeticNatives['createElement'],
    appendChild: Node.prototype.appendChild as CosmeticNatives['appendChild'],
    textContentSet: setter(Node.prototype, 'textContent'),
  };
}

let captured: CosmeticNatives | null = null;

/** This realm's natives for the cosmetic provider (captured on the first call). */
export function cosmeticNatives(): CosmeticNatives {
  captured ??= capture();
  return captured;
}
