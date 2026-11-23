(function (root) {
'use strict';

const I = typeof module === 'undefined' ? root.Scudem : require('./engine.js');
const HORIZONS = [60, 120, 240];
const STUDIES = {
  information: 'Information quality · Table 10',
  honesty: 'Random truthfulness · Table 11',
  validation: 'Distance validation · Table 13',
  all: 'All Case Study comparisons'
};

function design(c, study) {
  if (!Object.hasOwn(STUDIES, study)) throw Error('Unknown study.');
  const basic = [...new Set([c.L, Math.min(2 * c.L, c.R), c.R])];
  const span = Math.max(0, c.R - 2 * c.L);
  const extended = [...new Set([...basic, ...[0.25, 0.5, 0.75].map(f => Math.min(c.R, 2 * c.L + f * span))])].sort((a, b) => a - b);
  const information = ['c0', 'c1', 'c2', 'mixed'].flatMap(rule => basic.map(d => ({ d, rule })));
  const honesty = [0, 0.25, 0.5, 0.75, 1].flatMap(p => basic.map(d => ({ d, rule: p === 1 ? 'mixed' : 'random', p })));
  const validation = ['a', 'b', 'c', 'd'].flatMap(rule => extended.map(d => ({ d, rule })));
  const lists = { information, honesty, validation, all: [...information, ...honesty.filter(r => r.p !== 1), ...validation] };
  return lists[study].map((item, id) => {
    const rule = I.policy(item.rule, item.p);
    return { ...item, ...rule, id };
  });
}

function moments() {
  return { n: 0, mean: 0, m2: 0 };
}
function observe(m, value) {
  m.n++;
  const diff = value - m.mean;
  m.mean += diff / m.n;
  m.m2 += diff * (value - m.mean);
}
function describe({ n, mean, m2 }) {
  const se = n > 1 ? Math.sqrt(m2 / (n - 1) / n) : null;
  return { n, mean, se, ci95: se === null ? null : [mean - 1.96 * se, mean + 1.96 * se] };
}

function benchmarks(variants) {
  const hasSameRule = (a, b) => a.rule === b.rule && a.p === b.p;
  return variants.map(item => {
    const atDistance = variants.find(v => v.d === item.d && v.rule === 'c0');
    const honestyBase = item.rule === 'random' || item.rule === 'mixed' ?
      variants.find(v => v.d === item.d && v.rule === 'random' && v.p === 0) : null;
    const sameRule = variants.filter(v => hasSameRule(item, v));
    const near = sameRule[0];
    const next = sameRule[sameRule.indexOf(item) - 1];
    return { atDistance, honestyBase, near, next };
  });
}

function run(input, options = {}) {
  const study = options.study ?? 'all';
  const K = options.K ?? 1200;
  const horizons = [...new Set(options.horizons ?? HORIZONS)].sort((a, b) => a - b);
  if (!Number.isInteger(K) || K < 1 || K > 100000) throw Error('Use 1 to 100000 integer trials per configuration.');
  if (!horizons.length || horizons.some(t => !Number.isFinite(t) || t <= 0)) throw Error('Observation horizons must be positive.');
  const c = I.config({ ...input, T: horizons.at(-1), track: false, sampleTimes: horizons });
  const variants = design(c, study);
  const distances = [...new Set(variants.map(v => v.d))].sort((a, b) => a - b);
  const comparators = benchmarks(variants);
  const accumulators = variants.map(() => horizons.map(() => ({
    food: moments(), atDistance: moments(), honestyBase: moments(), near: moments(), next: moments()
  })));
  const diagnostics = { rangeViolations: 0, maxSpeed: 0, maxSearchDistanceError: 0, maxFiniteFoodError: 0 };
  const counts = variants.map(() => [0, 0, 0, 0]);
  const raw = options.raw ? [] : null;
  const progress = options.onProgress ?? (() => {});
  for (let trial = 0; trial < K; trial++) {
    const worlds = I.pairedWorlds({ ...c, trial }, distances);
    const values = variants.map(v => {
      const r = I.simulate({ ...c, trial, d: v.d, weights: v.weights, world: worlds[distances.indexOf(v.d)] });
      diagnostics.rangeViolations += r.diagnostics.rangeViolations;
      diagnostics.maxSpeed = Math.max(diagnostics.maxSpeed, r.diagnostics.maxSpeed);
      diagnostics.maxSearchDistanceError = Math.max(diagnostics.maxSearchDistanceError, r.diagnostics.maxSearchDistanceError);
      diagnostics.maxFiniteFoodError = Math.max(diagnostics.maxFiniteFoodError, r.diagnostics.finiteFoodError);
      for (const e of r.decisions) counts[v.id][e.C + 1]++;
      return r.samples.map(s => s.F);
    });
    for (const v of variants) {
      const references = comparators[v.id];
      horizons.forEach((time, j) => {
        const food = values[v.id][j];
        const m = accumulators[v.id][j];
        observe(m.food, food);
        for (const key of ['atDistance', 'honestyBase', 'near', 'next']) {
          if (references[key]) observe(m[key], food - values[references[key].id][j]);
        }
        if (raw) raw.push({ trial: trial + 1, configuration: v.id, d: v.d, rule: v.rule, p: v.p ?? null, time, F: food });
      });
    }
    if ((trial + 1) % 10 === 0 || trial + 1 === K) progress({ done: trial + 1, total: K });
  }
  const rows = variants.flatMap(v => horizons.map((time, j) => {
    const m = accumulators[v.id][j], refs = comparators[v.id];
    const paired = {};
    for (const key of ['atDistance', 'honestyBase', 'near', 'next']) {
      const ref = refs[key];
      if (!ref || ref.id === v.id) continue;
      const baseMean = accumulators[ref.id][j].food.mean;
      const result = describe(m[key]);
      paired[key] = { d: ref.d, label: ref.label, ...result, percent: baseMean > 0 ? 100 * result.mean / baseMean : null };
    }
    return { ...v, time, ...describe(m.food), paired, counts: counts[v.id] };
  }));
  return { K, study, horizons, config: c, rows, diagnostics, ...(raw ? { raw } : {}) };
}

const api = { HORIZONS, STUDIES, design, run };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ScudemStudy = api;
})(typeof window !== 'undefined' ? window : globalThis);
