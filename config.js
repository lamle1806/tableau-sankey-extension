/* Configuration dialog for the Sankey (Auto-Contrast) extension. */
'use strict';

(function () {
  const BRAND_PALETTE = [
    '#ED017F', '#39C2D7', '#FFC854', '#27004B', '#514F9C', '#9A98CB',
    '#F18DC1', '#72CDDF', '#FAD078', '#F3CBE0', '#C7E9F0', '#FCE7C8'
  ];

  const DEFAULTS = {
    worksheet: '', levels: [], measure: '', hideNulls: true,
    nodeWidth: 18, nodePadding: 24, nodeAlign: 'justify', nodeOpacity: 100,
    nodeBorder: false, nodeBorderColor: '#3D3C3C',
    sortNodes: 'auto', sortLinks: 'auto', allowReorder: false,
    linkOpacity: 55, linkColorMode: 'gradient', linkNeutralColor: '#BBBBBB',
    colorMode: 'byValue', palette: BRAND_PALETTE.slice(), colorOverrides: {},
    background: '#FFFFFF',
    showNodeLabels: true,
    nodeLabelTemplate: '<strong><DimensionValue></strong>\n<MeasureValue>',
    labelPosition: 'inside',
    showFromLinkLabel: true, fromLinkTemplate: '<MeasureValue>',
    showToLinkLabel: true, toLinkTemplate: '<MeasureValue>',
    fontSizePct: 100,
    fontFamily: "'Roboto', 'Benton Sans', 'Segoe UI', Arial, sans-serif",
    nodeLabelColorMode: 'auto', nodeLabelColor: '#3D3C3C',
    linkLabelColorMode: 'auto', linkLabelColor: '#3D3C3C', linkLabelHalo: true,
    showHeaders: false, headerColor: '#3D3C3C',
    decimals: 0, thousands: true, displayUnits: 'none',
    numberPrefix: '', numberSuffix: '',
    tooltips: true, highlightMode: 'hover', animate: true,
    actionType: 'none', actionTargets: [], actionParameter: '',
    clearOnDeselect: true, customOrder: {}
  };

  let config = Object.assign({}, DEFAULTS);
  let VIZ_MODE = false;  // viz extension (Marks card) vs dashboard extension
  let dimensions = [];   // [{fieldName}]
  let measures = [];
  let distinctValues = {}; // fieldName -> [values]

  function getWorksheet(wsName) {
    if (VIZ_MODE) return tableau.extensions.worksheetContent.worksheet;
    return tableau.extensions.dashboardContent.dashboard.worksheets
      .find(w => w.name === wsName);
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

  const $ = id => document.getElementById(id);
  const status = msg => { $('status').textContent = msg || ''; };

  // ------------------------------------------------------------ tabs
  document.querySelectorAll('#tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'colors') renderOverrides();
    });
  });

  // ------------------------------------------------------------ field discovery
  async function loadColumns(wsName) {
    dimensions = [];
    measures = [];
    distinctValues = {};
    const ws = getWorksheet(wsName);
    if (!ws) return;
    status('Reading worksheet columns…');
    try {
      const summary = await getSummaryTable(ws);
      summary.columns.forEach(col => {
        const t = col.dataType;
        if (t === 'int' || t === 'float') measures.push(col.fieldName);
        else dimensions.push(col.fieldName);
      });
      // distinct values per dimension, for color overrides
      summary.columns.forEach((col, ci) => {
        if (col.dataType === 'int' || col.dataType === 'float') return;
        const seen = new Set();
        for (const row of summary.data) {
          const v = row[ci].value === null || row[ci].value === '%null%'
            ? '(null)' : row[ci].formattedValue;
          seen.add(v);
          if (seen.size > 200) break; // guardrail for high-cardinality fields
        }
        distinctValues[col.fieldName] = Array.from(seen).sort();
      });
      status('');
    } catch (e) {
      status('Could not read worksheet: ' + e.message);
    }
  }

  // ------------------------------------------------------------ renderers
  function option(sel, value, label, selected) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label != null ? label : value;
    if (selected) o.selected = true;
    sel.appendChild(o);
  }

  function renderWorksheets() {
    const sel = $('worksheet');
    sel.innerHTML = '';
    if (VIZ_MODE) {
      const row = sel.closest('.row');
      if (row) row.style.display = 'none';
      document.getElementById('viz-mode-hint').style.display = '';
      document.getElementById('dash-mode-hint').style.display = 'none';
      return;
    }
    option(sel, '', '— choose a worksheet —', !config.worksheet);
    tableau.extensions.dashboardContent.dashboard.worksheets.forEach(ws => {
      option(sel, ws.name, ws.name, ws.name === config.worksheet);
    });
  }

  function renderLevels() {
    const list = $('levels-list');
    list.innerHTML = '';
    if (!config.levels.length) config.levels = ['', ''];
    config.levels.forEach((lvl, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      const lab = document.createElement('label');
      lab.textContent = 'Level ' + (i + 1);
      lab.style.flex = '0 0 70px';
      const sel = document.createElement('select');
      option(sel, '', '— choose a dimension —', !lvl);
      dimensions.forEach(d => option(sel, d, d, d === lvl));
      sel.addEventListener('change', () => { config.levels[i] = sel.value; renderOverrides(); });
      const up = document.createElement('button');
      up.className = 'small'; up.textContent = '↑'; up.disabled = i === 0;
      up.addEventListener('click', () => {
        [config.levels[i - 1], config.levels[i]] = [config.levels[i], config.levels[i - 1]];
        renderLevels();
      });
      const del = document.createElement('button');
      del.className = 'small danger'; del.textContent = '✕';
      del.disabled = config.levels.length <= 2;
      del.addEventListener('click', () => { config.levels.splice(i, 1); renderLevels(); renderOverrides(); });
      row.append(lab, sel, up, del);
      list.appendChild(row);
    });
  }

  function renderMeasures() {
    const sel = $('measure');
    sel.innerHTML = '';
    option(sel, '', '— choose a measure —', !config.measure);
    measures.forEach(m => option(sel, m, m, m === config.measure));
  }

  function renderPalette() {
    const list = $('palette-list');
    list.innerHTML = '';
    config.palette.forEach((hex, i) => {
      const row = document.createElement('div');
      row.className = 'row';
      const inp = document.createElement('input');
      inp.type = 'color'; inp.value = hex;
      inp.addEventListener('input', () => { config.palette[i] = inp.value; });
      const del = document.createElement('button');
      del.className = 'small danger'; del.textContent = '✕';
      del.disabled = config.palette.length <= 1;
      del.addEventListener('click', () => { config.palette.splice(i, 1); renderPalette(); });
      const lab = document.createElement('span');
      lab.textContent = 'Color ' + (i + 1);
      row.append(inp, lab, del);
      list.appendChild(row);
    });
  }

  function overrideKeys() {
    // keys shown in the override editor, mirroring main.js color keys
    const keys = [];
    const seen = new Set();
    config.levels.forEach((fieldName, li) => {
      (distinctValues[fieldName] || []).forEach(v => {
        const k = config.colorMode === 'unique' ? li + '|' + v : v;
        if (!seen.has(k)) { seen.add(k); keys.push({ key: k, label: config.colorMode === 'unique' ? 'L' + (li + 1) + ': ' + v : v }); }
      });
    });
    return keys;
  }

  function renderOverrides() {
    const list = $('override-list');
    list.innerHTML = '';
    const keys = overrideKeys();
    if (!keys.length) {
      list.innerHTML = '<p class="hint">Pick a worksheet and level dimensions first.</p>';
      return;
    }
    keys.forEach(({ key, label }) => {
      const row = document.createElement('div');
      row.className = 'row';
      const chip = document.createElement('span');
      chip.className = 'value-chip';
      chip.textContent = label;
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = config.colorOverrides[key] || '#eaeaea';
      inp.addEventListener('input', () => { config.colorOverrides[key] = inp.value; clr.disabled = false; });
      const clr = document.createElement('button');
      clr.className = 'small'; clr.textContent = 'auto';
      clr.disabled = !config.colorOverrides[key];
      clr.title = 'Remove override, use palette assignment';
      clr.addEventListener('click', () => { delete config.colorOverrides[key]; renderOverrides(); });
      row.append(chip, inp, clr);
      list.appendChild(row);
    });
  }

  function renderActionTargets() {
    const box = $('action-targets');
    box.innerHTML = '';
    if (VIZ_MODE) return;
    tableau.extensions.dashboardContent.dashboard.worksheets.forEach(ws => {
      if (ws.name === config.worksheet) return;
      const line = document.createElement('div');
      line.className = 'checkline';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = config.actionTargets.includes(ws.name);
      cb.addEventListener('change', () => {
        if (cb.checked) config.actionTargets.push(ws.name);
        else config.actionTargets = config.actionTargets.filter(n => n !== ws.name);
      });
      const lab = document.createElement('label');
      lab.textContent = ws.name;
      line.append(cb, lab);
      box.appendChild(line);
    });
    if (!box.children.length) box.innerHTML = '<p class="hint">No other worksheets on this dashboard.</p>';
  }

  async function renderParameters() {
    const sel = $('actionParameter');
    sel.innerHTML = '';
    option(sel, '', '— choose a parameter —', !config.actionParameter);
    try {
      const scope = VIZ_MODE
        ? tableau.extensions.worksheetContent.worksheet
        : tableau.extensions.dashboardContent.dashboard;
      const params = await scope.getParametersAsync();
      params.forEach(p => option(sel, p.name, p.name, p.name === config.actionParameter));
    } catch (e) { /* noop */ }
  }

  function adaptActionOptions() {
    // viz extensions cannot filter other sheets; they select marks instead,
    // which native dashboard actions can then respond to
    if (!VIZ_MODE) return;
    const sel = $('actionType');
    const filterOpt = sel.querySelector('option[value="filter"]');
    if (filterOpt) filterOpt.remove();
    if (!sel.querySelector('option[value="select"]')) {
      const o = document.createElement('option');
      o.value = 'select';
      o.textContent = 'Select marks (drives dashboard actions)';
      sel.insertBefore(o, sel.querySelector('option[value="parameter"]'));
    }
    if (config.actionType === 'filter') config.actionType = 'none';
  }

  function toggleActionOpts() {
    $('action-filter-opts').style.display = config.actionType === 'filter' && !VIZ_MODE ? '' : 'none';
    $('action-param-opts').style.display = config.actionType === 'parameter' ? '' : 'none';
  }

  // ------------------------------------------------------------ label shortcode chips
  const NODE_SHORTCODES = ['MeasureName', 'MeasureValue', 'DimensionName', 'DimensionValue',
    'PercentageOfTotal', 'PercentageOfGroup'];
  const LINK_SHORTCODES = ['MeasureName', 'MeasureValue', 'PercentOfSource', 'SourceName',
    'PercentOfTarget', 'TargetName', 'PercentageOfTotal'];

  function renderChips() {
    document.querySelectorAll('.chips').forEach(box => {
      box.innerHTML = '';
      const codes = (box.dataset.kind === 'node' ? NODE_SHORTCODES : LINK_SHORTCODES).slice();
      if (config.measure) codes.push(config.measure); // e.g. <AGG(Number of Students)>
      const ta = $(box.dataset.target);
      codes.forEach(code => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '<' + code + '>';
        btn.addEventListener('click', () => {
          const token = '<' + code + '>';
          const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
          const end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
          ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
          config[box.dataset.target] = ta.value;
          ta.focus();
          ta.selectionStart = ta.selectionEnd = start + token.length;
        });
        box.appendChild(btn);
      });
    });
  }

  // ------------------------------------------------------------ simple bindings
  const RANGES = ['nodeWidth', 'nodePadding', 'nodeOpacity', 'linkOpacity', 'fontSizePct'];
  const SELECTS = ['nodeAlign', 'sortNodes', 'sortLinks', 'colorMode', 'linkColorMode',
    'labelPosition', 'nodeLabelColorMode', 'linkLabelColorMode',
    'displayUnits', 'highlightMode', 'actionType'];
  const CHECKS = ['hideNulls', 'nodeBorder', 'allowReorder', 'showNodeLabels',
    'showFromLinkLabel', 'showToLinkLabel', 'linkLabelHalo', 'showHeaders', 'thousands',
    'tooltips', 'animate', 'clearOnDeselect'];
  const COLORS = ['nodeBorderColor', 'linkNeutralColor', 'background', 'nodeLabelColor',
    'linkLabelColor', 'headerColor'];
  const TEXTS = ['fontFamily', 'numberPrefix', 'numberSuffix',
    'nodeLabelTemplate', 'fromLinkTemplate', 'toLinkTemplate'];
  const NUMBERS = ['decimals'];

  function pushToUi() {
    RANGES.forEach(k => { $(k).value = config[k]; $(k + '-val').textContent = config[k] + (k.includes('Opacity') || k === 'fontSizePct' ? '%' : 'px'); });
    SELECTS.forEach(k => { $(k).value = config[k]; });
    CHECKS.forEach(k => { $(k).checked = !!config[k]; });
    COLORS.forEach(k => { $(k).value = config[k]; });
    TEXTS.forEach(k => { $(k).value = config[k]; });
    NUMBERS.forEach(k => { $(k).value = config[k]; });
    toggleActionOpts();
  }

  function wireInputs() {
    RANGES.forEach(k => $(k).addEventListener('input', () => {
      config[k] = +$(k).value;
      $(k + '-val').textContent = config[k] + (k.includes('Opacity') || k === 'fontSizePct' ? '%' : 'px');
    }));
    SELECTS.forEach(k => $(k).addEventListener('change', () => {
      config[k] = $(k).value;
      if (k === 'colorMode') renderOverrides();
      if (k === 'actionType') toggleActionOpts();
    }));
    CHECKS.forEach(k => $(k).addEventListener('change', () => { config[k] = $(k).checked; }));
    COLORS.forEach(k => $(k).addEventListener('input', () => { config[k] = $(k).value; }));
    TEXTS.forEach(k => $(k).addEventListener('input', () => { config[k] = $(k).value; }));
    NUMBERS.forEach(k => $(k).addEventListener('input', () => { config[k] = +$(k).value; }));

    $('worksheet').addEventListener('change', async () => {
      config.worksheet = $('worksheet').value;
      await loadColumns(config.worksheet);
      renderLevels(); renderMeasures(); renderOverrides(); renderActionTargets();
    });
    $('add-level').addEventListener('click', () => { config.levels.push(''); renderLevels(); });
    $('measure').addEventListener('change', () => { config.measure = $('measure').value; renderChips(); });
    $('add-color').addEventListener('click', () => { config.palette.push('#999999'); renderPalette(); });
    $('reset-palette').addEventListener('click', () => { config.palette = BRAND_PALETTE.slice(); renderPalette(); });
    $('clear-order').addEventListener('click', () => { config.customOrder = {}; status('Manual node order cleared.'); });

    $('cancel').addEventListener('click', () => tableau.extensions.ui.closeDialog(''));
    $('save').addEventListener('click', async () => {
      config.levels = config.levels.filter(Boolean);
      if (VIZ_MODE) {
        // empty mapping is fine: fields then come from the Marks card encoding tiles
        if (config.levels.length || config.measure) {
          if (config.levels.length < 2) { status('Choose at least two level dimensions (or clear all to use the Marks card tiles).'); return; }
          if (new Set(config.levels).size !== config.levels.length) { status('Each level must use a different dimension.'); return; }
          if (!config.measure) { status('Choose a measure (or clear all to use the Marks card tiles).'); return; }
        }
      } else {
        if (!config.worksheet) { status('Choose a worksheet first.'); return; }
        if (config.levels.length < 2) { status('Choose at least two level dimensions.'); return; }
        if (new Set(config.levels).size !== config.levels.length) { status('Each level must use a different dimension.'); return; }
        if (!config.measure) { status('Choose a measure.'); return; }
      }
      status('Saving…');
      tableau.extensions.settings.set('config', JSON.stringify(config));
      try {
        await tableau.extensions.settings.saveAsync();
        tableau.extensions.ui.closeDialog('saved');
      } catch (e) {
        status('Save failed: ' + e.message);
      }
    });
  }

  // ------------------------------------------------------------ init
  tableau.extensions.initializeDialogAsync().then(async () => {
    VIZ_MODE = !!tableau.extensions.worksheetContent;
    const raw = tableau.extensions.settings.get('config');
    if (raw) {
      try { Object.assign(config, JSON.parse(raw)); } catch (e) { /* defaults */ }
    }
    adaptActionOptions();
    renderWorksheets();
    if (VIZ_MODE) await loadColumns('');
    else if (config.worksheet) await loadColumns(config.worksheet);
    renderLevels();
    renderMeasures();
    renderPalette();
    renderOverrides();
    renderActionTargets();
    renderParameters();
    renderChips();
    pushToUi();
    wireInputs();
  }).catch(e => {
    status('Failed to initialize dialog: ' + e.message);
  });
})();
