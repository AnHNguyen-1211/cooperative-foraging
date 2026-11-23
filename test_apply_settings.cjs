'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const I = require('../dist/engine.js');
const II = require('../dist/model-ii.js');
const Study = require('../dist/study.js');
const root = path.resolve(__dirname, '../dist');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const noOp = () => {};
const context = new Proxy({}, { get: () => noOp, set: () => true });

function element(value = '') {
  const handlers = {};
  return {
    value, textContent: '', disabled: false, hidden: false, dataset: {},
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
    addEventListener(name, fn) { handlers[name] = fn; },
    emit(name) { (handlers[name] ?? this['on' + name])?.({ preventDefault: noOp }); },
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 480, height: 320 }),
    checkValidity: () => true,
    setAttribute: noOp, removeAttribute: noOp, append: noOp,
    add: noOp, replaceChildren: noOp, classList: { toggle: noOp }
  };
}

function card() {
  const nodes = new Map();
  return {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    }
  };
}

const elements = new Map([...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)].map(match =>
  [match[1], element(match[0].match(/\bvalue="([^"]*)"/)?.[1])]));
const $ = id => {
  assert.ok(elements.has(id), 'Missing element ' + id);
  return elements.get(id);
};
const cards = [card(), card()];
let cardIndex = 0;
$('card').content = { firstElementChild: { cloneNode: () => cards[cardIndex++] } };
$('scenario').value = 'encounter';
$('fitMode').value = 'report';
$('environment').value = 'report';
$('T').value = '25';
const tabs = ['trajectory', 'distance', 'experiments'].map(tab => Object.assign(element(), { dataset: { tab } }));
const requests = [];

class Worker {
  postMessage(data) {
    requests.push({ worker: this, data });
  }
  terminate() {
    this.terminated = true;
  }
}

const document = {
  getElementById: $, querySelectorAll: () => tabs, createElement: () => element()
};
vm.runInNewContext(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), {
  document, window: { addEventListener: noOp }, devicePixelRatio: 1, requestAnimationFrame: noOp,
  Worker, Option: class {}, DOMException, Scudem: I, ScudemII: II, ScudemStudy: Study
}, { filename: 'app.js' });

async function complete() {
  const { worker, data } = requests.at(-1);
  const result = data.options.weights.map(weights => I.simulate({ ...data.config, weights }));
  worker.onmessage({ data: { result } });
  await Promise.resolve();
  assert.equal($('applyStatus').dataset.state, 'applied');
  return result;
}

(async () => {
  const first = await complete();
  $('timeline').value = 25;
  $('timeline').emit('input');
  assert.notEqual(cards[0].querySelector('.food').textContent, '0.0');

  cards[1].querySelector('select').value = 'random';
  $('p').value = 0;
  $('q').value = 6.8;
  $('N').value = 30;
  $('settings').emit('input');
  $('settings').emit('submit');
  assert.equal($('timeline').value, '0');
  assert.equal(cards[0].querySelector('.food').textContent, '—');
  assert.equal($('play').disabled, true);
  const second = await complete();
  assert.equal(second[1].config.N, 30);
  assert.equal(second[1].config.q, 6.8);
  assert.ok(second[1].decisions.every(message => message.truthful === false));
  assert.notEqual(second[0].F, first[0].F);
  assert.equal($('timeline').value, 0);
  assert.equal(cards[0].querySelector('.food').textContent, '0.0');
  assert.equal($('play').disabled, false);

  $('settings').emit('submit');
  const stale = requests.at(-1);
  $('N').value = 12;
  $('settings').emit('input');
  assert.ok(stale.worker.terminated);
  $('settings').emit('submit');
  const third = await complete();
  stale.worker.onmessage({ data: { result: first } });
  await Promise.resolve();
  assert.equal(third[0].world.foods.length, 12);
  assert.match($('insight').textContent, /N = 12/);

  $('L').value = 200;
  $('settings').emit('submit');
  assert.equal($('applyStatus').dataset.state, 'error');
  assert.equal($('play').disabled, true);
  assert.equal($('downloadReplay').disabled, true);
  console.log('PASS: Apply clears outputs, uses edited settings, supersedes stale work and blocks invalid replay');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
