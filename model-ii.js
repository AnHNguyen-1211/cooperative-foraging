(function (root) {
'use strict';

const I = typeof module === 'undefined' ? root.Scudem : require('./engine.js');
const REPORT_FIT = Object.freeze({ k: 2.0221e-4, alpha: 0.6893, beta: 21.21, gamma: 0.1591 });

function area(d, L) {
  if (d >= 2 * L) return 2 * Math.PI * L ** 2;
  const angle = Math.acos(d / (2 * L));
  return 2 * L ** 2 * (Math.PI - angle) + d * Math.sqrt((2 * L) ** 2 - d ** 2) / 2;
}

function coverage(d, { L, beta, gamma }) {
  return area(d, L) - beta * Math.expm1(-gamma * Math.max(0, d - 2 * L));
}

function H(d, p) {
  return 1 / (p.k * coverage(d, p)) + (p.L + p.alpha * d) / p.v;
}

function derivative(d, p, right = d > 2 * p.L) {
  const { L, v, k, alpha, beta, gamma } = p;
  const slope = right ? beta * gamma * Math.exp(-gamma * (d - 2 * L)) :
    Math.sqrt(Math.max(0, (2 * L) ** 2 - d ** 2));
  return alpha / v - slope / (k * coverage(d, p) ** 2);
}

function minimize(params) {
  const p = { ...params };
  if (!['L', 'R', 'v', 'k', 'alpha', 'beta', 'gamma'].every(key => Number.isFinite(p[key])) ||
      !(p.L > 0 && p.R > p.L && p.v > 0 && p.k > 0 && p.alpha >= 0 && p.beta >= 0 && p.gamma >= 0)) {
    throw Error('Model II needs 0 < L < R, positive v and k, and nonnegative α, β and γ.');
  }
  const kink = 2 * p.L;
  const cuts = p.R > kink ? [0, kink, p.R] : [0, p.R];
  const candidates = cuts.map(d => ({ d, H: H(d, p) }));

  for (let i = 1; i < cuts.length; i++) {
    let lo = cuts[i - 1], hi = cuts[i];
    const right = i === 2;
    if (derivative(lo, p, right) >= 0 || derivative(hi, p, right) <= 0) continue;
    for (let iteration = 0; iteration < 64; iteration++) {
      const mid = (lo + hi) / 2;
      if (derivative(mid, p, right) < 0) lo = mid;
      else hi = mid;
    }
    const d = (lo + hi) / 2;
    candidates.push({ d, H: H(d, p) });
  }
  candidates.sort((a, b) => a.d - b.d);
  const best = candidates.reduce((a, b) => b.H < a.H - 1e-10 ? b : a);
  const slopeAtR = derivative(p.R, p, p.R > kink);
  const innerLowerBound = 1 / (2 * p.k * Math.PI * p.L ** 2) + p.L / p.v;
  const sufficientForR = p.R > kink && slopeAtR <= 0 && H(p.R, p) < innerLowerBound;
  const flatOptimum = p.R > kink && p.alpha === 0 && (p.beta === 0 || p.gamma === 0);
  return { ...best, candidates, slopeAtR, innerLowerBound, sufficientForR, flatOptimum };
}

function geometricMean(d, { L, v }, samples = 2048) {
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const angle = 2 * Math.PI * (i + 0.5) / samples;
    total += Math.max(L, Math.hypot(d - L * Math.cos(angle), L * Math.sin(angle)));
  }
  return total / (samples * v);
}

function fitAlpha(c, distances) {
  let numerator = 0, denominator = 0;
  const rows = distances.map(d => ({ d, approach: geometricMean(d, c) }));
  for (const { d, approach } of rows) {
    numerator += d * (c.v * approach - c.L);
    denominator += d ** 2;
  }
  const alpha = denominator ? numerator / denominator : 0;
  const rmse = Math.sqrt(rows.reduce((sum, r) =>
    sum + (r.approach - (c.L + alpha * r.d) / c.v) ** 2, 0) / rows.length);
  return { alpha, rmse, rows };
}

function fitCoverage(points, L) {
  if (points.length < 2) return { beta: 0, gamma: 0, rmse: null, status: 'insufficient-distances' };
  const span = Math.max(...points.map(r => r.d - 2 * L));
  const minLog = Math.log(1e-4 / span), maxLog = Math.log(100 / span);
  function profile(logGamma) {
    const gamma = Math.exp(logGamma);
    const basis = points.map(r => -Math.expm1(-gamma * (r.d - 2 * L)));
    const beta = Math.max(0, points.reduce((sum, r, i) => sum + r.observed * basis[i], 0) /
      basis.reduce((sum, b) => sum + b ** 2, 0));
    const sse = points.reduce((sum, r, i) => sum + (r.observed - beta * basis[i]) ** 2, 0);
    return { beta, gamma, sse };
  }
  const intervals = 96;
  const step = (maxLog - minLog) / intervals;
  const grid = Array.from({ length: intervals + 1 }, (_, i) => profile(minLog + i * step));
  let best = grid.reduce((a, b) => b.sse < a.sse ? b : a);
  for (let i = 1; i < intervals; i++) {
    if (!(grid[i].sse < grid[i - 1].sse && grid[i].sse < grid[i + 1].sse)) continue;
    let lo = minLog + (i - 1) * step, hi = minLog + (i + 1) * step;
    for (let iteration = 0; iteration < 48; iteration++) {
      const left = lo + (hi - lo) / 3, right = hi - (hi - lo) / 3;
      if (profile(left).sse <= profile(right).sse) hi = right;
      else lo = left;
    }
    const candidate = profile((lo + hi) / 2);
    if (candidate.sse < best.sse) best = candidate;
  }
  const { beta, sse } = best;
  const gamma = beta === 0 ? 0 : best.gamma;
  const status = beta === 0 ? 'no-positive-benefit' :
    best === grid[0] || best === grid.at(-1) ? 'gamma-at-fit-bound' : 'fitted';
  return { beta, gamma, rmse: Math.sqrt(sse / points.length), status };
}

function calibrationDistances({ L, R }) {
  const start = Math.min(2 * L, R);
  return [...new Set([L, start, ...[0.25, 0.5, 0.75, 1].map(f => start + f * (R - start))])];
}

function fitFromSearch(c, rows, method = 'anchor') {
  if (method !== 'anchor' && method !== 'pooled') throw Error('Unknown search-rate calibration method.');
  const inner = rows.filter(r => r.d <= 2 * c.L);
  const anchor = inner.find(r => r.d === 2 * c.L);
  const selected = method === 'anchor' && anchor ? [anchor] : inner;
  const exposure = selected.reduce((sum, r) => sum + area(r.d, c.L) * r.exposure, 0);
  const hits = selected.reduce((sum, r) => sum + r.hits, 0);
  if (!(hits > 0 && exposure > 0)) throw Error('No positive first-hit exposure for k. Increase the horizon or check the environment.');
  const k = hits / exposure;
  const enriched = rows.map(r => ({
    ...r, censored: r.K - r.hits, exponentialMean: r.hits > 0 ? r.exposure / r.hits : null,
    observed: r.d > 2 * c.L && r.exposure > 0 && r.hits > 0 ? r.hits / (k * r.exposure) - area(r.d, c.L) : null
  }));
  const extra = fitCoverage(enriched.filter(r => r.observed !== null), c.L);
  const travel = fitAlpha(c, rows.map(r => r.d));
  const params = { L: c.L, R: c.R, v: c.v, k, alpha: travel.alpha, beta: extra.beta, gamma: extra.gamma };
  return { params, optimum: minimize(params), rows: enriched, method: selected.length === 1 && selected[0] === anchor && method === 'anchor' ? 'anchor' : 'pooled', travel, extra };
}

async function calibration(input, options = {}) {
  const c = I.config({ ...input, track: false, stopAtFirstHit: true });
  const K = options.K ?? 3000, batches = options.batches ?? 2;
  if (!Number.isInteger(K) || K < 1 || !Number.isInteger(batches) || batches < 1) throw Error('Use positive integer calibration sample counts.');
  const distances = calibrationDistances(c);
  const newRows = () => distances.map(d => ({ d, K: 0, hits: 0, exposure: 0 }));
  const rows = newRows(), byBatch = Array.from({ length: batches }, newRows);
  const progress = options.onProgress ?? (() => {});
  let done = 0;
  for (let batch = 0; batch < batches; batch++) {
    for (let i = 0; i < K; i++) {
      const trial = 100000 + batch * K + i;
      const worlds = I.pairedWorlds({ ...c, trial }, distances);
      for (let j = 0; j < distances.length; j++) {
        const result = I.simulate({ ...c, trial, d: distances[j], world: worlds[j] });
        for (const row of [rows[j], byBatch[batch][j]]) {
          row.K++;
          row.hits += Number(result.firstHit !== null);
          row.exposure += result.firstHit ?? c.T;
        }
      }
      if (++done % 16 === 0) progress({ done, total: K * batches });
    }
  }
  progress({ done, total: K * batches });
  return {
    ...fitFromSearch(c, rows, options.method), K, batches,
    byBatch: byBatch.map(batch => {
      const hasAnchor = batch.some(r => r.d === 2 * c.L) && options.method !== 'pooled';
      const eligible = batch.filter(r => hasAnchor ? r.d === 2 * c.L : r.d <= 2 * c.L);
      if (!eligible.some(r => r.hits > 0 && r.exposure > 0)) {
        return { status: 'no-positive-hit-exposure', rows: batch };
      }
      return fitFromSearch(c, batch, options.method);
    })
  };
}

const api = { REPORT_FIT, area, coverage, H, derivative, minimize, geometricMean, fitAlpha, fitCoverage, calibrationDistances, fitFromSearch, calibration };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ScudemII = api;
})(typeof window !== 'undefined' ? window : globalThis);
