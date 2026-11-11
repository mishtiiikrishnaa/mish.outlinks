'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   mish.outlinks
   forward links: everything the open note points at, plus the names you wrote without linking.
   a starship prompt, an eza-style tree and a tiny shell, as a sidebar view.
   dressed like mish.eza and mish.fastfetch: the same palette presets, pill
   shapes and card options.
   ═══════════════════════════════════════════════════════════════════════ */

const {
  Plugin, ItemView, PluginSettingTab, Setting, Notice, Platform, Keymap, Menu, TFile,
  getLinkpath, parseFrontMatterAliases,
} = require('obsidian');

/* node's `os` module is how the prompt finds your username.
   it only exists on desktop, which is why the manifest says isDesktopOnly. */
let nodeOs = null;
try { nodeOs = require('os'); } catch (e) { nodeOs = null; }

/* the two plugins (mish.outlinks / mish.backlinks) are this same file with
   these constants changed. */
const MODE = 'out';                 /* out = forward links, in = backlinks */
const P = 'ol';                       /* css class prefix, so the two never clash */
const NAME = 'mish.outlinks';
const KEY = 'outlinks';
const VIEW_TYPE = 'tv-outlinks-view';
const CMD = 'outlinks';
const ICON = 'links-going-out';
const IS_OUT = MODE === 'out';
const SORTS = IS_OUT ? ['line', 'name', 'count'] : ['name', 'count', 'recent'];
const COMMAND_WORDS = ['help', '?', 'man', 'linked', 'unlinked', 'sort', 'ctx', 'rescan', 'clear'];

/* ── the rainbow ─────────────────────────────────────────────────────────
   six colours, in this order everywhere: the prompt pills, the tree names, the
   card border, the scrollbar and the ribbon icon all read from them. same palette
   engine as mish.eza and mish.fastfetch. a slot is a few css variables: the theme's
   own (vf), the fill this plugin ships (f: pills, border, scrollbar) and the text
   version (t: row text; darker in light mode, `dark` = how much, copied from styles.css). */
const SLOTS = [
  { name: 'pink',   vf: '--vf-pink-hi', f: '--mz-f-pink-hi', t: '--mz-pink-hi', dark: 40, used: 'user pill, the note name at the top of the tree, the prompt caret, where the border starts' },
  { name: 'peach',  vf: '--vf-peach',   f: '--mz-f-peach',   t: '--mz-peach',   dark: 42, used: 'note pill, quoted names in the command, the highlighted words inside a line' },
  { name: 'yellow', vf: '--vf-yellow',  f: '--mz-f-yellow',  t: '--mz-yellow',  dark: 50, used: 'first arrow of the >>> bridge, the ×n counts, the scanning line' },
  { name: 'green',  vf: '--vf-green',   f: '--mz-f-green',   t: '--mz-green',   dark: 48, used: 'commands and the prompt arrow, second bridge arrow' },
  { name: 'blue',   vf: '--vf-blue',    f: '--mz-f-blue',    t: '--mz-blue',    dark: 40, used: 'third bridge arrow, line numbers, hover text on the tabs' },
  { name: 'lilac',  vf: '--vf-lilac',   f: '--mz-f-lilac',   t: '--mz-lilac',   dark: 38, used: 'count pill, the embed and prop tags, the link buttons, where the border ends' },
];

/* two more colours the six slots don't cover: broken links (hot pink) and property links (cyan).
   with a custom palette they borrow slot `from`. */
const EXTRAS = [
  { vf: '--vf-pink', f: '--mz-f-pink', t: '--mz-pink', from: 0 },
  { vf: '--vf-cyan', f: '--mz-f-cyan', t: '--mz-cyan', from: 5 },
];

/* what the plugin draws with when "mish" is picked (the sorbet palette) */
const DARK_FILLS  = ['#ffa6c9', '#ffd6a6', '#fff1a8', '#c9ffa6', '#a6c9ff', '#c9b0ff'];
const LIGHT_FILLS = ['#ff8fb8', '#ffb27a', '#ffd54f', '#8ee07f', '#82b4ff', '#b79bff'];

const PALETTES = {
  catppuccin: ['#f5c2e7', '#fab387', '#f9e2af', '#a6e3a1', '#89b4fa', '#cba6f7'],
  dracula:    ['#ff79c6', '#ffb86c', '#f1fa8c', '#50fa7b', '#8be9fd', '#bd93f9'],
  nord:       ['#bf616a', '#d08770', '#ebcb8b', '#a3be8c', '#81a1c1', '#b48ead'],
  gruvbox:    ['#fb4934', '#fe8019', '#fabd2f', '#b8bb26', '#83a598', '#d3869b'],
  ocean:      ['#c4f1f9', '#7fe0e8', '#6fd3c2', '#7bc6f0', '#82a8ff', '#a98bff'],
  sunset:     ['#ff8fa3', '#ff9e6b', '#ffc15e', '#ff7eb6', '#e08bff', '#b794ff'],
  forest:     ['#e6c9a8', '#d9b26f', '#e3e08a', '#9fd58a', '#6fc2a0', '#7fa8c9'],
  greyscale:  ['#f5f5f5', '#dcdcdc', '#c4c4c4', '#a8a8a8', '#8c8c8c', '#707070'],
};



const HEX = /^#[0-9a-f]{6}$/i;
const SHAPES = ['arrow', 'round', 'flat'];

const lightTheme = () => document.body.classList.contains('theme-light');
const themeFills = () => (lightTheme() ? LIGHT_FILLS : DARK_FILLS).slice();

const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* defaults underneath, what was saved on top; nested groups merge key by key,
   so a setting added in an update never goes missing from an old data.json */
const deepMerge = (base, over) => {
  const out = Object.assign({}, base);
  if (!isPlain(over)) return out;
  for (const k of Object.keys(over)) {
    out[k] = isPlain(base[k]) && isPlain(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
};



/* a data.json from an older version, or one edited by hand, must never break the panel */
const DEFAULT_SETTINGS = {
  lowercaseUi: true,     /* settings text in lowercase (true) or sentence case (false) */
  username: '',          /* empty = auto-detect */
  pillShape: 'arrow',    /* arrow | round | flat */
  palette: { preset: 'theme', colours: DARK_FILLS.slice() },   /* preset = theme | custom | one of PALETTES */
  inkColour: '',         /* text on the pills. empty = automatic (dark ink) */
  card: {
    width: 'full',       /* fit (the prompt decides) | full (the whole sidebar) */
    hAlign: 'centre',    /* centre | left */
    vAlign: 'top',       /* centre | top */
    ring: 'rainbow',     /* rainbow | accent | subtle | none */
    ringWidth: 1,
    angle: 135,          /* degrees, for the rainbow border */
    radius: 10,
    pad: 10,
  },
  font: 'bundled',       /* bundled | obsidian | system | family:<n> | custom */
  customFont: '',
  pills: { user: true, note: true, count: true },
  list: {
    sort: IS_OUT ? 'line' : 'name',
    snippets: 3,         /* lines shown under each note */
    minName: 3,          /* shortest note name the unlinked scan will look for */
    maxUnlinked: 100,    /* stop the unlinked scan after this many notes */
    autoScan: false,     /* scan for unlinked mentions in the background, not only when the tab is open */
  },
  show: { context: true, lines: true, counts: true, tags: true, unlinkedTab: true },
};

const sanitise = (cfg) => {
  const p = cfg.palette;
  if (p.preset !== 'theme' && p.preset !== 'custom' && !PALETTES[p.preset]) p.preset = 'theme';
  if (!Array.isArray(p.colours) || p.colours.length !== 6 || !p.colours.every((c) => HEX.test(c))) {
    p.colours = DARK_FILLS.slice();
  }
  if (!SHAPES.includes(cfg.pillShape)) cfg.pillShape = 'arrow';
  if (!SORTS.includes(cfg.list.sort)) cfg.list.sort = DEFAULT_SETTINGS.list.sort;
  cfg.list.snippets = num(cfg.list.snippets, 1, 6, 3);
  cfg.list.minName = num(cfg.list.minName, 2, 8, 3);
  cfg.list.maxUnlinked = num(cfg.list.maxUnlinked, 20, 500, 100);
  cfg.lowercaseUi = cfg.lowercaseUi !== false;
  return cfg;
};

/* the six colours to draw with, or null when the theme decides */
const customColours = (cfg) => {
  const p = cfg.palette;
  return p.preset !== 'theme' && Array.isArray(p.colours) && p.colours.length === 6 && p.colours.every((c) => HEX.test(c))
    ? p.colours : null;
};

/* css variables for the colours. a custom palette sets the plugin's own fills and text
   colours, and tells the theme's --vf-* to step aside (`initial` = "not set", so the
   fallbacks win). in light mode the text colour is the fill darkened, the same way
   styles.css does it for the default palette. */
const paletteVars = (cfg) => {
  const v = {};
  const colours = customColours(cfg);
  if (colours) {
    const light = lightTheme();
    const text = (hex, dark) => (light ? 'color-mix(in oklab, ' + hex + ', black ' + dark + '%)' : hex);
    SLOTS.forEach((s, i) => {
      v[s.vf] = 'initial';
      v[s.f] = colours[i];
      v[s.t] = text(colours[i], s.dark);
    });
    EXTRAS.forEach((x) => {
      v[x.vf] = 'initial';
      v[x.f] = colours[x.from];
      v[x.t] = text(colours[x.from], SLOTS[x.from].dark);
    });
  }
  if (HEX.test(cfg.inkColour)) {
    v['--vf-black'] = 'initial';
    v['--mz-ink'] = cfg.inkColour;
  }
  return v;
};

/* css variables for the card. every one has the old fixed value as its fallback in
   styles.css, so the defaults look exactly as before. */
const layoutVars = (cfg) => {
  const c = cfg.card;
  const v = {
    '--ol-radius': num(c.radius, 0, 28, 10) + 'px',
    '--ol-pad': num(c.pad, 0, 32, 10) + 'px',
    '--ol-angle': num(c.angle, 0, 360, 135) + 'deg',
    '--ol-mt': c.vAlign === 'top' ? '0' : 'auto',
    '--ol-ml': c.hAlign === 'left' ? '0' : 'auto',
  };
  const w = num(c.ringWidth, 1, 4, 1) + 'px';
  if (c.ring === 'none') {
    v['--ol-ring-w'] = '0px';
  } else if (c.ring === 'accent') {
    v['--ol-ring-w'] = w;
    v['--ol-ring-bg'] = 'var(--interactive-accent)';
  } else if (c.ring === 'subtle') {
    v['--ol-ring-w'] = w;
    v['--ol-ring-bg'] = 'var(--background-modifier-border)';
  } else {
    v['--ol-ring-w'] = w;                 /* rainbow: the gradient in styles.css */
  }
  return v;
};

/* sets the variables, and clears ones set last time that are no longer wanted */
const applyVars = (node, vars) => {
  for (const name of node.__olVars || []) {
    if (!(name in vars)) node.style.removeProperty(name);
  }
  for (const name of Object.keys(vars)) node.style.setProperty(name, vars[name]);
  node.__olVars = Object.keys(vars);
};



/* ── lowercase ui ────────────────────────────────────────────────────────
   the text in the settings tab is written in lowercase, to match the terminal look.
   with the "lowercase ui" setting off, ui() shows it in sentence case instead (a capital
   at the start of each sentence, plus the few names that need one). only text that
   obsidian itself shows goes through ui(): the settings tab, its tooltips and its
   messages. the terminal panel is always lowercase. */
const uiCase = { lower: true };

const PROPER = [
  [/\bcmu typewriter\b/g, 'CMU Typewriter'],
  [/\bobsidian\b/g, 'Obsidian'],
  [/\bcss\b/g, 'CSS'],
  [/\bui\b/g, 'UI'],
  [/\bpdfs\b/g, 'PDFs'],
  [/\bmish\b(?!\.[a-z])/g, 'Mish'],      /* the palette, not mish.eza / mish.fastfetch */
  [/\bpm\b/g, 'PM'],
  [/(?<![\w./-])git\b(?!\/)/g, 'Git'],      /* not the .git folder */
];

/* commands stay lowercase even at the start of a sentence */
const KEEP_LOWER = new Set(['rm', 'eza', 'mv', 'cp', 'mkdir', 'touch']);

const sentence = (text) => {
  let out = String(text);
  for (const [re, name] of PROPER) out = out.replace(re, name);
  return out.replace(/(^|[.!?]\s+)([a-z][\w-]*)/g, (m, lead, word) => (
    KEEP_LOWER.has(word) ? m : lead + word.charAt(0).toUpperCase() + word.slice(1)
  ));
};

const ui = (text) => (uiCase.lower ? text : sentence(text));

const uiOptions = (options) => Object.fromEntries(
  Object.entries(options).map(([key, label]) => [key, ui(label)])
);

/* a Setting whose name and description go through ui() */
class UiSetting extends Setting {
  setName(name) { return super.setName(typeof name === 'string' ? ui(name) : name); }
  setDesc(desc) { return super.setDesc(typeof desc === 'string' ? ui(desc) : desc); }
}



/* who and where, as the operating system reports it */
const detectIdentity = () => {
  let user = 'user';
  let host = 'localhost';
  try { user = nodeOs.userInfo().username || user; } catch (e) { /* keep the fallback */ }
  try { host = nodeOs.hostname().replace(/\.local$/i, '') || host; } catch (e) { /* keep the fallback */ }
  return { user: user.toLowerCase(), host: host.toLowerCase() };
};

const osLabel = () => {
  if (Platform.isMacOS) return 'macOS';
  if (Platform.isWin) return 'windows';
  if (Platform.isLinux) return 'linux';
  return 'unknown';
};

/* nerd font logos: apple / windows / linux */
const osGlyph = () => {
  if (Platform.isMacOS) return '\uF179';
  if (Platform.isWin) return '\uF17A';
  return '\uF17C';
};

/* ── fonts ───────────────────────────────────────────────────────────────
   the panel ships its own typewriter face (embedded in styles.css), so the
   default needs nothing installed. the settings can swap it for a font from
   the user's own machine. */

/* well-known monospace fonts, checked quietly with no permission needed */
const CANDIDATE_FONTS = [
  'SF Mono', 'Menlo', 'Monaco', 'Andale Mono', 'Consolas', 'Lucida Console', 'Cascadia Code',
  'Cascadia Mono', 'Courier New', 'JetBrains Mono', 'Fira Code', 'Fira Mono', 'Source Code Pro',
  'IBM Plex Mono', 'Roboto Mono', 'Hack', 'Inconsolata', 'Ubuntu Mono', 'DejaVu Sans Mono',
  'Liberation Mono', 'Noto Sans Mono', 'Iosevka', 'Victor Mono', 'Space Mono', 'CMU Typewriter Text',
  'MesloLGS NF',
];

const quoteFont = (name) => '"' + String(name).replace(/["\\]/g, '') + '"';

let measureCtx = null;
const textWidth = (family, text) => {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = '64px ' + family;
  return measureCtx.measureText(text).width;
};

/* installed = drawing with it differs from every plain fallback */
const isInstalled = (name) => ['monospace', 'serif', 'sans-serif'].some(
  (base) => textWidth(quoteFont(name) + ', ' + base, 'mmmmmmmmmmlli') !== textWidth(base, 'mmmmmmmmmmlli')
);

/* monospace = narrow and wide letters take the same room */
const isMono = (name) => {
  const f = quoteFont(name) + ', monospace';
  return Math.abs(textWidth(f, 'iiiiiiiiii') - textWidth(f, 'mmmmmmmmmm')) < 0.5 &&
    Math.abs(textWidth(f, 'llllllllll') - textWidth(f, 'WWWWWWWWWW')) < 0.5;
};

/* asks chromium for every installed family (it may ask permission first) and
   keeps the monospace ones. returns null when this version can't do it. */
const scanSystemFonts = async () => {
  if (typeof window.queryLocalFonts !== 'function') return null;
  const fonts = await window.queryLocalFonts();
  const families = Array.from(new Set(fonts.map((f) => f.family)));
  return families
    .filter((name) => !/symbols|emoji|icons|dingbats|wingdings|webdings/i.test(name))
    .filter((name) => isInstalled(name) && isMono(name))
    .sort((a, b) => a.localeCompare(b));
};

/* the font-family to put in --vf-mono, or null to leave the css default
   (the bundled face, or whatever a theme sets) alone */
const fontStack = (cfg) => {
  switch (cfg.font) {
    case 'obsidian': return 'var(--font-monospace), ui-monospace, monospace';
    case 'system': return 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    case 'custom': return cfg.customFont.trim() || null;
    default:
      return cfg.font.indexOf('family:') === 0
        ? quoteFont(cfg.font.slice(7)) + ', ui-monospace, monospace'
        : null;
  }
};



const pad = (n) => String(n).padStart(2, '0');

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

/* ── rainbow gradient for our own icons ──────────────────────────────────
   a hidden svg holds the gradient; styles.css points `stroke` at it. it is this
   plugin's own (mish.eza keeps another), so each icon follows its own palette. */
const RAINBOW_ID = 'mish-outlinks-rainbow-defs';

const mountRainbow = () => {
  let svg = document.getElementById(RAINBOW_ID);
  if (!svg) {
    const NS = 'http://www.w3.org/2000/svg';
    svg = document.createElementNS(NS, 'svg');
    svg.id = RAINBOW_ID;
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';

    const defs = document.createElementNS(NS, 'defs');
    const grad = document.createElementNS(NS, 'linearGradient');
    grad.id = 'mish-outlinks-rainbow';
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');   /* lucide icons live in a 24x24 box */
    grad.setAttribute('x1', '2');
    grad.setAttribute('y1', '2');
    grad.setAttribute('x2', '22');
    grad.setAttribute('y2', '22');

    const stops = [
      ['--vf-pink-hi', '#ffa6c9'], ['--vf-peach', '#ffd6a6'], ['--vf-yellow', '#fff1a8'],
      ['--vf-green', '#c9ffa6'], ['--vf-blue', '#a6c9ff'], ['--vf-lilac', '#c9b0ff'],
    ];
    stops.forEach(([name, fallback], i) => {
      const stop = document.createElementNS(NS, 'stop');
      stop.setAttribute('offset', String(i / (stops.length - 1)));
      stop.style.stopColor = 'var(' + name + ', var(' + name.replace('--vf-', '--mz-') + ', ' + fallback + '))';
      grad.appendChild(stop);
    });

    defs.appendChild(grad);
    svg.appendChild(defs);
    document.body.appendChild(svg);
  }
  svg.dataset.users = String(Number(svg.dataset.users || 0) + 1);
};

/* a colour as the browser sees it right now, for a css value that may hold var() or
   color-mix(). a gradient stop that only holds `var(...)` text never repaints when the
   theme flips (the text is the same string, so nothing tells the browser the icon is
   stale). a real colour does change between light and dark, so the icons follow. */
const resolveColour = (css) => {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none;color:' + css;
  document.body.appendChild(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
};

/* point the gradient's six stops at the palette, or at the theme's colours when the
   palette is the default. run again on every theme change (see onload). */
const paintRainbow = (cfg) => {
  const svg = document.getElementById(RAINBOW_ID);
  if (!svg) return;
  const colours = customColours(cfg);
  const light = lightTheme();
  svg.querySelectorAll('stop').forEach((stop, i) => {
    const sl = SLOTS[i];
    if (!sl) return;
    const css = colours
      ? (light ? 'color-mix(in oklab, ' + colours[i] + ', black ' + sl.dark + '%)' : colours[i])
      : 'var(' + sl.vf + ', var(' + sl.t + ', ' + DARK_FILLS[i] + '))';
    stop.style.stopColor = resolveColour(css) || css;
  });
};

const unmountRainbow = () => {
  const svg = document.getElementById(RAINBOW_ID);
  if (!svg) return;
  const left = Number(svg.dataset.users || 1) - 1;
  if (left <= 0) svg.remove();
  else svg.dataset.users = String(left);
};

/* ── keep the whole vault name visible ───────────────────────────────────
   the orange path pill never truncates. when the prompt is wider than the
   room it has, the whole bar is scaled down just enough to fit (css zoom),
   and is re-fitted whenever the pane resizes. (the card is as wide as this bar,
   so normally it fits at full size and the card just moves when the sidebar
   resizes; this only kicks in when the pane is narrower than the bar.) only below half size does the
   pill start to ellipsise instead. */
const fitBar = (bar, watch) => {
  const FLOOR = 0.5;
  let queued = false;

  const fit = () => {
    bar.classList.remove('is-squeezed');
    bar.style.zoom = '';                       /* measure at natural size */
    const have = bar.clientWidth;
    const need = bar.scrollWidth;
    if (!have || need <= have + 1) return;     /* fits (or is hidden): leave it alone */
    let k = have / need;
    if (k < FLOOR) { k = FLOOR; bar.classList.add('is-squeezed'); }
    bar.style.zoom = String(k);
  };

  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fit(); });
  };

  const ro = new ResizeObserver(schedule);
  watch.forEach((node) => ro.observe(node));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  schedule();
  schedule.dispose = () => ro.disconnect();
  return schedule;
};

/* ── rainbow scrollbar ──────────────────────────────────────────────────
   the native scrollbar is hidden (see styles.css) and this draws a thin
   rainbow thumb in its place, so it looks the same whatever theme or snippet
   is styling scrollbars. wheel / trackpad scrolling is untouched; the thumb
   can also be dragged. the scroller's parent must be position: relative. */
const rainbowBar = (scroller) => {
  const parent = scroller.parentElement;
  const sb = el('div', P + '-sb');
  const thumb = el('div', P + '-sb-thumb');
  sb.appendChild(thumb);
  parent.appendChild(sb);

  const update = () => {
    const { scrollHeight, clientHeight, scrollTop, offsetTop, offsetHeight } = scroller;
    if (!offsetHeight || scrollHeight <= clientHeight + 1) {
      sb.style.display = 'none';
      return;
    }
    sb.style.display = 'block';
    sb.style.top = offsetTop + 'px';
    sb.style.height = clientHeight + 'px';
    const h = Math.max(24, (clientHeight * clientHeight) / scrollHeight);
    const y = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - h);
    thumb.style.height = h + 'px';
    thumb.style.transform = 'translateY(' + y + 'px)';
  };

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  };

  scroller.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(schedule).observe(scroller);
  new MutationObserver(schedule).observe(scroller, { childList: true, subtree: true, characterData: true });

  /* drag the thumb */
  sb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startTop = scroller.scrollTop;
    const ratio = (scroller.scrollHeight - scroller.clientHeight) /
      Math.max(1, scroller.clientHeight - thumb.offsetHeight);
    sb.setPointerCapture(e.pointerId);
    const move = (ev) => { scroller.scrollTop = startTop + (ev.clientY - startY) * ratio; };
    const up = () => {
      sb.removeEventListener('pointermove', move);
      sb.removeEventListener('pointerup', up);
      sb.removeEventListener('pointercancel', up);
    };
    sb.addEventListener('pointermove', move);
    sb.addEventListener('pointerup', up);
    sb.addEventListener('pointercancel', up);
  });

  schedule();
};



/* ── small helpers ───────────────────────────────────────────────────── */

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tick = () => new Promise((resolve) => window.setTimeout(resolve, 0));
const labelOf = (f) => (f.extension === 'md' ? f.basename : f.name);
const isExternal = (raw) => /^[a-z][a-z0-9+.-]*:/i.test(raw);

/* `text with [[a link]] in the middle`, cut to a window around the match. the match
   is highlighted by the caller using `from` and `hl`. */
const windowed = (line, col, len, width) => {
  const lead = line.length - line.trimStart().length;
  const s = line.trim();
  const c = Math.max(0, col - lead);
  const W = width || 72;
  let start = 0;
  let end = s.length;
  if (s.length > W) {
    start = Math.max(0, c - Math.floor((W - len) / 3));
    end = Math.min(s.length, start + W);
    start = Math.max(0, end - W);
  }
  let text = s.slice(start, end);
  let from = c - start;
  if (start > 0) { text = '…' + text; from += 1; }
  if (end < s.length) text += '…';
  return { text, from: Math.max(0, from), hl: len };
};

/* every place a regex matches in a note's text, skipping properties, code, and the
   inside of links, so a name that is already linked is not offered again */
const mentionsIn = (text, re, cap) => {
  const out = [];
  const lines = text.split('\n');
  let fm = false;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && /^---\s*$/.test(line)) { fm = true; continue; }
    if (fm) { if (/^(---|\.\.\.)\s*$/.test(line)) fm = false; continue; }
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const col = m.index;
      const before = line.slice(0, col);
      const after = line.slice(col + m[0].length);
      const inWiki = before.lastIndexOf('[[') > before.lastIndexOf(']]') && after.includes(']]');
      const inUrl = before.lastIndexOf('](') > before.lastIndexOf(')') && after.includes(')');
      const inCode = (before.match(/`/g) || []).length % 2 === 1;
      if (!inWiki && !inUrl && !inCode) {
        out.push(Object.assign({ line: i, col, len: m[0].length, raw: m[0] }, windowed(line, col, m[0].length)));
        if (out.length >= cap) return out;
      }
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return out;
};

/* a note's own name, plus any aliases from its properties, long enough to be worth searching for */
const namesOf = (app, f, min) => {
  const names = [f.basename];
  try {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const al = fm ? parseFrontMatterAliases(fm) : null;
    if (al) names.push(...al);
  } catch (e) { /* no aliases */ }
  return Array.from(new Set(names.filter((n) => typeof n === 'string' && n.trim().length >= min).map((n) => n.trim())));
};

const wordRe = (names) => new RegExp(
  '(?<![\\p{L}\\p{N}_])(?:' + names.slice().sort((a, b) => b.length - a.length).map(esc).join('|') + ')(?![\\p{L}\\p{N}_])',
  'giu'
);

/* ── what this pane is for (shown when it is empty, and on the help page) ─────
   text between `backticks` is drawn in the accent colour. */
const WHAT = IS_OUT ? {
  title: 'forward links',
  paras: [
    "`outlinks` is the forward half of obsidian's link graph: everything the open note points at, listed as a tree under the note's name.",
    'it picks up wikilinks, markdown links, embeds and links in properties, folds repeats into one row (`×n`) and keeps them in the order they appear. a row marked `?` points at a note that does not exist yet. click it and obsidian makes it.',
    'the `unlinked` tab reads this note\'s text for the names of other notes you typed without linking them. press `link` beside a mention and it becomes a real link.',
  ],
  syntax: (n) => [
    ['[[note name]]', 'a wikilink. type `[[` in the editor and pick a note'],
    ['[[note|text]]', 'a link that reads as different text'],
    ['[[note#heading]]', 'a link to a heading inside a note'],
    ['![[file.png]]', 'an embed: a note, an image or a pdf'],
    ['[text](note.md)', 'a markdown style link'],
    ['links: [[note]]', 'a link inside properties counts too'],
  ],
  unlinkedEmpty: 'no unlinked mentions. every note name written in this text is already a link, or none appear.',
  unlinkedHow: 'the scan looks for the names (and aliases) of your other notes inside this one, skipping code, properties and anything already linked.',
} : {
  title: 'backlinks',
  paras: [
    '`backlinks` is the reverse: every note that links to the open note, with the line around each link, so you can see where and why an idea gets used.',
    'each source note is one row; `×n` says how many times it links here. click a row to open it, or click a line to land right on the link.',
    'the `unlinked` tab finds notes that mention this note\'s name (or an alias) without linking it. press `link` beside a mention to turn it into one.',
  ],
  syntax: (n) => [
    ['[[' + n + ']]', 'put this in any other note and it shows up here at once'],
    ['[[' + n + '|text]]', 'an aliased link counts as a backlink too'],
    ['![[' + n + ']]', 'so does embedding it'],
    ['[text](' + n.replace(/ /g, '%20') + '.md)', 'and a markdown style link'],
    ['aliases: [x]', 'in properties; mentions of x then show up as unlinked'],
  ],
  unlinkedEmpty: 'no unlinked mentions. nobody names this note without linking it.',
  unlinkedHow: 'the scan looks through the rest of the vault for this note\'s name and aliases, skipping code, properties and anything already linked.',
};

/* `text` with `backticked` parts in the accent colour */
const rich = (text) => {
  const frag = document.createDocumentFragment();
  String(text).split('`').forEach((part, i) => {
    if (!part) return;
    if (i % 2) frag.appendChild(el('span', P + '-k', part));
    else frag.appendChild(document.createTextNode(part));
  });
  return frag;
};

/* ── starship-style powerline prompt ─────────────────────────────────── */

const buildPrompt = (pills, user, noteLabel, countLabel, fullName) => {
  const bar = el('div', P + '-bar');
  const segs = [];
  if (pills.user) segs.push([P + '-user', osGlyph() + ' ' + user]);
  if (pills.note) segs.push([P + '-path', noteLabel]);
  if (pills.count) {
    /* the chevrons only make sense as a bridge to the count pill */
    if (pills.user || pills.note) segs.push([P + '-ch ' + P + '-ch1', ''], [P + '-ch ' + P + '-ch2', ''], [P + '-ch ' + P + '-ch3', '']);
    segs.push([P + '-count', countLabel]);
  }
  segs.forEach(([cls, text], i) => {
    const seg = el('span', P + '-seg ' + cls, text);
    seg.style.zIndex = String(segs.length - i);          /* each arrow tip sits over the next segment */
    if (cls === P + '-path' && fullName) seg.title = fullName;
    bar.appendChild(seg);
  });
  bar.hidden = segs.length === 0;
  return bar;
};

/* a command line made of coloured parts: [[class, text], ...] */
const buildCmd = (parts) => {
  const line = el('div', P + '-cmd');
  line.appendChild(el('span', P + '-chev', '❯'));
  parts.forEach(([cls, text]) => {
    line.appendChild(document.createTextNode(' '));
    line.appendChild(el('span', cls, text));
  });
  return line;
};

/* ── the view ────────────────────────────────────────────────────────── */

class LinksView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.refs = {};
    this.tab = 'linked';
    this.help = false;
    this.filter = '';
    this.file = null;
    this.linked = [];
    this.token = 0;
    this.lines = new Map();     /* note text, split into lines, for the context rows */
    this.unl = { run: 0, path: null, status: 'idle', items: [], done: 0, total: 0, capped: false, busy: false };
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return ui(CMD); }
  getIcon() { return ICON; }

  async onOpen() {
    const host = this.contentEl;
    host.empty();
    host.addClass(P + '-host');

    const root = el('div', P + '-root');
    host.appendChild(root);
    const card = el('div', P + '-card');
    root.appendChild(card);
    const scroll = el('div', P + '-scroll');
    card.appendChild(scroll);
    const helpEl = el('div', P + '-helppage');
    card.appendChild(helpEl);

    const refs = this.refs;
    Object.assign(refs, { root, card, scroll, helpEl });
    refs.bar = el('div');
    refs.cmd = el('div');
    refs.body = el('div', P + '-body');
    scroll.appendChild(refs.bar);
    scroll.appendChild(refs.cmd);
    scroll.appendChild(refs.body);

    this.buildFoot(card);
    this.applyLook();
    rainbowBar(scroll);
    rainbowBar(helpEl);

    const { workspace, vault, metadataCache } = this.app;
    this.registerEvent(workspace.on('file-open', () => this.schedule()));
    this.registerEvent(workspace.on('active-leaf-change', () => this.schedule()));
    this.registerEvent(metadataCache.on('resolved', () => this.schedule()));
    this.registerEvent(metadataCache.on('changed', (f) => {
      if (!this.file || f.path !== this.file.path) return;
      this.schedule();
      /* the open note's own text changed: what it mentions has moved */
      if (IS_OUT && this.unl.status === 'done' && this.tab === 'unlinked') this.scheduleScan();
    }));
    this.registerEvent(vault.on('rename', () => this.schedule()));
    this.registerEvent(vault.on('delete', () => this.schedule()));

    this.render();
  }

  async onClose() {
    window.clearTimeout(this.renderTimer);
    window.clearTimeout(this.scanTimer);
    window.clearTimeout(this.filterTimer);
    this.unl.run++;                                   /* stop a scan in flight */
    if (this.refs.disposeFit) this.refs.disposeFit();
  }

  /* ── plumbing ────────────────────────────────────────────────────── */

  schedule() {
    window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.render(), 200);
  }

  scheduleScan() {
    window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => this.startScan(true), 1200);
  }

  currentFile() {
    const f = this.app.workspace.getActiveFile();
    return f instanceof TFile ? f : null;
  }

  /* ── the footer: a little shell and the tabs ─────────────────────── */

  buildFoot(card) {
    const refs = this.refs;
    const foot = el('div', P + '-foot');
    card.appendChild(foot);

    refs.out = el('div', P + '-out');
    refs.out.addEventListener('click', () => this.say(''));
    foot.appendChild(refs.out);

    const line = el('div', P + '-line');
    foot.appendChild(line);
    line.appendChild(el('span', P + '-chev', '❯'));

    /* the input is invisible; a coloured copy of its text is drawn behind it, with a block caret */
    const wrap = el('div', P + '-inwrap is-empty');
    const hl = el('div', P + '-hl');
    const hlIn = el('span', P + '-hl-in');
    hl.appendChild(hlIn);
    const meas = el('span', P + '-hl-meas');
    const input = el('input', P + '-input');
    input.type = 'text';
    input.placeholder = 'filter · help';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('autocapitalize', 'off');
    const caret = el('span', P + '-caret', ' ');
    wrap.append(hl, meas, input, caret);
    line.appendChild(wrap);
    Object.assign(refs, { inwrap: wrap, input, hlIn, meas, caret });

    const tabs = el('div', P + '-tabs');
    line.appendChild(tabs);
    refs.tabs = {};
    ['help', 'linked', 'unlinked'].forEach((k) => {
      const t = el('span', P + '-tab');
      t.appendChild(el('span', P + '-tab-t', k));
      t.appendChild(el('span', P + '-tab-n'));
      t.addEventListener('click', () => this.setTab(k));
      tabs.appendChild(t);
      refs.tabs[k] = t;
    });

    const paint = () => this.paintInput();
    input.addEventListener('input', () => {
      this.onType(input.value);
      paint();
    });
    ['keyup', 'click', 'mouseup', 'select', 'scroll'].forEach((ev) => input.addEventListener(ev, paint));
    input.addEventListener('focus', () => { wrap.classList.add('is-focus'); paint(); });
    input.addEventListener('blur', () => { wrap.classList.remove('is-focus'); paint(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit(input.value);
        paint();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (this.help) this.setHelp(false);
        input.value = '';
        this.onType('');
        this.say('');
        paint();
      } else {
        window.requestAnimationFrame(paint);
      }
    });
    this.paintInput();
  }

  /* the coloured copy behind the input, and where the block caret sits */
  paintInput() {
    const { input, hlIn, meas, caret, inwrap } = this.refs;
    if (!input) return;
    const v = input.value;
    inwrap.classList.toggle('is-empty', !v);
    hlIn.textContent = '';

    const m = v.match(/^(\s*)(\S*)([\s\S]*)$/);
    const first = m ? m[2].toLowerCase() : '';
    if (!v) {
      /* placeholder shows */
    } else if (COMMAND_WORDS.includes(first)) {
      hlIn.appendChild(document.createTextNode(m[1]));
      hlIn.appendChild(el('span', P + '-hl-cmd', m[2]));
      const rest = m[3];
      if (first === 'sort' && rest.trim()) {
        const key = this.sortAlias(rest.trim().toLowerCase());
        const lead = rest.match(/^\s*/)[0];
        hlIn.appendChild(document.createTextNode(lead));
        hlIn.appendChild(el('span', SORTS.includes(key) ? P + '-hl-key' : P + '-hl-bad', rest.slice(lead.length)));
      } else if (rest) {
        hlIn.appendChild(el('span', P + '-hl-str', rest));
      }
    } else {
      hlIn.appendChild(el('span', P + '-hl-str', v));        /* a filter, like grep's pattern */
    }

    const pos = input.selectionStart == null ? v.length : input.selectionStart;
    meas.textContent = v.slice(0, pos);
    const x = meas.offsetWidth - input.scrollLeft;
    caret.style.transform = 'translate(' + x + 'px, -50%)';
    caret.textContent = v.charAt(pos);
    caret.style.animation = 'none';          /* solid while you type, blinking when idle */
    void caret.offsetWidth;
    caret.style.animation = '';
    inwrap.classList.toggle('is-focus', input.ownerDocument.activeElement === input);
    hlIn.style.transform = 'translateX(' + -input.scrollLeft + 'px)';
    inwrap.classList.toggle('has-sel', input.selectionStart !== input.selectionEnd);
  }

  say(text, kind) {
    const out = this.refs.out;
    if (!out) return;
    out.textContent = text || '';
    out.classList.toggle('is-bad', kind === 'bad');
  }

  sortAlias(word) {
    const map = { mtime: 'recent', modified: 'recent', date: 'recent', new: 'recent', newest: 'recent', order: 'line', position: 'line', n: 'name', az: 'name', alpha: 'name', num: 'count', most: 'count' };
    return map[word] || word;
  }

  /* typing: anything that is not a command filters the list as you go */
  onType(value) {
    const first = (value.trim().split(/\s+/)[0] || '').toLowerCase();
    const next = COMMAND_WORDS.includes(first) ? '' : value.trim();
    if (next === this.filter) return;
    this.filter = next;
    window.clearTimeout(this.filterTimer);
    this.filterTimer = window.setTimeout(() => {
      this.drawCmd();
      this.drawBody();
    }, 90);
  }

  /* enter: run a command, or report on the filter */
  submit(value) {
    const line = value.trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = (parts[1] || '').toLowerCase();
    const s = this.plugin.settings;

    if (['help', '?', 'man'].includes(cmd)) {
      this.setHelp(!this.help);
    } else if (cmd === 'linked') {
      this.setTab('linked');
    } else if (cmd === 'unlinked') {
      if (!s.show.unlinkedTab) this.say('unlinked is switched off in the settings.', 'bad');
      else this.setTab('unlinked');
    } else if (cmd === 'sort') {
      const key = this.sortAlias(arg);
      if (!SORTS.includes(key)) {
        this.say('sort: ' + (arg ? 'no key "' + arg + '"' : 'which key?') + ' try ' + SORTS.join(' | '), 'bad');
        return;
      }
      s.list.sort = key;
      this.plugin.persist();
      this.drawCmd();
      this.drawBody();
      this.say('sorted by ' + key);
    } else if (cmd === 'ctx') {
      s.show.context = arg === 'on' ? true : arg === 'off' ? false : !s.show.context;
      this.plugin.persist();
      this.drawCmd();
      this.render();
      this.say('context lines ' + (s.show.context ? 'on' : 'off'));
    } else if (cmd === 'rescan') {
      this.setTab('unlinked');
      this.startScan(false);
    } else if (cmd === 'clear') {
      this.refs.input.value = '';
      this.onType('');
      this.say('');
      return;
    } else {
      const shown = this.visible(this.tab === 'unlinked' ? this.unl.items : this.linked).length;
      const all = (this.tab === 'unlinked' ? this.unl.items : this.linked).length;
      this.say('grep: ' + shown + ' of ' + all + ' shown. esc to clear.');
      return;
    }
    this.refs.input.value = '';
    this.onType('');
  }

  setHelp(on) {
    this.help = on;
    this.drawTabs();
    if (on) this.drawHelp();
    this.refs.root.classList.toggle('is-help', on);
  }

  setTab(k) {
    if (k === 'help') { this.setHelp(!this.help); return; }
    if (k === 'unlinked' && !this.plugin.settings.show.unlinkedTab) return;
    this.tab = k;
    this.setHelp(false);
    this.drawCmd();
    this.drawBody();
    this.drawTabs();
    if (k === 'unlinked') this.ensureScan();
  }

  /* ── drawing ─────────────────────────────────────────────────────── */

  async render() {
    const refs = this.refs;
    if (!refs.card) return;
    const token = ++this.token;
    const keep = refs.scroll.scrollTop;
    const file = this.currentFile();

    if (!file || (this.file && this.file.path !== file.path)) {
      this.unl.run++;
      Object.assign(this.unl, { path: null, status: 'idle', items: [], capped: false, busy: false });
    }
    this.file = file;
    this.linked = !file || (IS_OUT && file.extension !== 'md') ? [] : (IS_OUT ? this.collectOut(file) : this.collectIn(file));

    if (!this.plugin.settings.show.unlinkedTab && this.tab === 'unlinked') this.tab = 'linked';

    /* lines for the context rows: from the cache when we have them, from disk when we don't */
    const miss = !IS_OUT ? this.linked.filter((it) => !this.tryFill(it)) : [];

    this.drawPrompt();
    this.drawCmd();
    this.drawBody();
    this.drawTabs();
    refs.scroll.scrollTop = keep;
    if (this.help) this.drawHelp();

    if (miss.length) {
      await this.loadSnips(miss, token);
      if (token === this.token) {
        this.drawBody();
        refs.scroll.scrollTop = keep;
      }
    }
    if (this.file && this.tab === 'unlinked') this.ensureScan();
    else if (this.file && this.plugin.settings.list.autoScan && this.unl.path !== this.file.path) this.startScan(false);
  }

  drawPrompt() {
    const { refs, plugin } = this;
    const who = plugin.identity();
    if (refs.disposeFit) refs.disposeFit();
    const file = this.file;
    const note = '~/' + (file ? labelOf(file) : this.app.vault.getName());
    const n = this.linked.length;
    const bar = buildPrompt(plugin.settings.pills, who.user, note, n + (IS_OUT ? ' out' : ' in'), file ? file.path : '');
    refs.bar.replaceWith(bar);
    refs.bar = bar;
    refs.fit = fitBar(bar, [refs.card, refs.scroll]);
    refs.disposeFit = refs.fit.dispose;
  }

  /* the command that "produced" what is below, with its flags */
  drawCmd() {
    const { refs, plugin } = this;
    const s = plugin.settings;
    const parts = [[P + '-exe', CMD]];
    if (this.file) parts.push([P + '-str', '"' + labelOf(this.file) + '"']);
    if (this.tab === 'unlinked') parts.push([P + '-flag', '--unlinked']);
    if (s.list.sort !== DEFAULT_SETTINGS.list.sort) parts.push([P + '-flag', '--sort=' + s.list.sort]);
    if (!s.show.context) parts.push([P + '-flag', '--no-context']);
    if (this.filter) {
      parts.push([P + '-pipe', '|'], [P + '-exe', 'grep'], [P + '-str', '"' + this.filter + '"']);
    }
    const cmd = buildCmd(parts);
    refs.cmd.replaceWith(cmd);
    refs.cmd = cmd;
  }

  drawTabs() {
    const { refs, plugin } = this;
    const tabs = refs.tabs;
    if (!tabs) return;
    const on = this.help ? 'help' : this.tab;
    Object.keys(tabs).forEach((k) => tabs[k].classList.toggle('is-on', k === on));
    tabs.unlinked.hidden = !plugin.settings.show.unlinkedTab;
    const num = (k, v) => { tabs[k].querySelector('.' + P + '-tab-n').textContent = v == null ? '' : ' ' + v; };
    num('linked', this.file ? this.linked.length : null);
    num('unlinked', this.unl.status === 'done' ? this.unl.items.length + (this.unl.capped ? '+' : '') : (this.unl.status === 'scanning' ? '…' : null));
    num('help', null);
  }

  /* ── the lists ───────────────────────────────────────────────────── */

  visible(items) {
    const q = this.filter.toLowerCase();
    const by = {
      name: (a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }),
      count: (a, b) => b.count - a.count || by.name(a, b),
      line: (a, b) => (a.line || 1e9) - (b.line || 1e9) || by.name(a, b),
      recent: (a, b) => ((b.file && b.file.stat ? b.file.stat.mtime : 0) - (a.file && a.file.stat ? a.file.stat.mtime : 0)) || by.name(a, b),
    };
    const key = this.plugin.settings.list.sort;
    return items
      .filter((it) => !q || it.label.toLowerCase().includes(q) || it.snips.some((s) => s.text.toLowerCase().includes(q)))
      .sort(by[key] || by.name);
  }

  collectOut(file) {
    const { metadataCache } = this.app;
    const cache = metadataCache.getFileCache(file) || {};
    const map = new Map();

    const add = (raw, kind, line) => {
      if (typeof raw !== 'string' || isExternal(raw)) return;
      let text = raw;
      try { text = decodeURIComponent(raw); } catch (e) { text = raw; }
      const path = getLinkpath(text);
      if (!path) return;                                       /* [[#heading]]: a link to itself */
      const dest = metadataCache.getFirstLinkpathDest(path, file.path);
      const key = dest ? dest.path : 'x:' + path.toLowerCase();
      let it = map.get(key);
      if (!it) {
        it = {
          key, file: dest, resolved: Boolean(dest), linkText: text, count: 0, line: 0,
          label: dest ? labelOf(dest) : path, kinds: new Set(), snips: [],
        };
        map.set(key, it);
      }
      it.count++;
      it.kinds.add(kind);
      if (line && (!it.line || line < it.line)) it.line = line;
    };

    (cache.links || []).forEach((l) => add(l.link, 'link', l.position.start.line + 1));
    (cache.embeds || []).forEach((l) => add(l.link, 'embed', l.position.start.line + 1));
    (cache.frontmatterLinks || []).forEach((l) => add(l.link, 'prop', 0));
    return Array.from(map.values());
  }

  collectIn(file) {
    const { metadataCache, vault } = this.app;
    const out = [];
    const resolved = metadataCache.resolvedLinks || {};
    for (const src of Object.keys(resolved)) {
      if (src === file.path) continue;
      const n = resolved[src][file.path];
      if (!n) continue;
      const sf = vault.getAbstractFileByPath(src);
      if (!(sf instanceof TFile)) continue;

      const cache = metadataCache.getFileCache(sf) || {};
      const refs = [];
      const kinds = new Set();
      const hit = (l, kind, positioned) => {
        const lp = getLinkpath(l.link || '');
        if (!lp) return;
        const dest = metadataCache.getFirstLinkpathDest(lp, sf.path);
        if (!dest || dest.path !== file.path) return;
        kinds.add(kind);
        if (positioned) refs.push({ line: l.position.start.line, col: l.position.start.col, len: l.original.length });
      };
      (cache.links || []).forEach((l) => hit(l, 'link', true));
      (cache.embeds || []).forEach((l) => hit(l, 'embed', true));
      (cache.frontmatterLinks || []).forEach((l) => hit(l, 'prop', false));
      refs.sort((a, b) => a.line - b.line || a.col - b.col);

      out.push({
        key: src, file: sf, resolved: true, count: n, label: labelOf(sf),
        line: refs.length ? refs[0].line + 1 : 0, kinds, refs, snips: [],
      });
    }
    return out;
  }

  /* the lines of a note, split, cached until the note changes */
  async getLines(f) {
    const hit = this.lines.get(f.path);
    if (hit && hit.m === f.stat.mtime) return hit.l;
    const text = await this.app.vault.cachedRead(f);
    const l = text.split('\n');
    this.lines.set(f.path, { m: f.stat.mtime, l });
    if (this.lines.size > 400) this.lines.delete(this.lines.keys().next().value);
    return l;
  }

  fillFrom(it, lines) {
    const seen = new Set();
    it.snips = it.refs.filter((r) => !seen.has(r.line) && seen.add(r.line)).map((r) => Object.assign(
      { line: r.line, col: r.col, len: r.len, raw: '' },
      windowed(lines[r.line] || '', r.col, r.len)
    ));
  }

  tryFill(it) {
    const hit = this.lines.get(it.file.path);
    if (!hit || hit.m !== it.file.stat.mtime) return it.refs.length === 0;
    this.fillFrom(it, hit.l);
    return true;
  }

  async loadSnips(items, token) {
    if (!this.plugin.settings.show.context) return;
    for (let i = 0; i < items.length; i += 20) {
      if (token !== this.token) return;
      await Promise.all(items.slice(i, i + 20).map(async (it) => {
        try { this.fillFrom(it, await this.getLines(it.file)); } catch (e) { /* unreadable: no context */ }
      }));
    }
  }

  /* ── unlinked mentions ───────────────────────────────────────────── */

  ensureScan() {
    if (!this.file || (IS_OUT && this.file.extension !== 'md')) return;
    const u = this.unl;
    if (u.path === this.file.path && (u.status === 'done' || u.status === 'scanning')) return;
    this.startScan(false);
  }

  async startScan(keep) {
    const file = this.file;
    if (!file || (IS_OUT && file.extension !== 'md')) return;
    const u = this.unl;
    const run = ++u.run;
    const sameNote = u.path === file.path;
    u.path = file.path;
    u.status = 'scanning';
    u.busy = true;
    u.done = 0;
    u.total = 0;
    if (!(keep && sameNote)) { u.items = []; u.capped = false; }
    this.drawBody();
    this.drawTabs();

    let result = null;
    try {
      result = IS_OUT ? await this.scanOut(file, run) : await this.scanIn(file, run);
    } catch (e) {
      console.error(NAME + ': scan failed', e);
    }
    if (u.run !== run) return;                           /* a newer scan took over */
    if (result) { u.items = result.items; u.capped = result.capped; }
    u.status = 'done';
    u.busy = false;
    this.drawBody();
    this.drawTabs();
  }

  progress(run, done, total) {
    const u = this.unl;
    if (u.run !== run) return;
    u.done = done;
    u.total = total;
    if (this.refs.scanText) this.refs.scanText.textContent = 'scanning ' + done + '/' + total;
  }

  /* backlinks: which other notes say this note's name without linking it */
  async scanIn(file, run) {
    const cfg = this.plugin.settings.list;
    const names = namesOf(this.app, file, cfg.minName);
    if (!names.length) return { items: [], capped: false };
    const re = wordRe(names);
    const lowers = names.map((n) => n.toLowerCase());
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path !== file.path);
    const items = [];
    let capped = false;

    for (let i = 0; i < files.length; i++) {
      if (i % 25 === 0) {
        this.progress(run, i, files.length);
        await tick();
        if (this.unl.run !== run) return null;
      }
      let text;
      try { text = await this.app.vault.cachedRead(files[i]); } catch (e) { continue; }
      const lower = text.toLowerCase();
      if (!lowers.some((n) => lower.includes(n))) continue;
      const snips = mentionsIn(text, re, 40);
      if (!snips.length) continue;
      items.push({
        key: files[i].path, file: files[i], resolved: true, label: labelOf(files[i]),
        count: snips.length, line: snips[0].line + 1, kinds: new Set(), snips,
      });
      if (items.length >= cfg.maxUnlinked) { capped = true; break; }
    }
    return { items, capped };
  }

  /* outlinks: which other notes this note names without linking them */
  async scanOut(file, run) {
    const cfg = this.plugin.settings.list;
    const text = await this.app.vault.cachedRead(file);
    const lower = text.toLowerCase();
    const linked = new Set(this.linked.filter((it) => it.file).map((it) => it.file.path));
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path !== file.path && !linked.has(f.path));
    const items = [];
    let capped = false;

    for (let i = 0; i < files.length; i++) {
      if (i % 400 === 0) {
        this.progress(run, i, files.length);
        await tick();
        if (this.unl.run !== run) return null;
      }
      const names = namesOf(this.app, files[i], cfg.minName).filter((n) => lower.includes(n.toLowerCase()));
      if (!names.length) continue;
      const snips = mentionsIn(text, wordRe(names), 40);
      if (!snips.length) continue;
      items.push({
        key: files[i].path, file: files[i], resolved: true, label: labelOf(files[i]),
        count: snips.length, line: snips[0].line + 1, kinds: new Set(), snips,
      });
      if (items.length >= cfg.maxUnlinked) { capped = true; break; }
    }
    return { items, capped };
  }

  /* turn one mention into a real link, right in the note it was found in */
  async linkMention(it, s) {
    const target = IS_OUT ? it.file : this.file;
    const src = IS_OUT ? this.file : it.file;
    if (!target || !src) return;
    try {
      let done = false;
      await this.app.vault.process(src, (data) => {
        const lines = data.split('\n');
        const ln = lines[s.line];
        if (ln == null || ln.substr(s.col, s.len) !== s.raw) return data;
        const alias = s.raw === target.basename ? undefined : s.raw;
        const link = this.app.fileManager.generateMarkdownLink(target, src.path, '', alias);
        lines[s.line] = ln.slice(0, s.col) + link + ln.slice(s.col + s.len);
        done = true;
        return lines.join('\n');
      });
      this.say(done ? 'linked ' + labelOf(target) + ' in ' + labelOf(src) + ':' + (s.line + 1) : 'that line has changed, scanning again.', done ? '' : 'bad');
    } catch (e) {
      new Notice(ui("couldn't write that link."));
    }
    this.startScan(true);
  }

  /* ── opening things ──────────────────────────────────────────────── */

  openFile(f, e, line) {
    const leaf = this.app.workspace.getLeaf(e ? Keymap.isModEvent(e) : false);
    const state = line != null ? { eState: { line } } : undefined;
    return leaf.openFile(f, state);
  }

  openItem(it, e) {
    if (it.file) this.openFile(it.file, e);
    else this.app.workspace.openLinkText(it.linkText, this.file ? this.file.path : '', e ? Keymap.isModEvent(e) : false);
  }

  hover(e, it, el2) {
    if (!it.file) return;
    this.app.workspace.trigger('hover-link', {
      event: e, source: VIEW_TYPE, hoverParent: this, targetEl: el2, linkText: it.file.path, sourcePath: '',
    });
  }

  menu(e, it) {
    if (!it.file) return;
    e.preventDefault();
    const menu = new Menu();
    menu.addItem((i) => i.setTitle(ui('open')).setIcon('file').onClick(() => this.openFile(it.file, null)));
    menu.addItem((i) => i.setTitle(ui('open in new tab')).setIcon('file-plus').onClick(() => this.app.workspace.getLeaf('tab').openFile(it.file)));
    menu.addItem((i) => i.setTitle(ui('open to the right')).setIcon('separator-vertical').onClick(() => this.app.workspace.getLeaf('split').openFile(it.file)));
    try { this.app.workspace.trigger('file-menu', menu, it.file, 'link-context-menu', this.leaf); } catch (err) { /* plain menu is fine */ }
    menu.showAtMouseEvent(e);
  }

  /* ── building rows ───────────────────────────────────────────────── */

  rowEl(cells, cls) {
    const r = el('div', P + '-row ' + (cls || ''));
    cells.forEach((c) => r.appendChild(el('span', P + '-cell ' + P + '-' + c)));
    return r;
  }

  tree(body, list, kind) {
    const cfg = this.plugin.settings;
    const nouns = kind === 'unlinked' ? ['mention', 'mentions'] : (IS_OUT ? ['link', 'links'] : ['backlink', 'backlinks']);
    const noun = list.length === 1 ? nouns[0] : nouns[1];

    const top = this.rowEl([], 'is-top');
    top.appendChild(el('span', P + '-name ' + P + '-dir', this.file.name));
    const tm = el('span', P + '-meta');
    tm.appendChild(el('span', P + '-dim', list.length + ' ' + noun));
    top.appendChild(tm);
    body.appendChild(top);

    const showSnips = kind === 'unlinked' || cfg.show.context;
    const max = cfg.list.snippets;

    list.forEach((it, i) => {
      const last = i === list.length - 1;
      const row = this.rowEl([last ? 'l' : 't'], P + '-c' + (i % 6));
      const name = el('span', P + '-name' + (it.resolved ? '' : ' is-broken'), it.label);
      if (it.file) name.title = it.file.path;
      else name.title = ui('no such note yet. click to create it.');
      row.appendChild(name);

      const meta = el('span', P + '-meta');
      if (cfg.show.tags) {
        it.kinds.forEach((k) => { if (k !== 'link') meta.appendChild(el('span', P + '-tag', k)); });
      }
      if (!it.resolved) meta.appendChild(el('span', P + '-q', '?'));
      if (cfg.show.counts && it.count > 1) meta.appendChild(el('span', P + '-n', '×' + it.count));
      if (IS_OUT && kind === 'linked' && cfg.show.lines && it.line) {
        const ln = el('span', P + '-ln', ':' + it.line);
        ln.title = ui('jump to this link in the note');
        ln.addEventListener('click', (e) => { e.stopPropagation(); this.openFile(this.file, e, it.line - 1); });
        meta.appendChild(ln);
      }
      row.appendChild(meta);

      row.addEventListener('click', (e) => this.openItem(it, e));
      row.addEventListener('mouseover', (e) => this.hover(e, it, row));
      row.addEventListener('contextmenu', (e) => this.menu(e, it));
      body.appendChild(row);

      if (!showSnips || !it.snips.length) return;
      const q = this.filter.toLowerCase();
      let snips = it.snips;
      if (q && !it.label.toLowerCase().includes(q)) snips = snips.filter((s) => s.text.toLowerCase().includes(q));
      const shown = snips.slice(0, max);
      const more = snips.length - shown.length;

      shown.forEach((s, j) => {
        const end = j === shown.length - 1 && !more;
        const sr = this.rowEl([last ? 'b' : 'v', end ? 'l' : 't'], 'is-snip');
        sr.appendChild(el('span', P + '-sl', ':' + (s.line + 1)));
        const t = el('span', P + '-st');
        t.appendChild(document.createTextNode(s.text.slice(0, s.from)));
        if (s.hl) t.appendChild(el('span', P + '-hl-m', s.text.substr(s.from, s.hl)));
        t.appendChild(document.createTextNode(s.text.slice(s.from + s.hl)));
        sr.appendChild(t);

        if (kind === 'unlinked') {
          const act = el('span', P + '-act', 'link');
          act.title = ui('turn this mention into a link');
          act.addEventListener('click', (e) => { e.stopPropagation(); this.linkMention(it, s); });
          sr.appendChild(act);
        }
        sr.addEventListener('click', (e) => {
          const f = kind === 'unlinked' && IS_OUT ? this.file : it.file;
          this.openFile(f, e, s.line);
        });
        body.appendChild(sr);
      });
      if (more > 0) {
        const mr = this.rowEl([last ? 'b' : 'v', 'l'], 'is-snip is-more');
        mr.appendChild(el('span', P + '-st', '… ' + more + ' more'));
        mr.addEventListener('click', (e) => this.openItem(it, e));
        body.appendChild(mr);
      }
    });

    if (kind === 'unlinked' && this.unl.capped) {
      body.appendChild(el('div', P + '-note', 'stopped at ' + cfg.list.maxUnlinked + ' notes. raise the limit in the settings to see more.'));
    }
  }

  /* what this pane is for: shown whenever there is nothing else to show */
  explain(body, state) {
    const f = this.file;
    const says = el('div', P + '-says');
    if (state === 'none') {
      says.textContent = f
        ? f.name + ' is not a note, so it has no links to list.'
        : 'no note is open.';
      body.appendChild(says);
      body.appendChild(el('div', P + '-p', 'open a note and ' + CMD + ' follows it as you move between notes and as you type.'));
    } else if (state === 'unlinked-empty') {
      says.textContent = '0 mentions.';
      body.appendChild(says);
      body.appendChild(el('div', P + '-p', WHAT.unlinkedEmpty));
      body.appendChild(el('div', P + '-p', WHAT.unlinkedHow));
      return;
    } else {
      says.textContent = IS_OUT
        ? '0 links. ' + f.name + " doesn't point anywhere yet."
        : '0 backlinks. nothing links to ' + f.name + ' yet.';
      body.appendChild(says);
    }

    const sec = (t) => body.appendChild(el('div', P + '-sec', t));
    sec('what this does');
    WHAT.paras.forEach((p) => {
      const d = el('div', P + '-p');
      d.appendChild(rich(p));
      body.appendChild(d);
    });
    sec(IS_OUT ? 'ways to make a link' : 'ways to get a backlink');
    const grid = el('div', P + '-grid');
    WHAT.syntax(f ? f.basename : 'note name').forEach(([k, d]) => {
      grid.appendChild(el('div', P + '-k', k));
      const dd = el('div', P + '-gd');
      dd.appendChild(rich(d));
      grid.appendChild(dd);
    });
    body.appendChild(grid);
    const tip = el('div', P + '-p is-dim');
    tip.appendChild(rich('tip: type `help` below for every command and what each mark means.'));
    body.appendChild(tip);
  }

  drawBody() {
    const { refs } = this;
    const body = refs.body;
    body.empty();
    refs.scanText = null;
    const file = this.file;

    if (!file || (IS_OUT && file.extension !== 'md')) { this.explain(body, 'none'); return; }

    if (this.tab === 'linked') {
      if (!this.linked.length) { this.explain(body, 'empty'); return; }
      const list = this.visible(this.linked);
      if (!list.length) {
        body.appendChild(el('div', P + '-note', 'grep: nothing matches "' + this.filter + '"'));
        return;
      }
      this.tree(body, list, 'linked');
      return;
    }

    /* unlinked tab */
    const u = this.unl;
    if (!u.items.length) {
      if (u.status === 'done') { this.explain(body, 'unlinked-empty'); return; }
      const line = el('div', P + '-scan');
      refs.scanText = el('span', null, 'scanning ' + u.done + '/' + (u.total || '…'));
      line.appendChild(refs.scanText);
      line.appendChild(el('span', P + '-cursor'));
      body.appendChild(line);
      return;
    }
    const list = this.visible(u.items);
    if (!list.length) {
      body.appendChild(el('div', P + '-note', 'grep: nothing matches "' + this.filter + '"'));
      return;
    }
    this.tree(body, list, 'unlinked');
    if (u.busy) {
      const line = el('div', P + '-scan');
      refs.scanText = el('span', null, 'scanning ' + u.done + '/' + (u.total || '…'));
      line.appendChild(refs.scanText);
      body.appendChild(line);
    }
  }

  /* the help page: takes the list's place, the prompt stays put below */
  drawHelp() {
    const h = this.refs.helpEl;
    h.empty();
    const f = this.file;

    const head = el('div', P + '-h-head');
    head.appendChild(el('div', P + '-h-side'));
    head.appendChild(el('div', P + '-h-title', CMD + ' · help'));
    const close = el('div', P + '-h-close', '✕');
    close.addEventListener('click', () => this.setHelp(false));
    head.appendChild(close);
    h.appendChild(head);
    h.appendChild(el('div', P + '-h-note', WHAT.title + ' · ' + NAME));

    const sec = (t) => h.appendChild(el('div', P + '-sec', t));
    const grid = (rows) => {
      const g = el('div', P + '-grid');
      rows.forEach(([k, d]) => {
        g.appendChild(el('div', P + '-k', k));
        const dd = el('div', P + '-gd');
        dd.appendChild(rich(d));
        g.appendChild(dd);
      });
      h.appendChild(g);
    };

    sec('what this does');
    WHAT.paras.forEach((p) => {
      const d = el('div', P + '-p');
      d.appendChild(rich(p));
      h.appendChild(d);
    });

    sec('reading the tree');
    grid(IS_OUT ? [
      ['note.md', 'the note you have open, at the top'],
      ['name', 'a note, image or file it points at'],
      ['×3', 'it is linked three times in the note'],
      [':12', 'the first line it appears on. click to jump there'],
      ['?', 'a broken link: no such note yet. click to create it'],
      ['embed', 'an embed (`![[…]]`), not a plain link'],
      ['prop', 'a link written in the properties'],
    ] : [
      ['note.md', 'the note you have open, at the top'],
      ['name', 'a note that links here'],
      ['×3', 'it links here three times'],
      [':12', 'a line in that note. click to open it right there'],
      ['… 2 more', 'more links than the lines shown. raise it in settings'],
      ['embed', 'it embeds this note (`![[…]]`)'],
      ['prop', 'it links here from its properties'],
    ]);

    sec('commands');
    grid([
      ['help', 'this page. also `?` and `man`'],
      ['linked', IS_OUT ? 'what this note points at' : 'the notes that link here'],
      ['unlinked', IS_OUT ? 'names you wrote without linking them' : 'notes that say this name without linking it'],
      ['sort <key>', SORTS.join(' · ') + '. remembered'],
      ['ctx [on|off]', 'the lines shown under each note'],
      ['rescan', 'scan for unlinked mentions again'],
      ['clear', 'empty the filter. `esc` does too'],
      ['anything else', 'filters the list as you type, like `grep`'],
    ]);

    sec('mouse');
    grid([
      ['click', 'open the note'],
      ['cmd/ctrl click', 'open it in a new tab'],
      ['hold cmd/ctrl', 'while hovering, for a page preview'],
      ['right click', 'the usual file menu'],
      ['link', 'on the unlinked tab: turns the mention into a link'],
    ]);

    sec('try it');
    grid(WHAT.syntax(f ? f.basename : 'note name'));
    const note = el('div', P + '-p is-dim');
    note.appendChild(rich(WHAT.unlinkedHow));
    h.appendChild(note);
  }

  /* ── look ────────────────────────────────────────────────────────── */

  applyFont() {
    const stack = fontStack(this.plugin.settings);
    if (stack) this.refs.root.style.setProperty('--vf-mono', stack);
    else this.refs.root.style.removeProperty('--vf-mono');
  }

  applyLook() {
    const { refs, plugin } = this;
    if (!refs.card) return;
    const cfg = plugin.settings;
    this.applyFont();
    applyVars(this.contentEl, Object.assign({}, paletteVars(cfg), layoutVars(cfg)));
    SHAPES.forEach((n) => refs.card.classList.toggle(P + '-shape-' + n, cfg.pillShape === n));
    refs.card.classList.toggle('is-full', cfg.card.width === 'full');
    if (refs.fit) refs.fit();
    this.paintInput();
  }

  applySettings() {
    if (!this.refs.card) return;
    this.applyLook();
    this.render();
  }
}

class LinksSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.scanned = [];
  }

  display() {
    const { containerEl, plugin } = this;
    const s = plugin.settings;
    containerEl.empty();
    const found = plugin.detected;

    const flag = (group, key, name, desc) => new UiSetting(containerEl)
      .setName(name)
      .setDesc(desc || '')
      .addToggle((toggle) => toggle
        .setValue(Boolean(s[group][key]))
        .onChange(async (value) => {
          s[group][key] = value;
          await plugin.saveSettings();
        }));

    /* the builders below (the same ones mish.eza uses) write into the settings, repaint,
       and save a moment later. kind: 'look' = styles only (fast), 'bar' = redraw the prompt too. */
    const apply = (kind) => {
      if (kind === 'bar') plugin.refreshViews();
      else plugin.restyle();
      plugin.persist();
    };
    const holder = (group) => (group ? s[group] : s);
    const dflt = (group, key) => (group ? DEFAULT_SETTINGS[group] : DEFAULT_SETTINGS)[key];

    const drop = (group, key, name, desc, options, kind) => new UiSetting(containerEl)
      .setName(name)
      .setDesc(desc || '')
      .addDropdown((d) => d
        .addOptions(uiOptions(options))
        .setValue(String(holder(group)[key]))
        .onChange((value) => {
          holder(group)[key] = value;
          apply(kind);
        }));

    /* a slider with a little reset arrow that puts the default back */
    const slide = (group, key, name, desc, lo, hi, step, kind, unit) => {
      let comp = null;
      return new UiSetting(containerEl)
        .setName(name)
        .setDesc(desc || '')
        .addSlider((sl) => {
          comp = sl;
          sl.setLimits(lo, hi, step)
            .setValue(Number(holder(group)[key]))
            .setDynamicTooltip()
            .onChange((value) => {
              holder(group)[key] = value;
              apply(kind);
            });
        })
        .addExtraButton((b) => b
          .setIcon('rotate-ccw')
          .setTooltip(ui('back to the default (' + dflt(group, key) + (unit || '') + ')'))
          .onClick(() => {
            holder(group)[key] = dflt(group, key);
            comp.setValue(dflt(group, key));
            apply(kind);
          }));
    };

    

    /* ── the first setting: how the text in this tab is cased ── */
    new UiSetting(containerEl)
      .setName('lowercase ui')
      .setDesc('show the text in this tab, its tooltips and its messages in lowercase, to match the terminal look. turn it off for normal sentence case.')
      .addToggle((toggle) => toggle
        .setValue(s.lowercaseUi !== false)
        .onChange(async (value) => {
          s.lowercaseUi = value;
          uiCase.lower = value;
          await plugin.saveSettings();
          plugin.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => { if (leaf.updateHeader) leaf.updateHeader(); });
          this.display();
        }));

    

    /* ── who you are ── */
    new UiSetting(containerEl).setName('identity').setHeading();
    new UiSetting(containerEl)
      .setName('user name')
      .setDesc('shown in the first pill. leave empty to use the name your system reports.')
      .addText((text) => text
        .setPlaceholder(found.user)
        .setValue(s.username)
        .onChange(async (value) => {
          s.username = value.trim();
          await plugin.saveSettings();
        }));

    /* ── what the prompt shows ── */
    new UiSetting(containerEl).setName('prompt').setHeading();
    flag('pills', 'user', 'user pill', 'your name, with a logo for your operating system.');
    flag('pills', 'note', 'note pill', 'the name of the open note.');
    flag('pills', 'count', 'count pill', IS_OUT ? 'how many notes the open note links to.' : 'how many notes link to the open note.');
    drop(null, 'pillShape', 'pill shape', 'arrow is the powerline look. round and flat drop the arrow tips (and the little >>> bridge before the count pill) and use gaps instead.',
      { arrow: 'arrow (powerline)', round: 'round', flat: 'flat' }, 'look');

    /* ── what the list shows ── */
    new UiSetting(containerEl).setName('list').setHeading();
    drop('list', 'sort', 'sort order', IS_OUT
      ? 'line = the order the links appear in the note. name = a to z. count = most repeated first. you can also type `sort <key>` in the panel.'
      : 'name = a to z. count = most links first. recent = most recently edited first. you can also type `sort <key>` in the panel.',
      Object.fromEntries(SORTS.map((k) => [k, k])), 'bar');
    flag('show', 'context', 'context lines', IS_OUT
      ? 'the lines under each unlinked mention. (links themselves have no context rows here: the note is already open beside it.)'
      : 'show the line around each link, under the note it comes from.');
    slide('list', 'snippets', 'lines per note', 'how many context lines to show under each note before it says "… n more".', 1, 6, 1, 'bar');
    flag('show', 'counts', 'repeat counts', 'the ×n beside a note that is linked more than once.');
    if (IS_OUT) flag('show', 'lines', 'line numbers', 'the :12 beside a link. click it to jump to that line.');
    flag('show', 'tags', 'embed and prop tags', 'marks links that are embeds or sit in properties.');

    new UiSetting(containerEl).setName('unlinked mentions').setHeading();
    flag('show', 'unlinkedTab', 'unlinked tab', 'the tab that finds mentions that are not links yet.');
    flag('list', 'autoScan', 'scan in the background', 'look for unlinked mentions as soon as a note opens, so the count is ready. off = only when you open the tab. big vaults may prefer off.');
    slide('list', 'minName', 'shortest name', 'notes with shorter names are never searched for, so "a" does not match everywhere.', 2, 8, 1, 'bar');
    slide('list', 'maxUnlinked', 'stop after', 'the scan stops after this many notes.', 20, 500, 10, 'bar');

    /* ── colours ── */
    new UiSetting(containerEl).setName('colours').setHeading();

    const pickers = [];
    let presetDrop = null;
    let refreshing = false;       /* setValue on a picker must not count as the user picking */
    const shown = () => (s.palette.preset === 'theme' ? themeFills() : s.palette.colours);

    const presets = { theme: ui('mish') };
    Object.keys(PALETTES).forEach((k) => { presets[k] = ui(k); });
    presets.custom = ui('custom');

    new UiSetting(containerEl)
      .setName('palette')
      .setDesc('the six colours of the rainbow. they colour the prompt pills, the rows, the card border, the scrollbar and the ribbon icon. mish is the default: the pastel rainbow this plugin ships, and it follows the colours of your obsidian theme if the theme sets them. pick a preset, then change any colour below. in light mode the text versions are darkened for you.')
      .addDropdown((d) => {
        presetDrop = d;
        d.addOptions(presets)
          .setValue(presets[s.palette.preset] ? s.palette.preset : 'theme')
          .onChange((value) => {
            const was = s.palette.preset;
            s.palette.preset = value;
            if (PALETTES[value]) s.palette.colours = PALETTES[value].slice();
            else if (value === 'custom' && was === 'theme') s.palette.colours = themeFills();
            refreshing = true;
            shown().forEach((c, i) => { if (pickers[i]) pickers[i].setValue(c); });
            refreshing = false;
            apply('look');
          });
      })
      .addExtraButton((b) => b
        .setIcon('rotate-ccw')
        .setTooltip(ui('back to mish'))
        .onClick(() => {
          s.palette.preset = 'theme';
          presetDrop.setValue('theme');
          refreshing = true;
          shown().forEach((c, i) => { if (pickers[i]) pickers[i].setValue(c); });
          refreshing = false;
          apply('look');
        }));

    SLOTS.forEach((slot, i) => {
      new UiSetting(containerEl)
        .setName('colour ' + (i + 1))
        .setDesc(slot.used)
        .addColorPicker((c) => {
          pickers[i] = c;
          c.setValue(shown()[i]).onChange((hex) => {
            if (refreshing) return;
            if (s.palette.preset === 'theme') s.palette.colours = themeFills();   /* start from what you were seeing */
            s.palette.colours[i] = String(hex).toLowerCase();
            s.palette.preset = 'custom';
            presetDrop.setValue('custom');
            apply('look');
          });
        });
    });

    let inkPicker = null;
    const autoInk = () => (lightTheme() ? '#2a2430' : '#0f0f12');
    new UiSetting(containerEl)
      .setName('pill text colour')
      .setDesc('the text on every pill. automatic = dark ink. try white with a dark palette.')
      .addColorPicker((c) => {
        inkPicker = c;
        c.setValue(HEX.test(s.inkColour) ? s.inkColour : autoInk()).onChange((hex) => {
          s.inkColour = String(hex).toLowerCase();
          apply('look');
        });
      })
      .addExtraButton((b) => b
        .setIcon('rotate-ccw')
        .setTooltip(ui('back to automatic'))
        .onClick(() => {
          s.inkColour = '';
          inkPicker.setValue(autoInk());
          apply('look');
        }));

    /* ── card and layout ── */
    new UiSetting(containerEl).setName('card and layout').setHeading();
    drop('card', 'width', 'card width', 'fit = as wide as the prompt . full = the whole sidebar.',
      { fit: 'fit the prompt', full: 'full width' }, 'look');
    drop('card', 'hAlign', 'horizontal position', 'only matters for the fit width.', { centre: 'centre', left: 'left' }, 'look');
    drop('card', 'vAlign', 'vertical position', 'centred when the card is shorter than the sidebar, or pinned to the top.',
      { centre: 'centre', top: 'top' }, 'look');
    drop('card', 'ring', 'border', "rainbow uses the palette. accent is obsidian's accent colour. subtle is your theme's border colour.",
      { rainbow: 'rainbow', accent: 'accent colour', subtle: 'subtle', none: 'none' }, 'look');
    slide('card', 'ringWidth', 'border thickness', '', 1, 4, 1, 'look', 'px');
    slide('card', 'angle', 'rainbow angle', 'direction of the border gradient. 135 runs top-left to bottom-right.', 0, 345, 15, 'look', '°');
    slide('card', 'radius', 'corner radius', '', 0, 28, 1, 'look', 'px');
    slide('card', 'pad', 'outer margin', 'space between the card and the edge of the sidebar.', 0, 32, 1, 'look', 'px');

    /* ── font ── */
    new UiSetting(containerEl).setName('appearance').setHeading();

    const choices = () => {
      const opts = {
        bundled: ui('cmu typewriter (bundled)'),
        obsidian: ui("obsidian's monospace font"),
        system: ui('system monospace'),
      };
      const names = new Set(CANDIDATE_FONTS.filter((n) => isInstalled(n)));
      this.scanned.forEach((n) => names.add(n));
      if (s.font.indexOf('family:') === 0) names.add(s.font.slice(7));
      Array.from(names)
        .sort((a, b) => a.localeCompare(b))
        .forEach((n) => { opts['family:' + n] = n; });
      opts.custom = ui('custom…');
      return opts;
    };

    let custom = null;

    new UiSetting(containerEl)
      .setName('font')
      .setDesc('the default font is bundled with the plugin, so nothing needs installing. or pick a monospace font from this computer.')
      .addDropdown((dropdown) => {
        this.fontDropdown = dropdown;
        dropdown
          .addOptions(choices())
          .setValue(s.font)
          .onChange(async (value) => {
            s.font = value;
            if (custom) custom.settingEl.hidden = value !== 'custom';
            await plugin.saveSettings();
          });
      });

    custom = new UiSetting(containerEl)
      .setName('custom font')
      .setDesc('any css font-family list, such as "JetBrains Mono", monospace')
      .addText((text) => text
        .setPlaceholder('"JetBrains Mono", monospace')
        .setValue(s.customFont)
        .onChange(async (value) => {
          s.customFont = value;
          await plugin.saveSettings();
        }));
    custom.settingEl.hidden = s.font !== 'custom';

    new UiSetting(containerEl)
      .setName('find monospace fonts')
      .setDesc("adds every monospace font installed on this computer to the menu above. obsidian may ask for permission first. if this version can't do it, the menu still lists the common fonts it finds.")
      .addButton((button) => button
        .setButtonText(ui('scan'))
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const list = await scanSystemFonts();
            if (!list) {
              new Notice(ui("this version of obsidian can't list system fonts. use a custom font instead."));
            } else {
              this.scanned = list;
              this.fontDropdown.selectEl.empty();
              this.fontDropdown.addOptions(choices());
              this.fontDropdown.setValue(s.font);
              new Notice(ui('found ' + list.length + ' monospace fonts.'));
            }
          } catch (e) {
            new Notice(ui('could not read the font list. use a custom font instead.'));
          }
          button.setDisabled(false);
        }));

    /* ── reset ── */
    new UiSetting(containerEl).setName('reset').setHeading();
    new UiSetting(containerEl)
      .setName('reset appearance')
      .setDesc('puts every colour, shape and card option back to the default. your name, rows, font and prompt pills are not touched.')
      .addButton((button) => button
        .setButtonText(ui('reset'))
        .setWarning()
        .onClick(async () => {
          for (const k of ['palette', 'inkColour', 'pillShape', 'card']) {
            s[k] = clone(DEFAULT_SETTINGS[k]);
          }
          await plugin.saveSettings();
          plugin.restyle();
          this.display();
        }));
  }
}

module.exports = class MishLinks extends Plugin {
  async onload() {
    await this.loadSettings();
    this.detected = detectIdentity();

    mountRainbow();
    paintRainbow(this.settings);
    this.addSettingTab(new LinksSettingTab(this.app, this));

    /* theme changes: the ribbon and tab icons, and the darker light-mode text colours,
       are repainted. css-change fires when obsidian applies a theme; a second pass a
       moment later covers themes whose css lands just after. the body watcher catches
       the light <-> dark flip itself, e.g. when the operating system changes it. */
    const repaint = () => this.restyle();
    this.registerEvent(this.app.workspace.on('css-change', () => {
      repaint();
      window.setTimeout(repaint, 250);
    }));
    let wasLight = lightTheme();
    const watcher = new MutationObserver(() => {
      if (lightTheme() === wasLight) return;
      wasLight = lightTheme();
      repaint();
    });
    watcher.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    this.register(() => watcher.disconnect());

    this.registerView(VIEW_TYPE, (leaf) => new LinksView(leaf, this));
    try {
      /* lets the page-preview plugin show a preview when you hold cmd/ctrl over a row */
      this.registerHoverLinkSource(VIEW_TYPE, { display: NAME, defaultMod: true });
    } catch (e) { /* older obsidian: no preview, everything else works */ }

    /* the class lets styles.css find our ribbon icon and give it the gradient */
    const ribbon = this.addRibbonIcon(ICON, 'Open ' + CMD, () => this.activate());
    ribbon.addClass('mish-' + KEY + '-ribbon');
    this.addCommand({
      id: 'open-' + KEY,
      name: 'Open ' + CMD + ' in sidebar',
      callback: () => this.activate(),
    });

    /* first run: put it in the right sidebar without stealing focus.
       after that, obsidian restores it from the saved layout. */
    this.app.workspace.onLayoutReady(async () => {
      if (this.app.workspace.getLeavesOfType(VIEW_TYPE).length) return;
      const leaf = this.app.workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: VIEW_TYPE, active: false });
    });
  }

  onunload() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveData(this.settings);       /* a change made a moment ago is not lost */
    }
    unmountRainbow();
  }

  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.settings = sanitise(deepMerge(clone(DEFAULT_SETTINGS), saved));
    uiCase.lower = this.settings.lowercaseUi;
  }

  async saveSettings() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    await this.saveData(this.settings);
    this.refreshViews();
  }

  /* slider drags, colour picks and the panel's own commands: save a moment after the last change */
  persist() {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      this.saveData(this.settings);
    }, 500);
  }

  /* styles only (colours, sizes, shape): cheaper than refreshViews, no redraw of the list */
  restyle() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof LinksView) leaf.view.applyLook();
    });
    paintRainbow(this.settings);
  }

  /* what the settings say, falling back to what the system says */
  identity() {
    return { user: this.settings.username || this.detected.user };
  }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view instanceof LinksView) leaf.view.applySettings();
    });
    paintRainbow(this.settings);
  }

  async activate() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
};
