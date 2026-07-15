/**
 * bookself/app/static/js/app.js
 *
 * All client-side logic for the BookSelf reading UI.
 *
 * This file manages:
 *   - The left pane navigation tree (publications → series → editions)
 *   - The right pane "Action Canvas" (6 different states)
 *   - Search with debounce
 *   - The "Sync Now" button with live output streaming
 *   - The right-click context menu ("Open in Finder/Explorer")
 *   - The sort toggle (newest-first ↔ A-Z)
 *   - The last-sync timestamp in the footer
 *
 * State machine:
 *   currentState = { type, data }
 *   type: 'empty' | 'publication' | 'series' | 'reader' | 'search' | 'settings'
 *   data: whatever the current state needs (publication name, newsletter id, etc.)
 */

// ══════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════

// One-liners shown on the empty state (random selection on each load)
const EMPTY_TAGLINES = [
  "Your newsletters, unchained from Gmail.",
  "Reading is a superpower. You've got this.",
  "No algorithm decides what you see here.",
  "Offline. Organized. Yours.",
  "The Ken won't know you're here. Neither will anyone else.",
  "Press Sync to start building your library.",
  "Everything you saved to read later. Actually here.",
  "Your inbox, curated. Your machine, always.",
  "Built for readers who mean it.",
  "No tracking pixels survive here.",
  "The newsletter you paid for, finally readable.",
  "What the internet looked like before feeds took over."
];

// ══════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════

let currentState = { type: 'empty', data: null };
let currentSort = 'date_desc';   // 'date_desc' | 'date_asc' | 'title_asc'
let appStatus = { total_newsletters: 0, last_synced: null, platform: 'Darwin' };
let navData = {};                 // { publications: [], seriesMap: {pub: [series]}, editionsMap: {} }
let contextMenuTarget = null;    // The nav item that was right-clicked
let searchDebounceTimer = null;
let previousStateBeforeSearch = null; // To restore state when search is cleared
let activeDateFilter = null;     // null = all; { fromYear, fromMonth, toYear, toMonth }
let activeReadFilter = null;     // null = all; 'unread' = not done; 'read' = done

// ── Stats cache + calendar navigation state ───────────────────────
let _statsCache = null;                           // last fetched /api/stats response
let _calYear  = new Date().getFullYear();         // calendar month shown in full stats view
let _calMonth = new Date().getMonth() + 1;
let _sidebarCalYear  = new Date().getFullYear();  // calendar month shown in sidebar
let _sidebarCalMonth = new Date().getMonth() + 1;

// ── Navigation history (back / forward) ──────────────────────────
// Stores up to MAX_HISTORY states. navHistoryIndex points to the current
// position. goBack() decrements, goForward() increments.
const MAX_HISTORY = 5;
let navHistory = [];       // array of { type, data } state objects
let navHistoryIndex = -1;  // -1 = no history yet
let isNavigatingHistory = false; // prevents push during back/forward calls

// ══════════════════════════════════════════════════════════════════
// THEMES — CSS variable palettes (add more by extending this object)
// ══════════════════════════════════════════════════════════════════

const THEMES = {
  'midnight-blues': {
    name: 'Midnight Blues',
    vars: {
      '--bg-dark':    '#1a1a2e', '--bg-mid':     '#16213e',
      '--bg-item':    '#0f3460', '--bg-surface': '#1e2f52',
      '--accent':     '#e94560', '--accent-dim': '#a03040',
      '--done-color': '#5A9645',
      '--text-main':  '#e0e0e0', '--text-dim':   '#8892a4',
      '--border':     '#2a2a4a',
      '--btn-primary-bg':    'linear-gradient(180deg, #f04e6a 0%, #c23050 100%)',
      '--btn-primary-color': '#fff',
      '--btn-secondary-bg':  'linear-gradient(180deg, #1e3060 0%, #141f40 100%)',
    },
    swatches: ['#1a1a2e', '#16213e', '#0f3460', '#e94560', '#8892a4', '#e0e0e0'],
  },
  'forest-dark': {
    name: 'Forest Dark',
    vars: {
      '--bg-dark':    '#0d1f17', '--bg-mid':     '#122a1f',
      '--bg-item':    '#193a22', '--bg-surface': '#1e3d2a',
      '--accent':     '#4ade80', '--accent-dim': '#22c55e',
      '--done-color': '#86efac',
      '--text-main':  '#e8f5ee', '--text-dim':   '#7a9a86',
      '--border':     '#1e3028',
      '--btn-primary-bg':    'linear-gradient(180deg, #3dcf71 0%, #1fa855 100%)',
      '--btn-primary-color': '#052e16',
      '--btn-secondary-bg':  'linear-gradient(180deg, #1a3d22 0%, #0d2118 100%)',
    },
    swatches: ['#0d1f17', '#122a1f', '#193a22', '#4ade80', '#7a9a86', '#e8f5ee'],
  },
  'amber-noir': {
    name: 'Amber Noir',
    vars: {
      '--bg-dark':    '#191310', '--bg-mid':     '#211a14',
      '--bg-item':    '#2c2118', '--bg-surface': '#271d14',
      '--accent':     '#f59e0b', '--accent-dim': '#b45309',
      '--done-color': '#86efac',
      '--text-main':  '#f0e8d8', '--text-dim':   '#9a8a6a',
      '--border':     '#2e2418',
      '--btn-primary-bg':    'linear-gradient(180deg, #f59e0b 0%, #d97706 100%)',
      '--btn-primary-color': '#1a0a00',
      '--btn-secondary-bg':  'linear-gradient(180deg, #2c2010 0%, #1a1208 100%)',
    },
    swatches: ['#191310', '#211a14', '#2c2118', '#f59e0b', '#9a8a6a', '#f0e8d8'],
  },
  'deep-purple': {
    name: 'Deep Purple',
    vars: {
      '--bg-dark':    '#0d0a1a', '--bg-mid':     '#150f2b',
      '--bg-item':    '#1e1440', '--bg-surface': '#241850',
      '--accent':     '#a78bfa', '--accent-dim': '#7c3aed',
      '--done-color': '#4ade80',
      '--text-main':  '#ede9ff', '--text-dim':   '#8878b8',
      '--border':     '#2a1a50',
      '--btn-primary-bg':    'linear-gradient(180deg, #9b74f7 0%, #7c4ef0 100%)',
      '--btn-primary-color': '#fff',
      '--btn-secondary-bg':  'linear-gradient(180deg, #21145a 0%, #15093c 100%)',
    },
    swatches: ['#0d0a1a', '#150f2b', '#1e1440', '#a78bfa', '#8878b8', '#ede9ff'],
  },
  'slate-storm': {
    name: 'Slate Storm',
    vars: {
      '--bg-dark':    '#0d1117', '--bg-mid':     '#161b22',
      '--bg-item':    '#21262d', '--bg-surface': '#1c2128',
      '--accent':     '#58a6ff', '--accent-dim': '#1f6feb',
      '--done-color': '#3fb950',
      '--text-main':  '#e6edf3', '--text-dim':   '#7d8590',
      '--border':     '#30363d',
      '--btn-primary-bg':    'linear-gradient(180deg, #f04e6a 0%, #c23050 100%)',
      '--btn-primary-color': '#fff',
      '--btn-secondary-bg':  'linear-gradient(180deg, #1e3060 0%, #141f40 100%)',
    },
    swatches: ['#0d1117', '#161b22', '#21262d', '#58a6ff', '#7d8590', '#e6edf3'],
  },
  'rose-gold': {
    name: 'Rose Gold',
    vars: {
      '--bg-dark':    '#1a1015', '--bg-mid':     '#231520',
      '--bg-item':    '#2e1a28', '--bg-surface': '#2a1520',
      '--accent':     '#f472b6', '--accent-dim': '#be185d',
      '--done-color': '#4ade80',
      '--text-main':  '#fce7f3', '--text-dim':   '#c084a0',
      '--border':     '#3d1a30',
      '--btn-primary-bg':    'linear-gradient(180deg, #f472b6 0%, #db2777 100%)',
      '--btn-primary-color': '#fff',
      '--btn-secondary-bg':  'linear-gradient(180deg, #2e1a28 0%, #1a0d18 100%)',
    },
    swatches: ['#1a1015', '#231520', '#2e1a28', '#f472b6', '#c084a0', '#fce7f3'],
  },
};

/** Apply a theme by id — sets CSS vars on :root and persists to localStorage */
function applyTheme(themeId) {
  const theme = THEMES[themeId] || THEMES['midnight-blues'];
  const root  = document.documentElement;
  Object.entries(theme.vars).forEach(([prop, val]) => root.style.setProperty(prop, val));
  localStorage.setItem('bookself-theme', themeId);
  // Re-inject dark mode CSS with new theme colors if an article is open in dark mode
  if (localStorage.getItem('articleDarkMode') === 'true') {
    const iframe = document.querySelector('.reader-iframe');
    if (iframe) applyArticleDarkMode(iframe, true);
  }
}

// ══════════════════════════════════════════════════════════════════
// ZOOM — whole-app scale (body.style.zoom, like OS-level zoom)
// ══════════════════════════════════════════════════════════════════

const ZOOM_LEVELS = { '1': 0.80, '2': 0.90, '3': 1.00, '4': 1.12, '5': 1.25 };

// ── Article dark mode ─────────────────────────────────────────────
// Same-origin iframes let us inject a <style> tag directly into the
// newsletter document. We use aggressive !important overrides because
// newsletters embed inline styles on every element.
// Reads current theme CSS vars so the injected colors match the active theme.
function getArticleDarkCss() {
  const cs  = getComputedStyle(document.documentElement);
  const bg  = cs.getPropertyValue('--bg-dark').trim()  || '#1a1a2e';
  const txt = cs.getPropertyValue('--text-main').trim() || '#d0d0d0';
  const acc = cs.getPropertyValue('--accent').trim()    || '#7ab3f5';
  return `
    html, body { background: ${bg} !important; color: ${txt} !important; }
    * { background-color: transparent !important; }
    body { background-color: ${bg} !important; }
    *, *::before, *::after { color: ${txt} !important; }
    h1, h2, h3, h4, h5, h6 { color: #f0f0f0 !important; }
    strong, b, th { color: #ebebeb !important; }
    a, a * { color: ${acc} !important; }
    td, th { border-color: rgba(255,255,255,0.07) !important; }
    hr { border-color: rgba(255,255,255,0.15) !important;
         background-color: rgba(255,255,255,0.15) !important; }
  `;
}

/**
 * Inject or remove the dark-mode stylesheet inside a newsletter iframe.
 *
 * Two-step approach needed for robustness:
 *   1. CSS injection handles backgrounds set via stylesheets or non-!important inline styles.
 *   2. DOM walk handles inline styles with `!important` (e.g. style="background:#fff !important")
 *      which cannot be overridden by any stylesheet rule — inline !important always wins.
 *
 * On disable, all originals are restored from data-attributes saved during enable.
 */
function applyArticleDarkMode(iframe, enabled) {
  try {
    const doc = iframe?.contentDocument;
    if (!doc || !doc.head) return;
    const existingDark  = doc.getElementById('_bsdm');
    const existingLight = doc.getElementById('_bs_light');

    if (enabled) {
      // --- DARK MODE ON ---
      // Remove light-mode baseline so our dark CSS can control the background
      if (existingLight) existingLight.remove();

      if (!existingDark) {
        // Step 1 — inject dark CSS stylesheet
        const s = doc.createElement('style');
        s.id = '_bsdm';
        s.textContent = getArticleDarkCss();
        doc.head.appendChild(s);

        // Step 2 — strip background AND color from inline styles.
        // Inline !important beats any stylesheet !important — CSS alone can't win.
        doc.querySelectorAll('[style]').forEach(el => {
          const raw = el.getAttribute('style') || '';
          if (!raw) return;
          const kept = raw.split(';').filter(decl => {
            const colon = decl.indexOf(':');
            if (colon === -1) return !!decl.trim();
            const prop = decl.slice(0, colon).trim().toLowerCase();
            if (prop === 'color') return false;
            if (/^background/.test(prop)) return false;
            return true;
          }).join('; ').trim().replace(/;\s*$/, '');
          if (kept === raw.trim()) return;
          el.setAttribute('data-bsdm', raw);
          if (kept) el.setAttribute('style', kept);
          else      el.removeAttribute('style');
        });
        // Step 2b — remove bgcolor HTML attribute (used on <table>/<td> in old-school emails)
        doc.querySelectorAll('[bgcolor]').forEach(el => {
          el.setAttribute('data-bsdm-bgcolor', el.getAttribute('bgcolor'));
          el.removeAttribute('bgcolor');
        });
      }

    } else {
      // --- LIGHT MODE ON ---
      // Remove dark CSS and restore any stripped inline styles
      if (existingDark) {
        existingDark.remove();
        doc.querySelectorAll('[data-bsdm]').forEach(el => {
          el.setAttribute('style', el.getAttribute('data-bsdm'));
          el.removeAttribute('data-bsdm');
        });
        doc.querySelectorAll('[data-bsdm-bgcolor]').forEach(el => {
          el.setAttribute('bgcolor', el.getAttribute('data-bsdm-bgcolor'));
          el.removeAttribute('data-bsdm-bgcolor');
        });
      }

      // Force white background on html+body.
      // Newsletters like Finshots set no background on <body>, so the browser uses the
      // OS Canvas color — which is dark when macOS is in dark mode. This overrides that
      // regardless of what the newsletter or OS says.
      if (!existingLight) {
        const ls = doc.createElement('style');
        ls.id = '_bs_light';
        doc.head.appendChild(ls);
      }
      doc.getElementById('_bs_light').textContent =
        'html,body{background:#ffffff!important;color-scheme:light!important}';
    }
  } catch (_) { /* cross-origin guard — won't fire for our own content */ }
}

/**
 * Scale the whole app by transforming #app (position:fixed).
 * #app dimensions are set to 100/scale vw|vh so that after
 * transform:scale(scale) the content fills the viewport exactly.
 * Fixed positioning means parent overflow cannot clip it.
 */
function applyZoom(level) {
  const scale = ZOOM_LEVELS[level] ?? 1.0;
  const app   = document.getElementById('app');
  localStorage.setItem('uiScale', level);
  if (!app) return;
  if (scale === 1.0) {
    app.style.transform = '';
    app.style.width  = '100vw';
    app.style.height = '100vh';
  } else {
    const pct = (100 / scale).toFixed(4);
    app.style.transform = `scale(${scale})`;
    app.style.width  = `${pct}vw`;
    app.style.height = `${pct}vh`;
  }
}

// ══════════════════════════════════════════════════════════════════
// API HELPERS
// ══════════════════════════════════════════════════════════════════

const API = {
  async get(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error ${res.status} at ${url}`);
    return res.json();
  },

  async post(url, body = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      // Try to read the actual error message from the JSON body before throwing
      let msg = `API error ${res.status} at ${url}`;
      try { const d = await res.json(); if (d.error) msg = d.error; } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  },

  async getPublications() {
    return this.get('/api/publications');
  },

  async getSeries(publication) {
    return this.get(`/api/publications/${encodeURIComponent(publication)}/series`);
  },

  async getNewsletters(params = {}) {
    const q = new URLSearchParams(params).toString();
    return this.get(`/api/newsletters?${q}`);
  },

  async getNewsletter(id) {
    return this.get(`/api/newsletters/${id}`);
  },

  async getOverviewPublication(publication) {
    return this.get(`/api/overview/publication/${encodeURIComponent(publication)}`);
  },

  async getOverviewSeries(publication, series) {
    return this.get(`/api/overview/series/${encodeURIComponent(publication)}/${encodeURIComponent(series)}`);
  },

  async search(query) {
    return this.get(`/api/search?q=${encodeURIComponent(query)}`);
  },

  async getStatus() {
    return this.get('/api/status');
  },

  async reveal(path) {
    return this.post('/api/reveal', { path });
  },

  async getNote(id) {
    return this.get(`/api/newsletters/${id}/note`);
  },

  async saveNote(id, myNotes, aiSummary = '') {
    return this.post(`/api/newsletters/${id}/note`, { my_notes: myNotes, ai_summary: aiSummary });
  },

  async getConfig() {
    return this.get('/api/config');
  },

  async saveConfig(content) {
    return this.post('/api/config', { content });
  },

  async syncWith(options = {}) {
    const body = { mode: options.mode || 'incremental' };
    if (options.start_date)    body.start_date    = options.start_date;
    if (options.sender)        body.sender        = options.sender;
    if (options.wipe_user_data) body.wipe_user_data = true;
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res; // return raw response for SSE streaming
  },

  async getLibrarySummary() {
    return this.get('/api/library/summary');
  },

  async getStats() {
    return this.get('/api/stats');
  },

  async generateSummary(id) {
    return this.post(`/api/newsletters/${id}/generate-summary`, {});
  },

  async getAiConfig() {
    return this.get('/api/ai-config');
  },

  async saveAiConfig(cfg) {
    return this.post('/api/ai-config', cfg);
  },

  async testAiConfig() {
    return this.post('/api/ai-config/test', {});
  },

  async listAiModels(provider, baseUrl) {
    const p = new URLSearchParams();
    if (provider) p.set('provider', provider);
    if (baseUrl)  p.set('base_url', baseUrl);
    return this.get('/api/ai-config/models?' + p.toString());
  }
};

// ══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  // ── Apply saved scale preferences from localStorage ───────────
  const savedUiScale   = localStorage.getItem('uiScale')   || '3';
  const savedFontScale = localStorage.getItem('fontScale') || '3';
  const savedTheme     = localStorage.getItem('bookself-theme') || 'midnight-blues';
  applyZoom(savedUiScale);
  applyTheme(savedTheme);
  document.documentElement.dataset.fontScale = savedFontScale;

  // ── Initialise drag-to-resize divider ─────────────────────────
  initPaneResize();

  // Load status (last sync time, total count, platform)
  await loadStatus();

  // Build the left pane navigation tree
  await buildNavTree();

  // Show the empty state in the right pane
  renderEmpty();

  // Wire up all the event listeners
  setupEventListeners();

  // Non-blocking: check GitHub for a newer release, show banner if found
  checkForUpdates();
});

// ══════════════════════════════════════════════════════════════════
// UPDATE CHECK — compares APP_VERSION against latest GitHub release
// ══════════════════════════════════════════════════════════════════

async function checkForUpdates() {
  try {
    const r = await fetch('/api/update-check');
    const d = await r.json();
    if (!d.update_available) return;
    // Dismissed this version already? Stay quiet until the next one.
    if (localStorage.getItem('update-dismissed') === d.latest) return;

    const banner = document.createElement('div');
    banner.className = 'update-banner';
    banner.innerHTML = `
      <span class="update-banner-text">⬆ BookSelf v${d.latest} is available (you have v${d.current})</span>
      <button class="update-banner-btn" id="update-download-btn">Download</button>
      <button class="update-banner-dismiss" id="update-dismiss-btn" title="Dismiss until next release">✕</button>
    `;
    document.body.prepend(banner);
    document.getElementById('update-download-btn').addEventListener('click', () => {
      fetch('/api/open-release', { method: 'POST' });
    });
    document.getElementById('update-dismiss-btn').addEventListener('click', () => {
      localStorage.setItem('update-dismissed', d.latest);
      banner.remove();
    });
  } catch (e) { /* offline or dev — stay silent */ }
}

// ══════════════════════════════════════════════════════════════════
// NAVIGATION HISTORY — back / forward with 5-state memory
// ══════════════════════════════════════════════════════════════════

/**
 * Push the current state onto the history stack before navigating away.
 * Call this at the START of every render function, passing the OLD currentState.
 * Skip if we're currently navigating history (goBack / goForward).
 */
function pushHistory(stateSnapshot) {
  if (isNavigatingHistory) return;

  // Trim any forward history (navigating new path clears it)
  navHistory = navHistory.slice(0, navHistoryIndex + 1);

  // Add the snapshot
  navHistory.push({ ...stateSnapshot });

  // Cap at MAX_HISTORY
  if (navHistory.length > MAX_HISTORY) {
    navHistory.shift();
  }

  navHistoryIndex = navHistory.length - 1;
  updateHistoryButtons();
}

function goBack() {
  if (navHistoryIndex <= 0) return;
  navHistoryIndex--;
  updateHistoryButtons();
  const state = navHistory[navHistoryIndex];
  isNavigatingHistory = true;
  renderStateFromHistory(state);
  isNavigatingHistory = false;
}

function goForward() {
  if (navHistoryIndex >= navHistory.length - 1) return;
  navHistoryIndex++;
  updateHistoryButtons();
  const state = navHistory[navHistoryIndex];
  isNavigatingHistory = true;
  renderStateFromHistory(state);
  isNavigatingHistory = false;
}

async function renderStateFromHistory(state) {
  // Re-render whatever state was stored without pushing more history
  switch (state.type) {
    case 'empty':
      renderEmpty();
      break;
    case 'publication':
      await renderPublicationOverview(state.data.publication);
      break;
    case 'series':
      await renderSeriesOverview(state.data.publication, state.data.series);
      break;
    case 'reader':
      await renderNewsletterReader(state.data.id);
      break;
    case 'search':
      await renderSearchResults(state.data.query);
      break;
    case 'settings':
      renderSettings();
      break;
  }
}

function updateHistoryButtons() {
  const backBtn    = document.getElementById('btn-back');
  const forwardBtn = document.getElementById('btn-forward');
  if (!backBtn || !forwardBtn) return;
  backBtn.disabled    = navHistoryIndex <= 0;
  forwardBtn.disabled = navHistoryIndex >= navHistory.length - 1;
}

// ══════════════════════════════════════════════════════════════════
// PANE RESIZE — drag the divider to resize left / right panes
// ══════════════════════════════════════════════════════════════════

function initPaneResize() {
  const divider    = document.getElementById('pane-divider');
  const mainLayout = document.getElementById('main-layout');
  const leftPane   = document.getElementById('left-pane');

  if (!divider || !mainLayout || !leftPane) return;

  let isDragging   = false;
  let currentWidth = 260; // CSS default

  // Restore saved width
  const saved = localStorage.getItem('leftPaneWidth');
  if (saved && !isNaN(parseInt(saved))) {
    // Clamp restored width too — an old saved value below the new minimum
    // would resurrect the squished-pane bug on every launch
    currentWidth = Math.max(230, Math.min(600, parseInt(saved)));
    document.documentElement.style.setProperty('--left-pane-width', currentWidth + 'px');
  }

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    divider.classList.add('dragging');
    // ── Kill the CSS transition during drag so the pane follows the cursor
    //    instantly. Without this, each CSS-variable update triggers a fresh
    //    0.18s ease animation, making the pane lag and wobble.
    leftPane.style.transition = 'none';
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    // getBoundingClientRect() returns viewport px (already zoom-adjusted).
    // The CSS variable needs app-internal px, so divide by the current scale.
    const appEl = document.getElementById('app');
    const scaleMatch = (appEl.style.transform || '').match(/scale\(([^)]+)\)/);
    const scale = scaleMatch ? parseFloat(scaleMatch[1]) : 1.0;

    const rect   = mainLayout.getBoundingClientRect();
    const viewPx = e.clientX - rect.left;
    const cssPx  = scale === 1.0 ? viewPx : viewPx / scale;
    const newWidth = Math.max(230, Math.min(600, cssPx));

    currentWidth = newWidth;
    document.documentElement.style.setProperty('--left-pane-width', newWidth + 'px');
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    divider.classList.remove('dragging');
    leftPane.style.transition = '';   // restore CSS transition after drag ends
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    localStorage.setItem('leftPaneWidth', currentWidth);
  });
}

async function loadStatus() {
  try {
    appStatus = await API.getStatus();

    // Update last sync timestamp in footer
    const syncValueEl = document.getElementById('last-sync-value');
    if (appStatus.last_synced) {
      syncValueEl.textContent = appStatus.last_synced;
    } else {
      syncValueEl.textContent = 'Never';
    }

    // Set context menu label based on platform
    const ctxOpenFolder = document.getElementById('ctx-open-folder');
    if (appStatus.platform === 'Windows') {
      ctxOpenFolder.textContent = 'Open in Explorer';
    } else if (appStatus.platform === 'Darwin') {
      ctxOpenFolder.textContent = 'Open in Finder';
    } else {
      ctxOpenFolder.textContent = 'Open folder';
    }
  } catch (err) {
    console.warn('Could not load status:', err);
  }
}

// ══════════════════════════════════════════════════════════════════
// NAV TREE — BUILD AND RENDER
// ══════════════════════════════════════════════════════════════════

async function buildNavTree() {
  const treeEl = document.getElementById('nav-tree');

  try {
    const publications = await API.getPublications();

    if (publications.length === 0) {
      treeEl.innerHTML = `
        <div class="nav-loading">
          No newsletters yet.<br>Click Sync to fetch from Gmail.
        </div>`;
      return;
    }

    navData.publications = publications;
    navData.seriesMap = {};
    navData.editionsMap = {};

    // Render the tree HTML
    treeEl.innerHTML = renderNavTreeHTML(publications);

    // Attach click handlers to all nav items
    attachNavHandlers();

  } catch (err) {
    treeEl.innerHTML = `<div class="nav-loading" style="color:#e94560">
      Error loading library.<br><small>${err.message}</small>
    </div>`;
  }
}

/**
 * Replace the left nav tree with a filtered view of search results.
 * Groups results by publication and shows a flat list of matching editions.
 * Call buildNavTree() to restore the full tree when search is cleared.
 */
function buildFilteredNavTree(results) {
  const treeEl = document.getElementById('nav-tree');

  if (!results || results.length === 0) {
    treeEl.innerHTML = `<div class="nav-loading" style="font-size:12px;padding:12px">No results</div>`;
    return;
  }

  // Group results by publication (preserve insertion order → sorted by relevance)
  const grouped = {};
  for (const r of results) {
    if (!grouped[r.publication]) grouped[r.publication] = [];
    grouped[r.publication].push(r);
  }

  let html = '';
  for (const [pub, items] of Object.entries(grouped)) {
    html += `
      <div class="nav-publication">
        <div class="nav-pub-header" style="cursor:default">
          <span class="nav-pub-name">${escHtml(pub)}</span>
          <span class="nav-filter-count">${items.length}</span>
        </div>
        <div class="nav-series-list open">
          ${items.map(item => `
            <div class="nav-edition nav-filter-result" data-id="${item.id}">
              <span class="nav-edition-date">${formatDateShort(item.date_received)}</span>
              <span class="nav-edition-title">${escHtml(item.title.length > 40 ? item.title.slice(0, 40) + '…' : item.title)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  treeEl.innerHTML = html;

  // Attach click handlers to each filtered edition
  treeEl.querySelectorAll('.nav-filter-result').forEach(el => {
    el.addEventListener('click', () => {
      clearActiveNav();
      el.classList.add('active');
      renderNewsletterReader(parseInt(el.dataset.id));
    });
  });
}

function renderNavTreeHTML(publications) {
  return publications.map(pub => `
    <div class="nav-publication" data-pub="${escHtml(pub)}">
      <div class="nav-pub-header"
           data-pub="${escHtml(pub)}"
           data-type="publication"
           oncontextmenu="handleContextMenu(event, 'publication', '${escAttr(pub)}')"
      >
        <span class="nav-chevron">›</span>
        <span class="nav-pub-name">${escHtml(pub)}</span>
      </div>
      <div class="nav-series-list" data-pub="${escHtml(pub)}">
        <!-- Series loaded lazily when publication is expanded -->
        <div class="nav-loading" style="font-size:11px;padding:6px 8px">Loading...</div>
      </div>
    </div>
  `).join('');
}

function attachNavHandlers() {
  // Publication headers
  document.querySelectorAll('.nav-pub-header').forEach(el => {
    el.addEventListener('click', () => handlePublicationClick(el));
  });

  // Context menu suppression on right-click (handled separately)
  document.addEventListener('contextmenu', e => {
    if (!e.target.closest('[oncontextmenu]')) {
      // Don't show context menu on non-nav items
    }
  });
}

async function handlePublicationClick(headerEl) {
  const pub = headerEl.dataset.pub;
  const publicationEl = headerEl.closest('.nav-publication');
  const seriesListEl = publicationEl.querySelector('.nav-series-list');
  const chevronEl = headerEl.querySelector('.nav-chevron');

  // Highlight as active
  clearActiveNav();
  headerEl.classList.add('active');

  // Show publication overview in right pane
  renderPublicationOverview(pub);

  // Toggle expand/collapse
  const isOpen = seriesListEl.classList.contains('open');

  if (!isOpen) {
    // Expand: load series if not already loaded
    chevronEl.classList.add('open');
    seriesListEl.classList.add('open');

    if (!navData.seriesMap[pub]) {
      try {
        const series = await API.getSeries(pub);
        navData.seriesMap[pub] = series;
        renderSeriesInTree(pub, series, seriesListEl);
      } catch (err) {
        seriesListEl.innerHTML = `<div class="nav-loading" style="color:#e94560">Error loading</div>`;
      }
    }
  } else {
    // Collapse
    chevronEl.classList.remove('open');
    seriesListEl.classList.remove('open');
  }
}

function renderSeriesInTree(pub, seriesList, containerEl) {
  if (seriesList.length === 0) {
    // Flat publication — load editions directly
    containerEl.innerHTML = `<div class="nav-loading" style="font-size:11px;padding:4px 8px">Loading editions...</div>`;
    loadEditionsForFlat(pub, containerEl);
    return;
  }

  // Series publication — show each series with its own expand
  containerEl.innerHTML = seriesList.map(series => `
    <div class="nav-series" data-pub="${escHtml(pub)}" data-series="${escHtml(series)}">
      <div class="nav-series-header"
           data-pub="${escHtml(pub)}"
           data-series="${escHtml(series)}"
           data-type="series"
           oncontextmenu="handleContextMenu(event, 'series', '${escAttr(pub)}', '${escAttr(series)}')"
      >
        <span class="nav-chevron">›</span>
        <span class="nav-series-name">${escHtml(series)}</span>
      </div>
      <div class="nav-editions-list" data-pub="${escHtml(pub)}" data-series="${escHtml(series)}">
      </div>
    </div>
  `).join('');

  // Attach series click handlers
  containerEl.querySelectorAll('.nav-series-header').forEach(el => {
    el.addEventListener('click', () => handleSeriesClick(el));
  });
}

async function handleSeriesClick(headerEl) {
  const pub = headerEl.dataset.pub;
  const series = headerEl.dataset.series;
  const seriesEl = headerEl.closest('.nav-series');
  const editionsListEl = seriesEl.querySelector('.nav-editions-list');
  const chevronEl = headerEl.querySelector('.nav-chevron');

  clearActiveNav();
  headerEl.classList.add('active');

  // Show series overview in right pane
  renderSeriesOverview(pub, series);

  const isOpen = editionsListEl.classList.contains('open');

  if (!isOpen) {
    chevronEl.classList.add('open');
    editionsListEl.classList.add('open');

    if (!navData.editionsMap[`${pub}::${series}`]) {
      await loadEditionsForSeries(pub, series, editionsListEl);
    }
  } else {
    chevronEl.classList.remove('open');
    editionsListEl.classList.remove('open');
  }
}

async function loadEditionsForFlat(pub, containerEl) {
  try {
    const editions = await API.getNewsletters({ pub, sort: currentSort, limit: 200 });
    navData.editionsMap[pub] = editions;
    containerEl.innerHTML = renderEditionsHTML(editions, pub, null);
    attachEditionHandlers(containerEl);
  } catch (err) {
    containerEl.innerHTML = `<div class="nav-loading" style="color:#e94560">Error</div>`;
  }
}

async function loadEditionsForSeries(pub, series, containerEl) {
  const key = `${pub}::${series}`;
  try {
    const editions = await API.getNewsletters({ pub, series, sort: currentSort, limit: 200 });
    navData.editionsMap[key] = editions;
    containerEl.innerHTML = renderEditionsHTML(editions, pub, series);
    attachEditionHandlers(containerEl);
  } catch (err) {
    containerEl.innerHTML = `<div class="nav-loading" style="color:#e94560">Error</div>`;
  }
}

function renderEditionsHTML(editions, pub, series) {
  const filtered = filterEditionsByDate(filterEditionsByRead(editions));

  if (filtered.length === 0) {
    return `<div class="nav-loading" style="font-size:11px;padding:4px 8px;color:var(--text-dim)">No editions match filters</div>`;
  }

  return filtered.map(ed => {
    const dateLabel  = formatDateShort(ed.date_received);
    const titleShort = ed.title.length > 45 ? ed.title.slice(0, 45) + '…' : ed.title;
    const previewIcon = ed.is_preview ? '<span class="nav-preview-icon">🔒</span>' : '';
    const isDone = ed.is_read ? 1 : 0;

    return `
      <div class="nav-edition"
           data-id="${ed.id}"
           data-read="${isDone}"
           data-file="${escAttr(ed.file_path || '')}"
           data-pub="${escHtml(pub)}"
           data-series="${escHtml(series || '')}"
           oncontextmenu="handleContextMenu(event, 'edition', '${escAttr(pub)}', '${escAttr(series || '')}', '${escAttr(ed.file_path || '')}', ${ed.id})"
      >
        ${previewIcon}
        <span class="nav-edition-date">${dateLabel}</span>
        <span class="nav-edition-title">${escHtml(titleShort)}</span>
        <span class="nav-done-tick">✓</span>
      </div>
    `;
  }).join('');
}

function attachEditionHandlers(containerEl) {
  containerEl.querySelectorAll('.nav-edition').forEach(el => {
    el.addEventListener('click', () => {
      clearActiveNav();
      el.classList.add('active');
      renderNewsletterReader(parseInt(el.dataset.id));
    });
  });
}

/** Update is_read in the navData editionsMap cache for a given newsletter ID */
function updateEditionCacheReadState(id, newRead) {
  for (const key in navData.editionsMap) {
    const list = navData.editionsMap[key];
    const ed = list.find(e => e.id === id);
    if (ed) { ed.is_read = newRead; break; }
  }
}

function clearActiveNav() {
  document.querySelectorAll('.nav-pub-header.active, .nav-series-header.active, .nav-edition.active')
    .forEach(el => el.classList.remove('active'));
}

// ══════════════════════════════════════════════════════════════════
// FILTERS — date range + completion status
// ══════════════════════════════════════════════════════════════════

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FILTER_YEARS = ['2024','2025','2026'];

function initDateFilter() {
  ['from','to'].forEach(prefix => {
    const monthSel = document.getElementById(`df-${prefix}-month`);
    const yearSel  = document.getElementById(`df-${prefix}-year`);
    if (!monthSel || !yearSel) return;

    MONTHS.forEach((m, idx) => {
      const o = document.createElement('option');
      o.value = idx + 1; o.textContent = m;
      monthSel.appendChild(o);
    });
    FILTER_YEARS.forEach(y => {
      const o = document.createElement('option');
      o.value = y; o.textContent = y;
      yearSel.appendChild(o);
    });

    if (prefix === 'from') { monthSel.value = 1;  yearSel.value = '2024'; }
    else                   { monthSel.value = 12; yearSel.value = '2026'; }
  });

  document.getElementById('df-apply').addEventListener('click', applyDateFilter);
  document.getElementById('df-clear').addEventListener('click', clearDateFilter);
  document.getElementById('date-filter-header').addEventListener('click', toggleDateFilterPanel);
}

function toggleDateFilterPanel() {
  const body    = document.getElementById('date-filter-body');
  const chevron = document.getElementById('date-filter-chevron');
  const isOpen  = !body.classList.contains('hidden');
  body.classList.toggle('hidden', isOpen);
  chevron.classList.toggle('open', !isOpen);
}

function toggleReadFilterPanel() {
  const body    = document.getElementById('read-filter-body');
  const chevron = document.getElementById('read-filter-chevron');
  if (!body || !chevron) return;
  const isOpen = !body.classList.contains('hidden');
  body.classList.toggle('hidden', isOpen);
  chevron.classList.toggle('open', !isOpen);
}

function updateReadFilterSummary() {
  const el = document.getElementById('read-filter-summary');
  if (!el) return;
  const labels = { null: 'All', unread: 'Not done', read: 'Done' };
  const key = activeReadFilter == null ? 'null' : activeReadFilter;
  el.textContent = labels[key] || 'All';
  el.classList.toggle('filtered', activeReadFilter != null);
}

function applyDateFilter() {
  activeDateFilter = {
    fromMonth: parseInt(document.getElementById('df-from-month').value),
    fromYear:  parseInt(document.getElementById('df-from-year').value),
    toMonth:   parseInt(document.getElementById('df-to-month').value),
    toYear:    parseInt(document.getElementById('df-to-year').value),
  };
  updateDateFilterSummary();
  document.getElementById('date-filter-body').classList.add('hidden');
  document.getElementById('date-filter-chevron').classList.remove('open');
  rerenderOpenEditionLists();
}

function clearDateFilter() {
  activeDateFilter = null;
  updateDateFilterSummary();
  document.getElementById('date-filter-body').classList.add('hidden');
  document.getElementById('date-filter-chevron').classList.remove('open');
  rerenderOpenEditionLists();
}

function updateDateFilterSummary() {
  const el = document.getElementById('date-filter-summary');
  if (!el) return;
  if (!activeDateFilter) {
    el.textContent = 'All dates';
    el.classList.remove('filtered');
  } else {
    const { fromYear, fromMonth, toYear, toMonth } = activeDateFilter;
    const from = `${MONTHS[fromMonth-1]} ${fromYear}`;
    const to   = `${MONTHS[toMonth-1]} ${toYear}`;
    el.textContent = (from === to) ? from : `${from} → ${to}`;
    el.classList.add('filtered');
  }
}

function filterEditionsByDate(editions) {
  if (!activeDateFilter) return editions;
  const { fromYear, fromMonth, toYear, toMonth } = activeDateFilter;
  const fromYM = fromYear * 100 + fromMonth;
  const toYM   = toYear  * 100 + toMonth;
  return editions.filter(ed => {
    if (!ed.date_received) return true;
    const [y, m] = ed.date_received.split('-');
    return (parseInt(y) * 100 + parseInt(m)) >= fromYM &&
           (parseInt(y) * 100 + parseInt(m)) <= toYM;
  });
}

function filterEditionsByRead(editions) {
  if (!activeReadFilter) return editions;
  return editions.filter(ed =>
    activeReadFilter === 'unread' ? !ed.is_read : !!ed.is_read
  );
}

function applyReadFilter(value) {
  activeReadFilter = (value === 'all') ? null : value;
  document.querySelectorAll('.completion-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.read === (activeReadFilter || 'all'));
  });
  updateReadFilterSummary();
  rerenderOpenEditionLists();
}

function rerenderOpenEditionLists() {
  document.querySelectorAll('.nav-editions-list.open, .nav-series-list.open').forEach(containerEl => {
    const pub    = containerEl.dataset.pub;
    const series = containerEl.dataset.series;
    if (!pub) return;
    const key = series ? `${pub}::${series}` : pub;
    const editions = navData.editionsMap[key];
    if (editions) {
      containerEl.innerHTML = renderEditionsHTML(editions, pub, series || null);
      attachEditionHandlers(containerEl);
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// RIGHT PANE — STATE RENDERERS
// ══════════════════════════════════════════════════════════════════

const canvas = document.getElementById('canvas');

// ── State 1: Empty ───────────────────────────────────────────────
function renderEmpty() {
  pushHistory(currentState);
  currentState = { type: 'empty', data: null };
  const tagline = EMPTY_TAGLINES[Math.floor(Math.random() * EMPTY_TAGLINES.length)];
  const countMsg = appStatus.total_newsletters > 0
    ? `${appStatus.total_newsletters} newsletter${appStatus.total_newsletters !== 1 ? 's' : ''} in your library`
    : 'Run a sync to start building your library';

  canvas.innerHTML = `
    <div class="state-empty">
      <div class="empty-tagline">${escHtml(tagline)}</div>
      <div class="empty-count">${escHtml(countMsg)}</div>
    </div>
  `;
}

// ── State: Reading Stats ─────────────────────────────────────────

// Average words read by day-of-week histogram (7 bars: Sun–Sat)
function buildDowHistogramHTML(wordsByDow) {
  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const map = {};
  (wordsByDow || []).forEach(r => { map[r.dow] = r.avg; });
  const vals = DOW_LABELS.map((_, i) => map[i] || 0);
  const maxVal = Math.max(...vals, 1);
  const bars = vals.map((v, i) => {
    const pct   = Math.round((v / maxVal) * 100);
    const label = v > 0 ? v.toLocaleString() : '';
    return `<div class="stat-bar-wrap" title="${DOW_LABELS[i]}: ~${label || '0'} words avg">
      <div class="stat-bar-value">${label}</div>
      <div class="stat-bar" style="height:${pct}%"></div>
      <div class="stat-bar-label">${DOW_LABELS[i]}</div>
    </div>`;
  }).join('');
  return `<div class="stats-bar-chart">${bars}</div>`;
}

// ── Calendar heatmap builder (shared by renderStats + renderStatsSidebar) ──
function buildCalendarHTML(readByDate, year, month) {
  // readByDate: array of {date: "YYYY-MM-DD", count: N}
  const dateMap = {};
  (readByDate || []).forEach(r => { dateMap[r.date] = r.count; });

  const today     = new Date();
  const todayStr  = today.toISOString().slice(0, 10);
  const dayNames  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // First day of month (0=Sun, …, 6=Sat). Convert to Mon-first (0=Mon … 6=Sun).
  const firstDay = new Date(year, month - 1, 1);
  let startOffset = firstDay.getDay(); // 0=Sun
  startOffset = (startOffset + 6) % 7;  // Mon-first: Mon=0, …, Sun=6

  const daysInMonth = new Date(year, month, 0).getDate();

  const headers = dayNames.map(d => `<div class="stat-cal-header">${d}</div>`).join('');

  // Leading empty cells
  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    cells.push(`<div class="stat-cal-day empty"></div>`);
  }

  // Day cells
  const mm = String(month).padStart(2, '0');
  for (let d = 1; d <= daysInMonth; d++) {
    const dd  = String(d).padStart(2, '0');
    const key = `${year}-${mm}-${dd}`;
    const cnt = dateMap[key] || 0;
    const lvl = cnt === 0 ? 0 : cnt === 1 ? 1 : cnt <= 3 ? 2 : 3;
    const isToday = key === todayStr;
    const classes = ['stat-cal-day'];
    if (lvl > 0) classes.push(`lvl-${lvl}`);
    if (isToday) classes.push('today');
    cells.push(`<div class="${classes.join(' ')}" title="${key}: ${cnt} read">${d}</div>`);
  }

  return `
    <div class="stat-cal-grid">${headers}${cells.join('')}</div>
    <div class="stat-cal-legend">
      <div class="stat-cal-legend-swatch" style="background:#0e4429"></div>1
      <div class="stat-cal-legend-swatch" style="background:#26a641"></div>2–3
      <div class="stat-cal-legend-swatch" style="background:#39d353"></div>4+
    </div>`;
}

async function renderStats() {
  pushHistory(currentState);
  currentState = { type: 'stats', data: null };
  canvas.innerHTML = `<div class="stats-canvas"><div class="nav-loading">Loading your reading…</div></div>`;

  let s;
  try { s = await API.getStats(); } catch (e) {
    canvas.innerHTML = `<div class="stats-canvas"><p style="color:var(--accent)">Could not load stats: ${e.message}</p></div>`;
    return;
  }
  // Cache for calendar navigation (no re-fetch on month change)
  _statsCache = s;
  _calYear  = new Date().getFullYear();
  _calMonth = new Date().getMonth() + 1;

  // ── Streak message ───────────────────────────────────────────
  const streakMsg = s.current_streak_days > 0
    ? `🔥 ${s.current_streak_days}-day streak`
    : s.longest_streak_days > 0
      ? `Best: ${s.longest_streak_days}-day streak`
      : 'Start reading to build a streak';

  // ── Monthly bar chart ────────────────────────────────────────
  const months = s.read_by_month || [];
  const maxCount = Math.max(...months.map(m => m.count), 1);
  const bars = months.map(m => {
    const pct   = Math.round((m.count / maxCount) * 100);
    const label = m.month.slice(5);
    return `<div class="stat-bar-wrap" title="${m.month}: ${m.count} read">
      <div class="stat-bar" style="height:${pct}%"></div>
      <div class="stat-bar-label">${label}</div>
    </div>`;
  }).join('');

  // ── Top publications ─────────────────────────────────────────
  const topPubs = (s.top_publications || []).map((p, i) =>
    `<div class="stat-pub-row">
       <span class="stat-pub-rank">${i + 1}</span>
       <span class="stat-pub-name">${escHtml(p.name)}</span>
       <span class="stat-pub-count">${p.read}</span>
     </div>`
  ).join('');

  // ── Extra metric cards ───────────────────────────────────────
  const words = s.total_words_read || 0;
  const wordsStr = words >= 1_000_000
    ? (words / 1_000_000).toFixed(1) + 'M'
    : words >= 1000
      ? Math.round(words / 1000) + 'k'
      : String(words);

  const lastMonth = s.read_last_month ?? 0;
  const thisMonth = s.this_month ?? 0;
  let vsLastHtml = '—';
  let vsClass = 'neutral';
  if (lastMonth > 0) {
    const pctChange = Math.round(((thisMonth - lastMonth) / lastMonth) * 100);
    vsLastHtml = (pctChange >= 0 ? '+' : '') + pctChange + '%';
    vsClass = pctChange >= 0 ? 'positive' : 'neutral';
  } else if (thisMonth > 0) {
    vsLastHtml = 'New streak!'; vsClass = 'positive';
  }

  const completionPct = s.total_library > 0
    ? Math.round((s.total_read / s.total_library) * 100) : 0;

  const bestDay = s.best_day_of_week ? `${s.best_day_of_week}s` : '—';

  const fmtW = n => n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n || 0);
  const w7    = fmtW(s.words_last_7     || 0);
  const wMo   = fmtW(s.words_this_month || 0);
  const wLast = fmtW(s.words_last_month || 0);

  // ── Calendar heatmap (current month) ────────────────────────
  const now = new Date();
  const calHtml = buildCalendarHTML(s.read_by_date, now.getFullYear(), now.getMonth() + 1);
  const monthName = now.toLocaleString('default', { month: 'long', year: 'numeric' });

  canvas.innerHTML = `
    <div class="stats-canvas">
      <div class="stats-hero">
        <div class="stats-hero-number">${thisMonth}</div>
        <div class="stats-hero-label">articles read this month</div>
        <div class="stats-streak">${streakMsg}</div>
      </div>

      <div class="stats-row">
        <div class="stats-pill">
          <div class="stats-pill-value">${s.this_week}</div>
          <div class="stats-pill-label">this week</div>
        </div>
        <div class="stats-pill">
          <div class="stats-pill-value">${s.total_read}</div>
          <div class="stats-pill-label">total read</div>
        </div>
        <div class="stats-pill">
          <div class="stats-pill-value">${s.current_streak_days || 0}</div>
          <div class="stats-pill-label">current streak</div>
        </div>
        <div class="stats-pill">
          <div class="stats-pill-value">${s.longest_streak_days || 0}</div>
          <div class="stats-pill-label">best streak</div>
        </div>
      </div>

      <div class="stats-extra-row">
        <div class="stats-extra-card">
          <div class="stats-extra-label">📝 Words · last 7d</div>
          <div class="stats-extra-value">${w7}</div>
        </div>
        <div class="stats-extra-card">
          <div class="stats-extra-label">📝 Words · this month</div>
          <div class="stats-extra-value">${wMo}</div>
        </div>
        <div class="stats-extra-card">
          <div class="stats-extra-label">📝 Words · last month</div>
          <div class="stats-extra-value">${wLast}</div>
        </div>
        <div class="stats-extra-card">
          <div class="stats-extra-label">📈 vs. last month</div>
          <div class="stats-extra-value ${vsClass}">${vsLastHtml}</div>
        </div>
        <div class="stats-extra-card">
          <div class="stats-extra-label">📅 Best reading day</div>
          <div class="stats-extra-value" style="font-size:0.95rem">${bestDay}</div>
        </div>
      </div>

      <div class="stats-section-title" style="display:flex;align-items:center;gap:8px;justify-content:center">
        <button class="cal-nav-btn" id="btn-cal-prev">←</button>
        <span id="cal-month-label" style="font-size:1.05rem;font-weight:700;color:var(--text-main);letter-spacing:0.02em;text-transform:none">${monthName}</span>
        <button class="cal-nav-btn" id="btn-cal-next">→</button>
      </div>
      <div class="stat-cal-wrap" id="stats-cal-wrap">${calHtml}</div>

      ${months.length > 0 ? `
      <div class="stats-section-title">Monthly trend</div>
      <div class="stats-bar-chart">${bars}</div>` : ''}

      ${(s.words_by_dow || []).length > 0 ? `
      <div class="stats-section-title">Avg words read by day</div>
      ${buildDowHistogramHTML(s.words_by_dow)}` : ''}

      ${topPubs ? `
      <div class="stats-section-title">Top reads</div>
      <div class="stats-pubs">${topPubs}</div>` : ''}

      <div class="stats-footnote">Marked as Done = counted as read · Based on newsletter date</div>
    </div>
  `;

  // ── Wire up calendar month navigation ─────────────────────────
  function _updateMainCal() {
    const now = new Date();
    if (_calYear > now.getFullYear() || (_calYear === now.getFullYear() && _calMonth > now.getMonth() + 1)) {
      _calYear = now.getFullYear(); _calMonth = now.getMonth() + 1;
    }
    const name = new Date(_calYear, _calMonth - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
    document.getElementById('cal-month-label').textContent = name;
    document.getElementById('stats-cal-wrap').innerHTML = buildCalendarHTML(_statsCache.read_by_date, _calYear, _calMonth);
  }
  document.getElementById('btn-cal-prev')?.addEventListener('click', () => {
    _calMonth--; if (_calMonth < 1) { _calMonth = 12; _calYear--; }
    _updateMainCal();
  });
  document.getElementById('btn-cal-next')?.addEventListener('click', () => {
    _calMonth++; if (_calMonth > 12) { _calMonth = 1; _calYear++; }
    _updateMainCal();
  });
}

// ── Stats sidebar (compact, shown next to Settings) ──────────────
async function renderStatsSidebar() {
  const container = document.getElementById('stats-sidebar-content');
  if (!container) return;

  let s;
  try { s = await API.getStats(); } catch(e) {
    container.innerHTML = `<p style="font-size:0.75rem;color:var(--text-dim)">Could not load stats.</p>`;
    return;
  }

  const streakMsg = s.current_streak_days > 0
    ? `🔥 ${s.current_streak_days}-day streak`
    : s.longest_streak_days > 0
      ? `Best: ${s.longest_streak_days}d streak`
      : 'Start reading to build a streak';

  // Words consumed
  const words = s.total_words_read || 0;
  const wordsStr = words >= 1_000_000
    ? (words / 1_000_000).toFixed(1) + 'M'
    : words >= 1000 ? Math.round(words / 1000) + 'k' : String(words);

  // vs last month
  const lastMonth = s.read_last_month ?? 0;
  const thisMonth = s.this_month ?? 0;
  let vsStr = '—', vsClass = '';
  if (lastMonth > 0) {
    const pct = Math.round(((thisMonth - lastMonth) / lastMonth) * 100);
    vsStr = (pct >= 0 ? '+' : '') + pct + '%';
    vsClass = pct > 0 ? 'positive' : '';
  } else if (thisMonth > 0) {
    vsStr = 'New reader!'; vsClass = 'positive';
  }

  // Completion % — fix: API returns total_library (not total_newsletters)
  const totalLib = s.total_library || 0;
  const totalRead = s.total_read || 0;
  const completionPct = totalLib > 0 ? Math.round((totalRead / totalLib) * 100) : 0;

  // Cache + init sidebar calendar state on each fresh load
  _statsCache = s;
  _sidebarCalYear  = new Date().getFullYear();
  _sidebarCalMonth = new Date().getMonth() + 1;

  const now = new Date();
  const calHtml = buildCalendarHTML(s.read_by_date, now.getFullYear(), now.getMonth() + 1);
  const monthName = now.toLocaleString('default', { month: 'long', year: 'numeric' });

  container.innerHTML = `
    <div class="stats-sidebar-pills">
      <div class="stats-sidebar-pill">
        <div class="stats-sidebar-pill-value">${s.this_week}</div>
        <div class="stats-sidebar-pill-label">this week</div>
      </div>
      <div class="stats-sidebar-pill">
        <div class="stats-sidebar-pill-value">${s.this_month}</div>
        <div class="stats-sidebar-pill-label">this month</div>
      </div>
      <div class="stats-sidebar-pill">
        <div class="stats-sidebar-pill-value">${s.total_read}</div>
        <div class="stats-sidebar-pill-label">all time</div>
      </div>
    </div>
    <div class="stats-sidebar-streak">${streakMsg}</div>
    <div class="stats-sidebar-metric-grid">
      <div class="stats-sidebar-metric">
        <div class="stats-sidebar-metric-label">📖 Words consumed</div>
        <div class="stats-sidebar-metric-value">${wordsStr}</div>
      </div>
      <div class="stats-sidebar-metric">
        <div class="stats-sidebar-metric-label">📈 vs. last month</div>
        <div class="stats-sidebar-metric-value ${vsClass}">${vsStr}</div>
      </div>
      <div class="stats-sidebar-metric">
        <div class="stats-sidebar-metric-label">📅 Best reading day</div>
        <div class="stats-sidebar-metric-value" style="font-size:0.86rem">${s.best_day_of_week || '—'}</div>
      </div>
      <div class="stats-sidebar-metric">
        <div class="stats-sidebar-metric-label">🎯 Library read</div>
        <div class="stats-sidebar-metric-value">${completionPct}%</div>
      </div>
    </div>
    <div class="stats-sidebar-cal-heading" style="display:flex;align-items:center;gap:6px">
      <button class="cal-nav-btn" id="btn-sidebar-cal-prev">←</button>
      <span id="sidebar-cal-month-label" style="flex:1;text-align:center;font-size:0.9rem;font-weight:700;color:var(--text-main);text-transform:none;letter-spacing:0.01em">${monthName}</span>
      <button class="cal-nav-btn" id="btn-sidebar-cal-next">→</button>
    </div>
    <div class="stat-cal-wrap" id="sidebar-cal-wrap">${calHtml}</div>
    ${(s.words_by_dow || []).length > 0 ? `
    <div class="stats-sidebar-section-heading">AVG WORDS / DAY</div>
    ${buildDowHistogramHTML(s.words_by_dow)}` : ''}
    ${(s.top_publications || []).length > 0 ? `
    <div class="stats-sidebar-section-heading">TOP READS</div>
    <div class="stats-sidebar-top-reads">
      ${(s.top_publications || []).slice(0, 5).map((p, i) => `
        <div class="stats-sidebar-top-row">
          <span class="stats-sidebar-top-rank">${i + 1}</span>
          <span class="stats-sidebar-top-name">${escHtml(p.name)}</span>
          <span class="stats-sidebar-top-count">${p.read}</span>
        </div>`).join('')}
    </div>` : ''}
    <button class="stats-sidebar-view-all" id="btn-sidebar-view-stats">View full stats →</button>
  `;

  // Wire up sidebar calendar month navigation
  function _updateSidebarCal() {
    const now = new Date();
    if (_sidebarCalYear > now.getFullYear() || (_sidebarCalYear === now.getFullYear() && _sidebarCalMonth > now.getMonth() + 1)) {
      _sidebarCalYear = now.getFullYear(); _sidebarCalMonth = now.getMonth() + 1;
    }
    const name = new Date(_sidebarCalYear, _sidebarCalMonth - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
    document.getElementById('sidebar-cal-month-label').textContent = name;
    document.getElementById('sidebar-cal-wrap').innerHTML = buildCalendarHTML(_statsCache.read_by_date, _sidebarCalYear, _sidebarCalMonth);
  }
  document.getElementById('btn-sidebar-cal-prev')?.addEventListener('click', () => {
    _sidebarCalMonth--; if (_sidebarCalMonth < 1) { _sidebarCalMonth = 12; _sidebarCalYear--; }
    _updateSidebarCal();
  });
  document.getElementById('btn-sidebar-cal-next')?.addEventListener('click', () => {
    _sidebarCalMonth++; if (_sidebarCalMonth > 12) { _sidebarCalMonth = 1; _sidebarCalYear++; }
    _updateSidebarCal();
  });

  // Wire up view-all button
  document.getElementById('btn-sidebar-view-stats')?.addEventListener('click', () => {
    renderStats();
  });
}

// ── State 2: Publication Overview ────────────────────────────────
async function renderPublicationOverview(publication) {
  pushHistory(currentState);
  currentState = { type: 'publication', data: { publication } };

  canvas.innerHTML = `<div class="state-overview"><div class="nav-loading">Loading...</div></div>`;

  try {
    const newsletters = await API.getOverviewPublication(publication);
    const series = await API.getSeries(publication);
    const subtitle = series.length > 0
      ? `${series.length} series · ${newsletters.length > 0 ? `${newsletters.length} recent editions shown` : 'No editions yet'}`
      : `${newsletters.length} recent editions`;

    canvas.innerHTML = `
      <div class="state-overview">
        <div class="overview-header">
          <div class="overview-title">${escHtml(publication)}</div>
          <div class="overview-subtitle">${escHtml(subtitle)}</div>
        </div>
        <div class="overview-cards">
          ${newsletters.length > 0 ? newsletters.map(n => renderCard(n)).join('') : '<p class="text-dim">No newsletters found.</p>'}
        </div>
      </div>
    `;

    attachCardHandlers();
  } catch (err) {
    canvas.innerHTML = `<div class="state-overview"><p style="color:#e94560">Error loading: ${err.message}</p></div>`;
  }
}

// ── State 3: Series Overview ─────────────────────────────────────
async function renderSeriesOverview(publication, series) {
  pushHistory(currentState);
  currentState = { type: 'series', data: { publication, series } };

  canvas.innerHTML = `<div class="state-overview"><div class="nav-loading">Loading...</div></div>`;

  try {
    const newsletters = await API.getOverviewSeries(publication, series);

    canvas.innerHTML = `
      <div class="state-overview">
        <div class="overview-header">
          <div class="overview-title">${escHtml(series)}</div>
          <div class="overview-subtitle">
            <span class="text-accent">${escHtml(publication)}</span>
            · ${newsletters.length} recent editions
          </div>
        </div>
        <div class="overview-cards">
          ${newsletters.length > 0 ? newsletters.map(n => renderCard(n)).join('') : '<p class="text-dim">No newsletters found.</p>'}
        </div>
      </div>
    `;

    attachCardHandlers();
  } catch (err) {
    canvas.innerHTML = `<div class="state-overview"><p style="color:#e94560">Error loading: ${err.message}</p></div>`;
  }
}

function renderCard(newsletter) {
  const date = formatDateFull(newsletter.date_received);
  const wordCount = newsletter.word_count ? `${newsletter.word_count.toLocaleString()} words` : '';
  const seriesTag = newsletter.series ? `<span class="card-series">${escHtml(newsletter.series)}</span>` : '';
  const previewBadge = newsletter.is_preview ? `<span class="card-preview-badge">Preview</span>` : '';

  return `
    <div class="overview-card" data-id="${newsletter.id}">
      <div class="card-date">${escHtml(date)}</div>
      <div class="card-title">${escHtml(newsletter.title)}</div>
      <div class="card-meta">
        ${seriesTag}
        ${wordCount ? `<span class="card-wordcount">${wordCount}</span>` : ''}
        ${previewBadge}
      </div>
    </div>
  `;
}

function attachCardHandlers() {
  canvas.querySelectorAll('.overview-card').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt(el.dataset.id);
      renderNewsletterReader(id);
    });
  });
}

// ── State 4: Newsletter Reader ───────────────────────────────────
async function renderNewsletterReader(newsletterId) {
  // Close notes/summary panel whenever the user switches articles — prevents stale content
  document.getElementById('note-modal-overlay')?.classList.add('hidden');
  document.getElementById('btn-reader-note')?.classList.remove('panel-active');
  document.getElementById('btn-reader-summary')?.classList.remove('panel-active');

  pushHistory(currentState);
  currentState = { type: 'reader', data: { id: newsletterId } };

  canvas.innerHTML = `<div class="state-reader"><div class="nav-loading">Loading...</div></div>`;

  try {
    const n = await API.getNewsletter(newsletterId);

    const date         = formatDateFull(n.date_received);
    const wordCount    = n.word_count ? `${n.word_count.toLocaleString()} words` : '';
    const seriesTag    = n.series ? `<span class="reader-series">· ${escHtml(n.series)}</span>` : '';
    const previewBanner = n.is_preview && n.preview_label ? `
      <div class="preview-banner">🔒 ${escHtml(n.preview_label)}</div>` : '';
    const isDone       = !!n.is_read;
    const darkMode     = localStorage.getItem('articleDarkMode') === 'true';
    const savedUiScale   = localStorage.getItem('uiScale')   || '3';
    const savedFontScale = document.documentElement.dataset.fontScale || '3';

    canvas.innerHTML = `
      <div class="state-reader">
        <div class="reader-meta-bar">
          <div class="reader-meta-left">
            <div class="reader-title">${escHtml(n.title)}</div>
            <div class="reader-meta-row">
              <span class="reader-pub">${escHtml(n.publication)}</span>
              ${seriesTag}
              <span class="reader-date">${escHtml(date)}</span>
              ${wordCount ? `<span class="reader-wordcount">${wordCount}</span>` : ''}
            </div>
            ${previewBanner}
          </div>
          <div class="reader-meta-right">
            <!-- Group 1: Article panels -->
            <div class="reader-ribbon-group">
              <button class="reader-icon-btn" id="btn-reader-note"    title="My Notes"   data-id="${n.id}">✎ My Notes</button>
              <button class="reader-icon-btn" id="btn-reader-summary" title="AI Summary" data-id="${n.id}">⚡ AI Summary</button>
            </div>
            <div class="reader-ribbon-divider"></div>
            <!-- Group 2: View controls -->
            <div class="reader-ribbon-group">
              <!-- Sun · sliding switch · Moon dark mode toggle -->
              <div class="dm-bar-toggle" title="Toggle article dark mode">
                <span class="dm-bar-icon dm-bar-sun${!darkMode ? ' lit' : ''}">☀</span>
                <label class="dm-bar-switch">
                  <input type="checkbox" id="chk-dark-mode" class="dm-bar-chk"${darkMode ? ' checked' : ''}>
                  <span class="dm-bar-track"><span class="dm-bar-thumb"></span></span>
                </label>
                <span class="dm-bar-icon dm-bar-moon${darkMode ? ' lit' : ''}">🌙</span>
              </div>
              <!-- UI Scale card (invisible select overlay covers full card) -->
              <div class="ribbon-scale-wrap" title="UI zoom — applies globally">
                <span class="ribbon-scale-label">UI Scale</span>
                <span class="ribbon-scale-val" id="ui-scale-val">${['80%','90%','100%','112%','125%'][parseInt(savedUiScale)-1]}</span>
                <select id="sel-ui-scale" class="ribbon-scale-select">
                  <option value="1"${savedUiScale==='1'?' selected':''}>80%</option>
                  <option value="2"${savedUiScale==='2'?' selected':''}>90%</option>
                  <option value="3"${savedUiScale==='3'?' selected':''}>100%</option>
                  <option value="4"${savedUiScale==='4'?' selected':''}>112%</option>
                  <option value="5"${savedUiScale==='5'?' selected':''}>125%</option>
                </select>
              </div>
              <!-- Font Size card -->
              <div class="ribbon-scale-wrap" title="Font size — applies globally">
                <span class="ribbon-scale-label">Font Size</span>
                <span class="ribbon-scale-val" id="font-scale-val">${['XS','S','M','L','XL'][parseInt(savedFontScale)-1]}</span>
                <select id="sel-font-scale" class="ribbon-scale-select">
                  <option value="1"${savedFontScale==='1'?' selected':''}>XS</option>
                  <option value="2"${savedFontScale==='2'?' selected':''}>S</option>
                  <option value="3"${savedFontScale==='3'?' selected':''}>M</option>
                  <option value="4"${savedFontScale==='4'?' selected':''}>L</option>
                  <option value="5"${savedFontScale==='5'?' selected':''}>XL</option>
                </select>
              </div>
            </div>
            <div class="reader-ribbon-divider"></div>
            <button class="reader-done-btn${isDone ? ' is-done' : ''}" data-id="${n.id}">${isDone ? '✓ Done' : 'Mark Done'}</button>
          </div>
        </div>
        <div class="reader-iframe-wrapper">
          <div class="reader-load-cover" id="reader-load-cover"></div>
          <iframe
            class="reader-iframe"
            id="newsletter-iframe"
            src="/api/newsletters/${n.id}/content"
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            title="${escAttr(n.title)}"
          ></iframe>
        </div>
      </div>
    `;

    // Auto-resize iframe + apply dark mode on load
    const iframe = document.getElementById('newsletter-iframe');
    iframe.addEventListener('load', () => {
      try {
        // Force the newsletter to light mode at the browser level.
        // Newsletters (Substack, Finshots, etc.) ship their own <meta name="color-scheme" content="light dark">
        // which lets macOS dark mode trigger their own @media(prefers-color-scheme:dark) CSS.
        // We must REPLACE that meta (not skip if one exists) to suppress it.
        // Our JS applyArticleDarkMode handles explicit dark mode; we never want the newsletter's own dark mode firing.
        const doc = iframe.contentDocument;
        if (doc && doc.head) {
          let meta = doc.querySelector('meta[name="color-scheme"]');
          if (!meta) {
            meta = doc.createElement('meta');
            meta.name = 'color-scheme';
            doc.head.insertBefore(meta, doc.head.firstChild);
          }
          meta.content = 'light only';
          // Belt-and-suspenders: CSS property also suppresses media queries
          let csStyle = doc.getElementById('_bs_cs');
          if (!csStyle) {
            csStyle = doc.createElement('style');
            csStyle.id = '_bs_cs';
            doc.head.appendChild(csStyle);
          }
          csStyle.textContent = ':root,html{color-scheme:light!important}';
        }
      } catch (_) {}

      try {
        const iframeBody = iframe.contentDocument.body;
        if (iframeBody) iframe.style.height = iframeBody.scrollHeight + 'px';
      } catch (err) {
        iframe.style.height = '800px';
      }
      applyArticleDarkMode(iframe, localStorage.getItem('articleDarkMode') === 'true');
      // Fade out the cover — it hid the white flash during load
      const cover = document.getElementById('reader-load-cover');
      if (cover) {
        requestAnimationFrame(() => {
          cover.style.opacity = '0';
          setTimeout(() => cover.remove(), 220);
        });
      }
    });

    // Sun · switch · Moon dark mode toggle
    const dmChk = canvas.querySelector('#chk-dark-mode');
    if (dmChk) {
      dmChk.addEventListener('change', () => {
        const nowDark = dmChk.checked;
        localStorage.setItem('articleDarkMode', nowDark);
        canvas.querySelector('.dm-bar-sun')?.classList.toggle('lit', !nowDark);
        canvas.querySelector('.dm-bar-moon')?.classList.toggle('lit',  nowDark);
        applyArticleDarkMode(iframe, nowDark);
        setTimeout(() => {
          try { const b = iframe.contentDocument.body; if (b) iframe.style.height = b.scrollHeight + 'px'; } catch (_) {}
        }, 100);
      });
    }

    // Font scale dropdown — adjusts global root font-size, updates visible value span
    const fontSel = canvas.querySelector('#sel-font-scale');
    if (fontSel) {
      fontSel.addEventListener('change', () => {
        const val = fontSel.value;
        document.documentElement.dataset.fontScale = val;
        localStorage.setItem('fontScale', val);
        const span = canvas.querySelector('#font-scale-val');
        if (span) span.textContent = ['XS','S','M','L','XL'][parseInt(val)-1];
        const lbl = document.getElementById('font-scale-label');
        if (lbl) lbl.textContent = `Current: ${val}`;
      });
    }

    // UI scale dropdown — adjusts whole-app zoom, updates visible value span
    const uiScaleSel = canvas.querySelector('#sel-ui-scale');
    if (uiScaleSel) {
      uiScaleSel.addEventListener('change', () => {
        const val = uiScaleSel.value;
        applyZoom(val);
        const span = canvas.querySelector('#ui-scale-val');
        if (span) span.textContent = ['80%','90%','100%','112%','125%'][parseInt(val)-1];
        const lbl = document.getElementById('ui-scale-label');
        if (lbl) lbl.textContent = `Current: ${val}`;
      });
    }

    // Done button — user manually marks article as done/not done
    const doneBtn = canvas.querySelector('.reader-done-btn');
    if (doneBtn) {
      doneBtn.addEventListener('click', async () => {
        const id = parseInt(doneBtn.dataset.id);
        try {
          const result = await API.post(`/api/newsletters/${id}/toggle-read`);
          const nowDone = !!result.is_read;
          doneBtn.classList.toggle('is-done', nowDone);
          doneBtn.textContent = nowDone ? '✓ Done' : 'Mark Done';
          // Update nav tick
          const navEl = document.querySelector(`.nav-edition[data-id="${id}"]`);
          if (navEl) navEl.dataset.read = nowDone ? '1' : '0';
          updateEditionCacheReadState(id, nowDone ? 1 : 0);
          // If completion filter is active, re-render nav
          if (activeReadFilter) rerenderOpenEditionLists();
        } catch (err) { console.warn('toggle-read failed:', err); }
      });
    }

    // Note icon — opens My Notes tab; clicking again while open closes it
    const noteBtn = canvas.querySelector('#btn-reader-note');
    if (noteBtn) {
      noteBtn.addEventListener('click', async () => {
        const overlay = document.getElementById('note-modal-overlay');
        if (noteBtn.classList.contains('panel-active')) {
          // Already open on this tab — close it
          overlay.classList.add('hidden');
          noteBtn.classList.remove('panel-active');
          canvas.querySelector('#btn-reader-summary')?.classList.remove('panel-active');
          return;
        }
        const id = parseInt(noteBtn.dataset.id);
        let myNotes = '', aiSummary = '', notesPath = '';
        try { const d = await API.getNote(id); myNotes = d.my_notes || ''; aiSummary = d.ai_summary || ''; notesPath = d.notes_path || ''; } catch(e) {}
        if (myNotes) noteBtn.classList.add('has-content');
        renderNoteModal(id, myNotes, aiSummary, 'my_notes', notesPath);
      });
    }

    // Summary icon — opens AI Summary tab; clicking again while open closes it
    const summaryBtn = canvas.querySelector('#btn-reader-summary');
    if (summaryBtn) {
      summaryBtn.addEventListener('click', async () => {
        const overlay = document.getElementById('note-modal-overlay');
        if (summaryBtn.classList.contains('panel-active')) {
          overlay.classList.add('hidden');
          summaryBtn.classList.remove('panel-active');
          canvas.querySelector('#btn-reader-note')?.classList.remove('panel-active');
          return;
        }
        const id = parseInt(summaryBtn.dataset.id);
        let myNotes = '', aiSummary = '', notesPath = '';
        try { const d = await API.getNote(id); myNotes = d.my_notes || ''; aiSummary = d.ai_summary || ''; notesPath = d.notes_path || ''; } catch(e) {}
        if (aiSummary) summaryBtn.classList.add('has-content');
        renderNoteModal(id, myNotes, aiSummary, 'ai_summary', notesPath);
      });
    }

    // Refresh icon button states (show amber if note already exists)
    try {
      const noteData = await API.getNote(n.id);
      if (noteData.my_notes)   noteBtn?.classList.add('has-content');
      if (noteData.ai_summary) summaryBtn?.classList.add('has-content');
    } catch(e) {}

  } catch (err) {
    canvas.innerHTML = `<div class="state-reader"><p style="padding:20px;color:var(--accent)">Error: ${err.message}</p></div>`;
  }
}

// ── State 5: Search Results ──────────────────────────────────────
async function renderSearchResults(query) {
  pushHistory(currentState);
  currentState = { type: 'search', data: { query } };

  canvas.innerHTML = `<div class="state-search"><div class="nav-loading">Searching...</div></div>`;

  try {
    const results = await API.search(query);

    // Update the left nav to show filtered results grouped by publication
    buildFilteredNavTree(results);

    canvas.innerHTML = `
      <div class="state-search">
        <div class="search-header">
          <div class="search-query-label">Results for <strong>"${escHtml(query)}"</strong></div>
          <div class="search-count">${results.length} result${results.length !== 1 ? 's' : ''} found</div>
        </div>
        ${results.length > 0
          ? results.map(n => `
              <div class="search-result" data-id="${n.id}">
                <div class="search-result-title">${escHtml(n.title)}</div>
                <div class="search-result-meta">
                  <span class="text-accent">${escHtml(n.publication)}</span>
                  ${n.series ? `<span>${escHtml(n.series)}</span>` : ''}
                  <span>${escHtml(formatDateFull(n.date_received))}</span>
                  ${n.word_count ? `<span>${n.word_count.toLocaleString()} words</span>` : ''}
                </div>
              </div>
            `).join('')
          : `<div class="no-results">No results found for "${escHtml(query)}"</div>`
        }
      </div>
    `;

    // Attach click handlers to search results
    canvas.querySelectorAll('.search-result').forEach(el => {
      el.addEventListener('click', () => {
        const id = parseInt(el.dataset.id);
        renderNewsletterReader(id);
      });
    });

  } catch (err) {
    canvas.innerHTML = `<div class="state-search"><p style="color:#e94560">Search error: ${err.message}</p></div>`;
  }
}

// ── State 6: Settings ────────────────────────────────────────────
function renderSettings() {
  pushHistory(currentState);
  currentState = { type: 'settings', data: null };

  const totalStr    = appStatus.total_newsletters.toLocaleString();
  const lastSynced  = appStatus.last_synced || 'Never';
  const savedUiScale   = localStorage.getItem('uiScale')   || '3';
  const savedFontScale = document.documentElement.dataset.fontScale || '3';

  canvas.innerHTML = `
    <div class="state-settings-layout">
    <div class="state-settings">
      <div id="settings-master-header" style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:20px;user-select:none">
        <span id="settings-master-chevron" style="font-size:0.65rem;color:var(--text-dim);transition:transform 0.2s ease;display:inline-block;transform:rotate(90deg)">▶</span>
        <h2 style="font-size:18px;font-weight:700;color:var(--text-main);margin:0">Settings</h2>
      </div>

      <!-- ── Sync ───────────────────────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-header" data-section-key="sync">
          <span class="settings-chevron">▶</span>
          <span class="settings-section-title">Sync</span>
        </div>
        <div class="settings-section-body">

        <div class="settings-row">
          <span class="settings-label">Last synced</span>
          <span class="settings-value" id="settings-last-sync">${escHtml(lastSynced)}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Library total</span>
          <span class="settings-value">${escHtml(totalStr)} newsletters</span>
        </div>

        <div style="margin-top:16px;margin-bottom:8px;font-size:0.86rem;color:var(--text-dim)">
          Choose a sync mode. <strong style="color:var(--text-main)">Seed</strong> = full
          import from Jan 2024. <strong style="color:var(--text-main)">Incremental</strong>
          = new only, since the last seed.
        </div>

        <div class="sync-mode-buttons">
          <button class="sync-mode-btn sync-mode-seed" id="btn-sync-seed" data-mode="seed">
            <span class="sync-mode-icon">⟳</span>
            <span class="sync-mode-name">Seed Sync</span>
            <span class="sync-mode-desc">Full import · Jan 2024 → today</span>
          </button>
          <button class="sync-mode-btn" id="btn-sync-incremental" data-mode="incremental">
            <span class="sync-mode-icon">⟳</span>
            <span class="sync-mode-name">Incremental</span>
            <span class="sync-mode-desc">New only · since last seed</span>
          </button>
          <button class="sync-mode-btn" id="btn-sync-new-sender" data-mode="new-sender">
            <span class="sync-mode-icon">⊕</span>
            <span class="sync-mode-name">New Sender</span>
            <span class="sync-mode-desc">Seed one sender · add without full reset</span>
          </button>
        </div>

        <!-- New-sender input — shown when "New Sender" is selected -->
        <div id="new-sender-panel" class="sync-confirm-panel hidden" style="margin-top:10px">
          <label style="font-size:12px;color:var(--text-dim);display:block;margin-bottom:6px">
            Enter the sender name or email exactly as it appears in config.yaml:
          </label>
          <input id="new-sender-input" type="text" placeholder='e.g. "The Ken" or info@the-ken.com'
            style="width:100%;padding:7px 10px;background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.18);
                   color:var(--text-main);border-radius:6px;font-size:0.86rem;margin-bottom:8px">
          <div class="sync-confirm-actions">
            <button id="btn-new-sender-cancel" class="btn-secondary">Cancel</button>
            <button id="btn-new-sender-run"    class="btn-primary">⊕ Seed This Sender</button>
          </div>
        </div>

        <!-- Confirmation panel — shown after clicking a sync mode button -->
        <div id="sync-confirm-panel" class="sync-confirm-panel hidden">
          <div id="sync-confirm-desc" class="sync-confirm-desc"></div>
          <label id="wipe-data-row" style="display:none;align-items:center;gap:8px;
                 font-size:12px;color:var(--accent);margin:8px 0 4px;cursor:pointer">
            <input type="checkbox" id="chk-wipe-user-data" style="accent-color:var(--accent)">
            Also wipe all my notes and read history (cannot be undone)
          </label>
          <div class="sync-confirm-actions">
            <button id="btn-sync-cancel" class="btn-secondary">Cancel</button>
            <button id="btn-sync-run"    class="btn-primary">▶ Run Sync</button>
          </div>
        </div>

        <!-- Live sync output log (hidden until sync starts) -->
        <div id="sync-log"></div>

        </div><!-- /settings-section-body -->
      </div>

      <!-- ── Library Summary ────────────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-header" data-section-key="library">
          <span class="settings-chevron">▶</span>
          <span class="settings-section-title">Library</span>
        </div>
        <div class="settings-section-body">
          <div id="library-summary-wrap">
            <div class="nav-loading" style="font-size:12px;padding:8px 0">Loading…</div>
          </div>
        </div><!-- /settings-section-body -->
      </div>

      <!-- ── Appearance / Theme Picker ────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-header" data-section-key="appearance">
          <span class="settings-chevron">▶</span>
          <span class="settings-section-title">Appearance</span>
        </div>
        <div class="settings-section-body">
          <p style="font-size:0.86rem;color:var(--text-dim);margin-bottom:14px">
            Choose a colour theme. Select one then click <strong style="color:var(--text-main)">Save &amp; Apply</strong>.
          </p>
          <div class="theme-picker">
            ${Object.entries(THEMES).map(([id, t]) => `
              <label class="theme-row">
                <input type="radio" name="theme-select" value="${id}"
                       ${(localStorage.getItem('bookself-theme') || 'midnight-blues') === id ? 'checked' : ''}>
                <span class="theme-name">${escHtml(t.name)}</span>
                <span class="theme-swatches">
                  ${t.swatches.map(c => `<span class="theme-swatch" style="background:${c}" title="${c}"></span>`).join('')}
                </span>
              </label>
            `).join('')}
          </div>
          <button class="btn-primary theme-apply-btn" id="btn-apply-theme">Save &amp; Apply Theme</button>
        </div><!-- /settings-section-body -->
      </div>

      <!-- ── Config Editor ──────────────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-header" data-section-key="configuration">
          <span class="settings-chevron">▶</span>
          <span class="settings-section-title">Configuration</span>
        </div>
        <div class="settings-section-body">
          <p style="font-size:0.93rem;color:var(--text-dim);margin-bottom:10px">
            Edit your newsletter sources directly. Changes take effect on next sync.
          </p>
          <div id="config-editor-wrap">
            <div class="nav-loading" style="font-size:12px;padding:8px 0">Loading config…</div>
          </div>
        </div><!-- /settings-section-body -->
      </div>

      <!-- ── AI Summary ────────────────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-header" data-section-key="ai-summary">
          <span class="settings-chevron">▶</span>
          <span class="settings-section-title">AI Summary</span>
        </div>
        <div class="settings-section-body">
          <p style="font-size:0.93rem;color:var(--text-dim);margin-bottom:12px">
            Configure which AI model generates article summaries.
            BookSelf is local-first by default — Ollama runs entirely on your machine.
          </p>
          <div id="ai-config-wrap">
            <div class="nav-loading" style="font-size:12px;padding:8px 0">Loading…</div>
          </div>
        </div><!-- /settings-section-body -->
      </div>

      <!-- ── Display ────────────────────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-header" data-section-key="display">
          <span class="settings-chevron">▶</span>
          <span class="settings-section-title">Display</span>
        </div>
        <div class="settings-section-body">

        <div class="settings-display-row">
          <span class="settings-label">UI size</span>
          <div class="scale-slider-wrap">
            <input type="range" id="ui-scale-slider" class="scale-slider"
              min="1" max="5" step="1" value="${escAttr(savedUiScale)}">
            <div class="scale-ticks">
              <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
            </div>
          </div>
          <div class="scale-apply-row">
            <span class="scale-current-label" id="ui-scale-label">Current: ${savedUiScale}</span>
            <button class="btn-apply" id="ui-scale-apply">Apply</button>
          </div>
        </div>

        <div class="settings-display-row">
          <span class="settings-label">Font size</span>
          <div class="scale-slider-wrap">
            <input type="range" id="font-scale-slider" class="scale-slider"
              min="1" max="5" step="1" value="${escAttr(savedFontScale)}">
            <div class="scale-ticks">
              <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
            </div>
          </div>
          <div class="scale-apply-row">
            <span class="scale-current-label" id="font-scale-label">Current: ${savedFontScale}</span>
            <button class="btn-apply" id="font-scale-apply">Apply</button>
          </div>
        </div>

        <div style="margin-top:16px;text-align:right">
          <button class="btn-primary" id="display-save-all">
            Save &amp; Apply All
          </button>
        </div>

        </div><!-- /settings-section-body -->
      </div>

      <!-- ── About ──────────────────────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-header" data-section-key="about">
          <span class="settings-chevron">▶</span>
          <span class="settings-section-title">About</span>
        </div>
        <div class="settings-section-body">
          <p class="about-version" id="about-version">BookSelf — Local-first newsletter reader</p>
          <p style="font-size:0.86rem;color:var(--text-dim);margin-top:8px">
            Built with Python + Flask + SQLite. All data stays on your machine.
          </p>
          <label id="autostart-row" style="display:none;align-items:center;gap:10px;margin-top:14px;cursor:pointer;font-size:0.93rem">
            <input type="checkbox" id="autostart-chk">
            <span>Launch BookSelf when you log in to your Mac</span>
          </label>
        </div><!-- /settings-section-body -->
      </div>
    </div><!-- /state-settings -->

    <!-- ── Stats Sidebar ────────────────────────────────────────── -->
    <div class="stats-sidebar-column">
      <div class="stats-col-spacer"></div>
      <div class="stats-sidebar" id="stats-sidebar">
        <div class="stats-sidebar-title">
          <span>📈 Reading Stats</span>
          <button class="stats-sidebar-reveal-btn" id="btn-stats-reveal">👁 Reveal</button>
        </div>
        <div class="stats-sidebar-content" id="stats-sidebar-content">
          <div class="nav-loading" style="font-size:0.79rem;padding:8px 0">Loading…</div>
        </div>
      </div>
    </div>

    </div><!-- /state-settings-layout -->
  `;

  // ── Wire up sync mode buttons (2-stage: select → confirm → run) ──
  let pendingSyncMode = null;

  function showSyncConfirm(mode) {
    pendingSyncMode = mode;
    const panel = document.getElementById('sync-confirm-panel');
    const desc  = document.getElementById('sync-confirm-desc');
    const wipeRow = document.getElementById('wipe-data-row');
    if (!panel || !desc) return;

    // Mark selected button
    document.querySelectorAll('.sync-mode-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset.mode === mode);
    });

    if (mode === 'seed') {
      desc.innerHTML = `
        <strong>Seed Sync</strong> will re-import every newsletter from
        <strong>Jan 2024 → today</strong>. Your notes and read history are preserved
        unless you check the option below. This may take several minutes.`;
      if (wipeRow) wipeRow.style.display = 'flex';
    } else {
      desc.innerHTML = `
        <strong>Incremental Sync</strong> will fetch only new newsletters since your last
        sync. Usually completes in under a minute.`;
      if (wipeRow) wipeRow.style.display = 'none';
    }

    // Hide new-sender panel if open
    const nsp = document.getElementById('new-sender-panel');
    if (nsp) nsp.classList.add('hidden');

    panel.classList.remove('hidden');
  }

  function hideSyncConfirm() {
    pendingSyncMode = null;
    const panel = document.getElementById('sync-confirm-panel');
    if (panel) panel.classList.add('hidden');
    const chk = document.getElementById('chk-wipe-user-data');
    if (chk) chk.checked = false;
    document.querySelectorAll('.sync-mode-btn').forEach(b => b.classList.remove('selected'));
  }

  document.getElementById('btn-sync-seed').addEventListener('click', () => showSyncConfirm('seed'));
  document.getElementById('btn-sync-incremental').addEventListener('click', () => showSyncConfirm('incremental'));

  // New Sender button — shows inline input panel instead of confirm panel
  document.getElementById('btn-sync-new-sender').addEventListener('click', () => {
    hideSyncConfirm();
    document.querySelectorAll('.sync-mode-btn').forEach(b =>
      b.classList.toggle('selected', b.id === 'btn-sync-new-sender')
    );
    const nsp = document.getElementById('new-sender-panel');
    if (nsp) {
      nsp.classList.remove('hidden');
      document.getElementById('new-sender-input')?.focus();
    }
  });

  document.getElementById('btn-new-sender-cancel').addEventListener('click', () => {
    const nsp = document.getElementById('new-sender-panel');
    if (nsp) nsp.classList.add('hidden');
    document.querySelectorAll('.sync-mode-btn').forEach(b => b.classList.remove('selected'));
    const inp = document.getElementById('new-sender-input');
    if (inp) inp.value = '';
  });

  document.getElementById('btn-new-sender-run').addEventListener('click', () => {
    const inp    = document.getElementById('new-sender-input');
    const sender = inp ? inp.value.trim() : '';
    if (!sender) { if (inp) inp.focus(); return; }
    const nsp = document.getElementById('new-sender-panel');
    if (nsp) nsp.classList.add('hidden');
    if (inp) inp.value = '';
    document.querySelectorAll('.sync-mode-btn').forEach(b => b.classList.remove('selected'));
    runSync('seed', { sender });
  });

  document.getElementById('btn-sync-cancel').addEventListener('click', () => hideSyncConfirm());

  document.getElementById('btn-sync-run').addEventListener('click', () => {
    if (!pendingSyncMode) return;
    const mode = pendingSyncMode;
    const wipeUserData = document.getElementById('chk-wipe-user-data')?.checked || false;
    hideSyncConfirm();
    runSync(mode, { wipeUserData });
  });

  // ── Load async panels ────────────────────────────────────────
  loadLibrarySummary();
  loadConfigEditor();
  loadAiConfigEditor();
  renderStatsSidebar();

  // ── Stats sidebar reveal toggle ──────────────────────────────
  document.getElementById('btn-stats-reveal')?.addEventListener('click', () => {
    const content = document.getElementById('stats-sidebar-content');
    const btn = document.getElementById('btn-stats-reveal');
    if (!content || !btn) return;
    const revealed = content.classList.toggle('revealed');
    btn.textContent = revealed ? '🙈 Hide' : '👁 Reveal';
  });

  // ── Slider UX — pending model (no instant apply) ─────────────
  let pendingUiScale   = localStorage.getItem('uiScale')   || '3';
  let pendingFontScale = document.documentElement.dataset.fontScale || '3';

  document.getElementById('ui-scale-slider').addEventListener('input', (e) => {
    pendingUiScale = e.target.value;
    document.getElementById('ui-scale-label').textContent = `Pending: ${pendingUiScale}`;
  });

  document.getElementById('font-scale-slider').addEventListener('input', (e) => {
    pendingFontScale = e.target.value;
    document.getElementById('font-scale-label').textContent = `Pending: ${pendingFontScale}`;
  });

  function applyUiScale(val) {
    applyZoom(val);
    const lbl = document.getElementById('ui-scale-label');
    if (lbl) { lbl.textContent = `Applied: ${val}`; lbl.style.color = 'var(--done-color)'; }
    setTimeout(() => { if (lbl) { lbl.style.color = ''; lbl.textContent = `Current: ${val}`; } }, 1500);
  }

  function applyFontScale(val) {
    document.documentElement.dataset.fontScale = val;
    localStorage.setItem('fontScale', val);
    const lbl = document.getElementById('font-scale-label');
    if (lbl) { lbl.textContent = `Applied: ${val}`; lbl.style.color = '#4caf8a'; }
    setTimeout(() => { if (lbl) { lbl.style.color = ''; lbl.textContent = `Current: ${val}`; } }, 1500);
  }

  document.getElementById('ui-scale-apply').addEventListener('click', () => applyUiScale(pendingUiScale));
  document.getElementById('font-scale-apply').addEventListener('click', () => applyFontScale(pendingFontScale));

  document.getElementById('display-save-all').addEventListener('click', () => {
    applyUiScale(pendingUiScale);
    applyFontScale(pendingFontScale);
  });

  // ── Collapsible section headers ──────────────────────────────────
  document.querySelectorAll('.settings-section-header').forEach(header => {
    const key  = header.dataset.sectionKey;
    const body = header.nextElementSibling; // .settings-section-body
    const savedState = localStorage.getItem(`settings-collapse-${key}`);
    if (savedState === 'closed') {
      body.classList.add('collapsed');
    } else {
      header.classList.add('open');
    }
    header.addEventListener('click', () => {
      const isOpen = header.classList.toggle('open');
      body.classList.toggle('collapsed', !isOpen);
      localStorage.setItem(`settings-collapse-${key}`, isOpen ? 'open' : 'closed');
    });
  });

  // ── About: live version + launch-at-login toggle ─────────────────
  fetch('/api/version').then(r => r.json()).then(v => {
    const el = document.getElementById('about-version');
    if (el) el.textContent = `BookSelf v${v.version} — Local-first newsletter reader${v.packaged ? '' : ' (dev mode)'}`;
  }).catch(() => {});
  fetch('/api/autostart').then(r => r.json()).then(a => {
    const row = document.getElementById('autostart-row');
    const chk = document.getElementById('autostart-chk');
    if (!row || !a.supported) return;
    row.style.display = 'flex';
    chk.checked = a.enabled;
    chk.addEventListener('change', async () => {
      const res = await fetch('/api/autostart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: chk.checked }),
      });
      const d = await res.json();
      if (d.error) { alert(d.error); chk.checked = !chk.checked; }
    });
  }).catch(() => {});

  // ── Master settings collapser ────────────────────────────────────
  const masterHeader  = canvas.querySelector('#settings-master-header');
  const masterChevron = canvas.querySelector('#settings-master-chevron');
  masterHeader?.addEventListener('click', () => {
    const allHeaders = canvas.querySelectorAll('.settings-section-header');
    const allBodies  = canvas.querySelectorAll('.settings-section-body');
    const anyOpen = [...allHeaders].some(h => h.classList.contains('open'));
    allHeaders.forEach(h => {
      const key = h.dataset.sectionKey;
      if (anyOpen) { h.classList.remove('open'); localStorage.setItem(`settings-collapse-${key}`, 'closed'); }
      else         { h.classList.add('open');    localStorage.setItem(`settings-collapse-${key}`, 'open');   }
    });
    allBodies.forEach(b => b.classList.toggle('collapsed', anyOpen));
    masterChevron.style.transform = anyOpen ? '' : 'rotate(90deg)';
  });

  // ── Theme apply ──────────────────────────────────────────────────
  document.getElementById('btn-apply-theme')?.addEventListener('click', () => {
    const sel = canvas.querySelector('input[name="theme-select"]:checked');
    if (!sel) return;
    const btn = document.getElementById('btn-apply-theme');
    const orig = btn?.textContent || 'Save & Apply Theme';
    if (btn) { btn.textContent = 'Applying theme…'; btn.disabled = true; }
    requestAnimationFrame(() => {
      applyTheme(sel.value);
      if (btn) {
        btn.textContent = 'Appying Theme!';
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
      }
    });
  });
}

/**
 * Fetch config.yaml content from the server and render the inline YAML editor.
 * Called inside renderSettings(). Populates #config-editor-wrap.
 */
async function loadConfigEditor() {
  const wrap = document.getElementById('config-editor-wrap');
  if (!wrap) return;

  try {
    const data = await API.getConfig();

    wrap.innerHTML = `
      <textarea id="config-textarea" spellcheck="false">${escHtml(data.content)}</textarea>
      <div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:8px;flex-wrap:wrap">
        <span   id="config-save-status" style="margin-right:auto;font-size:0.86rem;color:var(--text-dim)"></span>
        <button id="config-save-btn"   class="btn-primary"  >Save</button>
        <button id="config-expand-btn" class="btn-secondary" title="Expand to fullscreen">⤢ Expand</button>
        <button id="config-finder-btn" class="btn-secondary" title="Reveal config.yaml in Finder">Show in Finder</button>
      </div>
    `;

    // Save button
    document.getElementById('config-save-btn').addEventListener('click', async () => {
      await saveConfigContent(
        document.getElementById('config-textarea').value,
        document.getElementById('config-save-btn'),
        document.getElementById('config-save-status')
      );
    });

    // Open in Finder
    document.getElementById('config-finder-btn').addEventListener('click', async () => {
      try {
        await API.post('/api/reveal', { path: 'config.yaml' });
      } catch (err) {
        console.warn('Reveal failed:', err);
      }
    });

    // Expand to modal
    document.getElementById('config-expand-btn').addEventListener('click', () => {
      openConfigModal(data.content);
    });

  } catch (err) {
    wrap.innerHTML = `<p style="color:#e94560;font-size:13px">Could not load config: ${err.message}</p>`;
  }
}

/**
 * Load AI config from the server and render the inline config form.
 * Called inside renderSettings(). Populates #ai-config-wrap.
 */
async function loadAiConfigEditor() {
  const wrap = document.getElementById('ai-config-wrap');
  if (!wrap) return;

  let cfg;
  try {
    cfg = await API.getAiConfig();
  } catch (e) {
    wrap.innerHTML = `<p style="color:var(--accent);font-size:12px">Could not load AI config.</p>`;
    return;
  }

  const provider      = cfg.provider       || 'ollama';
  const model         = cfg.model          || '';
  const baseUrl       = cfg.base_url       || 'http://localhost:11434';
  const apiKeyVal     = cfg.api_key        || '';
  const maxWords      = cfg.max_words      || 6000;
  const defaultPrompt = "You are a newsletter summarizer. Extract the substance so the reader gets 75% of the value in 25% of the time.\n\nRules:\n- Mirror the article's tone and register (analytical, investigative, casual — match it)\n- Target 150–250 words regardless of article length\n- Lead with the single most important fact, number, or development — not a generic sentence\n- Include every key number, date, name, and causal chain — these are non-negotiable\n- Preserve chronology where events are sequential\n- Cut entirely: anecdotes, analogies, personal asides, rhetorical questions, repetition\n- Do NOT write meta-commentary like \"This article discusses...\" or \"The author argues...\" — just the substance\n- Output ONLY the summary. No preamble, no sign-off, no thinking.";
  const summaryPrompt = cfg.summary_prompt || defaultPrompt;

  function buildInstructions(p) {
    if (p === 'ollama') return `
      <strong>Ollama — runs locally, free, fully private, no internet needed</strong><br><br>
      Ollama must be running before you generate a summary.<br>
      Click <strong>↺ Load</strong> to list your installed models, pick one, then <strong>Save</strong>.
      <details class="ai-setup-guide">
        <summary>▸ First time? Setup guide</summary>
        <ol>
          <li>Install Ollama: go to <strong>ollama.com</strong> → Download → run the installer</li>
          <li>Open Terminal and run: <code>ollama pull llama3.2</code> (downloads a model — ~2 GB, one-time)</li>
          <li>Start Ollama: <code>ollama serve</code> — keep this terminal window open while using BookSelf</li>
          <li>Back in BookSelf: click <strong>↺ Load</strong> to see your installed models</li>
          <li>Pick a model → click <strong>Save</strong> → open any article and try <em>Generate AI Summary</em></li>
        </ol>
        <p><em>Ollama runs entirely on your machine. No account or payment needed.</em></p>
      </details>
    `;
    if (p === 'openai') return `
      <strong>OpenAI — cloud-based, fast, requires a paid API key</strong><br><br>
      Recommended model: <code>gpt-4o-mini</code> (cheap, fast) · ~$0.001–0.003 per summary
      <details class="ai-setup-guide">
        <summary>▸ First time? Setup guide</summary>
        <ol>
          <li>Go to <strong>platform.openai.com/api-keys</strong> and sign in (or create a free account)</li>
          <li>Click <em>Create new secret key</em> — copy it immediately, you won't see it again</li>
          <li>Paste the key into the <strong>API Key</strong> field below and click <strong>Save</strong></li>
          <li>Set model to <code>gpt-4o-mini</code> for best price/quality ratio</li>
        </ol>
        <p><em>Requires a funded OpenAI account. Summaries cost fractions of a cent each.</em></p>
      </details>
    `;
    if (p === 'anthropic') return `
      <strong>Anthropic Claude — cloud-based, requires an API key</strong><br><br>
      Recommended model: <code>claude-haiku-4-5</code> (fast, economical) · ~$0.001–0.005 per summary
      <details class="ai-setup-guide">
        <summary>▸ First time? Setup guide</summary>
        <ol>
          <li>Go to <strong>console.anthropic.com</strong> → sign in → click <em>API Keys</em></li>
          <li>Click <em>Create Key</em> — copy it immediately</li>
          <li>Paste the key into the <strong>API Key</strong> field below and click <strong>Save</strong></li>
          <li>Set model to <code>claude-haiku-4-5</code> for best price/quality ratio</li>
        </ol>
        <p><em>Requires a funded Anthropic Console account.</em></p>
      </details>
    `;
    if (p === 'custom') return `
      <strong>Custom / OpenAI-compatible server</strong><br><br>
      Works with: LM Studio, Groq, Together AI, or any server with a <code>/chat/completions</code> endpoint.
      <details class="ai-setup-guide">
        <summary>▸ LM Studio quickstart</summary>
        <ol>
          <li>Download <strong>LM Studio</strong> at lmstudio.ai and install it</li>
          <li>In LM Studio: search for a model (e.g. <em>Mistral 7B</em>) → Download</li>
          <li>Go to the <em>Local Server</em> tab → click <strong>Start Server</strong></li>
          <li>Set Base URL to <code>http://localhost:1234/v1</code> and model to the name shown in LM Studio</li>
          <li>Leave API Key blank (or enter any text — it's ignored locally)</li>
        </ol>
      </details>
    `;
    return '';
  }

  const showBaseUrl = provider === 'ollama' || provider === 'custom';
  const showApiKey  = provider !== 'ollama';

  wrap.innerHTML = `
    <div class="ai-cfg-form">

      <!-- LEFT COLUMN: connection (provider / model / URL / key) -->
      <div class="ai-cfg-col">
        <div class="ai-cfg-row">
          <label class="ai-cfg-label">Provider</label>
          <select id="ai-provider-sel" class="ai-cfg-select">
            <option value="ollama"    ${provider === 'ollama'    ? 'selected' : ''}>🖥 Ollama (local, private)</option>
            <option value="openai"    ${provider === 'openai'    ? 'selected' : ''}>⚡ OpenAI</option>
            <option value="anthropic" ${provider === 'anthropic' ? 'selected' : ''}>⚡ Anthropic</option>
            <option value="custom"    ${provider === 'custom'    ? 'selected' : ''}>🔧 Custom / Compatible</option>
          </select>
        </div>
        <div id="ai-cfg-instructions" class="ai-cfg-instructions">${buildInstructions(provider)}</div>

        <!-- Model: select (Ollama) or text input (cloud providers) -->
        <div class="ai-cfg-row">
          <label class="ai-cfg-label">Model</label>
          <!-- Ollama: proper <select> populated by Load — avoids datalist filtering issues -->
          <div id="ai-model-ollama-row" style="display:${provider === 'ollama' ? 'flex' : 'none'};gap:6px;align-items:center">
            <select id="ai-model-sel" class="ai-cfg-input" style="flex:1">
              ${model
                ? `<option value="${escAttr(model)}">${escHtml(model)}</option>`
                : `<option value="">— click ↺ Load to list models —</option>`}
            </select>
            <button id="btn-ai-load-models" class="btn-secondary"
              style="font-size:0.79rem;padding:5px 8px;white-space:nowrap;flex-shrink:0"
              title="List models installed in Ollama">↺ Load</button>
          </div>
          <!-- Cloud / Custom providers: free-text input -->
          <div id="ai-model-text-row" style="display:${provider !== 'ollama' ? '' : 'none'}">
            <input id="ai-model-inp" type="text" class="ai-cfg-input"
              placeholder="e.g. gpt-4o-mini"
              value="${escAttr(model)}" style="width:100%;box-sizing:border-box">
          </div>
          <span id="ai-model-hint" class="ai-cfg-hint" style="margin-top:3px"></span>
        </div>

        <div class="ai-cfg-row" id="ai-baseurl-row" style="${showBaseUrl ? '' : 'display:none'}">
          <label class="ai-cfg-label">Base URL</label>
          <input id="ai-baseurl-inp" type="text" class="ai-cfg-input"
            placeholder="http://localhost:11434" value="${escAttr(baseUrl)}">
        </div>
        <div class="ai-cfg-row" id="ai-apikey-row" style="${showApiKey ? '' : 'display:none'}">
          <label class="ai-cfg-label">API Key</label>
          <input id="ai-apikey-inp" type="password" class="ai-cfg-input"
            placeholder="${provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}"
            value="${escAttr(apiKeyVal)}">
          <span class="ai-cfg-hint">Or set the <code>AI_API_KEY</code> environment variable</span>
        </div>
      </div><!-- /left col -->

      <!-- RIGHT COLUMN: summary prompt -->
      <div class="ai-cfg-col">
        <div class="ai-cfg-row" style="height:100%">
          <label class="ai-cfg-label">Summary Prompt</label>
          <select id="ai-prompt-preset" class="ai-cfg-select" style="margin-bottom:6px">
            <option value="default">Default — 75% value, tone-matched, fact-dense</option>
            <option value="brief">TL;DR — one paragraph, max 5 sentences</option>
            <option value="bullets">Key bullets only — 5 concise takeaways</option>
            <option value="custom">Custom — edit below</option>
          </select>
          <textarea id="ai-prompt-inp" class="ai-cfg-input ai-prompt-readonly" rows="14"
            style="resize:vertical;font-family:inherit;font-size:0.86rem;line-height:1.5;flex:1"
            placeholder="">${escHtml(summaryPrompt)}</textarea>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px">
            <span class="ai-cfg-hint">Article title, publication, and full text are appended automatically.</span>
            <button id="btn-prompt-expand" class="btn-secondary"
              style="font-size:0.79rem;padding:4px 9px;white-space:nowrap;margin-left:8px;flex-shrink:0"
              title="Open full-screen prompt editor">⤢ Expand</button>
          </div>
        </div>
      </div><!-- /right col -->

    </div><!-- /ai-cfg-form grid -->

    <!-- FOOTER: outside the 2-col grid so it always anchors to the bottom edge -->
    <div class="ai-cfg-footer">
      <div id="ai-cfg-feedback"></div>
      <div class="ai-cfg-actions">
        <button id="btn-ai-cfg-test" class="btn-secondary">⚡ Test Connection</button>
        <button id="btn-ai-cfg-save" class="btn-primary">Save</button>
      </div>
    </div>
  `;

  // ── Prompt presets + readonly logic ───────────────────────────
  const PROMPT_PRESETS = {
    default: defaultPrompt,
    brief:   "Write a TL;DR for this newsletter article in one paragraph of no more than 5 sentences. Focus on the single most important point.",
    bullets: "List the 5 most important takeaways from this newsletter article as concise bullet points. No intro, no conclusion — bullets only.",
  };
  const promptTextarea = document.getElementById('ai-prompt-inp');
  const promptPreset   = document.getElementById('ai-prompt-preset');

  function _updatePromptEditability(preset) {
    if (!promptTextarea) return;
    const isCustom = preset === 'custom';
    promptTextarea.readOnly = !isCustom;
    promptTextarea.classList.toggle('ai-prompt-readonly', !isCustom);
    promptTextarea.placeholder = isCustom ? 'Summarize the article, please and thank you' : '';
  }

  // Set initial preset selection based on stored value
  const storedPrompt = summaryPrompt.trim();
  if      (storedPrompt === PROMPT_PRESETS.default.trim()) promptPreset.value = 'default';
  else if (storedPrompt === PROMPT_PRESETS.brief.trim())   promptPreset.value = 'brief';
  else if (storedPrompt === PROMPT_PRESETS.bullets.trim()) promptPreset.value = 'bullets';
  else                                                     promptPreset.value = 'custom';

  // Apply initial readonly state
  _updatePromptEditability(promptPreset.value);

  promptPreset.addEventListener('change', () => {
    const v = promptPreset.value;
    if (v !== 'custom') {
      promptTextarea.value = PROMPT_PRESETS[v] || '';
    }
    _updatePromptEditability(v);
  });

  // ── Prompt pop-out expand button ──────────────────────────────
  document.getElementById('btn-prompt-expand')?.addEventListener('click', () => {
    // Auto-switch to Custom if on a preset, so the user can edit freely
    if (promptPreset.value !== 'custom') {
      promptPreset.value = 'custom';
      _updatePromptEditability('custom');
    }
    openPromptModal(promptTextarea.value);
  });

  // ── Provider change ────────────────────────────────────────────
  document.getElementById('ai-provider-sel').addEventListener('change', (e) => {
    const p = e.target.value;
    document.getElementById('ai-cfg-instructions').innerHTML = buildInstructions(p);
    document.getElementById('ai-baseurl-row').style.display = (p === 'ollama' || p === 'custom') ? '' : 'none';
    document.getElementById('ai-apikey-row').style.display  = p === 'ollama' ? 'none' : '';
    const keyInp = document.getElementById('ai-apikey-inp');
    if (keyInp) keyInp.placeholder = p === 'anthropic' ? 'sk-ant-...' : 'sk-...';
    // Toggle model select (Ollama) vs text input (cloud)
    const ollamaRow = document.getElementById('ai-model-ollama-row');
    const textRow   = document.getElementById('ai-model-text-row');
    if (ollamaRow) ollamaRow.style.display = (p === 'ollama') ? 'flex' : 'none';
    if (textRow)   textRow.style.display   = (p === 'ollama') ? 'none' : '';
  });

  // ── Load models button ─────────────────────────────────────────
  document.getElementById('btn-ai-load-models').addEventListener('click', async () => {
    const btn      = document.getElementById('btn-ai-load-models');
    const hint     = document.getElementById('ai-model-hint');
    const modelSel = document.getElementById('ai-model-sel');
    btn.disabled    = true;
    btn.textContent = '…';
    hint.textContent = '';
    try {
      const currentProvider = document.getElementById('ai-provider-sel')?.value || 'ollama';
      const currentBaseUrl  = document.getElementById('ai-baseurl-inp')?.value  || 'http://localhost:11434';
      const result = await API.listAiModels(currentProvider, currentBaseUrl);
      if (result.ok && result.models.length > 0) {
        const prevModel = modelSel?.value || '';
        modelSel.innerHTML = result.models
          .map(m => `<option value="${escAttr(m)}">${escHtml(m)}</option>`)
          .join('');
        // Keep previous selection if it exists in the list; otherwise pick first
        modelSel.value = result.models.includes(prevModel) ? prevModel : result.models[0];
        hint.innerHTML = `<span style="color:#4caf8a">✓ ${result.models.length} model${result.models.length > 1 ? 's' : ''} found</span>`;
      } else if (result.ok && result.models.length === 0) {
        hint.innerHTML = `<span style="color:var(--text-dim)">No models found. Pull one first: <code>ollama pull qwen3:8b</code></span>`;
      } else {
        hint.innerHTML = `<span style="color:var(--accent)">${escHtml(result.error || 'Could not list models')}</span>`;
      }
    } catch (e) {
      hint.innerHTML = `<span style="color:var(--accent)">Could not reach server</span>`;
    } finally {
      btn.disabled    = false;
      btn.textContent = '↺ Load';
    }
  });

  // ── Test button ───────────────────────────────────────────────
  document.getElementById('btn-ai-cfg-test').addEventListener('click', async () => {
    const fb  = document.getElementById('ai-cfg-feedback');
    const btn = document.getElementById('btn-ai-cfg-test');
    btn.disabled = true;
    btn.textContent = 'Testing…';
    fb.innerHTML = '';
    try {
      const result = await API.testAiConfig();
      if (result.ok) {
        fb.innerHTML = `<span style="color:#4caf8a">✓ ${escHtml(result.message)}</span>`;
      } else {
        fb.innerHTML = `<span style="color:var(--accent);white-space:pre-line">✗ ${escHtml(result.error)}</span>`;
      }
    } catch (e) {
      fb.innerHTML = `<span style="color:var(--accent)">✗ Could not reach server</span>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '⚡ Test Connection';
    }
  });

  // ── Save button ───────────────────────────────────────────────
  document.getElementById('btn-ai-cfg-save').addEventListener('click', async () => {
    const fb  = document.getElementById('ai-cfg-feedback');
    const btn = document.getElementById('btn-ai-cfg-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    fb.innerHTML = '';

    const providerVal = document.getElementById('ai-provider-sel').value;
    // Ollama uses a <select>; cloud providers use a text input
    const modelVal = providerVal === 'ollama'
      ? (document.getElementById('ai-model-sel')?.value || '').trim()
      : (document.getElementById('ai-model-inp')?.value || '').trim();
    const newCfg = {
      provider:       providerVal,
      model:          modelVal,
      base_url:       (document.getElementById('ai-baseurl-inp')?.value || '').trim(),
      api_key:        document.getElementById('ai-apikey-inp')?.value || '',
      max_words:      maxWords,
      summary_prompt: document.getElementById('ai-prompt-inp').value.trim() || defaultPrompt,
    };

    try {
      const result = await API.saveAiConfig(newCfg);
      if (result.ok) {
        fb.innerHTML = `<span style="color:#4caf8a">✓ Saved to ai_config.yaml</span>`;
        setTimeout(() => { const el = document.getElementById('ai-cfg-feedback'); if (el) el.innerHTML = ''; }, 3000);
      } else {
        fb.innerHTML = `<span style="color:var(--accent)">✗ ${escHtml(result.error || 'Save failed')}</span>`;
      }
    } catch (e) {
      fb.innerHTML = `<span style="color:var(--accent)">✗ Could not save config</span>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });
}

/** Shared save logic used by both inline editor and fullscreen modal */
async function saveConfigContent(content, btn, statusEl) {
  btn.disabled    = true;
  btn.textContent = 'Saving…';
  statusEl.textContent = '';
  statusEl.style.color = '';
  try {
    const result = await API.saveConfig(content);
    if (result.ok) {
      statusEl.textContent = '✓ Saved';
      statusEl.style.color = '#4caf8a';
    } else {
      statusEl.textContent = '✗ ' + (result.error || 'Validation failed');
      statusEl.style.color = '#e94560';
    }
  } catch (err) {
    statusEl.textContent = '✗ ' + err.message;
    statusEl.style.color = '#e94560';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Save';
  }
}

/** Open a fullscreen modal with the YAML editor */
function openConfigModal(initialContent) {
  // Remove existing modal if any
  document.getElementById('config-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'config-modal';
  modal.innerHTML = `
    <div id="config-modal-overlay">
      <div id="config-modal-box">
        <div id="config-modal-header">
          <span>config.yaml</span>
          <button id="config-modal-close" title="Close">✕</button>
        </div>
        <textarea id="config-modal-textarea" spellcheck="false">${escHtml(initialContent)}</textarea>
        <div id="config-modal-footer">
          <button id="config-modal-save" class="btn-primary">Save</button>
          <span   id="config-modal-status"></span>
        </div>
      </div>
    </div>
  `;
  (document.getElementById('app') || document.body).appendChild(modal);

  document.getElementById('config-modal-save').addEventListener('click', async () => {
    await saveConfigContent(
      document.getElementById('config-modal-textarea').value,
      document.getElementById('config-modal-save'),
      document.getElementById('config-modal-status')
    );
    // Sync the inline textarea too
    const inline = document.getElementById('config-textarea');
    if (inline) inline.value = document.getElementById('config-modal-textarea').value;
  });

  document.getElementById('config-modal-close').addEventListener('click', () => {
    modal.remove();
  });

  // Click outside box to close
  document.getElementById('config-modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) modal.remove();
  });
}

function openPromptModal(initialContent) {
  // Remove existing modal if any
  document.getElementById('prompt-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'prompt-modal';
  modal.innerHTML = `
    <div id="prompt-modal-overlay">
      <div id="prompt-modal-box">
        <div id="prompt-modal-header">
          <span>Edit Summary Prompt</span>
          <button id="prompt-modal-close" title="Close">✕</button>
        </div>
        <textarea id="prompt-modal-textarea" spellcheck="true"
          placeholder="Summarize the article, please and thank you">${escHtml(initialContent)}</textarea>
        <div id="prompt-modal-footer">
          <button id="prompt-modal-save" class="btn-primary">Save</button>
          <span id="prompt-modal-status" style="font-size:0.86rem;color:var(--text-dim)"></span>
        </div>
      </div>
    </div>
  `;
  (document.getElementById('app') || document.body).appendChild(modal);

  document.getElementById('prompt-modal-save').addEventListener('click', () => {
    const val = document.getElementById('prompt-modal-textarea').value;
    // Write back to inline textarea
    const inline = document.getElementById('ai-prompt-inp');
    if (inline) inline.value = val;
    // Flash confirmation
    const status = document.getElementById('prompt-modal-status');
    if (status) { status.textContent = '✓ Saved'; setTimeout(() => { status.textContent = ''; }, 1800); }
    modal.remove();
  });

  document.getElementById('prompt-modal-close').addEventListener('click', () => {
    modal.remove();
  });

  // Click outside box to close
  document.getElementById('prompt-modal-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) modal.remove();
  });

  // Focus the textarea
  setTimeout(() => {
    const ta = document.getElementById('prompt-modal-textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }, 50);
}

// ══════════════════════════════════════════════════════════════════
// SYNC — Stream fetch.py output via SSE
// ══════════════════════════════════════════════════════════════════

async function runSync(mode, opts = {}) {
  // mode: 'seed' | 'incremental'
  // opts: { sender?: string, wipeUserData?: boolean }
  const seedBtn        = document.getElementById('btn-sync-seed');
  const incrBtn        = document.getElementById('btn-sync-incremental');
  const footerSyncBtn  = document.getElementById('btn-sync');
  const syncLog        = document.getElementById('sync-log');

  if (!syncLog) return;

  // Disable both sync buttons while running
  if (seedBtn) { seedBtn.disabled = true; seedBtn.classList.add('syncing'); }
  if (incrBtn) { incrBtn.disabled = true; incrBtn.classList.add('syncing'); }
  if (footerSyncBtn) { footerSyncBtn.disabled = true; footerSyncBtn.classList.add('syncing'); }

  // Footer sync indicator
  const syncValueEl = document.getElementById('last-sync-value');
  if (syncValueEl) { syncValueEl.textContent = '⟳ Syncing…'; syncValueEl.classList.add('syncing'); }

  // Show and clear the log
  syncLog.classList.add('visible');
  syncLog.textContent = '';

  const appendLog = (line) => {
    syncLog.textContent += line + '\n';
    syncLog.scrollTop = syncLog.scrollHeight;
  };

  const modeLabel = mode === 'seed' ? 'Seed Sync (full import)' : 'Incremental Sync';
  appendLog(`Starting ${modeLabel}...\n`);

  try {
    const options = { mode };
    if (mode === 'seed' && !opts.sender) options.start_date = '2024-01-01';
    if (opts.sender)       options.sender          = opts.sender;
    if (opts.wipeUserData) options.wipe_user_data  = true;

    const response = await API.syncWith(options);

    if (!response.body) {
      appendLog('Error: SSE not supported by this browser.');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE format: "data: <content>\n\n"
      const events = buffer.split('\n\n');
      buffer = events.pop(); // Keep incomplete last event in buffer

      for (const event of events) {
        if (event.startsWith('data: ')) {
          const line = event.slice(6); // Remove "data: " prefix

          if (line === '[STAGE_1_COMPLETE]') {
            // Acquisition done — refresh nav immediately so new newsletters
            // appear while cataloging continues in the background.
            await buildNavTree();
          } else if (line === '[SYNC_COMPLETE]') {
            appendLog('\n✅ Sync complete!');
            if (syncValueEl) syncValueEl.classList.remove('syncing');
            await loadStatus();
            await buildNavTree();
            // Refresh library summary in settings panel
            loadLibrarySummary();
            const settingsSyncEl = document.getElementById('settings-last-sync');
            if (settingsSyncEl) settingsSyncEl.textContent = appStatus.last_synced || 'Just now';
          } else if (line.startsWith('[SYNC_ERROR]')) {
            appendLog('\n❌ ' + line.slice(12));
          } else {
            appendLog(line);
          }
        }
      }
    }
  } catch (err) {
    appendLog('\n❌ Connection error: ' + err.message);
  } finally {
    // Re-enable buttons
    if (seedBtn) { seedBtn.disabled = false; seedBtn.classList.remove('syncing'); }
    if (incrBtn) { incrBtn.disabled = false; incrBtn.classList.remove('syncing'); }
    if (footerSyncBtn) { footerSyncBtn.disabled = false; footerSyncBtn.classList.remove('syncing'); }
    // Ensure syncing indicator is always cleared (covers error/disconnect paths)
    if (syncValueEl) syncValueEl.classList.remove('syncing');
    // On failure the text would stay "⟳ Syncing…" forever — restore the real
    // last-synced timestamp regardless of how the stream ended.
    await loadStatus();
  }
}

// ══════════════════════════════════════════════════════════════════
// LIBRARY SUMMARY — Populate the settings panel summary table
// ══════════════════════════════════════════════════════════════════

async function loadLibrarySummary() {
  const wrap = document.getElementById('library-summary-wrap');
  if (!wrap) return;

  wrap.innerHTML = '<p class="settings-loading">Loading library…</p>';

  try {
    const data = await API.getLibrarySummary();
    // API returns a plain array (or object with .sources)
    const sources = Array.isArray(data) ? data : (data.sources || []);

    if (sources.length === 0) {
      wrap.innerHTML = '<p class="settings-empty">No newsletters in library yet. Run a Seed Sync to import.</p>';
      return;
    }

    const rows = sources.map(s => `
      <tr>
        <td>${escHtml(s.name || s.publication)}</td>
        <td class="library-sender">${escHtml(s.sender || '—')}</td>
        <td class="library-count">${s.count ?? 0}</td>
        <td class="library-count library-count-read">${s.read_count ?? 0}</td>
        <td class="library-count library-count-ai">${s.ai_summary_count ?? 0}</td>
      </tr>`).join('');

    const total    = sources.reduce((sum, s) => sum + (s.count         || 0), 0);
    const totalRd  = sources.reduce((sum, s) => sum + (s.read_count    || 0), 0);
    const totalAI  = sources.reduce((sum, s) => sum + (s.ai_summary_count || 0), 0);

    wrap.innerHTML = `
      <table class="library-summary-table">
        <thead>
          <tr>
            <th>Publication</th>
            <th>Sender</th>
            <th class="library-count">Articles</th>
            <th class="library-count library-count-read">Read</th>
            <th class="library-count library-count-ai">AI Summaries</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="2"><strong>Total</strong></td>
            <td class="library-count"><strong>${total}</strong></td>
            <td class="library-count library-count-read"><strong>${totalRd}</strong></td>
            <td class="library-count library-count-ai"><strong>${totalAI}</strong></td>
          </tr>
        </tfoot>
      </table>`;
  } catch (err) {
    wrap.innerHTML = `<p class="settings-error">Could not load library summary: ${err.message}</p>`;
  }
}

// ══════════════════════════════════════════════════════════════════
// CONTEXT MENU — Right-click on nav items
// ══════════════════════════════════════════════════════════════════

// Called by oncontextmenu attributes in the nav tree HTML.
// editionId is only set for edition items.
function handleContextMenu(event, type, pub, series, filePath, editionId) {
  event.preventDefault();
  event.stopPropagation();

  contextMenuTarget = { type, pub, series, filePath, editionId: editionId || null };

  // Update "Mark as read" label + visibility based on current read state
  const markReadItem = document.getElementById('ctx-mark-read');
  if (editionId) {
    const navEl = document.querySelector(`.nav-edition[data-id="${editionId}"]`);
    const isRead = navEl ? navEl.dataset.read === '1' : false;
    markReadItem.textContent = isRead ? 'Mark as unread' : 'Mark as read';
    markReadItem.classList.remove('ctx-disabled');
  } else {
    markReadItem.textContent = 'Mark as read';
    markReadItem.classList.add('ctx-disabled');
  }

  // Note item only for editions
  const noteItem = document.getElementById('ctx-note');
  if (editionId) {
    noteItem.classList.remove('ctx-disabled');
  } else {
    noteItem.classList.add('ctx-disabled');
  }

  const menu = document.getElementById('context-menu');
  menu.classList.remove('hidden');

  const x = Math.min(event.clientX, window.innerWidth - 200);
  const y = Math.min(event.clientY, window.innerHeight - 100);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
  contextMenuTarget = null;
}

async function handleReveal() {
  if (!contextMenuTarget) return;
  const target = { ...contextMenuTarget }; // capture before hideContextMenu nulls it
  hideContextMenu();

  let revealPath;
  if (target.type === 'edition' && target.filePath) {
    revealPath = target.filePath;
  } else {
    revealPath = 'newsletters';
  }

  try {
    await API.reveal(revealPath);
  } catch (err) {
    alert('Could not open folder: ' + err.message);
  }
}

async function handleMarkReadFromMenu() {
  if (!contextMenuTarget || !contextMenuTarget.editionId) return;
  const target = { ...contextMenuTarget };
  hideContextMenu();

  try {
    const data = await API.post(`/api/newsletters/${target.editionId}/toggle-read`, {});
    const newIsRead = data.is_read;

    // Update nav item read state
    const navEl = document.querySelector(`.nav-edition[data-id="${target.editionId}"]`);
    if (navEl) navEl.dataset.read = String(newIsRead);

    // If this newsletter is currently open in the reader, sync its done button too
    if (currentState.type === 'reader' && currentState.data &&
        currentState.data.id === parseInt(target.editionId)) {
      const btn = document.querySelector('.reader-done-btn');
      if (btn) {
        btn.classList.toggle('is-done', newIsRead === 1);
        btn.textContent = newIsRead ? '✓ Done' : 'Mark Done';
      }
    }
  } catch (err) {
    console.error('Failed to toggle read status:', err);
  }
}

async function handleEditNote() {
  if (!contextMenuTarget || !contextMenuTarget.editionId) return;
  const target = { ...contextMenuTarget };
  hideContextMenu();

  let myNotes = '', aiSummary = '', notesPath = '';
  try {
    const data = await API.getNote(target.editionId);
    myNotes   = data.my_notes   || '';
    aiSummary = data.ai_summary || '';
    notesPath = data.notes_path || '';
  } catch (e) {}

  renderNoteModal(target.editionId, myNotes, aiSummary, 'my_notes', notesPath);
}

/**
 * Render the note modal with two tabs: My Notes (editable) and AI Summary (read-only placeholder).
 * @param {number}  editionId  - newsletter DB id
 * @param {string}  notesPath  - relative path to the .notes.md file (shown in modal header)
 * @param {string}  myNotes    - current user notes text
 * @param {string}  aiSummary  - current AI summary text (may be empty)
 * @param {string}  activeTab  - 'my_notes' | 'ai_summary'
 */
function renderNoteModal(editionId, myNotes, aiSummary, activeTab = 'my_notes', notesPath = '') {
  const overlay  = document.getElementById('note-modal-overlay');
  const modal    = document.getElementById('note-modal');
  const textarea = document.getElementById('note-modal-textarea');
  const subtitle = document.getElementById('note-modal-subtitle');
  const body     = document.getElementById('note-modal-body');

  // Populate subtitle: article title + dim file path line
  const navEl   = document.querySelector(`.nav-edition[data-id="${editionId}"]`);
  const titleEl = navEl ? navEl.querySelector('.nav-edition-title') : null;
  const titleText = titleEl ? titleEl.textContent : `Newsletter #${editionId}`;
  subtitle.innerHTML = `<span class="note-subtitle-title">${escHtml(titleText)}</span>`
    + (notesPath ? `<span class="note-subtitle-path">📄 ${escHtml(notesPath)}</span>` : '');

  // ── Reset inline overrides so CSS right-anchor defaults take over ─
  modal.style.left   = '';
  modal.style.right  = '';
  modal.style.bottom = '';
  modal.style.width  = '';
  modal.style.height = '';

  // ── Position modal below the reader bar so it never covers the buttons ─
  // Measure the bar each time (its height can vary by article title length).
  const readerBar = document.querySelector('.reader-meta-bar');
  modal.style.top = readerBar
    ? (readerBar.getBoundingClientRect().bottom + 8) + 'px'
    : '80px';

  // ── Clone tab strip to wipe any stacked drag listeners ───────────
  const oldTabStrip   = document.getElementById('note-modal-tabs');
  const freshTabStrip = oldTabStrip.cloneNode(true);
  oldTabStrip.replaceWith(freshTabStrip);
  const dragHandle = freshTabStrip;

  // ── Current values held in closure so tab switch doesn't lose edits
  let currentMyNotes   = myNotes;
  let currentAiSummary = aiSummary;

  // Remove all AI-tab-specific UI elements from the body
  function _clearAiUi() {
    body.querySelector('.ai-empty-state')?.remove();
    body.querySelector('.ai-error-msg')?.remove();
    body.querySelector('.ai-meta-line')?.remove();
    body.querySelector('.ai-md-view')?.remove();
    document.getElementById('note-modal-actions')?.querySelector('#btn-ai-generate')?.remove();
  }

  function _showAiError(msg) {
    body.querySelector('.ai-error-msg')?.remove();
    const errDiv = document.createElement('div');
    errDiv.className = 'ai-error-msg';
    errDiv.innerHTML = `<strong>Could not generate summary</strong><span>${escHtml(msg)}</span>`;
    // Always add a direct link to the AI settings page
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'ai-error-settings-link';
    settingsBtn.textContent = '→ Open AI Settings';
    settingsBtn.addEventListener('click', () => { close(); renderSettings(); });
    errDiv.appendChild(settingsBtn);
    body.insertBefore(errDiv, document.getElementById('note-modal-actions'));
  }

  function _renderAiTab() {
    _clearAiUi();
    const actionsEl = document.getElementById('note-modal-actions');

    // ⚙ AI Settings — always visible in AI tab regardless of summary state
    if (!actionsEl.querySelector('#btn-ai-settings-link')) {
      const sl = document.createElement('button');
      sl.id = 'btn-ai-settings-link';
      sl.className = 'ai-error-settings-link';
      sl.textContent = '⚙ AI Settings';
      sl.style.fontSize = '0.82rem';
      actionsEl.appendChild(sl);
      sl.addEventListener('click', () => {
        close();
        renderSettings();
        setTimeout(() => {
          const h = document.querySelector('[data-section-key="ai-summary"]');
          if (h && !h.classList.contains('open')) h.click();
          h?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 80);
      });
    }

    if (currentAiSummary) {
      // Summary exists: split off the Generated: metadata line, render it separately
      let displaySummary = currentAiSummary;
      const metaMatch = currentAiSummary.match(/^(Generated:[^\n]+)\n\n([\s\S]*)$/);
      if (metaMatch) {
        // Remove any existing meta-line first, then insert fresh one
        body.querySelector('.ai-meta-line')?.remove();
        const metaDiv = document.createElement('div');
        metaDiv.className = 'ai-meta-line';
        metaDiv.textContent = metaMatch[1];
        body.insertBefore(metaDiv, textarea);
        displaySummary = metaMatch[2];
      }

      // Render markdown in a read view; keep textarea hidden (never read its value for AI tab)
      textarea.style.display = 'none';
      const mdView = document.createElement('div');
      mdView.className = 'ai-md-view';
      mdView.innerHTML = renderMarkdown(displaySummary);
      body.insertBefore(mdView, actionsEl);

      const regenBtn = document.createElement('button');
      regenBtn.id        = 'btn-ai-generate';
      regenBtn.className = 'btn-secondary ai-regen-action';
      regenBtn.textContent = '↺ Re-generate';
      // left-align it so it anchors to the left while Show in Finder / Cancel stay right
      regenBtn.style.marginRight = 'auto';
      actionsEl.insertBefore(regenBtn, actionsEl.firstChild);
    } else {
      // No summary: hide textarea, show centred empty-state CTA
      textarea.style.display = 'none';
      const emptyState = document.createElement('div');
      emptyState.className = 'ai-empty-state';
      emptyState.innerHTML = `
        <div class="ai-empty-icon">⚡</div>
        <div class="ai-empty-label">No AI summary yet for this article.</div>
        <button class="ai-generate-btn" id="btn-ai-generate">⚡ Generate AI Summary</button>
      `;
      body.insertBefore(emptyState, actionsEl);
    }

    // Wire the generate / regenerate button (it's always a fresh element)
    document.getElementById('btn-ai-generate')?.addEventListener('click', async () => {
      const genBtn = document.getElementById('btn-ai-generate');
      if (!genBtn) return;
      const wasRegen = !!currentAiSummary;
      genBtn.disabled = true;
      body.querySelector('.ai-error-msg')?.remove();

      // ── Elapsed timer ──────────────────────────────────────────────
      let elapsed = 0;
      genBtn.textContent = 'Generating… 0s';
      const timer = setInterval(() => {
        elapsed++;
        const btn = document.getElementById('btn-ai-generate');
        if (btn) btn.textContent = `Generating… ${elapsed}s`;
      }, 1000);

      // ── Model/provider status line ─────────────────────────────────
      let statusDiv = body.querySelector('.ai-gen-status');
      if (!statusDiv) {
        statusDiv = document.createElement('div');
        statusDiv.className = 'ai-gen-status';
        body.insertBefore(statusDiv, document.getElementById('note-modal-actions'));
      }
      statusDiv.textContent = 'Connecting to AI…';

      // Fetch AI config in parallel — shows model/provider while generation runs
      API.getAiConfig().then(cfg => {
        if (!statusDiv || !statusDiv.parentNode) return;
        const m = (cfg.model || '').trim() || '(no model set)';
        const p = cfg.provider || 'ollama';
        statusDiv.textContent = `Using ${m} via ${p[0].toUpperCase() + p.slice(1)}`;
      }).catch(() => {});

      try {
        const result = await API.generateSummary(editionId);
        clearInterval(timer);
        statusDiv?.remove();
        if (result.ok) {
          currentAiSummary = result.ai_summary;
          // Only re-render the AI tab if we're still on it — prevents overwriting
          // the My Notes textarea if the user switched tabs while generation ran
          if (activeTab === 'ai_summary') _renderAiTab();
          document.getElementById('btn-reader-summary')?.classList.add('has-content');
        } else {
          if (activeTab === 'ai_summary') {
            genBtn.disabled    = false;
            genBtn.textContent = wasRegen ? '↺ Re-generate' : '⚡ Generate AI Summary';
            _showAiError(result.error || 'Unknown error');
          }
        }
      } catch (e) {
        clearInterval(timer);
        statusDiv?.remove();
        // Only update the UI if we're still on the AI tab
        if (activeTab === 'ai_summary') {
          genBtn.disabled    = false;
          genBtn.textContent = wasRegen ? '↺ Re-generate' : '⚡ Generate AI Summary';
          _showAiError(e.message || 'Network error — check your connection and try again.');
        }
      }
    });
  }

  function switchTab(tab) {
    // Only save the My Notes textarea — the AI Summary tab is read-only
    // (its textarea shows displaySummary without the Generated: header,
    //  NOT the full currentAiSummary value — reading it back would corrupt the data)
    if (activeTab === 'my_notes') currentMyNotes = textarea.value;
    activeTab = tab;
    dragHandle.querySelectorAll('.note-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.tab === tab)
    );
    const saveBtn = document.getElementById('note-modal-save');
    if (tab === 'my_notes') {
      _clearAiUi();
      textarea.style.display = '';
      textarea.value          = currentMyNotes;
      textarea.readOnly       = false;
      textarea.placeholder    = 'Write your notes here…';
      saveBtn.style.display   = '';
      setTimeout(() => textarea.focus(), 30);
    } else {
      textarea.readOnly     = true;
      textarea.placeholder  = '';
      saveBtn.style.display = 'none';
      _renderAiTab();
    }
  }

  // Bind tab click listeners on the fresh clone
  dragHandle.querySelectorAll('.note-tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  // Initial render + show
  switchTab(activeTab);
  overlay.classList.remove('hidden');

  // Highlight the button that opened the panel; clear on close
  const _noteBtn    = document.getElementById('btn-reader-note');
  const _summaryBtn = document.getElementById('btn-reader-summary');
  function _setActiveBtn(tab) {
    _noteBtn?.classList.toggle('panel-active', tab === 'my_notes');
    _summaryBtn?.classList.toggle('panel-active', tab === 'ai_summary');
  }
  _setActiveBtn(activeTab);
  // Keep button state in sync when user clicks the in-panel tabs
  dragHandle.querySelectorAll('.note-tab').forEach(t => {
    t.addEventListener('click', () => _setActiveBtn(t.dataset.tab));
  });

  const close = () => {
    overlay.classList.add('hidden');
    _noteBtn?.classList.remove('panel-active');
    _summaryBtn?.classList.remove('panel-active');
  };

  // ── Action buttons — replace to clear stacked listeners ──────────
  const doSave = async () => {
    if (activeTab === 'my_notes') currentMyNotes = textarea.value;
    // AI Summary tab is read-only — never read its textarea back into currentAiSummary
    try {
      await API.saveNote(editionId, currentMyNotes, currentAiSummary);
      const nb = document.getElementById('btn-reader-note');
      const sb = document.getElementById('btn-reader-summary');
      if (nb) nb.classList.toggle('has-content', !!currentMyNotes.trim());
      if (sb) sb.classList.toggle('has-content', !!currentAiSummary.trim());
    } catch (e) { console.error('Failed to save note:', e); }
    close();
  };

  const saveBtn   = document.getElementById('note-modal-save');
  const cancelBtn = document.getElementById('note-modal-cancel');
  const finderBtn = document.getElementById('note-modal-finder');
  saveBtn.replaceWith(saveBtn.cloneNode(true));
  cancelBtn.replaceWith(cancelBtn.cloneNode(true));
  finderBtn.replaceWith(finderBtn.cloneNode(true));

  document.getElementById('note-modal-save').addEventListener('click', doSave);
  document.getElementById('note-modal-cancel').addEventListener('click', close);
  document.getElementById('note-modal-finder').addEventListener('click', async () => {
    try {
      const rec = await API.getNewsletter(editionId);
      if (rec && rec.file_path) await API.reveal(rec.file_path);
    } catch (e) { console.warn('Could not reveal folder:', e); }
  });

  // ── Left-edge resize handle — drag left to widen the panel ───────
  const resizeHandle = document.getElementById('note-modal-resize-handle');
  if (resizeHandle) {
    // Clone to clear previous listeners
    const freshHandle = resizeHandle.cloneNode(true);
    resizeHandle.replaceWith(freshHandle);
    freshHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();   // don't trigger tab-strip drag

      // ── Scale factor ────────────────────────────────────────────
      // #app uses transform:scale() for zoom. position:fixed children
      // live in app-coordinate space, so CSS px ≠ viewport px when
      // zoom ≠ 100%. getBoundingClientRect() returns viewport px;
      // mouse events also use viewport px. We need CSS px for style.width.
      // CSS px = viewport px / scale.
      const appEl = document.getElementById('app');
      const scaleMatch = (appEl?.style.transform || '').match(/scale\(([^)]+)\)/);
      const scale = scaleMatch ? parseFloat(scaleMatch[1]) : 1.0;

      // ── Fixed reference point ────────────────────────────────────
      // Right edge in CSS px — stays fixed throughout the resize
      // regardless of whether the modal is CSS-anchored or freely dragged.
      const rightEdgeCss = modal.getBoundingClientRect().right / scale;

      // If the modal is in free-position mode (dragged), we also need to
      // move `left` as width changes, to keep the right edge stationary.
      const isFreePositioned = modal.style.right === 'auto';

      const onMove = (ev) => {
        const cursorCss = ev.clientX / scale;
        const newWidth  = Math.min(680, Math.max(280, rightEdgeCss - cursorCss));
        modal.style.width = newWidth + 'px';
        if (isFreePositioned) {
          modal.style.left = (rightEdgeCss - newWidth) + 'px';
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  // ── Drag by the tab strip to reposition the panel ────────────────
  // Activates only after ≥4px of movement so tab clicks still register.
  // On first movement we switch from CSS anchor (right:16px) to free
  // position by setting left/top and clearing right/bottom.
  let _dragMoveHandler, _dragUpHandler;

  dragHandle.addEventListener('mousedown', (e) => {
    const startX = e.clientX, startY = e.clientY;
    const r  = modal.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    let committed = false;

    _dragMoveHandler = (ev) => {
      if (!committed) {
        if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
        committed = true;
        // Capture current size before releasing CSS anchors — otherwise
        // bottom:auto causes the modal to collapse to content height
        modal.style.height = r.height + 'px';
        modal.style.right  = 'auto';
        modal.style.bottom = 'auto';
        modal.style.left   = r.left + 'px';
        modal.style.top    = r.top  + 'px';
      }
      modal.style.left = (ev.clientX - dx) + 'px';
      modal.style.top  = (ev.clientY - dy) + 'px';
    };
    _dragUpHandler = () => {
      committed = false;
      document.removeEventListener('mousemove', _dragMoveHandler);
      document.removeEventListener('mouseup',   _dragUpHandler);
    };
    document.addEventListener('mousemove', _dragMoveHandler);
    document.addEventListener('mouseup',   _dragUpHandler);
  });
}

// ══════════════════════════════════════════════════════════════════
// SEARCH
// ══════════════════════════════════════════════════════════════════

function handleSearchInput(query) {
  query = query.trim();

  const clearBtn = document.getElementById('search-clear');

  if (query) {
    clearBtn.classList.remove('hidden');
    // Save state before search so we can restore it on clear
    if (currentState.type !== 'search') {
      previousStateBeforeSearch = { ...currentState };
    }
    renderSearchResults(query);
  } else {
    clearBtn.classList.add('hidden');
    // Restore full nav tree (search replaced it with filtered view)
    buildNavTree();
    // Restore previous state or show empty
    if (previousStateBeforeSearch && previousStateBeforeSearch.type !== 'empty') {
      restoreState(previousStateBeforeSearch);
    } else {
      renderEmpty();
    }
    previousStateBeforeSearch = null;
  }
}

async function restoreState(state) {
  if (state.type === 'publication') {
    await renderPublicationOverview(state.data.publication);
  } else if (state.type === 'series') {
    await renderSeriesOverview(state.data.publication, state.data.series);
  } else if (state.type === 'reader') {
    await renderNewsletterReader(state.data.id);
  } else {
    renderEmpty();
  }
}

// ══════════════════════════════════════════════════════════════════
// EVENT LISTENERS SETUP
// ══════════════════════════════════════════════════════════════════

function setupEventListeners() {
  // ── Home / Back / Forward navigation ─────────────────────────
  document.getElementById('btn-home').addEventListener('click', () => renderEmpty());
  document.getElementById('btn-back').addEventListener('click', goBack);
  document.getElementById('btn-forward').addEventListener('click', goForward);

  // ── Left pane collapse / expand ──────────────────────────────
  document.getElementById('toggle-pane').addEventListener('click', () => {
    const leftPane  = document.getElementById('left-pane');
    const toggleBtn = document.getElementById('toggle-pane');
    const expandBtn = document.getElementById('btn-expand');
    leftPane.classList.add('collapsed');
    toggleBtn.classList.add('pane-hidden');
    expandBtn.classList.remove('hidden');
  });

  document.getElementById('btn-expand').addEventListener('click', () => {
    const leftPane  = document.getElementById('left-pane');
    const toggleBtn = document.getElementById('toggle-pane');
    const expandBtn = document.getElementById('btn-expand');
    leftPane.classList.remove('collapsed');
    toggleBtn.classList.remove('pane-hidden');
    expandBtn.classList.add('hidden');
  });

  // ── Search bar ───────────────────────────────────────────────
  const searchInput = document.getElementById('search-input');

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchDebounceTimer);
      handleSearchInput(searchInput.value);
    }
    if (e.key === 'Escape') {
      searchInput.value = '';
      handleSearchInput('');
    }
  });

  searchInput.addEventListener('input', () => {
    // Debounce: wait 300ms after user stops typing
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      handleSearchInput(searchInput.value);
    }, 300);
  });

  document.getElementById('search-clear').addEventListener('click', () => {
    searchInput.value = '';
    handleSearchInput('');
    searchInput.focus();
  });

  // ── Completion filter buttons (All / Not done / Done) ───────────
  document.querySelectorAll('.completion-btn').forEach(btn => {
    btn.addEventListener('click', () => applyReadFilter(btn.dataset.read));
  });
  document.getElementById('read-filter-header')?.addEventListener('click', toggleReadFilterPanel);

  // ── Date range filter (initialise dropdowns + toggle) ───────────
  initDateFilter();

  // ── Footer buttons ───────────────────────────────────────────
  document.getElementById('btn-sync').addEventListener('click', () => {
    // Navigate to Settings so user can choose Seed or Incremental
    renderSettings();
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    renderSettings();
  });

  document.getElementById('btn-stats').addEventListener('click', () => {
    renderStats();
  });

  document.getElementById('btn-finder').addEventListener('click', () => {
    API.reveal('newsletters').catch(err => alert('Could not open folder: ' + err.message));
  });

  // ── Context menu ─────────────────────────────────────────────
  document.getElementById('ctx-mark-read').addEventListener('click', handleMarkReadFromMenu);
  document.getElementById('ctx-open-folder').addEventListener('click', handleReveal);
  document.getElementById('ctx-note').addEventListener('click', handleEditNote);

  // Close context menu when clicking anywhere else
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#context-menu')) {
      hideContextMenu();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
    }
  });

  // Suppress default browser context menu on the nav tree only.
  // Inputs and textareas keep their OS-level copy/paste/spellcheck menu.
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('[oncontextmenu]')
        && !e.target.closest('textarea')
        && !e.target.closest('input')) {
      e.preventDefault();
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════

/**
 * Format a YYYY-MM-DD date string as "Feb 25" (short, for nav tree)
 */
function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(month) - 1]} ${parseInt(day)}`;
}

/**
 * Format a YYYY-MM-DD date string as "25 Feb 2026" (full, for cards/reader)
 */
function formatDateFull(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(day)} ${months[parseInt(month) - 1]} ${year}`;
}

/**
 * Escape a string for safe insertion into HTML content.
 * Prevents XSS from newsletter titles/names.
 */
// ── Simple markdown → HTML renderer (used for AI summaries) ────────
// Handles: headings, bold, italic, code, bullet/numbered lists, HR, paragraphs.
// Input is HTML-escaped first so no XSS risk from AI output.
function renderMarkdown(text) {
  if (!text) return '';

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function inline(s) {
    s = esc(s);
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/_(.+?)_/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return s;
  }

  const lines  = text.split('\n');
  const out    = [];
  let inUl     = false;
  let inOl     = false;

  function closeLists() {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const tr  = raw.trim();

    if (/^---+\s*$/.test(tr)) { closeLists(); out.push('<hr>'); continue; }

    const h3 = tr.match(/^###\s+(.+)/);
    const h2 = tr.match(/^##\s+(.+)/);
    const h1 = tr.match(/^#\s+(.+)/);
    if (h3) { closeLists(); out.push(`<h3>${inline(h3[1])}</h3>`); continue; }
    if (h2) { closeLists(); out.push(`<h2>${inline(h2[1])}</h2>`); continue; }
    if (h1) { closeLists(); out.push(`<h1>${inline(h1[1])}</h1>`); continue; }

    const ul = tr.match(/^[-*]\s+(.+)/);
    if (ul) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = tr.match(/^\d+\.\s+(.+)/);
    if (ol) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    if (tr === '') {
      closeLists();
      // collapse multiple blank lines: only add spacer if previous wasn't already one
      if (out.length > 0 && out[out.length - 1] !== '<p class="md-gap"></p>') {
        out.push('<p class="md-gap"></p>');
      }
      continue;
    }

    closeLists();
    out.push(`<p>${inline(tr)}</p>`);
  }
  closeLists();
  return out.join('');
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape a string for safe use in HTML attribute values (oncontextmenu etc.)
 */
function escAttr(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
}
