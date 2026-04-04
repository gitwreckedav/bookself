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
let activeYearFilter = null;     // null = all years; '2024'/'2025'/'2026' = filter editions

// ── Navigation history (back / forward) ──────────────────────────
// Stores up to MAX_HISTORY states. navHistoryIndex points to the current
// position. goBack() decrements, goForward() increments.
const MAX_HISTORY = 5;
let navHistory = [];       // array of { type, data } state objects
let navHistoryIndex = -1;  // -1 = no history yet
let isNavigatingHistory = false; // prevents push during back/forward calls

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
    if (!res.ok) throw new Error(`API error ${res.status} at ${url}`);
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

  async getConfig() {
    return this.get('/api/config');
  },

  async saveConfig(content) {
    return this.post('/api/config', { content });
  },

  async syncWith(options = {}) {
    // options: { mode: 'seed'|'incremental', start_date: 'YYYY-MM-DD' (optional) }
    const body = { mode: options.mode || 'incremental' };
    if (options.start_date) body.start_date = options.start_date;
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res; // return raw response for SSE streaming
  },

  async getLibrarySummary() {
    return this.get('/api/library/summary');
  }
};

// ══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  // ── Apply saved scale preferences from localStorage ───────────
  const savedUiScale   = localStorage.getItem('uiScale')   || '2';
  const savedFontScale = localStorage.getItem('fontScale') || '2';
  document.body.dataset.uiScale   = savedUiScale;
  document.body.dataset.fontScale = savedFontScale;

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
});

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
  const divider   = document.getElementById('pane-divider');
  const mainLayout = document.getElementById('main-layout');

  if (!divider || !mainLayout) return;

  let isDragging  = false;
  let currentWidth = 280; // px — matches CSS default

  // Restore saved width from previous session
  const saved = localStorage.getItem('leftPaneWidth');
  if (saved && !isNaN(parseInt(saved))) {
    currentWidth = parseInt(saved);
    // Set on body so it overrides body[data-ui-scale] CSS rules
    document.body.style.setProperty('--left-pane-width', currentWidth + 'px');
  }

  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    divider.classList.add('dragging');
    document.body.style.cursor    = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = mainLayout.getBoundingClientRect();
    // Clamp between 160 px (minimum usable) and 600 px (max)
    const newWidth = Math.max(160, Math.min(600, e.clientX - rect.left));
    currentWidth = newWidth;
    // Set on body so it overrides body[data-ui-scale] CSS rules
    document.body.style.setProperty('--left-pane-width', newWidth + 'px');
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor    = '';
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
  const filtered = filterEditionsByYear(editions);

  if (filtered.length === 0) {
    const msg = activeYearFilter
      ? `No editions in ${activeYearFilter}`
      : 'No editions';
    return `<div class="nav-loading" style="font-size:11px;padding:4px 8px;color:#8892a4">${msg}</div>`;
  }

  return filtered.map(ed => {
    // Format date as "Feb 25"
    const dateLabel = formatDateShort(ed.date_received);
    // Truncate title to ~45 chars
    const titleShort = ed.title.length > 45 ? ed.title.slice(0, 45) + '…' : ed.title;
    const previewIcon = ed.is_preview ? '<span class="nav-preview-icon">🔒</span>' : '';

    return `
      <div class="nav-edition"
           data-id="${ed.id}"
           data-file="${escAttr(ed.file_path || '')}"
           data-pub="${escHtml(pub)}"
           data-series="${escHtml(series || '')}"
           oncontextmenu="handleContextMenu(event, 'edition', '${escAttr(pub)}', '${escAttr(series || '')}', '${escAttr(ed.file_path || '')}')"
      >
        ${previewIcon}
        <span class="nav-edition-date">${dateLabel}</span>
        <span class="nav-edition-title">${escHtml(titleShort)}</span>
      </div>
    `;
  }).join('');
}

function attachEditionHandlers(containerEl) {
  containerEl.querySelectorAll('.nav-edition').forEach(el => {
    el.addEventListener('click', () => {
      clearActiveNav();
      el.classList.add('active');
      const id = parseInt(el.dataset.id);
      renderNewsletterReader(id);
    });
  });
}

function clearActiveNav() {
  document.querySelectorAll('.nav-pub-header.active, .nav-series-header.active, .nav-edition.active')
    .forEach(el => el.classList.remove('active'));
}

// ══════════════════════════════════════════════════════════════════
// YEAR FILTER — filter nav editions by selected year
// ══════════════════════════════════════════════════════════════════

function filterEditionsByYear(editions) {
  if (!activeYearFilter) return editions;
  return editions.filter(ed => {
    if (!ed.date_received) return true;
    return ed.date_received.startsWith(activeYearFilter);
  });
}

function applyYearFilter(year) {
  // Toggle: clicking the same year again clears the filter
  activeYearFilter = (activeYearFilter === year) ? null : year;

  // Update button active states
  document.querySelectorAll('.year-filter-btn').forEach(btn => {
    const isAll = btn.dataset.year === 'all';
    if (isAll) {
      btn.classList.toggle('active', activeYearFilter === null);
    } else {
      btn.classList.toggle('active', btn.dataset.year === activeYearFilter);
    }
  });

  // Re-render all currently-expanded edition lists with the new filter
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
  pushHistory(currentState);
  currentState = { type: 'reader', data: { id: newsletterId } };

  canvas.innerHTML = `<div class="state-reader"><div class="nav-loading">Loading...</div></div>`;

  try {
    const n = await API.getNewsletter(newsletterId);

    const date = formatDateFull(n.date_received);
    const wordCount = n.word_count ? `${n.word_count.toLocaleString()} words` : '';
    const seriesTag = n.series ? `<span class="reader-series">· ${escHtml(n.series)}</span>` : '';
    const previewBanner = n.is_preview && n.preview_label ? `
      <div class="preview-banner">
        🔒 ${escHtml(n.preview_label)}
      </div>` : '';

    canvas.innerHTML = `
      <div class="state-reader">
        <div class="reader-meta-bar">
          <div class="reader-title">${escHtml(n.title)}</div>
          <div class="reader-meta-row">
            <span class="reader-pub">${escHtml(n.publication)}</span>
            ${seriesTag}
            <span class="reader-date">${escHtml(date)}</span>
            ${wordCount ? `<span class="reader-wordcount">${wordCount}</span>` : ''}
          </div>
          ${previewBanner}
        </div>
        <div class="reader-iframe-wrapper">
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

    // Auto-resize iframe to match content height
    const iframe = document.getElementById('newsletter-iframe');
    iframe.addEventListener('load', () => {
      try {
        const body = iframe.contentDocument.body;
        if (body) {
          const height = body.scrollHeight;
          iframe.style.height = height + 'px';
        }
      } catch (err) {
        // Cross-origin restriction (shouldn't happen since we serve from localhost)
        iframe.style.height = '800px';
      }
    });

  } catch (err) {
    canvas.innerHTML = `<div class="state-reader"><p style="padding:20px;color:#e94560">Error: ${err.message}</p></div>`;
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
  const savedUiScale   = document.body.dataset.uiScale   || '2';
  const savedFontScale = document.body.dataset.fontScale || '2';

  canvas.innerHTML = `
    <div class="state-settings">
      <h2 style="font-size:18px;font-weight:700;margin-bottom:20px;color:var(--text-main)">Settings</h2>

      <!-- ── Sync ───────────────────────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-title">Sync</div>

        <div class="settings-row">
          <span class="settings-label">Last synced</span>
          <span class="settings-value" id="settings-last-sync">${escHtml(lastSynced)}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Library total</span>
          <span class="settings-value">${escHtml(totalStr)} newsletters</span>
        </div>

        <div style="margin-top:16px;margin-bottom:8px;font-size:12px;color:var(--text-dim)">
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
        </div>

        <!-- Confirmation panel — shown after clicking a sync mode button -->
        <div id="sync-confirm-panel" class="sync-confirm-panel hidden">
          <div id="sync-confirm-desc" class="sync-confirm-desc"></div>
          <div class="sync-confirm-actions">
            <button id="btn-sync-cancel" class="btn-secondary">Cancel</button>
            <button id="btn-sync-run"    class="btn-primary">▶ Run Sync</button>
          </div>
        </div>

        <!-- Live sync output log (hidden until sync starts) -->
        <div id="sync-log"></div>
      </div>

      <!-- ── Library Summary ────────────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-title">Library</div>
        <div id="library-summary-wrap">
          <div class="nav-loading" style="font-size:12px;padding:8px 0">Loading…</div>
        </div>
      </div>

      <!-- ── Config Editor ──────────────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-title">Configuration</div>
        <p style="font-size:13px;color:var(--text-dim);margin-bottom:10px">
          Edit your newsletter sources directly. Changes take effect on next sync.
        </p>
        <div id="config-editor-wrap">
          <div class="nav-loading" style="font-size:12px;padding:8px 0">Loading config…</div>
        </div>
      </div>

      <!-- ── Display ────────────────────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-title">Display</div>

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
          <button class="btn-primary" id="display-save-all" style="font-size:13px">
            Save &amp; Apply All
          </button>
        </div>
      </div>

      <!-- ── About ──────────────────────────────────────────────── -->
      <div class="settings-section">
        <div class="settings-section-title">About</div>
        <p class="about-version">BookSelf v1.0.0 — Local-first newsletter reader</p>
        <p style="font-size:12px;color:var(--text-dim);margin-top:8px">
          Built with Python + Flask + SQLite. All data stays on your machine.
        </p>
      </div>
    </div>
  `;

  // ── Wire up sync mode buttons (2-stage: select → confirm → run) ──
  let pendingSyncMode = null;

  function showSyncConfirm(mode) {
    pendingSyncMode = mode;
    const panel = document.getElementById('sync-confirm-panel');
    const desc  = document.getElementById('sync-confirm-desc');
    if (!panel || !desc) return;

    // Mark selected button, unmark the other
    document.querySelectorAll('.sync-mode-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset.mode === mode);
    });

    if (mode === 'seed') {
      desc.innerHTML = `
        <strong>Seed Sync</strong> will purge all pre-2024 data and re-import every
        newsletter from <strong>Jan 2024 → today</strong>. This may take several minutes.
        Are you sure?`;
    } else {
      desc.innerHTML = `
        <strong>Incremental Sync</strong> will fetch only new newsletters since your last
        seed sync. Usually completes in under a minute.`;
    }
    panel.classList.remove('hidden');
  }

  function hideSyncConfirm() {
    pendingSyncMode = null;
    const panel = document.getElementById('sync-confirm-panel');
    if (panel) panel.classList.add('hidden');
    document.querySelectorAll('.sync-mode-btn').forEach(b => b.classList.remove('selected'));
  }

  document.getElementById('btn-sync-seed').addEventListener('click', () => showSyncConfirm('seed'));
  document.getElementById('btn-sync-incremental').addEventListener('click', () => showSyncConfirm('incremental'));

  document.getElementById('btn-sync-cancel').addEventListener('click', () => hideSyncConfirm());

  document.getElementById('btn-sync-run').addEventListener('click', () => {
    if (!pendingSyncMode) return;
    const mode = pendingSyncMode;
    hideSyncConfirm();
    runSync(mode);
  });

  // ── Load async panels ────────────────────────────────────────
  loadLibrarySummary();
  loadConfigEditor();

  // ── Slider UX — pending model (no instant apply) ─────────────
  let pendingUiScale   = document.body.dataset.uiScale   || '2';
  let pendingFontScale = document.body.dataset.fontScale || '2';

  document.getElementById('ui-scale-slider').addEventListener('input', (e) => {
    pendingUiScale = e.target.value;
    document.getElementById('ui-scale-label').textContent = `Pending: ${pendingUiScale}`;
  });

  document.getElementById('font-scale-slider').addEventListener('input', (e) => {
    pendingFontScale = e.target.value;
    document.getElementById('font-scale-label').textContent = `Pending: ${pendingFontScale}`;
  });

  function applyUiScale(val) {
    document.body.dataset.uiScale = val;
    localStorage.setItem('uiScale', val);
    const lbl = document.getElementById('ui-scale-label');
    if (lbl) { lbl.textContent = `Applied: ${val}`; lbl.style.color = '#4caf8a'; }
    setTimeout(() => { if (lbl) { lbl.style.color = ''; lbl.textContent = `Current: ${val}`; } }, 1500);
  }

  function applyFontScale(val) {
    document.body.dataset.fontScale = val;
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
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <button id="config-save-btn" class="btn-primary" style="font-size:13px;padding:6px 16px">Save</button>
        <span id="config-save-status"></span>
      </div>
    `;

    document.getElementById('config-save-btn').addEventListener('click', async () => {
      const btn      = document.getElementById('config-save-btn');
      const statusEl = document.getElementById('config-save-status');
      const content  = document.getElementById('config-textarea').value;

      btn.disabled     = true;
      btn.textContent  = 'Saving…';
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
    });

  } catch (err) {
    wrap.innerHTML = `<p style="color:#e94560;font-size:13px">Could not load config: ${err.message}</p>`;
  }
}

// ══════════════════════════════════════════════════════════════════
// SYNC — Stream fetch.py output via SSE
// ══════════════════════════════════════════════════════════════════

async function runSync(mode) {
  // mode: 'seed' | 'incremental'
  const seedBtn        = document.getElementById('btn-sync-seed');
  const incrBtn        = document.getElementById('btn-sync-incremental');
  const footerSyncBtn  = document.getElementById('btn-sync');
  const syncLog        = document.getElementById('sync-log');

  if (!syncLog) return;

  // Disable both sync buttons while running
  if (seedBtn) { seedBtn.disabled = true; seedBtn.classList.add('syncing'); }
  if (incrBtn) { incrBtn.disabled = true; incrBtn.classList.add('syncing'); }
  if (footerSyncBtn) { footerSyncBtn.disabled = true; footerSyncBtn.classList.add('syncing'); }

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
    if (mode === 'seed') options.start_date = '2024-01-01';

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

          if (line === '[SYNC_COMPLETE]') {
            appendLog('\n✅ Sync complete!');
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
        <td>${s.name || s.publication}</td>
        <td class="library-sender">${s.sender || '—'}</td>
        <td class="library-count">${s.count}</td>
      </tr>`).join('');

    const total = sources.reduce((sum, s) => sum + (s.count || 0), 0);

    wrap.innerHTML = `
      <table class="library-summary-table">
        <thead>
          <tr><th>Publication</th><th>Sender</th><th>Issues</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="2"><strong>Total</strong></td><td class="library-count"><strong>${total}</strong></td></tr>
        </tfoot>
      </table>`;
  } catch (err) {
    wrap.innerHTML = `<p class="settings-error">Could not load library summary: ${err.message}</p>`;
  }
}

// ══════════════════════════════════════════════════════════════════
// CONTEXT MENU — Right-click to open folder
// ══════════════════════════════════════════════════════════════════

// Called by oncontextmenu attributes in the nav tree HTML
function handleContextMenu(event, type, pub, series, filePath) {
  event.preventDefault();
  event.stopPropagation();

  // Store the target info for when the menu item is clicked
  contextMenuTarget = { type, pub, series, filePath };

  const menu = document.getElementById('context-menu');
  menu.classList.remove('hidden');

  // Position menu at cursor, keeping it within viewport
  const x = Math.min(event.clientX, window.innerWidth - 200);
  const y = Math.min(event.clientY, window.innerHeight - 60);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
}

function hideContextMenu() {
  const menu = document.getElementById('context-menu');
  menu.classList.add('hidden');
  contextMenuTarget = null;
}

async function handleReveal() {
  if (!contextMenuTarget) return;
  hideContextMenu();

  const { type, pub, series, filePath } = contextMenuTarget;

  // Determine which path to reveal:
  // - edition → reveal the folder containing the HTML file
  // - series  → reveal the series subfolder
  // - publication → reveal the publication folder
  let revealPath;
  if (type === 'edition' && filePath) {
    revealPath = filePath; // Flask will open parent folder if this is a file
  } else if (type === 'series' && series) {
    // Find series folder name from navData (series display name → folder)
    // Simpler: just use newsletters/<pub folder>/<series folder> approximation
    revealPath = `newsletters`;
  } else {
    revealPath = 'newsletters';
  }

  try {
    await API.reveal(revealPath);
  } catch (err) {
    alert('Could not open folder: ' + err.message);
  }
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
  // ── Back / Forward navigation ─────────────────────────────────
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

  // ── Year filter buttons ──────────────────────────────────────
  document.querySelectorAll('.year-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const year = btn.dataset.year;
      if (year === 'all') {
        activeYearFilter = null;
        document.querySelectorAll('.year-filter-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.year === 'all');
        });
        // Re-render open edition lists
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
      } else {
        applyYearFilter(year);
      }
    });
  });

  // ── Footer buttons ───────────────────────────────────────────
  document.getElementById('btn-sync').addEventListener('click', () => {
    // Navigate to Settings so user can choose Seed or Incremental
    renderSettings();
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    renderSettings();
  });

  // ── Context menu ─────────────────────────────────────────────
  document.getElementById('ctx-open-folder').addEventListener('click', handleReveal);

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

  // Suppress default browser context menu everywhere in the app
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('[oncontextmenu]')) {
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
