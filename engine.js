(function (root) {
'use strict';

const TAU = 2 * Math.PI;
const EPS = 1e-8;
const CONTACT = 1e-7;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const wrap = x => Math.atan2(Math.sin(x), Math.cos(x));
function unit(x, y) {
  const d = Math.hypot(x, y);
  return d > 1e-14 ? {x: x / d, y: y / d}: {x: 0, y: 0};
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6D2B79F5;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(seed, trial, stream) {
  let x = (seed ^ Math.imul(trial + 1, 0x9e3779b1) ^ Math.imul(stream + 1, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
function normal(rand) {
  return Math.sqrt(-2 * Math.log(Math.max(1e-15, rand()))) * Math.cos(TAU * rand());
}

const CASE_STUDY = Object.freeze({
  width: 500, height: 500, N: 20, L: 5, R: 20, d: 20,
  v: 25, q: 3.4, foodMu: Math.log(300), foodSigma: 0.7
});
const LEVELS = [-1, 0, 1, 2];
const POLICIES = Object.freeze({
  c0: { label: 'C = 0 · No information', weights: [0, 1, 0, 0] },
  c1: { label: 'C = 1 · Discovery information', weights: [0, 0, 1, 0] },
  c2: { label: 'C = 2 · Location information', weights: [0, 0, 0, 1] },
  mixed: { label: 'Mixed truthful · C = 1 or 2', weights: [0, 0, 0.5, 0.5] },
  a: { label: 'A · Reliable', weights: [0.05, 0.05, 0.45, 0.45] },
  b: { label: 'B · Moderate', weights: [0.20, 0.10, 0.35, 0.35] },
  c: { label: 'C · Unreliable', weights: [0.40, 0.20, 0.20, 0.20] },
  d: { label: 'D · Severely unreliable', weights: [0.60, 0.20, 0.10, 0.10] }
});
const INFORMATION = {
  '-1': 'False negative', 0: 'No information', 1: 'Discovery information', 2: 'Location information'
};

function policy(id, p = 0.5) {
  if (id === 'random') {
    if (!Number.isFinite(p) || p < 0 || p > 1) throw Error('Truthfulness p must be between 0 and 1.');
    return { label: 'Random honesty · p = ' + p, weights: [1 - p, 0, p / 2, p / 2] };
  }
  if (!Object.hasOwn(POLICIES, id)) throw Error('Unknown communication rule.');
  const { label, weights } = POLICIES[id];
  return { label, weights: [...weights] };
}

function config(input = {}) {
  const c = {
    ...CASE_STUDY, T: 240, dt: 0.1, turnTime: 0.5, turnSD: 0.6,
    seed: 42, trial: 0, weights: POLICIES.c2.weights, track: true,
    frameEvery: 0.25, conditionInitial: true, stopAtFirstHit: false,
    resampleWorld: true, ...input
  };
  for (const key of ['width', 'height', 'L', 'R', 'v', 'q', 'T', 'dt', 'turnTime', 'frameEvery']) {
    if (!Number.isFinite(c[key]) || c[key] <= 0) throw Error(key + ' must be positive.');
  }
  if (!(c.L < c.R && c.R < Math.min(c.width, c.height))) {
    throw Error('Use 0 < L < R, with R smaller than both arena sides.');
  }
  if (!Number.isFinite(c.d) || c.d < 0 || c.d > c.R) throw Error('Use 0 ≤ d ≤ R.');
  if (!Number.isInteger(c.N) || c.N < 1 || c.N > 10000) throw Error('N must be an integer from 1 to 10000.');
  if (!Number.isFinite(c.foodMu) || !Number.isFinite(c.foodSigma) || c.foodSigma < 0) {
    throw Error('Use a finite log-mass mean and a nonnegative log-mass standard deviation.');
  }
  if (!Number.isFinite(c.turnSD) || c.turnSD < 0) throw Error('Turning SD must be nonnegative.');
  if (!Number.isInteger(c.seed) || !Number.isInteger(c.trial)) throw Error('Seed and trial must be integers.');
  if (!Array.isArray(c.weights) || c.weights.length !== 4 ||
      c.weights.some(x => !Number.isFinite(x) || x < 0 || x > 1) ||
      Math.abs(c.weights.reduce((sum, x) => sum + x, 0) - 1) > EPS) {
    throw Error('The four information probabilities must be between 0 and 1 and sum to 1.');
  }
  c.dt = Math.min(c.dt, c.L / (2 * c.v), c.turnTime / 2);
  if (c.T / c.dt > 5e6 || c.T / c.turnTime > 1e6) throw Error('Reduce the horizon or increase the step size.');
  return c;
}

function validateWorld(world, c) {
  if (!world || world.agents?.length !== 2 || !Array.isArray(world.foods) || !world.foods.length) {
    throw Error('A world needs two foragers and at least one food patch.');
  }
  for (const point of [...world.agents, ...world.foods]) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !inside(point, c)) {
      throw Error('Every position must be inside the arena.');
    }
  }
  for (const food of world.foods) {
    if (!Number.isFinite(food.mass) || food.mass <= 0) throw Error('Patch mass must be finite and positive.');
  }
  if (dist(...world.agents) > c.R + EPS) throw Error('Initial separation exceeds R.');
}

function initialPair(c, foods, distances) {
  const rand = rng(seedOf(c.seed, c.resampleWorld ? c.trial : 0, 2));
  for (let attempt = 0; attempt < 30000; attempt++) {
    const a = { x: rand() * c.width, y: rand() * c.height };
    const angle = rand() * TAU;
    const starts = distances.map(d => ({ x: a.x + d * Math.cos(angle), y: a.y + d * Math.sin(angle) }));
    if (starts.some(b => !inside(b, c))) continue;
    if (c.conditionInitial && foods.some(f => dist(f, a) <= c.L || starts.some(b => dist(f, b) <= c.L))) continue;
    return starts.map(b => ({ foods, agents: [a, b] }));
  }
  throw Error('No undetected initial pair was found. Lower patch density or L, or try a different seed.');
}

function pairedWorlds(input, distances) {
  const c = config(input);
  if (distances.some(d => !Number.isFinite(d) || d < 0 || d > c.R)) throw Error('Every separation must lie in [0, R].');
  if (c.world) {
    validateWorld(c.world, c);
    if (distances.length !== 1) throw Error('An explicit world supports a single initial separation.');
    return [c.world];
  }
  const trial = c.resampleWorld ? c.trial : 0;
  const rand = rng(seedOf(c.seed, trial, 0));
  const massRand = rng(seedOf(c.seed, trial, 1));
  const foods = Array.from({ length: c.N }, (_, id) => ({
    id, x: rand() * c.width, y: rand() * c.height,
    mass: Math.exp(c.foodMu + c.foodSigma * normal(massRand))
  }));
  if (foods.some(f => !Number.isFinite(f.mass) || f.mass <= 0)) throw Error('The lognormal parameters produced an out-of-range mass.');
  return initialPair(c, foods, distances);
}

function makeWorld(input = {}) {
  const c = config(input);
  return pairedWorlds(c, [c.d])[0];
}

function move(p, goal, s) {
  const d = dist(p, goal);
  return d <= s + 1e-12 ? {x: goal.x, y: goal.y}: {x: p.x + (goal.x - p.x) * s / d, y: p.y + (goal.y - p.y) * s / d};
}
function inside(p, c) {
  return p.x >= -1e-9 && p.x <= c.width + 1e-9 && p.y >= -1e-9 && p.y <= c.height + 1e-9;
}
function reflected(p, c) {
  function fold(x, m) {
    let z = ((x % (2 * m)) + 2 * m) % (2 * m);
    return z <= m ? z: 2 * m - z;
  }
  return {x: fold(p.x, c.width), y: fold(p.y, c.height)};
}

function rigidStep(a, b, theta, v, h, branch) {
  const d = dist(a, b), an = {x: a.x + v * h * Math.cos(theta), y: a.y + v * h * Math.sin(theta)};
  if (d < 1e-7 || branch === 0)return [an, {x: b.x + an.x - a.x, y: b.y + an.y - a.y}];
  const psi = wrap(Math.atan2(b.y - a.y, b.x - a.x) - theta), z = 2 * v * h / d;
  let psin;
  if (z > 35)psin = Math.sign(psi || 1) * Math.PI; else psin = 2 * Math.atan2(Math.sin(psi / 2) * Math.exp(z), Math.cos(psi / 2));
  return [an, {x: an.x + d * Math.cos(theta + psin), y: an.y + d * Math.sin(theta + psin)}];
}
function rigidBounded(a, b, theta, v, h, branch, c) {
  const first = rigidStep(a, b, theta, v, h, branch);
  if (first.every(p => inside(p, c)))return {positions: first, boundary: false};
  const tries = [theta];
  const badX = first.some(p => p.x < 0 || p.x > c.width), badY = first.some(p => p.y < 0 || p.y > c.height);
  if (badX)tries.push(Math.PI - theta);
  if (badY)tries.push(-theta);
  if (badX && badY)tries.push(theta + Math.PI);
  for (let k = 1; k < 32; k++)tries.push(theta + TAU * k / 32);
  for (const br of [branch, 0])for (const th of tries) {
    const out = rigidStep(a, b, th, v, h, br);
    if (out.every(p => inside(p, c)))return {positions: out, boundary: Math.abs(wrap(th - theta)) > 1e-8 || br !== branch};
  }
  throw Error('No feasible paired step at the boundary. Reduce dt.');
}
function circles(a, r, b, R) {
  const d = dist(a, b);
  if (d < 1e-14 || d > r + R + 1e-8 || d < Math.abs(r - R) - 1e-8)return [];
  const x = (r * r - R * R + d * d) / (2 * d),
    hh = Math.sqrt(Math.max(0, r * r - x * x)),
    u = unit(b.x - a.x, b.y - a.y),
    p = {x: a.x + x * u.x, y: a.y + x * u.y};
  return [{x: p.x - hh * u.y, y: p.y + hh * u.x}, {x: p.x + hh * u.y, y: p.y - hh * u.x}];
}

function constrainedMove(b, goal, an, R, s, c) {
  const desired = move(b, goal, s);
  if (dist(desired, an) <= R + 1e-10)return desired;
  const candidates = [b, move(an, b, R), move(an, goal, R), ...circles(b, s, an, R)];
  for (const x of [0, c.width])for (const [center, r] of [[b, s], [an, R]]) {
    const z = r * r - (x - center.x)**2;
    if (z >= 0) {
      const q = Math.sqrt(z);
      candidates.push({x, y: center.y + q}, {x, y: center.y - q});
    }
  }
  for (const y of [0, c.height])for (const [center, r] of [[b, s], [an, R]]) {
    const z = r * r - (y - center.y)**2;
    if (z >= 0) {
      const q = Math.sqrt(z);
      candidates.push({x: center.x + q, y}, {x: center.x - q, y});
    }
  }
  const good = candidates.filter(p => inside(p, c) && dist(p, b) <= s + 1e-7 && dist(p, an) <= R + 1e-7);
  if (!good.length)throw Error('No feasible constrained step. Reduce dt.');
  good.sort((x, y) => dist(x, goal) - dist(y, goal));
  return good[0];
}
function pursueRK4(follower, leader, nextLeader, speed, step) {
  function velocity(time, point) {
    const x = leader.x + (nextLeader.x - leader.x) * time / step;
    const y = leader.y + (nextLeader.y - leader.y) * time / step;
    const direction = unit(x - point.x, y - point.y);
    return { x: direction.x * speed, y: direction.y * speed };
  }

  function midpoint(slope) {
    return {
      x: follower.x + slope.x * step / 2,
      y: follower.y + slope.y * step / 2
    };
  }

  const k1 = velocity(0, follower);
  const k2 = velocity(step / 2, midpoint(k1));
  const k3 = velocity(step / 2, midpoint(k2));
  const k4 = velocity(step, { x: follower.x + k3.x * step, y: follower.y + k3.y * step });
  return {
    x: follower.x + step * (k1.x + 2 * k2.x + 2 * k3.x + k4.x) / 6,
    y: follower.y + step * (k1.y + 2 * k2.y + 2 * k3.y + k4.y) / 6
  };
}

function circleEntry(p, pn, f, r) {
  const dx = pn.x - p.x, dy = pn.y - p.y, ox = p.x - f.x, oy = p.y - f.y, C = ox * ox + oy * oy - r * r;
  if (C <= 1e-10)return 0;
  const A = dx * dx + dy * dy;
  if (A < 1e-20)return null;
  const B = 2 * (ox * dx + oy * dy), D = B * B - 4 * A * C;
  if (D < 0)return null;
  const u = (-B - Math.sqrt(D)) / (2 * A);
  return u >= -1e-10 && u <= 1 + 1e-10 ? clamp(u, 0, 1): null;
}
function summarize(xs) {
  if (!xs.length)return {n: 0, mean: null, sd: null, se: null};
  const n = xs.length,
    mean = xs.reduce((s, x) => s + x, 0) / n,
    sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean)**2, 0) / (n - 1)): 0;
  return {n, mean, sd, se: sd / Math.sqrt(n)};
}

function headingSchedule(c, index) {
  const rand = rng(seedOf(c.seed, c.trial, index));
  let heading = rand() * TAU;
  return Float64Array.from({ length: Math.ceil(c.T / c.turnTime) + 1 }, (_, epoch) => {
    if (epoch > 0) heading = wrap(heading + c.turnSD * normal(rand));
    return heading;
  });
}

function offset(point, heading, length) {
  return { x: point.x + length * Math.cos(heading), y: point.y + length * Math.sin(heading) };
}

function distanceFollower(a, b, an, radius, step, heading, branch, h, c) {
  const gap = dist(a, b);
  if (Math.abs(gap - radius) <= CONTACT) {
    if (dist(a, an) <= EPS) return b;
    const direction = Math.atan2(an.y - a.y, an.x - a.x);
    for (const choice of [branch, 1 - branch]) {
      const [, candidate] = rigidStep(a, b, direction, c.v, h, choice);
      if (inside(candidate, c) && dist(b, candidate) <= step + EPS) return candidate;
    }
  }
  const angle = gap > EPS ? Math.atan2(b.y - a.y, b.x - a.x) : heading;
  const bearing = gap > radius ? angle + Math.PI : angle;
  const desired = reflected(offset(b, bearing, step), c);
  const fromLeader = dist(an, desired) > EPS ? Math.atan2(desired.y - an.y, desired.x - an.x) : angle;
  const contact = offset(an, fromLeader, radius);
  if ((gap - radius) * (dist(an, desired) - radius) <= 0 &&
      dist(b, contact) <= step + EPS && inside(contact, c)) return contact;
  return constrainedMove(b, desired, an, c.R, step, c);
}

function tetherExitTime(leader, target, follower, c) {
  const velocity = unit(target.x - leader.x, target.y - leader.y);
  const x = leader.x - follower.x, y = leader.y - follower.y;
  const along = x * velocity.x + y * velocity.y;
  const inside = Math.max(0, c.R ** 2 - x ** 2 - y ** 2);
  const root = Math.sqrt(along ** 2 + inside);
  const length = along > 0 ? inside / (root + along) : root - along;
  return length / c.v;
}

function simulate(input = {}) {
  const c = config(input);
  const world = makeWorld(c);
  const foods = world.foods.map((f, id) => ({
    ...f, id, remaining: f.mass, arrivals: [null, null], firstDiscovery: null, C: null, finder: null
  }));
  const agents = world.agents.map((point, id) => ({
    ...point, id, total: 0, target: null, pursuit: false, arrived: false, state: 'search'
  }));
  const events = [], frames = [], decisions = [], samples = [];
  const sampleTimes = [...new Set(c.sampleTimes ?? [])].sort((a, b) => a - b);
  if (sampleTimes.some(x => !Number.isFinite(x) || x < 0 || x > c.T)) throw Error('Sample times must lie within the horizon.');
  const headings = [headingSchedule(c, 3), headingSchedule(c, 4)];
  const branchRand = rng(seedOf(c.seed, c.trial, 7));
  const branches = Uint8Array.from({ length: headings[0].length }, () => branchRand() < 0.5 ? 0 : 1);
  const messageRand = rng(seedOf(c.seed, c.trial, 5));
  const weightSum = c.weights.reduce((sum, x) => sum + x, 0);
  const foodMass = foods.reduce((sum, f) => sum + f.mass, 0);
  const diagnostics = {
    steps: 0, boundarySteps: 0, maxGap: dist(...agents), maxSpeed: 0,
    maxSearchDistanceError: 0, rangeViolations: 0, finiteFoodError: 0
  };
  let t = 0, lead = 0, firstFood = null, firstHit = null, bothAt = null, nextFrame = 0;
  let activeCount = foods.length;
  const total = () => agents[0].total + agents[1].total;
  const log = (type, message, details) => {
    if (c.track) events.push({ time: t, type, message, ...details });
  };
  const name = i => i === 0 ? 'A' : 'B';
  const known = agent => agent.target !== null && !agent.pursuit;
  const live = agent => agent.target !== null && foods[agent.target].remaining > EPS;

  function assign(agent, food, pursuit = false) {
    agent.target = food.id;
    agent.pursuit = pursuit;
    agent.arrived = false;
  }

  function applyMessage(food, receiver) {
    if (receiver.target === null && food.C >= 1) assign(receiver, food, food.C === 1);
  }

  function detect(agent, food) {
    assign(agent, food);
    if (food.firstDiscovery !== null) {
      log('detect', name(agent.id) + ' independently detects patch ' + (food.id + 1), { agent: agent.id, food: food.id });
      return;
    }
    food.firstDiscovery = t;
    food.finder = agent.id;
    if (firstHit === null) {
      firstHit = t;
      firstFood = food.id;
    }
    if (!known(agents[lead])) lead = agent.id;

    let draw = messageRand() * weightSum;
    let index = 0;
    while (index < LEVELS.length - 1 && draw >= c.weights[index]) draw -= c.weights[index++];
    food.C = LEVELS[index];
    const truthful = food.C === 0 ? null : food.C > 0;
    const decision = { time: t, agent: agent.id, food: food.id, mass: food.mass, C: food.C, truthful };
    decisions.push(decision);
    log('discover', name(agent.id) + ' discovers patch ' + (food.id + 1) + ' · C = ' + food.C + ' · ' + INFORMATION[food.C], decision);
    applyMessage(food, agents[1 - agent.id]);
  }

  function resolve() {
    for (const agent of agents) {
      if (agent.target !== null && !live(agent)) {
        agent.target = null;
        agent.pursuit = false;
        agent.arrived = false;
      }
    }
    const other = agents[1 - lead];
    if (!known(agents[lead]) && known(other)) {
      lead = other.id;
      log('role', name(lead) + ' takes trajectory priority', { agent: lead });
      const food = foods[other.target];
      if (food.finder === lead) applyMessage(food, agents[1 - lead]);
    }

    for (const i of [lead, 1 - lead]) {
      const agent = agents[i];
      if (!known(agent)) {
        let closest = null;
        let best = c.L + CONTACT;
        for (const food of foods) {
          if (food.remaining <= EPS) continue;
          const dx = agent.x - food.x, dy = agent.y - food.y;
          if (Math.abs(dx) > best || Math.abs(dy) > best) continue;
          const distance = Math.hypot(dx, dy);
          if (distance <= best && (!closest || distance < best)) {
            closest = food;
            best = distance;
          }
        }
        if (closest) detect(agent, closest);
      }
    }
    for (const agent of agents) {
      if (known(agent)) {
        const food = foods[agent.target];
        if (!agent.arrived && dist(agent, food) <= CONTACT) {
          agent.arrived = true;
          food.arrivals[agent.id] ??= t;
          log('arrive', name(agent.id) + ' reaches patch ' + (food.id + 1), { agent: agent.id, food: food.id });
        }
      }
      agent.state = agent.arrived ? 'eat' : agent.pursuit ? 'pursue' :
        agent.target !== null ? 'approach' : activeCount ? 'search' : 'done';
    }
    if (firstFood !== null && foods[firstFood].arrivals.every(x => x !== null)) {
      bothAt ??= Math.max(...foods[firstFood].arrivals);
    }
  }

  function predict(h, epoch) {
    const a = agents[lead], b = agents[1 - lead];
    const step = c.v * h, heading = headings[lead][epoch], branch = branches[epoch];
    let an, bn, boundary = false, fixed = false;
    if (!known(a)) {
      if (Math.abs(dist(a, b) - c.d) <= CONTACT) {
        const result = rigidBounded(a, b, heading, c.v, h, branch, c);
        [an, bn] = result.positions;
        boundary = result.boundary;
        fixed = true;
      } else {
        const straight = offset(a, heading, step);
        an = reflected(straight, c);
        boundary = !inside(straight, c);
        bn = distanceFollower(a, b, an, c.d, step, headings[b.id][epoch], branch, h, c);
      }
    } else {
      const food = foods[a.target];
      an = a.arrived ? a : move(a, food, step);
      if (b.pursuit) {
        const pursued = a.arrived ? move(b, a, step) : pursueRK4(b, a, an, c.v, h);
        bn = constrainedMove(b, reflected(pursued, c), an, c.R, step, c);
      } else if (known(b)) {
        bn = constrainedMove(b, foods[b.target], an, c.R, step, c);
      } else {
        const radius = food.C === -1 && food.finder === lead ? c.R : c.d;
        bn = distanceFollower(a, b, an, radius, step, headings[b.id][epoch], branch, h, c);
      }
    }
    return { out: lead === 0 ? [an, bn] : [bn, an], boundary, fixed };
  }

  function snapshot() {
    if (!c.track) return;
    frames.push({
      t, agents: agents.map(a => ({ ...a })), remaining: foods.map(f => f.remaining), F: total()
    });
    nextFrame = t + c.frameEvery;
  }

  function takeSamples() {
    while (samples.length < sampleTimes.length && sampleTimes[samples.length] <= t + EPS) {
      samples.push({ time: sampleTimes[samples.length], F: total() });
    }
  }

  resolve();
  snapshot();
  takeSamples();
  while (t < c.T - EPS && !(c.stopAtFirstHit && firstHit !== null)) {
    if (diagnostics.steps > 1e7) throw Error('Too many simulation steps.');
    if (!activeCount) {
      t = c.T;
      takeSamples();
      break;
    }
    const epoch = Math.floor((t + 1e-9) / c.turnTime);
    const leader = agents[lead], follower = agents[1 - lead];
    const nextSample = sampleTimes[samples.length] ?? c.T;
    let h = Math.min(c.T - t, nextSample - t);
    if (follower.arrived && known(leader) && !leader.arrived) {
      const exit = tetherExitTime(leader, foods[leader.target], follower, c);
      if (exit <= EPS) {
        follower.arrived = false;
        log('leave', name(follower.id) + ' leaves its patch to stay within R', { agent: follower.id, food: follower.target });
      } else {
        h = Math.min(h, exit);
      }
    }
    const eatA = agents[0].arrived ? foods[agents[0].target] : null;
    const eatB = agents[1].arrived ? foods[agents[1].target] : null;
    const leaderFood = lead === 0 ? eatA : eatB;
    const restingGap = leaderFood?.C === -1 && leaderFood.finder === lead ? c.R : c.d;
    const stationary = Boolean((eatA && eatB) || (leaderFood && follower.target === null &&
      Math.abs(dist(...agents) - restingGap) <= CONTACT));
    if (!stationary) h = Math.min(h, c.dt, (epoch + 1) * c.turnTime - t);
    else if (c.track) h = Math.min(h, nextFrame - t);
    if (eatA) h = Math.min(h, eatA.remaining / (c.q * (eatA === eatB ? 2 : 1)));
    if (eatB && eatB !== eatA) h = Math.min(h, eatB.remaining / c.q);
    for (const agent of agents) {
      if (!known(agent) || agent.arrived) continue;
      const travel = dist(agent, foods[agent.target]);
      if (travel > CONTACT) h = Math.min(h, travel / c.v);
    }

    if (!(t + h > t)) throw Error('The solver cannot advance time. Check the numerical settings.');
    let predicted = stationary ? { out: agents } : predict(h, epoch);

    for (let refine = 0; !stationary && refine < 10; refine++) {
      let fraction = 1;
      for (const agent of agents) {
        if (known(agent)) continue;
        const end = predicted.out[agent.id];
        const left = Math.min(agent.x, end.x) - c.L, right = Math.max(agent.x, end.x) + c.L;
        const bottom = Math.min(agent.y, end.y) - c.L, top = Math.max(agent.y, end.y) + c.L;
        for (const food of foods) {
          if (food.remaining <= EPS || food.x < left || food.x > right || food.y < bottom || food.y > top) continue;
          const crossing = circleEntry(agent, end, food, c.L);
          if (crossing !== null && crossing > EPS && crossing < fraction) fraction = crossing;
        }
      }
      if (fraction >= 1 - 1e-7 || h < CONTACT) break;
      h *= fraction;
      predicted = predict(h, epoch);
    }

    for (const agent of agents) {
      const end = predicted.out[agent.id];
      diagnostics.maxSpeed = Math.max(diagnostics.maxSpeed, dist(agent, end) / h);
      agent.x = clamp(end.x, 0, c.width);
      agent.y = clamp(end.y, 0, c.height);
    }
    const gap = dist(...agents);
    diagnostics.maxGap = Math.max(diagnostics.maxGap, gap);
    if (gap > c.R + 1e-6) diagnostics.rangeViolations++;
    if (predicted.fixed) diagnostics.maxSearchDistanceError = Math.max(diagnostics.maxSearchDistanceError, Math.abs(gap - c.d));
    if (predicted.boundary) diagnostics.boundarySteps++;
    t += h;
    diagnostics.steps++;
    for (const food of [eatA, eatB === eatA ? null : eatB]) {
      if (!food) continue;
      const count = Number(food === eatA) + Number(food === eatB);
      const eaten = Math.min(food.remaining, count * c.q * h);
      if (food === eatA) agents[0].total += eaten / count;
      if (food === eatB) agents[1].total += eaten / count;
      food.remaining -= eaten;
      if (food.remaining <= EPS) {
        activeCount--;
        log('empty', 'Patch ' + (food.id + 1) + ' is depleted', { food: food.id });
      }
    }
    resolve();
    takeSamples();
    if (c.track && t >= nextFrame - EPS) snapshot();
  }

  if (c.track && t > frames.at(-1).t + EPS) snapshot();
  diagnostics.finiteFoodError = Math.abs(total() - foods.reduce((sum, f) => sum + f.mass - f.remaining, 0));
  return {
    config: c, world, foods, agents, frames, events, decisions, samples, F: total(), t,
    firstHit, firstFood, bothAt, totalFood: foodMass, diagnostics
  };
}

const api = {
  CASE_STUDY, INFORMATION, POLICIES, policy, config, simulate, makeWorld, pairedWorlds,
  rng, seedOf, dist, summarize, rigidStep, constrainedMove, circleEntry
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.Scudem = api;
})(typeof window !== 'undefined' ? window : globalThis);
