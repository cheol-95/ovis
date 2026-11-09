/** Compatibility for Codex visualization fragments, inside the existing no-network page sandbox.
 * This implements local controls and in-memory widget state, never host actions or external assets.
 */
const styles = `
:root { color-scheme: light dark; --background: Canvas; --foreground: CanvasText;
  --card: Canvas; --card-foreground: CanvasText; --muted: ButtonFace; --muted-foreground: GrayText;
  --popover: Canvas; --popover-foreground: CanvasText; --primary: ButtonText; --primary-foreground: ButtonFace;
  --secondary: ButtonFace; --secondary-foreground: ButtonText; --accent: ButtonFace; --accent-foreground: ButtonText;
  --destructive: LinkText; --border: ButtonBorder; --input: ButtonBorder; --ring: Highlight;
  --blue: LinkText; --orange: LinkText; --green: LinkText; --red: LinkText; --purple: LinkText; --yellow: LinkText;
  --viz-series-1: LinkText; --viz-series-2: CanvasText; --viz-series-3: Highlight;
  --viz-series-4: LinkText; --viz-series-5: CanvasText; --viz-series-6: Highlight;
  --font-size-base: 14px;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 12px; background: var(--background); color: var(--foreground);
  font: var(--font-size-base)/1.55 system-ui, sans-serif; overflow-wrap: anywhere; }
h1,h2,h3,p { margin: 0; } h1 { font-size: 1.4em; } h2 { font-size: 1.2em; } h3 { font-size: 1em; }
button,input,select,textarea { font: inherit; color: inherit; }
button { cursor: pointer; } button:disabled { cursor: default; opacity: .6; }
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
a { color: var(--blue); } img,svg,canvas { max-width: 100%; }
.btn,.nav-link { padding: .4em .75em; border: 1px solid var(--border); border-radius: .4em; background: var(--background); }
.btn:hover,.nav-link:hover { background: var(--muted); }
.btn-primary,.btn[aria-pressed=true],.nav-link.active { background: var(--primary); color: var(--primary-foreground); }
.btn-ghost { border-color: transparent; }
.card { padding: 1em; background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: .6em; }
.viz-row,.viz-controls,.nav { display: flex; align-items: center; gap: .5em; flex-wrap: wrap; }
.viz-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,14em),1fr)); gap: 1em; }
.nav-justified > * { flex: 1; }
.text-muted { color: var(--muted-foreground); } .text-small { font-size: .86em; } .tabular-nums { font-variant-numeric: tabular-nums; }
.viz-stat-value { font-size: 1.7em; font-weight: 500; }
.form-label { display: grid; gap: .25em; } .form-control,.form-select { max-width: 100%; padding: .35em .5em; background: var(--background); border: 1px solid var(--input); border-radius: .3em; }
.form-check { display: inline-flex; gap: .4em; align-items: center; }
.table-responsive { overflow-x: auto; } table { border-collapse: collapse; } td,th { padding: .4em .6em; border-bottom: 1px solid var(--border); text-align: start; }
.progress { background: var(--muted); border-radius: .3em; overflow: hidden; } .progress-bar { min-height: .5em; background: var(--viz-series-1); }
.viz-badge { padding: .1em .4em; border-radius: .3em; background: var(--muted); }
[hidden] { display: none !important; }
@media (pointer: coarse) { .btn,.nav-link { min-height: 44px; } input,select,textarea { font-size: 16px; } }
`;

const runtime = String.raw`
(() => {
  let state = null;
  window.openai = { get widgetState() { return state; }, setWidgetState: async (next) => { state = next; } };
  let last = 0;
  const size = () => {
    const root = document.getElementById('ovis-visualization-content');
    if (!root) return;
    const height = Math.ceil(root.getBoundingClientRect().height + 24);
    if (height !== last) { last = height; parent.postMessage({type:'ovis-visualization-size',height}, '*'); }
  };
  addEventListener('message', (event) => {
    if (event.source !== parent || event.data?.type !== 'ovis-visualization-theme') return;
    const values = event.data.values;
    if (!values || typeof values !== 'object') return;
    for (const [key, value] of Object.entries(values)) {
      if (/^--[a-z0-9-]+$/.test(key) && typeof value === 'string' && value.length < 256)
        document.documentElement.style.setProperty(key, value);
    }
    size();
  });
  addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('ovis-visualization-content');
    if (root) new ResizeObserver(size).observe(root);
    document.addEventListener('click', (event) => {
      const tab = event.target.closest?.('.nav-link[role=tab]');
      const list = tab?.closest('[role=tablist]');
      if (!list || tab.disabled || tab.getAttribute('aria-disabled') === 'true') return;
      for (const item of list.querySelectorAll('[role=tab]')) {
        const selected = item === tab;
        item.classList.toggle('active', selected);
        item.setAttribute('aria-selected', String(selected));
        const panel = document.getElementById(item.getAttribute('aria-controls'));
        if (panel) panel.hidden = !selected;
      }
    });
    size();
    parent.postMessage({type:'ovis-visualization-ready'}, '*');
  });
})();`;

/** The file has already passed pageWithLocalFiles; neither policy nor resource permissions widen. */
export function visualizationPage(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style><script>${runtime}</script></head><body><div id="ovis-visualization-content">${html}</div></body></html>`;
}
