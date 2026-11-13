// Keeps task descriptions to a small, standard set of formatting: bold, italic, underline, lists, links, line breaks.
// Everything else (styles, fonts, colors, scripts, images) is stripped, both when saving and when pasting.

const KEEP = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'P', 'DIV', 'BR', 'A']);
const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'META', 'LINK', 'TITLE', 'HEAD']);
const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const BLOCKS = new Set(['SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE', 'PRE', 'TR', 'TABLE', 'FIGURE']);

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html ?? ''}`, 'text/html');
  const out = document.createElement('div');
  copy(doc.body, out);
  return out.innerHTML;
}

function copy(src, dst) {
  for (const n of src.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) { dst.append(n.textContent); continue; }
    if (n.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = n.tagName;
    if (DROP.has(tag)) continue;
    if (KEEP.has(tag)) {
      const e = document.createElement(tag);
      if (tag === 'A') {
        const href = n.getAttribute('href') ?? '';
        if (/^(https?:|mailto:)/i.test(href)) {
          e.setAttribute('href', href);
          e.setAttribute('target', '_blank');
          e.setAttribute('rel', 'noopener noreferrer');
        }
      }
      copy(n, e);
      dst.append(e);
    } else if (HEADINGS.has(tag)) {
      const d = document.createElement('div');
      const b = document.createElement('b');
      copy(n, b);
      d.append(b);
      dst.append(d);
    } else if (BLOCKS.has(tag)) {
      const d = document.createElement('div');
      copy(n, d);
      dst.append(d);
    } else {
      copy(n, dst); // unwrap span, font, etc.
    }
  }
}

/** True when the HTML has no visible text and no list items. */
export function htmlIsEmpty(html) {
  if (!html) return true;
  const d = document.createElement('div');
  d.innerHTML = html;
  return !d.textContent.trim() && !d.querySelector('li');
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
