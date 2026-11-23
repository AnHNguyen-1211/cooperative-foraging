'use strict';

const fs = require('node:fs');
const path = require('node:path');
const I = require('../dist/engine.js');
const II = require('../dist/model-ii.js');
const Study = require('../dist/study.js');

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log(`node scripts/run_experiment.cjs case-study [--study all|information|honesty|validation] [--K 1200] [--out results/case-study.json] [--raw true]
node scripts/run_experiment.cjs calibrate [--K 3000] [--batches 2] [--T 360] [--out results/calibration.json]
node scripts/run_experiment.cjs optimum
node scripts/run_experiment.cjs trajectory [--rule c0|c1|c2|mixed|random|a|b|c|d] [--p 0.5] [--out results/trajectory.json]
Common overrides: --seed --N --L --R --d --v --q --T --dt --foodMu --foodSigma --turnTime --turnSD`);
    return;
  }
  const args = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!flags[i].startsWith('--') || flags[i + 1] === undefined) throw Error('Use --flag value. See --help.');
    args[flags[i].slice(2)] = flags[i + 1];
  }
  const input = {};
  for (const key of ['seed', 'N', 'L', 'R', 'd', 'v', 'q', 'T', 'dt', 'foodMu', 'foodSigma', 'turnTime', 'turnSD']) {
    if (args[key] !== undefined) input[key] = Number(args[key]);
  }
  if (input.d === undefined) input.d = input.R ?? I.CASE_STUDY.R;
  const onProgress = ({ done, total }) => {
    if (done === total || done % 100 === 0) process.stderr.write(`${done}/${total} matched trials\n`);
  };
  let result;
  if (command === 'case-study') {
    result = Study.run(input, {
      K: Number(args.K ?? 1200), study: args.study ?? 'all', onProgress,
      raw: args.raw === 'true', horizons: input.T !== undefined ? [input.T] : undefined
    });
  } else if (command === 'calibrate') {
    result = await II.calibration({ T: 360, ...input }, {
      K: Number(args.K ?? 3000), batches: Number(args.batches ?? 2),
      method: args.method, onProgress
    });
  } else if (command === 'optimum') {
    const params = { ...I.CASE_STUDY, ...input, ...II.REPORT_FIT };
    result = { params, optimum: II.minimize(params) };
  } else if (command === 'trajectory') {
    result = I.simulate({ ...input, ...I.policy(args.rule ?? 'c2', Number(args.p ?? 0.5)) });
  } else {
    throw Error('Unknown command. See --help.');
  }
  const json = JSON.stringify(result, null, 2) + '\n';
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, json);
    console.log(path.resolve(args.out));
  } else {
    process.stdout.write(json);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
