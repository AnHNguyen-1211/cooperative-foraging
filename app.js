'use strict';

const $ = id => document.getElementById(id);
const I = Scudem, II = ScudemII, Study = ScudemStudy;
const colors = ['#098787', '#8963bd'];
const names = { search: 'Search', pursue: 'Pursue', approach: 'Approach', eat: 'Eat', done: 'Done' };
const fmt = (value, digits = 1) => value === null || value === undefined ? '—' : Number(value).toFixed(digits);
const numericFields = ['L', 'R', 'd', 'v', 'q', 'T', 'N', 'foodMu', 'foodSigma', 'seed', 'dt', 'turnTime', 'turnSD'];
const tasks = new Map();
let runs = [], applied = null, replayVersion = 0, clock = 0, playing = false, lastStamp = null;
let tab = 'trajectory', distance = null, study = null, distanceVersion = 0, studyVersion = 0;

const rules = [
  ...['c0', 'c1', 'c2', 'mixed'].map(id => [id, I.POLICIES[id].label]),
  ['random', 'Random honesty · Section 7.2'],
  ...['a', 'b', 'c', 'd'].map(id => [id, I.POLICIES[id].label])
];
const cards = ['A', 'B'].map((label, index) => {
  const card = $('card').content.firstElementChild.cloneNode(true);
  card.querySelector('label span').textContent = label;
  card.querySelector('canvas').setAttribute('aria-label', 'Trajectory map for run ' + label);
  const select = card.querySelector('select');
  select.id = 'strategy' + (index + 1);
  for (const [id, text] of rules) select.add(new Option(text, id));
  select.value = index === 0 ? 'c0' : 'c2';
  $('compare').append(card);
  return card;
});
for (const [id, label] of Object.entries(Study.STUDIES)) $('study').add(new Option(label, id));
$('study').value = 'validation';

function settings() {
  if (!$('settings').checkValidity()) throw Error('Check the simulation settings.');
  return I.config(Object.fromEntries(numericFields.map(key => [key, $(key).valueAsNumber])));
}

function replayWorld(c) {
  const scenario = $('scenario').value;
  if (scenario === 'search') return I.makeWorld(c);
  const world = I.makeWorld({ ...c, conditionInitial: false });
  const x = 250 - c.d / 2, y = 250;
  world.agents = [{ x, y }, { x: x + c.d, y }];
  const step = Math.min(0.6 * c.L, 0.5 * x);
  world.foods[0] = { ...world.foods[0], x: x - step, y };
  if (scenario === 'hidden' && world.foods.length > 1) {
    world.foods[1] = { ...world.foods[1], x: x + c.d + step, y };
  }
  return world;
}

function task(job, config, options, progress = () => {}) {
  tasks.get(job)?.cancel();
  return new Promise((resolve, reject) => {
    const worker = new Worker('worker.js');
    let finished = false;
    function finish(error, result) {
      if (finished) return;
      finished = true;
      worker.terminate();
      tasks.delete(job);
      if (error) reject(error);
      else resolve(result);
    }
    tasks.set(job, { cancel: () => finish(new DOMException('Calculation cancelled.', 'AbortError')) });
    worker.onmessage = ({ data }) => {
      if (data.progress) progress(data.progress);
      else if (data.error) finish(Error(data.error));
      else finish(null, data.result);
    };
    worker.onerror = event => finish(Error(event.message || 'The calculation worker could not start. Open the app over HTTP.'));
    worker.postMessage({ job, config, options });
  });
}

function showError(message = '') {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function status(message, state) {
  $('applyStatus').textContent = message;
  $('applyStatus').dataset.state = state;
}

function play(value) {
  playing = value;
  lastStamp = null;
  $('play').textContent = value ? 'Ⅱ Pause' : '▶ Play';
}

function cancelPendingReplay() {
  const running = tasks.get('replay');
  if (!running) return;
  replayVersion++;
  running.cancel();
  $('apply').removeAttribute('aria-busy');
}

function resetReplay() {
  play(false);
  runs = [];
  clock = 0;
  $('timeline').value = '0';
  $('clock').textContent = '0.0 min';
  $('endTime').textContent = '— min';
  $('eventLog').replaceChildren();
  delete $('eventLog').dataset.signature;
  $('eventCount').textContent = '0 events';
  $('convergenceResults').textContent = '';
  $('diagnostics').textContent = '';
  for (const id of ['play', 'restart', 'jump', 'timeline', 'downloadReplay', 'runConvergence']) $(id).disabled = true;
  for (const card of cards) {
    const canvas = card.querySelector('canvas');
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    for (const field of ['food', 'gap', 'truth', 'lies']) card.querySelector('.' + field).textContent = '—';
  }
  const canvas = $('foodChart');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

function invalidateDistance() {
  distanceVersion++;
  tasks.get('distance')?.cancel();
  distance = null;
  $('runDistance').disabled = false;
  $('cancelDistance').hidden = true;
  $('exportDistance').disabled = true;
  $('distanceResults').hidden = true;
  $('distanceStatus').textContent = 'Ready to calculate.';
}
function invalidateStudy() {
  studyVersion++;
  tasks.get('study')?.cancel();
  study = null;
  $('runStudy').disabled = false;
  $('cancelStudy').hidden = true;
  $('exportStudy').disabled = true;
  $('exportStudyJson').disabled = true;
  $('studyResults').hidden = true;
  $('studyStatus').textContent = 'Ready to run.';
}

async function applySettings({ useApplied = false } = {}) {
  const version = ++replayVersion;
  tasks.get('replay')?.cancel();
  resetReplay();
  showError();
  $('apply').setAttribute('aria-busy', 'true');
  status('Calculating both trajectories…', 'pending');
  $('insight').textContent = 'Preparing a shared environment and paired runs.';
  try {
    const c = useApplied ? applied.config : settings();
    const world = useApplied ? applied.world : replayWorld(c);
    const p = useApplied ? applied.p : $('p').valueAsNumber;
    const chosen = cards.map(card => I.policy(card.querySelector('select').value, p));
    const result = await task('replay', { ...c, world }, { weights: chosen.map(rule => rule.weights) });
    if (version !== replayVersion) return;
    runs = result;
    if (!useApplied) {
      applied = { config: c, world, p };
      if ($('fitMode').value !== 'report') invalidateDistance();
      if ($('environment').value === 'applied') invalidateStudy();
    }
    $('timeline').max = c.T;
    $('endTime').textContent = fmt(c.T, 1) + ' min';
    for (const id of ['play', 'restart', 'timeline', 'downloadReplay', 'runConvergence']) $(id).disabled = false;
    $('jump').disabled = !runs.some(run => run.firstHit !== null);
    $('insight').textContent = `Both runs reset to time zero · d = ${fmt(c.d, 2)} m · N = ${c.N} · seed ${c.seed} · median mass ${fmt(Math.exp(c.foodMu))} g`;
    const maxGap = Math.max(...runs.map(r => r.diagnostics.maxGap));
    const error = Math.max(...runs.map(r => r.diagnostics.finiteFoodError));
    $('diagnostics').textContent = `Maximum gap ${fmt(maxGap, 3)} m · mass balance error ${error.toExponential(2)} g · step ≤ ${fmt(c.dt, 3)} min`;
    status('Applied. Playback is ready at 0.0 min.', 'applied');
    renderReplay();
  } catch (error) {
    if (version !== replayVersion || error.name === 'AbortError') return;
    status('Check the settings and apply again.', 'error');
    $('insight').textContent = 'Trajectories are cleared until the calculation succeeds.';
    showError(error.message);
  } finally {
    if (version === replayVersion) $('apply').removeAttribute('aria-busy');
  }
}

function indexAt(run, time) {
  let low = 0;
  let high = run.frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (run.frames[middle].t <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}

function sample(run, time) {
  const index = indexAt(run, time);
  const current = run.frames[index];
  const next = run.frames[Math.min(index + 1, run.frames.length - 1)];
  const duration = next.t - current.t;
  const fraction = duration > 0 ? clamp((time - current.t) / duration, 0, 1) : 0;
  return {
    ...current,
    t: time,
    F: current.F + (next.F - current.F) * fraction,
    index,
    agents: current.agents.map((agent, i) => ({
      ...agent,
      x: agent.x + (next.agents[i].x - agent.x) * fraction,
      y: agent.y + (next.agents[i].y - agent.y) * fraction
    }))
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fitCanvas(canvas) {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  const ratio = devicePixelRatio || 1;
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { g: context, w: width, h: height };
}

function drawWorld(canvas, r, s) {
  const {g, w, h} = fitCanvas(canvas),
    p = 18,
    c = r.config,
    scale = Math.min((w - p * 2) / c.width, (h - p * 2) / c.height),
    ox = (w - c.width * scale) / 2,
    oy = (h - c.height * scale) / 2,
    X = x => ox + x * scale,
    Y = y => oy + (c.height - y) * scale;
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#fcfcf6';
  g.fillRect(0, 0, w, h);
  g.lineWidth = .6;
  g.strokeStyle = '#e5eadf';
  for (let x = 0; x <= c.width; x += c.width / 10) {
    g.beginPath();
    g.moveTo(X(x), Y(0));
    g.lineTo(X(x), Y(c.height));
    g.stroke();
  }
  for (let y = 0; y <= c.height; y += c.height / 10) {
    g.beginPath();
    g.moveTo(X(0), Y(y));
    g.lineTo(X(c.width), Y(y));
    g.stroke();
  }
  g.strokeStyle = '#cdd8c9';
  g.strokeRect(X(0), Y(c.height), c.width * scale, c.height * scale);
  for (let j = 0; j < r.world.foods.length; j++) {
    const f = r.world.foods[j],
      remaining = s.remaining[j],
      empty = remaining <= 1e-8,
      radius = clamp(2 + Math.log1p(f.mass) / 4, 2, 5);
    g.beginPath();
    g.arc(X(f.x), Y(f.y), empty ? 2: radius, 0, Math.PI * 2);
    g.fillStyle = empty ? '#d8ddcf': '#bd8532';
    g.fill();
    if (s.agents.some(a => a.target === j)) {
      g.beginPath();
      g.arc(X(f.x), Y(f.y), c.L * scale, 0, Math.PI * 2);
      g.strokeStyle = '#bd853255';
      g.setLineDash([2, 3]);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#a17a3c';
      g.font = '9px ui-monospace,monospace';
      g.fillText('#' + (j + 1), X(f.x) + 5, Y(f.y) - 5);
    }
  }
  for (let i = 0; i < 2; i++) {
    g.beginPath();
    g.strokeStyle = colors[i] + 'b0';
    g.lineWidth = 1.5;
    for (let k = 0; k <= s.index; k++) {
      const a = r.frames[k].agents[i];
      if (k === 0)g.moveTo(X(a.x), Y(a.y)); else g.lineTo(X(a.x), Y(a.y));
    }
    g.lineTo(X(s.agents[i].x), Y(s.agents[i].y));
    g.stroke();
  }
  const [a, b] = s.agents;
  g.beginPath();
  g.moveTo(X(a.x), Y(a.y));
  g.lineTo(X(b.x), Y(b.y));
  g.strokeStyle = '#8f9d8e55';
  g.setLineDash([3, 4]);
  g.lineWidth = 1;
  g.stroke();
  g.setLineDash([]);
  if ($('showR').checked) {
    g.beginPath();
    g.arc(X(a.x), Y(a.y), c.R * scale, 0, Math.PI * 2);
    g.setLineDash([4, 4]);
    g.strokeStyle = '#09878733';
    g.stroke();
    g.setLineDash([]);
  }
  const together = Scudem.dist(a, b) * scale < 8;
  for (let i = 0; i < 2; i++) {
    const a = s.agents[i], dx = together ? (i === 0 ? -5: 5): 0;
    g.beginPath();
    g.arc(X(a.x) + dx, Y(a.y), 6, 0, Math.PI * 2);
    g.fillStyle = colors[i];
    g.fill();
    g.lineWidth = 1.8;
    g.strokeStyle = '#fffefa';
    g.stroke();
    g.fillStyle = '#fff';
    g.font = 'bold 8px sans-serif';
    g.textAlign = 'center';
    g.fillText(i === 0 ? 'A': 'B', X(a.x) + dx, Y(a.y) + 2.8);
    g.textAlign = 'left';
    if (!together || i === 0) {
      g.fillStyle = colors[i];
      g.font = '9px sans-serif';
      const tx = clamp(X(a.x) - 13, 3, w - 90), ty = Y(a.y) < 25 ? Y(a.y) + 20: Y(a.y) - 12;
      g.fillText((together ? 'A+B · ': '') + (names[a.state] || a.state), tx, ty);
    }
  }
  g.fillStyle = '#94a18d';
  g.font = '8px ui-monospace,monospace';
  g.fillText(c.width + ' × ' + c.height + ' m', ox + 3, h - 5);
}
function lineChart(canvas, series, maxX, maxY, cursor = null, points = []) {
  const {g, w, h} = fitCanvas(canvas),
    p = {l: 40, r: 18, t: 12, b: 25},
    cw = w - p.l - p.r,
    ch = h - p.t - p.b,
    X = x => p.l + x / Math.max(1e-12, maxX) * cw,
    Y = y => p.t + ch - y / Math.max(1e-12, maxY) * ch;
  g.clearRect(0, 0, w, h);
  g.font = '9px ui-monospace,monospace';
  g.lineWidth = .6;
  for (let i = 0; i <= 4; i++) {
    const y = maxY * i / 4;
    g.beginPath();
    g.moveTo(p.l, Y(y));
    g.lineTo(w - p.r, Y(y));
    g.strokeStyle = '#e2e9dc';
    g.stroke();
    g.fillStyle = '#8e9c88';
    g.textAlign = 'right';
    g.fillText(fmt(y, 0), p.l - 6, Y(y) + 3);
    g.textAlign = 'center';
    g.fillText(fmt(maxX * i / 4, 0), X(maxX * i / 4), h - 7);
  }
  series.forEach((s, j) => {
    g.beginPath();
    g.strokeStyle = colors[j % 2];
    g.lineWidth = 1.8;
    s.forEach((v, k) => {
      if (k === 0)g.moveTo(X(v.x), Y(v.y)); else g.lineTo(X(v.x), Y(v.y));
    });
    g.stroke();
  });
  for (const pt of points) {
    g.beginPath();
    g.arc(X(pt.x), Y(pt.y), 4, 0, 2 * Math.PI);
    g.fillStyle = pt.color || '#bd8532';
    g.fill();
  }
  if (cursor !== null) {
    g.beginPath();
    g.moveTo(X(cursor), p.t);
    g.lineTo(X(cursor), h - p.b);
    g.strokeStyle = '#8d9f87';
    g.setLineDash([3, 3]);
    g.stroke();
    g.setLineDash([]);
  }
  g.textAlign = 'left';
}

function renderReplay() {
  if (tab !== 'trajectory' || !runs.length) return;
  const timelineEvents = [];
  runs.forEach((run, i) => {
    const frame = sample(run, clock);
    const card = cards[i];
    drawWorld(card.querySelector('canvas'), run, frame);
    const decisions = run.decisions.filter(d => d.time <= clock + 1e-8);
    card.querySelector('.food').textContent = fmt(frame.F);
    card.querySelector('.gap').textContent = fmt(I.dist(...frame.agents));
    card.querySelector('.truth').textContent = decisions.filter(d => d.truthful === true).length;
    card.querySelector('.lies').textContent = decisions.filter(d => d.truthful === false).length;
    timelineEvents.push(...run.events.filter(e => e.time <= clock + 1e-8)
      .map(e => ({ ...e, run: i === 0 ? 'A' : 'B' })));
  });
  $('clock').textContent = fmt(clock) + ' min';
  $('timeline').value = clock;
  const series = runs.map(r => r.frames.map(frame => ({ x: frame.t, y: frame.F })));
  lineChart($('foodChart'), series, runs[0].config.T, Math.max(1, ...runs.map(r => r.F)), clock);
  const events = timelineEvents.sort((a, b) => b.time - a.time);
  $('eventCount').textContent = events.length + ' events';
  const signature = events.length + ':' + events[0]?.time;
  if ($('eventLog').dataset.signature !== signature) {
    $('eventLog').dataset.signature = signature;
    $('eventLog').replaceChildren(...events.slice(0, 80).map(e => {
      const item = document.createElement('li');
      item.textContent = `${fmt(e.time, 2)} min · Run ${e.run} · ${e.message}`;
      return item;
    }));
  }
}

function animate(stamp) {
  if (playing && runs.length) {
    if (lastStamp !== null) clock = Math.min(runs[0].config.T, clock + (stamp - lastStamp) / 1000 * +$('speed').value);
    lastStamp = stamp;
    renderReplay();
    if (clock >= runs[0].config.T) play(false);
  }
  requestAnimationFrame(animate);
}

function table(id, headers, rows) {
  const element = document.createElement('table');
  const head = element.createTHead().insertRow();
  for (const title of headers) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = title;
    head.append(cell);
  }
  const body = element.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    for (const value of row) tr.insertCell().textContent = value;
  }
  $(id).replaceChildren(element);
}

function renderDistance() {
  if (!distance || tab !== 'distance') return;
  $('distanceResults').hidden = false;
  $('exportDistance').disabled = false;
  const { params, optimum, rows } = distance;
  $('optD').textContent = fmt(optimum.d, 3);
  $('optH').textContent = fmt(optimum.H, 3);
  $('slopeR').textContent = fmt(optimum.slopeAtR, 5);
  const source = distance.source === 'report' ? 'Section 7.3 · Table 12' :
    distance.source === 'custom' ? 'Custom coefficients' :
    `Simulated first hits · ${distance.method} estimate of k · coverage fit ${distance.extra.status.replaceAll('-', ' ')}`;
  $('distanceDetail').textContent = `${source}. k = ${params.k.toExponential(4)}, α = ${fmt(params.alpha, 4)}, β = ${fmt(params.beta, 4)}, γ = ${fmt(params.gamma, 4)}. ` +
    (optimum.sufficientForR ? `The report’s sufficient conditions hold. H(R) is below the inner lower bound of ${fmt(optimum.innerLowerBound, 2)} min.` :
      optimum.flatOptimum ? 'Every distance from 2L through R minimizes H.' : 'The global minimum is selected by comparing all candidate points.');
  const curve = Array.from({ length: 241 }, (_, i) => {
    const x = params.R * i / 240;
    return { x, y: II.H(x, params) };
  });
  lineChart($('distanceChart'), [curve], params.R, Math.max(...curve.map(point => point.y)) * 1.04,
    null, [{ x: optimum.d, y: optimum.H }]);
  if (rows) {
    table('distanceTable', ['d (m)', 'Hits / trials', 'Censored', 'Estimated wait (min)', 'Observed B (m²)', 'Fitted H (min)'],
      rows.map(r => [fmt(r.d, 2), `${r.hits} / ${r.K}`, r.censored,
        fmt(r.exponentialMean, 3), fmt(r.observed, 3), fmt(II.H(r.d, params), 3)]));
  } else {
    const distances = [...new Set([...II.calibrationDistances(params), ...optimum.candidates.map(r => r.d)])].sort((a, b) => a - b);
    table('distanceTable', ['d (m)', 'A(d) (m²)', 'A(d) + B(d) (m²)', 'H(d) (min)'],
      distances.map(d => [fmt(d, 4), fmt(II.area(d, params.L), 3), fmt(II.coverage(d, params), 3), fmt(II.H(d, params), 3)]));
  }
}

function currentConfig() {
  if (!applied) throw Error('Apply valid simulation settings first.');
  return applied.config;
}

async function runDistance() {
  invalidateDistance();
  const version = distanceVersion;
  const mode = $('fitMode').value;
  $('runDistance').disabled = true;
  try {
    if (mode === 'simulation') {
      const K = $('calK').valueAsNumber;
      if (!Number.isInteger(K) || K < 1 || K > 3000) throw Error('Choose 1 to 3000 trials per batch.');
      const c = currentConfig();
      $('cancelDistance').hidden = false;
      $('distanceStatus').textContent = 'Starting two independent calibration batches…';
      const result = await task('distance', { ...c, T: Math.max(c.T, 360) }, { K, batches: 2 }, p => {
        $('distanceStatus').textContent = `Calibrating · ${p.done} / ${p.total} matched trials`;
      });
      if (version !== distanceVersion) return;
      distance = { ...result, source: mode };
    } else {
      const { L, R, v } = mode === 'report' ? I.CASE_STUDY : currentConfig();
      const fit = mode === 'report' ? II.REPORT_FIT :
        Object.fromEntries(['k', 'alpha', 'beta', 'gamma'].map(key => [key, $(key).valueAsNumber]));
      const params = { L, R, v, ...fit };
      distance = { params, optimum: II.minimize(params), source: mode };
    }
    $('distanceStatus').textContent = 'Calculation complete.';
    renderDistance();
  } catch (error) {
    if (version === distanceVersion) $('distanceStatus').textContent = error.message;
  } finally {
    if (version === distanceVersion) {
      $('cancelDistance').hidden = true;
      $('runDistance').disabled = false;
    }
  }
}

function interval(values) {
  return values ? '[' + values.map(x => fmt(x, 1)).join(', ') + ']' : '—';
}

function delta(paired) {
  return paired ? fmt(paired.mean) + ' ' + interval(paired.ci95) : '—';
}

function renderStudy() {
  if (!study || tab !== 'experiments') return;
  $('studyResults').hidden = false;
  $('exportStudy').disabled = false;
  $('exportStudyJson').disabled = false;
  const horizon = +$('studyHorizon').value;
  const filtered = study.rows.filter(r => r.time === horizon);
  table('studyTable', ['Rule', 'd (m)', 'Mean (g)', '95% CI (g)', 'Δ vs C = 0', 'Δ vs p = 0', 'Δ vs near', 'Δ vs previous', 'C = −1 messages'],
    filtered.map(r => [r.p === 1 ? 'Random honesty · p = 1' : r.label, fmt(r.d, 2), fmt(r.mean, 2), interval(r.ci95),
      delta(r.paired.atDistance), delta(r.paired.honestyBase), delta(r.paired.near), delta(r.paired.next), r.counts[0]]));
}

async function runStudy() {
  invalidateStudy();
  const version = studyVersion;
  $('runStudy').disabled = true;
  $('cancelStudy').hidden = false;
  try {
    const c = $('environment').value === 'report' ? {} : currentConfig();
    const K = $('K').valueAsNumber;
    if (!Number.isInteger(K) || K < 1 || K > 1200) throw Error('Choose 1 to 1200 trials per configuration.');
    $('studyStatus').textContent = 'Starting paired simulations…';
    const result = await task('study', c, { K, study: $('study').value }, p => {
      $('studyStatus').textContent = `Running · ${p.done} / ${p.total} matched trials`;
    });
    if (version !== studyVersion) return;
    study = result;
    $('studyStatus').textContent = `Completed · ${study.K} trials per configuration · seed ${study.config.seed}`;
    renderStudy();
  } catch (error) {
    if (version === studyVersion) $('studyStatus').textContent = error.message;
  } finally {
    if (version === studyVersion) {
      $('runStudy').disabled = false;
      $('cancelStudy').hidden = true;
    }
  }
}

async function loadStudy() {
  invalidateStudy();
  const version = studyVersion;
  $('studyStatus').textContent = 'Loading the completed study…';
  try {
    const response = await fetch('case-study.json');
    if (!response.ok) throw Error('The completed study could not be loaded. You can run a new comparison.');
    const result = await response.json();
    if (version !== studyVersion) return;
    study = result;
    $('study').value = result.study;
    $('K').value = result.K;
    $('environment').value = 'report';
    $('studyStatus').textContent = `Completed run · ${study.K} trials per configuration · Section 7 defaults · seed ${study.config.seed}`;
    renderStudy();
  } catch (error) {
    if (version === studyVersion) $('studyStatus').textContent = error.message;
  }
}

function download(name, contents, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function studyCsv() {
  const header = ['rule', 'd_m', 'T_min', 'trials', 'mean_g', 'ci_low', 'ci_high'];
  const comparisons = ['atDistance', 'honestyBase', 'near', 'next'];
  for (const key of comparisons) header.push(key + '_delta_g', key + '_ci_low', key + '_ci_high');
  header.push('C-1_count', 'C0_count', 'C1_count', 'C2_count');
  const rows = study.rows.map(r => {
    const cells = [r.label, r.d, r.time, r.n, r.mean, ...(r.ci95 ?? ['', ''])];
    for (const key of comparisons) {
      const pair = r.paired[key];
      cells.push(pair?.mean ?? '', ...(pair?.ci95 ?? ['', '']));
    }
    return [...cells, ...r.counts];
  });
  return [header, ...rows].map(row => row.map(cell =>
    typeof cell === 'string' ? '"' + cell.replaceAll('"', '""') + '"' : cell).join(',')).join('\n') + '\n';
}

$('settings').addEventListener('submit', event => {
  event.preventDefault();
  setTab('trajectory');
  applySettings();
});
$('settings').addEventListener('input', () => {
  $('d').max = Number.isFinite($('R').valueAsNumber) && $('R').valueAsNumber > 0 ? $('R').value : 20;
  $('dout').textContent = fmt($('d').valueAsNumber, 2) + ' m';
  $('pout').textContent = fmt($('p').valueAsNumber, 2);
  const notes = {
    search: 'Food locations and starting positions are seeded.',
    encounter: 'The first patch is placed within A’s detection radius.',
    hidden: 'The first two patches start near different foragers when N is at least two.'
  };
  $('scenarioNote').textContent = notes[$('scenario').value];
  cancelPendingReplay();
  status('Settings edited. Apply to recalculate.', 'pending');
});
for (const card of cards) card.querySelector('select').addEventListener('change', () => {
  const pending = $('applyStatus').dataset.state === 'pending';
  if (applied && !pending) applySettings({ useApplied: true });
  else {
    cancelPendingReplay();
    status('Communication rule selected. Apply to recalculate.', 'pending');
  }
});

function setTab(next) {
  tab = next;
  play(false);
  for (const button of document.querySelectorAll('.tab')) {
    const selected = button.dataset.tab === tab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', selected);
    $(button.dataset.tab + 'View').hidden = !selected;
  }
  renderReplay();
  if (tab === 'distance' && !distance && $('fitMode').value === 'report') runDistance();
  else renderDistance();
  renderStudy();
}

for (const button of document.querySelectorAll('.tab')) button.onclick = () => setTab(button.dataset.tab);
$('play').onclick = () => {
  if (!runs.length) return;
  if (clock >= runs[0].config.T) clock = 0;
  play(!playing);
};
$('restart').onclick = () => { play(false); clock = 0; renderReplay(); };
$('jump').onclick = () => { play(false); clock = Math.min(...runs.map(r => r.firstHit ?? Infinity)); renderReplay(); };
$('timeline').oninput = () => { play(false); clock = $('timeline').valueAsNumber; renderReplay(); };
$('showR').onchange = renderReplay;
$('runDistance').onclick = runDistance;
$('cancelDistance').onclick = () => tasks.get('distance')?.cancel();
$('fitMode').onchange = () => {
  $('fitFields').hidden = $('fitMode').value !== 'custom';
  $('calibrationOptions').hidden = $('fitMode').value !== 'simulation';
  invalidateDistance();
  if ($('fitMode').value === 'report') runDistance();
};
for (const id of ['k', 'alpha', 'beta', 'gamma', 'calK']) $(id).oninput = invalidateDistance;
$('runStudy').onclick = runStudy;
$('cancelStudy').onclick = () => tasks.get('study')?.cancel();
$('loadStudy').onclick = loadStudy;
$('studyHorizon').onchange = renderStudy;
for (const id of ['study', 'K', 'environment']) $(id).onchange = invalidateStudy;
$('downloadReplay').onclick = () => download('scudem-trajectories.json', JSON.stringify(runs, null, 2));
$('exportDistance').onclick = () => download('scudem-distance.json', JSON.stringify(distance, null, 2));
$('exportStudy').onclick = () => download('scudem-case-study.csv', studyCsv(), 'text/csv');
$('exportStudyJson').onclick = () => download('scudem-case-study.json', JSON.stringify(study, null, 2));
$('runConvergence').onclick = () => {
  if (!runs.length) return;
  const run = runs[0];
  const finer = I.simulate({ ...run.config, track: false, dt: run.config.dt / 2 });
  $('convergenceResults').textContent =
    `Run A · Δt ${fmt(run.config.dt, 4)} → ${fmt(finer.config.dt, 4)} min · final food ${fmt(run.F, 2)} → ${fmt(finer.F, 2)} g · first hit ${fmt(run.firstHit, 3)} → ${fmt(finer.firstHit, 3)} min`;
};
window.addEventListener('resize', () => { renderReplay(); renderDistance(); });
requestAnimationFrame(animate);
applySettings();
