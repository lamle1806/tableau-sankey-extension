/* Sankey (Auto-Contrast) — Tableau dashboard extension
 * Renders a source-target sankey from a worksheet's summary data with
 * relative-luminance based auto-contrast for node and link labels.
 */
'use strict';

(function () {
  // ---------------------------------------------------------------- defaults

  const BRAND_PALETTE = [
    '#ED017F', // pink
    '#39C2D7', // blue
    '#FFC854', // yellow
    '#27004B', // dark purple
    '#514F9C', // mid purple
    '#9A98CB', // light purple
    '#F18DC1', // pink tint
    '#72CDDF', // blue tint
    '#FAD078', // yellow tint
    '#F3CBE0', // pale pink
    '#C7E9F0', // pale blue
    '#FCE7C8'  // pale yellow
  ];

  const DEFAULTS = {
    // data
    worksheet: '',
    levels: [],                 // ordered dimension field names
    measure: '',                // numeric field name
    hideNulls: true,
    // layout / nodes
    nodeWidth: 90,
    nodePadding: 24,
    nodeHPadding: 0,            // horizontal gap between nodes and link ends
    nodeAlign: 'justify',       // justify | left | right | center
    nodeOpacity: 100,           // 0-100
    nodeBorder: false,
    nodeBorderColor: '#3D3C3C',
    sortNodes: 'auto',          // auto | data | custom | desc | asc | alpha
    sortLinks: 'auto',          // auto | data | desc | asc
    valueOrder: {},             // fieldName -> ordered array of values (custom sort)
    allowReorder: false,        // drag nodes vertically
    // links
    linkOpacity: 55,            // 0-100
    linkColorMode: 'gradient',  // gradient | input | output | none
    linkNeutralColor: '#BBBBBB',
    // colors
    colorMode: 'byValue',       // byValue (same value = same color) | unique
    palette: BRAND_PALETTE,
    colorOverrides: {},         // value (or level|value in unique mode) -> hex
    background: '#FFFFFF',
    // labels (templates support shortcodes like <DimensionValue> and <strong> tags)
    showNodeLabels: true,
    nodeLabelTemplate: '<strong><DimensionValue></strong>\n<MeasureValue>',
    labelPosition: 'inside',    // inside | outside
    showFromLinkLabel: true,
    fromLinkTemplate: '<MeasureValue>',
    showToLinkLabel: true,
    toLinkTemplate: '<MeasureValue>',
    fontSizePct: 100,           // 50-150
    fontFamily: "'Roboto', 'Benton Sans', 'Segoe UI', Arial, sans-serif",
    nodeLabelColorMode: 'auto', // auto | fixed
    nodeLabelColor: '#3D3C3C',  // fixed color; in auto mode this is the dark candidate
    linkLabelColorMode: 'auto',
    linkLabelColor: '#3D3C3C',
    linkLabelHalo: true,
    showHeaders: false,
    headerColor: '#3D3C3C',
    // measure formatting
    decimals: 0,
    thousands: true,
    displayUnits: 'none',       // none | K | M | auto
    numberPrefix: '',
    numberSuffix: '',           // numeric decoration on every <MeasureValue>, e.g. " pts"
    // tooltips
    tooltips: true,
    nodeTooltipTemplate: '<DimensionName>: <strong><DimensionValue></strong>\n<MeasureName>: <MeasureValue>',
    linkTooltipTemplate: '<MeasureName>: <MeasureValue>\n<PercentOfSource> of <SourceName> to <PercentOfTarget> of <TargetName>',
    // interactions
    highlightMode: 'hover',     // hover | click | off
    animate: true,
    actionType: 'none',         // none | filter | parameter
    actionTargets: [],          // worksheet names to filter
    actionParameter: '',
    clearOnDeselect: true,
    // manual node order (persisted by drag-reorder)
    customOrder: {}             // node id -> index within its level
  };

  const DEMO_MODE = new URLSearchParams(location.search).has('demo');
  let VIZ_MODE = false;         // true when running as a viz extension (Marks card)

  let config = Object.assign({}, DEFAULTS);
  let rows = [];                // [{levels: [v1, v2, ...], value: n}]
  let levelCaptions = [];       // effective level field names, left to right
  let measureCaption = '';      // effective measure field name
  let stickyKey = null;         // sticky highlight (click mode)
  let appliedFilters = [];      // [{wsName, fieldName}]
  let renderPending = null;

  const chartEl = document.getElementById('chart');
  const tooltipEl = document.getElementById('tooltip');
  const placeholderEl = document.getElementById('placeholder');
  const phMessageEl = document.getElementById('ph-message');
  const phButton = document.getElementById('ph-configure');

  // ---------------------------------------------------------------- helpers

  function parseHex(hex) {
    let h = (hex || '#000000').replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function toHex(rgb) {
    const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + c(rgb.r) + c(rgb.g) + c(rgb.b);
  }

  // WCAG relative luminance
  function relLuminance(hex) {
    const { r, g, b } = parseHex(hex);
    const f = v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  function contrastRatio(hexA, hexB) {
    const la = relLuminance(hexA);
    const lb = relLuminance(hexB);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  }

  // pick the better of white / dark candidate against a background color
  function autoTextColor(bgHex, darkCandidate) {
    const dark = darkCandidate || '#3D3C3C';
    return contrastRatio(bgHex, '#FFFFFF') >= contrastRatio(bgHex, dark) ? '#FFFFFF' : dark;
  }

  // color as it actually appears: fill at opacity composited over the page background
  function effectiveColor(hex, opacityPct, bgHex) {
    const a = Math.max(0, Math.min(100, opacityPct)) / 100;
    const c = parseHex(hex);
    const b = parseHex(bgHex || '#FFFFFF');
    return toHex({
      r: c.r * a + b.r * (1 - a),
      g: c.g * a + b.g * (1 - a),
      b: c.b * a + b.b * (1 - a)
    });
  }

  function fmtNumber(v) {
    let x = v;
    let unit = '';
    if (config.displayUnits === 'K') { x = v / 1e3; unit = 'K'; }
    else if (config.displayUnits === 'M') { x = v / 1e6; unit = 'M'; }
    else if (config.displayUnits === 'auto') {
      if (Math.abs(v) >= 1e6) { x = v / 1e6; unit = 'M'; }
      else if (Math.abs(v) >= 1e4) { x = v / 1e3; unit = 'K'; }
    }
    const s = x.toLocaleString('en-US', {
      minimumFractionDigits: config.decimals,
      maximumFractionDigits: config.decimals,
      useGrouping: !!config.thousands
    });
    return config.numberPrefix + s + unit + config.numberSuffix;
  }

  function fmtPercent(share) {
    return (share * 100).toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1
    }) + '%';
  }

  // template renderer: shortcodes like <DimensionValue>, <strong>/</strong> for bold,
  // newlines for multi-line labels. Unknown tags render literally.
  // Returns an array of lines; each line is an array of {text, bold} spans.
  function renderTemplate(tpl, vars) {
    return String(tpl == null ? '' : tpl).split('\n').map(function (line) {
      const spans = [];
      let bold = false;
      line.split(/(<\/?strong>|<[^<>]+>)/g).forEach(function (part) {
        if (!part) return;
        if (part === '<strong>') { bold = true; return; }
        if (part === '</strong>') { bold = false; return; }
        const m = /^<([^<>]+)>$/.exec(part);
        if (m && Object.prototype.hasOwnProperty.call(vars, m[1])) {
          spans.push({ text: String(vars[m[1]]), bold: bold });
          return;
        }
        spans.push({ text: part, bold: bold });
      });
      return spans;
    }).filter(function (spans) {
      return spans.some(function (s) { return s.text.trim() !== ''; });
    });
  }

  // append rendered template lines as SVG text elements
  function drawTemplateText(parent, lines, opts) {
    // opts: {x, yStart, lineH, anchor, fontSize, fill, halo, haloWidth, className}
    lines.forEach(function (spans, li) {
      const t = parent.append('text')
        .attr('class', opts.className + (opts.halo ? ' halo' : ''))
        .attr('x', opts.x)
        .attr('y', opts.yStart + li * opts.lineH)
        .attr('text-anchor', opts.anchor)
        .attr('font-size', opts.fontSize + 'px')
        .attr('fill', opts.fill);
      if (opts.halo) t.attr('stroke', opts.halo).attr('stroke-width', opts.haloWidth);
      spans.forEach(function (s) {
        t.append('tspan')
          .attr('font-weight', s.bold ? 700 : 400)
          .text(s.text);
      });
      if (opts.datum !== undefined) t.datum(opts.datum);
    });
  }

  function showPlaceholder(msg, showButton) {
    phMessageEl.textContent = msg;
    phButton.classList.toggle('hidden', !showButton);
    placeholderEl.classList.remove('hidden');
    chartEl.classList.add('hidden');
  }

  function hidePlaceholder() {
    placeholderEl.classList.add('hidden');
    chartEl.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- settings

  function readSettings() {
    const raw = tableau.extensions.settings.get('config');
    config = Object.assign({}, DEFAULTS);
    if (raw) {
      try { Object.assign(config, JSON.parse(raw)); } catch (e) { /* keep defaults */ }
    }
  }

  function saveCustomOrder(order) {
    config.customOrder = order;
    try {
      tableau.extensions.settings.set('config', JSON.stringify(config));
      tableau.extensions.settings.saveAsync().catch(() => { /* viewer mode: not persisted */ });
    } catch (e) { /* viewer mode */ }
  }

  // ---------------------------------------------------------------- data

  function getWorksheet() {
    if (VIZ_MODE) return tableau.extensions.worksheetContent.worksheet;
    return tableau.extensions.dashboardContent.dashboard.worksheets
      .find(w => w.name === config.worksheet);
  }

  async function getSummaryTable(ws) {
    if (typeof ws.getSummaryDataReaderAsync === 'function') {
      const reader = await ws.getSummaryDataReaderAsync(undefined, { ignoreSelection: true });
      const table = await reader.getAllPagesAsync();
      await reader.releaseAsync();
      return table;
    }
    return ws.getSummaryDataAsync({ ignoreSelection: true });
  }

  // viz mode: read field mapping from the Levels / Link Value encoding tiles
  async function encodedFields(ws) {
    try {
      const spec = await ws.getVisualSpecificationAsync();
      const marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
      if (!marks) return null;
      const levels = marks.encodings.filter(e => e.id === 'level').map(e => e.field.name);
      const size = marks.encodings.find(e => e.id === 'size');
      if (levels.length >= 2 && size) return { levels: levels, measure: size.field.name };
      return null;
    } catch (e) {
      return null;
    }
  }

  async function loadData() {
    const ws = getWorksheet();
    if (!ws) {
      showPlaceholder('Worksheet "' + config.worksheet + '" was not found on this dashboard. ' +
        'The source worksheet must be on the dashboard (it can be hidden behind other objects).', true);
      return false;
    }

    let levels = config.levels;
    let measure = config.measure;
    if (VIZ_MODE) {
      const enc = await encodedFields(ws);
      if (enc) { levels = enc.levels; measure = enc.measure; }
    }
    if (levels.length < 2 || !measure) {
      showPlaceholder('Drop at least two dimensions on the Levels tile and a measure on the Link Value tile of the Marks card (or map fields manually in the configuration).', true);
      return false;
    }

    const summary = await getSummaryTable(ws);
    const cols = summary.columns;

    const levelIdx = levels.map(name => cols.findIndex(c => c.fieldName === name));
    const measureIdx = cols.findIndex(c => c.fieldName === measure);
    if (levelIdx.some(i => i < 0) || measureIdx < 0) {
      showPlaceholder('Configured fields were not found on the worksheet. Re-check the encoding tiles or re-select the fields in the configuration.', true);
      return false;
    }

    levelCaptions = levels.slice();
    measureCaption = measure;
    rows = [];
    for (const row of summary.data) {
      const levels = levelIdx.map(i => {
        const dv = row[i];
        return (dv.value === null || dv.value === '%null%') ? null : dv.formattedValue;
      });
      if (config.hideNulls && levels.some(v => v === null)) continue;
      const value = Number(row[measureIdx].value);
      if (!isFinite(value) || value === 0) continue;
      rows.push({ levels: levels.map(v => v === null ? '(null)' : v), value: value });
    }
    return true;
  }

  function loadDemoData() {
    // roughly mirrors the "Current Unit to Reading Goal" example
    const demo = [
      ['1st', 'EAR', 'EAR', 6], ['1st', 'EAR', 'ULS', 1],
      ['2nd', 'ULS', 'B+D', 3], ['2nd', 'ULS', 'ULS', 1], ['2nd', 'EAR', 'EAR', 1],
      ['3rd', 'ULP', 'VCE', 2], ['3rd', 'B+D', 'B+D', 1], ['3rd', 'ULS', 'VCE', 1],
      ['4th', 'ULS', 'B+D', 2], ['4th', 'B+D', 'VCE', 2], ['4th', 'ULP', '2nd', 1], ['4th', 'EAR', 'ULS', 1],
      ['5th', 'B+D', '2nd', 2], ['5th', 'ULS', '3rd', 2], ['5th', 'EAR', 'EAR', 1], ['5th', 'VCE', '3rd', 1]
    ];
    levelCaptions = ['Current Unit', 'Current Skill', 'Reading Goal'];
    measureCaption = 'AGG(Number of Students)';
    rows = demo.map(d => ({ levels: [d[0], d[1], d[2]], value: d[3] }));
    config.nodeLabelTemplate = '<strong><DimensionValue></strong>\n<MeasureValue> students';
    config.showHeaders = true;
  }

  // ---------------------------------------------------------------- graph

  function buildGraph() {
    const nodeIndex = new Map();  // id -> node
    const linkIndex = new Map();  // key -> link
    const nodes = [];
    const links = [];

    function getNode(level, name) {
      const id = level + '|' + name;
      if (!nodeIndex.has(id)) {
        const node = { id: id, name: name, level: level };
        nodeIndex.set(id, node);
        nodes.push(node);
      }
      return nodeIndex.get(id);
    }

    for (const row of rows) {
      for (let i = 0; i < row.levels.length - 1; i++) {
        const s = getNode(i, row.levels[i]);
        const t = getNode(i + 1, row.levels[i + 1]);
        const key = s.id + '>>' + t.id;
        if (!linkIndex.has(key)) {
          const link = { source: s.id, target: t.id, value: 0 };
          linkIndex.set(key, link);
          links.push(link);
        }
        linkIndex.get(key).value += row.value;
      }
    }
    const grandTotal = rows.reduce((a, r) => a + r.value, 0);
    return { nodes: nodes, links: links, grandTotal: grandTotal };
  }

  // stable color assignment: distinct keys in first-appearance order
  function buildColorScale(nodes) {
    const assigned = new Map();
    let i = 0;
    const keyOf = n => config.colorMode === 'unique' ? n.id : n.name;
    for (const n of nodes) {
      const k = keyOf(n);
      if (!assigned.has(k)) {
        assigned.set(k, config.palette[i % config.palette.length]);
        i++;
      }
    }
    return function (node) {
      const k = keyOf(node);
      if (config.colorOverrides && config.colorOverrides[k]) return config.colorOverrides[k];
      return assigned.get(k) || '#999999';
    };
  }

  // ---------------------------------------------------------------- render

  function scheduleRender() {
    if (renderPending) cancelAnimationFrame(renderPending);
    renderPending = requestAnimationFrame(() => { renderPending = null; render(); });
  }

  function render() {
    d3.select(chartEl).selectAll('*').interrupt();
    stickyKey = null;
    chartEl.innerHTML = '';
    if (!rows.length) {
      showPlaceholder('No data rows to plot. Check worksheet filters, null handling, and the configured fields.', true);
      return;
    }
    hidePlaceholder();
    document.body.style.background = config.background;

    const width = chartEl.clientWidth || 600;
    const height = chartEl.clientHeight || 400;
    const fontScale = config.fontSizePct / 100;
    const baseFont = 12 * fontScale;
    const headerSpace = config.showHeaders ? Math.round(22 * fontScale) : 0;
    const margin = { top: 2 + headerSpace, right: 2, bottom: 2, left: 2 };
    // outside labels need horizontal room
    const outsidePad = config.labelPosition === 'outside' ? Math.round(120 * fontScale) : 0;
    margin.left += outsidePad;
    margin.right += outsidePad;

    const graph = buildGraph();
    const colorOf = buildColorScale(graph.nodes);

    const align = {
      justify: d3.sankeyJustify, left: d3.sankeyLeft,
      right: d3.sankeyRight, center: d3.sankeyCenter
    }[config.nodeAlign] || d3.sankeyJustify;

    const sankey = d3.sankey()
      .nodeId(d => d.id)
      .nodeWidth(+config.nodeWidth)
      .nodePadding(+config.nodePadding)
      .nodeAlign(align)
      .extent([[margin.left, margin.top], [width - margin.right, height - margin.bottom]])
      .iterations(32);

    // node sorting
    const hasCustom = config.allowReorder && config.customOrder && Object.keys(config.customOrder).length;
    if (hasCustom) {
      sankey.nodeSort((a, b) => {
        const ia = config.customOrder[a.id], ib = config.customOrder[b.id];
        if (ia != null && ib != null) return ia - ib;
        return 0;
      });
    } else if (config.sortNodes === 'data') {
      // Tableau returns summary rows in reverse of the worksheet's field sort,
      // so reverse insertion order (node.index) to match the displayed sort
      sankey.nodeSort((a, b) => b.index - a.index);
    } else if (config.sortNodes === 'custom') {
      // order each level by the user-defined value list; unlisted values keep data order
      sankey.nodeSort((a, b) => {
        const order = (config.valueOrder && config.valueOrder[levelCaptions[a.level]]) || [];
        const ia = order.indexOf(a.name), ib = order.indexOf(b.name);
        const ra = ia < 0 ? Infinity : ia, rb = ib < 0 ? Infinity : ib;
        if (ra === rb) return b.index - a.index; // both unlisted: data order (see above)
        return ra - rb;
      });
    } else if (config.sortNodes === 'desc') {
      sankey.nodeSort((a, b) => b.value - a.value);
    } else if (config.sortNodes === 'asc') {
      sankey.nodeSort((a, b) => a.value - b.value);
    } else if (config.sortNodes === 'alpha') {
      sankey.nodeSort((a, b) => d3.ascending(a.name, b.name));
    } // 'auto' -> d3 default (crossing minimization)

    if (config.sortLinks === 'data') sankey.linkSort((a, b) => b.index - a.index); // reversed: see nodeSort 'data'
    else if (config.sortLinks === 'desc') sankey.linkSort((a, b) => b.value - a.value);
    else if (config.sortLinks === 'asc') sankey.linkSort((a, b) => a.value - b.value);

    let laid;
    try {
      laid = sankey({
        nodes: graph.nodes.map(d => Object.assign({}, d)),
        links: graph.links.map(d => Object.assign({}, d))
      });
    } catch (e) {
      showPlaceholder('Could not compute the sankey layout: ' + e.message, true);
      return;
    }

    const svg = d3.select(chartEl).append('svg')
      .attr('width', width)
      .attr('height', height)
      .style('font-family', config.fontFamily)
      .style('background', config.background);

    const defs = svg.append('defs');
    const nodeOpacity = config.nodeOpacity / 100;
    const linkOpacity = config.linkOpacity / 100;

    // ---- links
    function linkBaseColor(link, end) {
      // end: 'source' | 'target' — color of the link where the label sits
      if (config.linkColorMode === 'none') return config.linkNeutralColor;
      if (config.linkColorMode === 'input') return colorOf(link.source);
      if (config.linkColorMode === 'output') return colorOf(link.target);
      return end === 'target' ? colorOf(link.target) : colorOf(link.source); // gradient
    }

    const hpad = Math.max(0, +config.nodeHPadding || 0);
    const linkGen = d3.sankeyLinkHorizontal()
      .source(d => [d.source.x1 + hpad, d.y0])
      .target(d => [d.target.x0 - hpad, d.y1]);

    const linkG = svg.append('g').attr('fill', 'none');
    const linkSel = linkG.selectAll('path')
      .data(laid.links)
      .join('path')
      .attr('class', 'sankey-link')
      .attr('d', linkGen)
      .attr('stroke-width', d => Math.max(1, d.width))
      .attr('stroke-opacity', linkOpacity)
      .attr('stroke', (d, i) => {
        if (config.linkColorMode === 'gradient') {
          const gid = 'grad-' + i;
          const grad = defs.append('linearGradient')
            .attr('id', gid)
            .attr('gradientUnits', 'userSpaceOnUse')
            .attr('x1', d.source.x1 + hpad).attr('x2', d.target.x0 - hpad);
          grad.append('stop').attr('offset', '0%').attr('stop-color', colorOf(d.source));
          grad.append('stop').attr('offset', '100%').attr('stop-color', colorOf(d.target));
          return 'url(#' + gid + ')';
        }
        return linkBaseColor(d);
      });

    // ---- nodes
    const nodeG = svg.append('g');
    const nodeSel = nodeG.selectAll('g')
      .data(laid.nodes)
      .join('g')
      .attr('class', 'sankey-node' + (config.allowReorder ? ' draggable' : ''))
      .attr('opacity', 1);

    nodeSel.append('rect')
      .attr('x', d => d.x0)
      .attr('y', d => d.y0)
      .attr('width', d => d.x1 - d.x0)
      .attr('height', d => Math.max(1, d.y1 - d.y0))
      .attr('fill', d => colorOf(d))
      .attr('fill-opacity', nodeOpacity)
      .attr('stroke', config.nodeBorder ? config.nodeBorderColor : 'none')
      .attr('stroke-width', config.nodeBorder ? 1 : 0);

    // ---- labels
    const lineH = Math.round(baseFont * 1.25);
    const levelTotals = {};
    laid.nodes.forEach(function (n) {
      levelTotals[n.level] = (levelTotals[n.level] || 0) + n.value;
    });

    function nodeVars(d) {
      const vars = {
        MeasureName: measureCaption,
        MeasureValue: fmtNumber(d.value),
        DimensionName: levelCaptions[d.level] || '',
        DimensionValue: d.name,
        PercentageOfTotal: fmtPercent(d.value / graph.grandTotal),
        PercentageOfGroup: fmtPercent(d.value / (levelTotals[d.level] || graph.grandTotal))
      };
      vars[measureCaption] = vars.MeasureValue; // e.g. <AGG(Number of Students)>
      return vars;
    }

    function linkVars(l) {
      const vars = {
        MeasureName: measureCaption,
        MeasureValue: fmtNumber(l.value),
        SourceName: l.source.name,
        TargetName: l.target.name,
        PercentOfSource: fmtPercent(l.value / l.source.value),
        PercentOfTarget: fmtPercent(l.value / l.target.value),
        PercentageOfTotal: fmtPercent(l.value / graph.grandTotal)
      };
      vars[measureCaption] = vars.MeasureValue;
      return vars;
    }

    function nodeLabelColor(d) {
      if (config.labelPosition === 'outside') {
        return config.nodeLabelColorMode === 'auto'
          ? autoTextColor(config.background, config.nodeLabelColor)
          : config.nodeLabelColor;
      }
      if (config.nodeLabelColorMode === 'fixed') return config.nodeLabelColor;
      const eff = effectiveColor(colorOf(d), config.nodeOpacity, config.background);
      return autoTextColor(eff, config.nodeLabelColor);
    }

    if (config.showNodeLabels) {
      nodeSel.each(function (d) {
        const g = d3.select(this);
        const h = d.y1 - d.y0;
        const lines = renderTemplate(config.nodeLabelTemplate, nodeVars(d));

        const inside = config.labelPosition === 'inside';
        const fits = inside ? Math.max(0, Math.floor((h - 4) / lineH)) : lines.length;
        const shown = lines.slice(0, fits);
        if (!shown.length) return;

        let x, anchor, placedOutside = !inside;
        if (inside) {
          x = d.x0 + 5 * fontScale;
          anchor = 'start';
          // if the node is too narrow for inside text, fall back to outside placement
          if ((d.x1 - d.x0) < baseFont * 2.2) {
            placedOutside = true;
          }
        }
        if (placedOutside) {
          x = d.x0 < width / 2 ? d.x1 + 5 : d.x0 - 5;
          anchor = d.x0 < width / 2 ? 'start' : 'end';
        }
        const color = placedOutside
          ? (config.nodeLabelColorMode === 'auto'
            ? autoTextColor(config.background, config.nodeLabelColor)
            : config.nodeLabelColor)
          : nodeLabelColor(d);
        const yStart = inside
          ? d.y0 + baseFont + 2
          : (d.y0 + d.y1) / 2 - ((shown.length - 1) * lineH) / 2 + baseFont / 2 - 1;

        drawTemplateText(g, shown, {
          x: x, yStart: yStart, lineH: lineH, anchor: anchor,
          fontSize: baseFont, fill: color, className: 'node-label'
        });
      });
    }

    // ---- link end labels
    let linkLabelSel = null;
    if (config.showFromLinkLabel || config.showToLinkLabel) {
      const linkLabelG = svg.append('g');
      laid.links.forEach(function (l) {
        if (l.width < baseFont * 0.85) return; // too thin to label legibly
        const ends = [];
        if (config.showFromLinkLabel) ends.push('source');
        if (config.showToLinkLabel) ends.push('target');
        ends.forEach(function (end) {
          const isSource = end === 'source';
          const tpl = isSource ? config.fromLinkTemplate : config.toLinkTemplate;
          const lines = renderTemplate(tpl, linkVars(l));
          if (!lines.length) return;
          const x = isSource ? l.source.x1 + hpad + 4 : l.target.x0 - hpad - 4;
          const yMid = (isSource ? l.y0 : l.y1) + baseFont / 2 - 1.5;
          const yStart = yMid - ((lines.length - 1) * lineH) / 2;
          let fill, halo;
          if (config.linkLabelColorMode === 'fixed') {
            fill = config.linkLabelColor;
            halo = config.linkLabelHalo ? autoTextColor(fill, '#3D3C3C') : null;
          } else {
            const eff = effectiveColor(linkBaseColor(l, end), config.linkOpacity, config.background);
            fill = autoTextColor(eff, config.linkLabelColor);
            halo = config.linkLabelHalo
              ? (fill === '#FFFFFF' ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.8)')
              : null;
          }
          drawTemplateText(linkLabelG, lines, {
            x: x, yStart: yStart, lineH: lineH, anchor: isSource ? 'start' : 'end',
            fontSize: baseFont, fill: fill, halo: halo, haloWidth: 2.5 * fontScale,
            className: 'link-label', datum: l
          });
        });
      });
      linkLabelSel = linkLabelG.selectAll('text').attr('opacity', 1);
    }

    // ---- level headers
    if (config.showHeaders) {
      const byLevel = d3.group(laid.nodes, d => d.level);
      const maxLevel = d3.max(laid.nodes, d => d.level);
      byLevel.forEach(function (nodesAtLevel, level) {
        const x0 = d3.min(nodesAtLevel, n => n.x0);
        const x1 = d3.max(nodesAtLevel, n => n.x1);
        const anchor = level === 0 ? 'start' : (level === maxLevel ? 'end' : 'middle');
        const hx = level === 0 ? x0 : (level === maxLevel ? x1 : (x0 + x1) / 2);
        svg.append('text')
          .attr('class', 'level-header')
          .attr('x', hx)
          .attr('y', Math.max(baseFont, margin.top - 8))
          .attr('text-anchor', anchor)
          .attr('font-size', (baseFont * 1.05) + 'px')
          .attr('font-weight', 700)
          .attr('fill', config.headerColor)
          .text(levelCaptions[level] || '');
      });
    }

    // ---- highlight
    const dur = config.animate ? 150 : 0;

    function setHighlight(predicate) {
      linkSel.transition().duration(dur)
        .attr('stroke-opacity', d => (!predicate || predicate(d)) ? Math.min(1, linkOpacity + 0.25) : linkOpacity * 0.18);
      if (linkLabelSel) {
        linkLabelSel.transition().duration(dur)
          .attr('opacity', d => (!predicate || predicate(d)) ? 1 : 0.15);
      }
      nodeSel.transition().duration(dur)
        .attr('opacity', d => {
          if (!predicate) return 1;
          const touched = laid.links.some(l => predicate(l) && (l.source === d || l.target === d));
          return touched ? 1 : 0.3;
        });
    }

    function clearHighlight() { setHighlight(null); }

    const highlightOn = config.highlightMode !== 'off';
    const hoverEnabled = config.highlightMode === 'hover';

    function nodePredicate(d) { return l => l.source === d || l.target === d; }
    function linkPredicate(d) { return l => l === d; }

    // ---- tooltips
    function showTip(html, evt) {
      if (!config.tooltips || !html) return;
      tooltipEl.innerHTML = html;
      tooltipEl.classList.remove('hidden');
      moveTip(evt);
    }
    function moveTip(evt) {
      if (tooltipEl.classList.contains('hidden')) return;
      const pad = 12;
      let x = evt.clientX + pad, y = evt.clientY + pad;
      const r = tooltipEl.getBoundingClientRect();
      if (x + r.width > window.innerWidth) x = evt.clientX - r.width - pad;
      if (y + r.height > window.innerHeight) y = evt.clientY - r.height - pad;
      tooltipEl.style.left = x + 'px';
      tooltipEl.style.top = y + 'px';
    }
    function hideTip() { tooltipEl.classList.add('hidden'); }

    function templateHtml(tpl, vars) {
      return renderTemplate(tpl, vars).map(spans =>
        spans.map(s => s.bold ? '<strong>' + escapeHtml(s.text) + '</strong>' : escapeHtml(s.text)).join('')
      ).join('<br>');
    }
    function nodeTipHtml(d) { return templateHtml(config.nodeTooltipTemplate, nodeVars(d)); }
    function linkTipHtml(d) { return templateHtml(config.linkTooltipTemplate, linkVars(d)); }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    }

    // ---- dashboard actions
    async function runAction(fields) {
      // fields: [{fieldName, value}]
      if (DEMO_MODE || config.actionType === 'none') return;
      try {
        if (config.actionType === 'select' && VIZ_MODE) {
          const ws = getWorksheet();
          await ws.selectMarksByValueAsync(
            fields.map(f => ({ fieldName: f.fieldName, value: [f.value] })),
            tableau.SelectionUpdateType.Replace);
        } else if (config.actionType === 'filter' && !VIZ_MODE) {
          const dashboard = tableau.extensions.dashboardContent.dashboard;
          for (const wsName of config.actionTargets) {
            const ws = dashboard.worksheets.find(w => w.name === wsName);
            if (!ws) continue;
            for (const f of fields) {
              await ws.applyFilterAsync(f.fieldName, [f.value], tableau.FilterUpdateType.Replace, {});
              appliedFilters.push({ wsName: wsName, fieldName: f.fieldName });
            }
          }
        } else if (config.actionType === 'parameter' && config.actionParameter) {
          const scope = VIZ_MODE ? getWorksheet() : tableau.extensions.dashboardContent.dashboard;
          const p = await scope.findParameterAsync(config.actionParameter);
          if (p) await p.changeValueAsync(fields[0].value);
        }
      } catch (e) { console.warn('action failed', e); }
    }

    async function clearAction() {
      if (DEMO_MODE || !config.clearOnDeselect) return;
      if (config.actionType === 'select' && VIZ_MODE) {
        try { await getWorksheet().clearSelectedMarksAsync(); } catch (e) { /* noop */ }
        return;
      }
      if (config.actionType !== 'filter' || VIZ_MODE) return;
      try {
        const dashboard = tableau.extensions.dashboardContent.dashboard;
        const seen = new Set();
        for (const f of appliedFilters) {
          const key = f.wsName + '|' + f.fieldName;
          if (seen.has(key)) continue;
          seen.add(key);
          const ws = dashboard.worksheets.find(w => w.name === f.wsName);
          if (ws) await ws.clearFilterAsync(f.fieldName).catch(() => {});
        }
      } catch (e) { /* noop */ }
      appliedFilters = [];
    }

    // ---- event wiring
    nodeSel
      .on('mousemove', function (evt, d) {
        moveTip(evt);
        if (hoverEnabled && highlightOn && !stickyKey) setHighlight(nodePredicate(d));
      })
      .on('mouseenter', function (evt, d) {
        showTip(nodeTipHtml(d), evt);
        if (hoverEnabled && highlightOn && !stickyKey) setHighlight(nodePredicate(d));
      })
      .on('mouseleave', function () {
        hideTip();
        if (hoverEnabled && highlightOn && !stickyKey) clearHighlight();
      })
      .on('click', function (evt, d) {
        evt.stopPropagation();
        if (highlightOn) {
          if (stickyKey === d.id) {
            stickyKey = null; clearHighlight(); clearAction();
            return;
          }
          stickyKey = d.id;
          setHighlight(nodePredicate(d));
        }
        runAction([{ fieldName: levelCaptions[d.level], value: d.name }]);
      });

    linkSel
      .on('mousemove', moveTip)
      .on('mouseenter', function (evt, d) {
        showTip(linkTipHtml(d), evt);
        if (hoverEnabled && highlightOn && !stickyKey) setHighlight(linkPredicate(d));
      })
      .on('mouseleave', function () {
        hideTip();
        if (hoverEnabled && highlightOn && !stickyKey) clearHighlight();
      })
      .on('click', function (evt, d) {
        evt.stopPropagation();
        const key = d.source.id + '>>' + d.target.id;
        if (highlightOn) {
          if (stickyKey === key) {
            stickyKey = null; clearHighlight(); clearAction();
            return;
          }
          stickyKey = key;
          setHighlight(linkPredicate(d));
        }
        runAction([
          { fieldName: levelCaptions[d.source.level], value: d.source.name },
          { fieldName: levelCaptions[d.target.level], value: d.target.name }
        ]);
      });

    svg.on('click', function () {
      if (stickyKey) { stickyKey = null; clearHighlight(); clearAction(); }
    });

    // ---- manual drag-reorder
    if (config.allowReorder) {
      nodeSel.call(d3.drag()
        .on('drag', function (evt, d) {
          const h = d.y1 - d.y0;
          d.y0 = Math.max(margin.top, Math.min(height - margin.bottom - h, evt.y - h / 2));
          d.y1 = d.y0 + h;
          d3.select(this).select('rect').attr('y', d.y0).attr('height', Math.max(1, h));
          sankey.update(laid);
          linkSel.attr('d', linkGen);
        })
        .on('end', function () {
          // persist per-level vertical order, then re-render cleanly
          const order = {};
          d3.group(laid.nodes, n => n.level).forEach(nodesAtLevel => {
            nodesAtLevel.slice().sort((a, b) => a.y0 - b.y0)
              .forEach((n, i) => { order[n.id] = i; });
          });
          saveCustomOrder(order);
          scheduleRender();
        }));
    }
  }

  // ---------------------------------------------------------------- refresh

  async function refresh() {
    readSettings();
    if (!VIZ_MODE && (!config.worksheet || config.levels.length < 2 || !config.measure)) {
      showPlaceholder('Open the configuration to choose a worksheet, at least two level dimensions, and a measure.', true);
      return;
    }
    try {
      const ok = await loadData();
      if (ok) render();
    } catch (e) {
      showPlaceholder('Failed to load data: ' + e.message, true);
    }
  }

  function openConfig() {
    const url = new URL('config.html', window.location.href).toString();
    tableau.extensions.ui.displayDialogAsync(url, '', { width: 560, height: 680 })
      .then(refresh)
      .catch(err => {
        // DialogClosedByUser is normal; anything else re-reads settings anyway
        if (!err || err.errorCode !== tableau.ErrorCodes.DialogClosedByUser) refresh();
      });
  }

  // ---------------------------------------------------------------- init

  function wireWorksheetEvents() {
    const sheets = VIZ_MODE
      ? [tableau.extensions.worksheetContent.worksheet]
      : tableau.extensions.dashboardContent.dashboard.worksheets;
    sheets.forEach(ws => {
      if (tableau.TableauEventType.SummaryDataChanged) {
        try { ws.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh); } catch (e) { /* older API */ }
      }
      try { ws.addEventListener(tableau.TableauEventType.FilterChanged, refresh); } catch (e) { /* noop */ }
    });
  }

  // authoring-mode gear button so the configuration is always reachable in viz mode
  function addConfigButton() {
    try {
      if (tableau.extensions.environment.mode !== 'authoring') return;
    } catch (e) { return; }
    const btn = document.createElement('button');
    btn.id = 'gear';
    btn.title = 'Configure Sankey (Auto-Contrast)';
    btn.textContent = '⚙';
    btn.style.cssText = 'position:absolute;top:4px;right:4px;z-index:6;width:26px;height:26px;' +
      'border:1px solid #ccc;border-radius:50%;background:rgba(255,255,255,0.9);cursor:pointer;' +
      'font-size:14px;line-height:1;color:#3d3c3c;';
    btn.addEventListener('click', openConfig);
    document.getElementById('root').appendChild(btn);
  }

  if (DEMO_MODE) {
    loadDemoData();
    // demo tweaks so both label modes are visible
    hidePlaceholder();
    render();
    window.addEventListener('resize', scheduleRender);
    new ResizeObserver(scheduleRender).observe(chartEl);
    window.__sankeyDemo = {
      setConfig: function (patch) { Object.assign(config, patch); render(); },
      getConfig: function () { return config; }
    };
  } else {
    tableau.extensions.initializeAsync({ configure: openConfig }).then(function () {
      VIZ_MODE = !!tableau.extensions.worksheetContent;
      phButton.addEventListener('click', openConfig);
      addConfigButton();
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged, refresh);
      wireWorksheetEvents();
      window.addEventListener('resize', scheduleRender);
      new ResizeObserver(scheduleRender).observe(chartEl);
      refresh();
    }).catch(function (e) {
      showPlaceholder('Failed to initialize the Tableau Extensions API: ' + e.message +
        '. Add ?demo=1 to the URL to preview outside Tableau.', false);
    });
  }
})();
