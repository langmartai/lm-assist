/**
 * Structure-aware SVG scrub for mermaid output (browser-only: needs DOMParser).
 *
 * Why not a regex over the serialized string: entity-encoded payloads
 * (`jav&#x09;ascript:`) and exotic attribute spacing survive regexes but are
 * DECODED by the parser — so validate the PARSED tree, then re-serialize.
 * Why not DOMPurify: it empties foreignObject children by design, and mermaid-11
 * flowcharts put every node label inside foreignObject HTML (see MermaidBlock).
 *
 * Policy: drop script-capable elements outright; strip all on* attributes;
 * allow href/src-like attributes only for fragment or http(s) targets.
 * Returns null when the input does not parse as SVG (caller falls back to raw).
 */
const BAD_ELEMENTS = new Set([
  'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'video', 'audio',
]);
const URL_ATTRS = new Set(['href', 'xlink:href', 'src', 'action', 'formaction']);

export function sanitizeSvgTree(svgText: string): string | null {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror') || !doc.documentElement || doc.documentElement.nodeName !== 'svg') {
    return null;
  }
  scrub(doc.documentElement);
  return new XMLSerializer().serializeToString(doc.documentElement);
}

function scrub(el: Element): void {
  for (const child of Array.from(el.children)) {
    if (BAD_ELEMENTS.has(child.tagName.toLowerCase())) {
      child.remove();
      continue;
    }
    scrub(child);
  }
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on')) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (URL_ATTRS.has(name)) {
      const v = attr.value.trim().toLowerCase();
      const safe = v.startsWith('#') || v.startsWith('http://') || v.startsWith('https://');
      if (!safe) el.removeAttribute(attr.name);
    }
  }
}
