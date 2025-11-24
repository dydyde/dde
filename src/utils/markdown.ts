import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

declare const marked: any;
declare const mermaid: any;

let markedConfigured = false;
let mermaidInitialized = false;

function escapeHtml(value: string) {
  return (value || '').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHref(href?: string | null) {
  if (!href) return '#';
  const trimmed = href.trim().toLowerCase();
  if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:')) return '#';
  return href;
}

function ensureMarkedConfigured() {
  if (markedConfigured || typeof marked === 'undefined') return;

  const renderer = new marked.Renderer();
  const baseCode = renderer.code?.bind(renderer);

  renderer.code = (code: string, infostring?: string, escaped?: boolean) => {
    const lang = (infostring || '').trim().toLowerCase();
    if (lang === 'mermaid' || lang === 'flowchart') {
      return `<div class="mermaid">${code}</div>`;
    }
    return baseCode ? baseCode(code, infostring, escaped) : false;
  };
  renderer.html = (html: string) => escapeHtml(html);
  renderer.link = (href: string | null, title: string | null, text: string) => {
    const safeHref = sanitizeHref(href);
    const safeTitle = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(safeHref)}"${safeTitle} rel="noopener noreferrer" target="_blank">${text}</a>`;
  };

  marked.use({ renderer });
  markedConfigured = true;
}

function schedule(fn: () => void) {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(fn);
  } else {
    setTimeout(fn, 0);
  }
}

function runMermaid(host?: HTMLElement) {
  if (!host || typeof mermaid === 'undefined') return;
  if (!mermaidInitialized) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    mermaidInitialized = true;
  }
  const nodes = host.querySelectorAll('.markdown-preview .mermaid:not([data-processed])');
  if (nodes.length === 0) return;
  mermaid.run({ nodes });
}

export function renderMarkdownWithMermaid(content: string, sanitizer: DomSanitizer, host?: HTMLElement): SafeHtml | string {
  if (typeof marked === 'undefined') return content;
  ensureMarkedConfigured();
  const html = marked.parse(escapeHtml(content || ''));
  if (host) {
    schedule(() => runMermaid(host));
  }
  return sanitizer.bypassSecurityTrustHtml(html);
}
