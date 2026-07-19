# BookSelf — Frontend Doc (incl. Design tokens)

**Version:** 1.0   **Date:** 2026-07-19   **Owner:** AV
**Status:** locked   **Companion to:** BookSelf_PRD.md, BookSelf_BackendDoc.md, BookSelf_DevOpsDoc.md
**Governed by:** LivingDocs Protocol v1.1

> Reduced stack per protocol §"fewer docs": DesignDoc is folded into §4 here (light-UI app,
> one shared CSS file). Split it out if a dedicated design system emerges.

## §0.1 Version History

| Version | Date | Chat | Changes |
|---|---|---|---|
| 1.0 | 2026-07-19 | Fable checkpoint | First formalization from live codebase. |

## §0.2 Section Status Legend

`[locked]` / `[draft]` / `[needs-review]` per protocol.

## §0.3 Cross-Doc Contracts

| This doc owns | Consumes from |
|---|---|
| UI structure, JS patterns, design tokens/themes, UX conventions, known UI bug classes | BackendDoc §5: the API seam — never redefine routes, shapes, or SSE tokens here. PRD: decisions #10, #24; rejected list §7. |

---

## §1. Structure `[locked]`

Single-page vanilla JS (`app/static/js/app.js`, ~3.5k lines), one stylesheet
(`app/static/css/style.css`), one template (`app/templates/index.html`). No framework, no build step
— deliberate (modifiable by any tool, zero toolchain lock-in).

Layout: `#left-pane` (nav: search, filters, **Daily Briefs pinned section**, publication tree,
footer) + `#pane-divider` (drag-resize, clamped 230-600px, iframe pointer-events disabled during
drag) + `#right-pane` (welcome / reader / settings / stats). Reader renders article HTML in a
sandboxed **iframe**; dark-mode CSS is injected per-theme via `getArticleDarkCss()` (reads live CSS
vars — never a hardcoded string).

Key render functions: `buildNavTree`, `renderBriefsSectionHTML`, `renderNewsletterReader`,
`renderSettings`, `renderStats`, `renderBriefReader`. Notes/AI panel: floating draggable modal with
tab strip (`My Notes` editable / `AI Summary` read-only — NEVER read the AI textarea's value back;
it displays a transformed value).

## §2. State + persistence `[locked]`

No state library. Module-level objects (`navData`, `appStatus`) + `localStorage` keys:
`bookself-theme`, `uiScale`, `fontScale`, `leftPaneWidth`, `settings-collapse-{key}`,
`briefs-section-open`, `update-dismissed`. UI scale = `transform: scale()` on `#app` with
compensating vw/vh (drag math must divide by scale — see `initPaneResize`).

## §3. UX conventions `[locked]`

- Every clickable element: `:hover` + `:active`; selected states unambiguous (accent left-border + bold).
- 3D dark-button recipe: gradient face + `border-bottom` base edge + `box-shadow: 0 3px 0` travel; hover `translateY(-1px)`, active `translateY(+2px)` with collapsed shadow.
- Buttons in one row: identical height (`display:inline-flex; align-items:center` + same padding).
- Text overflow: **CSS ellipsis only** — never JS char-slicing (double-crops, width-blind).
- Collapsible sections: chevron `▶` rotating 90°, state in localStorage, master collapser overrides.
- Panels opened by ribbon buttons: button stays highlighted while open, click-again closes, state cleared when panel closes or article switches.
- Errors shown to user = what went wrong + how to fix it, never a bare string.
- No internal jargon in UI copy; no condescending/obvious copy.

## §4. Design tokens `[locked]` (PRD #10)

All colors via `:root` CSS variables — **zero one-off hexes**. Layering (darkest→lightest):
`--bg-dark` (app bg) → `--bg-mid` (left pane) → `--bg-surface` (cards/modals) → `--bg-item`
(interactive). Text: `--text-main` (#e0e0e0 on dark, WCAG AA), `--text-dim`. Accent: `--accent`,
`--accent-dim`, `--done-color`. Buttons: `--btn-primary-bg` / `--btn-primary-color` /
`--btn-secondary-bg` (can hold full `linear-gradient(...)` strings).

`THEMES` map in app.js: 6 themes (midnight-blues default, forest-dark, amber-noir, deep-purple,
slate-storm, rose-gold), each a complete var set. `applyTheme()` sets vars + re-injects article
dark CSS if a reader is open. **Adding any new surface: pick the nearest existing var, never a new
shade.** Inputs on dark cards: recessed well (`rgba(0,0,0,0.35)` bg + `rgba(255,255,255,0.18)`
border) — never `--bg-item` (invisible against card).

## §5. Known UI bug classes (regression watchlist) `[locked]`

1. Fixed-height containers cropping wrapped content (footer 2×2 wrap needs `min-height`).
2. Disabled-state colors darker than their background (invisible glyphs).
3. Iframes swallowing mouse events (drag, context menu) — disable `pointer-events` during drag; never `preventDefault` contextmenu on inputs/textareas.
4. Inline `style="… !important"` inside newsletter HTML beats injected CSS — fix via DOM walk storing originals in `data-*`.
5. Stale panel content on article switch — always close floating panels + clear ribbon active states in `renderNewsletterReader`.
6. Mismatched control heights in a shared row (measure both; `inline-flex` + explicit height).
7. Saved localStorage values must be re-clamped on restore (old out-of-range values resurrect bugs).

**Standing directive (AV, 2026-07-15):** every feature turn includes a proactive UI audit of touched
screens — cropping, alignment, font scale coherence, icon sizes, states — fixed unprompted.

---

**End of BookSelf FrontendDoc v1.0**
