'use strict';

const assert = require('node:assert/strict');
const I = require('../dist/engine.js');
const II = require('../dist/model-ii.js');
const Study = require('../dist/study.js');

function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

const fixture = {
  d: 10, T: 12, turnTime: 1, v: 5, q: 2, track: true, frameEvery: 0.05,
  world: {
    agents: [{ x: 100, y: 100 }, { x: 110, y: 100 }],
    foods: [{ x: 96, y: 100, mass: 20 }]
  }
};
const run = (id, p) => I.simulate({ ...fixture, weights: I.policy(id, p).weights });
const silent = run('c0');
const lie = run('random', 0);
const discovery = run('c1');
const location = run('c2');
assert.equal(silent.decisions[0].truthful, null);
assert.equal(lie.decisions[0].C, -1);
assert.ok(lie.decisions.every(message => message.truthful === false));
assert.ok(run('random', 1).decisions.every(message => message.truthful === true));
assert.ok(silent.frames.every(frame => I.dist(...frame.agents) <= 10 + 1e-6));
assert.ok(lie.diagnostics.maxGap > 19.9);
assert.ok(discovery.events.some(event => event.type === 'detect' && event.agent === 1));
assert.equal(discovery.decisions.length, 1);
assert.equal(location.decisions.length, 1);
close(location.foods[0].arrivals[0], 0.8);
close(location.foods[0].arrivals[1], 2.8);
close(location.events.find(e => e.type === 'empty').time, 6.8);
close(location.F, 20);
close(location.agents[0].total, 12);
close(location.agents[1].total, 8);

const conflictingTargets = {
  ...fixture, d: 20,
  world: {
    agents: [{ x: 100, y: 100 }, { x: 120, y: 100 }],
    foods: [{ x: 96, y: 100, mass: 4 }, { x: 120, y: 100, mass: 50 }]
  },
  weights: I.policy('c0').weights
};
const conflict = I.simulate(conflictingTargets);
assert.ok(conflict.events.some(e => e.type === 'leave' && e.agent === 1));
assert.ok(conflict.events.some(e => e.type === 'role' && e.agent === 1));
assert.equal(conflict.diagnostics.rangeViolations, 0);

for (const id of ['c0', 'c1', 'c2', 'random', 'a', 'b', 'c', 'd']) {
  const result = I.simulate({ weights: I.policy(id, 0.4).weights, sampleTimes: [0, 60, 120, 240] });
  assert.equal(result.diagnostics.rangeViolations, 0);
  assert.ok(result.diagnostics.maxSpeed < result.config.v + 1e-3);
  assert.ok(result.diagnostics.finiteFoodError < 1e-7);
  assert.ok(result.foods.every(food => food.remaining >= 0 && food.remaining <= food.mass));
  assert.ok(result.samples.every((sample, j) => j === 0 || sample.F >= result.samples[j - 1].F));
  close(result.samples.at(-1).F, result.F);
}

const [near, far] = I.pairedWorlds({ trial: 2 }, [5, 20]);
assert.deepEqual(near.foods, far.foods);
assert.deepEqual(near.agents[0], far.agents[0]);
close(I.dist(...near.agents), 5);
close(I.dist(...far.agents), 20);
assert.notDeepEqual(I.makeWorld({ trial: 2 }).foods, I.makeWorld({ trial: 3 }).foods);
assert.deepEqual(I.makeWorld({ foodSigma: 0 }).foods.map(f => f.mass), Array(20).fill(Math.exp(Math.log(300))));
assert.throws(() => I.config({ weights: [0, 1, 1, 0] }), /probabilities/);

const params = { ...I.CASE_STUDY, ...II.REPORT_FIT };
const solution = II.minimize(params);
close(II.area(0, 5), Math.PI * 25);
close(II.coverage(10, params), 2 * Math.PI * 25);
close(solution.d, 20);
close(solution.H, 29.1781283829);
close(solution.slopeAtR, -0.08476000073);
assert.equal(solution.sufficientForR, true);
const custom = { ...params, alpha: 5, beta: 0, gamma: 0 };
const interior = II.minimize(custom);
assert.ok(interior.d > 0 && interior.d < 2 * custom.L);
assert.ok(Math.abs(II.derivative(interior.d, custom)) < 1e-8);
assert.equal(II.minimize({ ...custom, alpha: 10000 }).d, 0);
assert.equal(II.minimize({ ...custom, alpha: 0 }).flatOptimum, true);
assert.equal(II.minimize({ ...params, R: 8, alpha: 0 }).d, 8);
for (const p of [params, custom, { ...params, beta: 10, gamma: 1 }]) {
  const exact = II.minimize(p).H;
  const grid = Array.from({ length: 2001 }, (_, i) => II.H(p.R * i / 2000, p));
  assert.ok(exact <= Math.min(...grid) + 1e-9);
}
const synthetic = [12.5, 15, 17.5, 20].map(d => ({
  d, observed: -params.beta * Math.expm1(-params.gamma * (d - 10))
}));
const fit = II.fitCoverage(synthetic, 5);
close(fit.beta, params.beta, 1e-4);
close(fit.gamma, params.gamma, 1e-5);
const design = Study.design(I.config(), 'all');
assert.equal(design.length, 48);
assert.equal(Study.design(I.config(), 'honesty').length, 15);
assert.equal(Study.design(I.config(), 'validation').length, 24);
const short = Study.run({}, { K: 3, horizons: [60], raw: true });
assert.equal(short.raw.length, 48 * 3);
const silentR = short.rows.find(r => r.d === 20 && r.rule === 'c0');
const lieR = short.rows.find(r => r.d === 20 && r.p === 0);
close(silentR.mean, lieR.mean);
assert.deepEqual(lieR.counts.slice(1), [0, 0, 0]);

console.log('PASS: Model I rules, priority, range, mass, reproducibility, Model II optima and paired study design');
