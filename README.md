# Sankey (Auto-Contrast) — Tableau dashboard extension

Custom replacement for the Infotopics "Sankey Diagram" extension with one addition: node labels and link value labels automatically switch between white and dark based on the WCAG relative luminance of the color they sit on, so labels stay readable on dark nodes (e.g. brand purple `#27004B`) and pale links.

Built by the Data team. No external dependencies at runtime: d3, d3-sankey, and the Tableau Extensions API are vendored in `lib/`. The extension only reads worksheet **summary** data, so it does not need the full-data permission.

## Files

| file | purpose |
|---|---|
| `index.html` / `main.js` / `styles.css` | the viz |
| `config.html` / `config.js` | configuration dialog (opens from the extension's context menu) |
| `sankey-autocontrast-viz.trex` | manifest to add the extension to a worksheet's Marks card; update the URL after hosting |
| `lib/` | vendored d3 v7, d3-sankey 0.12.3, Tableau Extensions API 1.x |

## Features

- 2+ level dimensions (levels ordered left to right), any numeric measure for flow size
- Node color modes: same values share a color, or unique per node; editable palette (defaults to the Ignite brand palette) plus per-value color overrides
- Link color modes: input→output gradient, input, output, or neutral
- Node and link opacity, node width, vertical padding, node border, 4 layout modes (justify/left/right/center), background color
- Sorting: automatic, by value (asc/desc), alphabetical; link sorting; manual drag-reorder of nodes (order persists when authoring)
- Labels: node name / value / % of total, inside or outside nodes, link value labels at either or both ends, level headers, font size and family
- **Auto-contrast label color** (the reason this exists) with optional text halo on link labels; can be switched to fixed colors
- Measure formatting: decimals, thousands separator, display units (K/M/auto), prefix/suffix
- Tooltips, hover/click highlighting with fade, dashboard actions on click (filter target sheets or set a parameter)

## Worksheet requirements

The extension is a **viz (worksheet) extension**: it renders on the worksheet itself and reads its fields from the Marks card encoding tiles — 2+ dimensions on **Levels** (ordered left to right, e.g. `Current Unit`, `Reading Goal`) and a measure on **Link Value** (e.g. `CNTD(Student ID)`). Fields can also be mapped manually in the configuration dialog instead.

(The code also still runs in the legacy dashboard-extension mode for workbooks that embedded the old dashboard manifest, reading a separate worksheet on the same dashboard.)

## Local preview

```bash
cd tableau-extensions/sankey-autocontrast && python3 -m http.server 8765
```

Open `http://localhost:8765/index.html?demo=1` for a self-contained demo (no Tableau needed).

## Hosting (required for Tableau Cloud)

Tableau Cloud can only load extensions from a public HTTPS URL. GitHub Pages is the zero-infrastructure option:

1. Create a **public** repo (the code is generic — no Ignite data lives in it), e.g. `Ignite-Reading/tableau-sankey-extension`.
2. Copy the contents of this folder into the repo root and push.
3. Repo Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
4. Your URL becomes `https://<org-or-user>.github.io/tableau-sankey-extension/index.html`.
5. Edit `sankey-autocontrast-viz.trex` and replace the `<url>` value with that URL.

Any other static HTTPS host (Netlify, S3 + CloudFront) works the same way.

## Tableau Cloud setup

1. **Site admin, one time:** Settings → Extensions → under "Extensions Safe List" (network-enabled extensions), add the hosted URL (`https://…/index.html`). "Allow full data access" is **not** needed; "Prompt users" is optional.
2. Open the workbook in web authoring and go to (or create) the worksheet for the sankey.
3. On the Marks card, open the mark type dropdown → **Add Extension** → choose **Access Local Extensions** and upload `sankey-autocontrast-viz.trex`.
4. Drop 2+ dimensions on the **Levels** tile (left-to-right order) and a measure on the **Link Value** tile.
5. Click **Configure…** (extension context menu ▼) to adjust Layout / Colors / Labels / Format / Interactions. Save.

## Notes and limitations

- Colors are assigned by the extension's palette and overrides; it cannot read the color assignments off the Tableau worksheet (the Extensions API does not expose them). Use the per-value overrides to pin specific values to specific colors.
- Manual node reordering persists via extension settings, which only save while authoring; viewers can drag but their order resets.
- In auto-contrast mode, the label color picker sets the *dark* candidate; the extension picks white or that color per node/link, whichever has the higher contrast ratio against the rendered color (fill composited over the background at its opacity).
