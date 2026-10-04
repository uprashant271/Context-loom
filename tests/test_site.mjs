import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../site/dist/app.js', import.meta.url), 'utf8');
const motionSource = readFileSync(new URL('../site/dist/motion.js', import.meta.url), 'utf8');

// A small DOM substitute keeps these tests about observable UI state and resource
// lifetime. Real rendering, animation smoothness and layout are checked in-browser.
class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(callback); this.listeners.set(type, listeners);
  }
  async emit(type, properties = {}) {
    const event = { type, target: this, preventDefault() { this.defaultPrevented = true; }, ...properties };
    await Promise.all((this.listeners.get(type) || []).map(callback => callback(event)));
    return event;
  }
}
class Element extends Events {
  constructor(tag = 'div') {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map();
    this.style = {}; this.disabled = false; this.hidden = false; this.scrollTop = 0;
    this._text = ''; this._value = ''; this.className = ''; this.animations = [];
    this.rect = { top: 40, bottom: 140, left: 0, right: 300 };
    this.classList = {
      add: name => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.classList.contains(name) : force;
        this.classList[enabled ? 'add' : 'remove'](name); return enabled;
      },
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  append(...children) {
    for (const child of children) {
      if (child.tagName === '#FRAGMENT') this.append(...child.children);
      else { child.parentElement = this; this.children.push(child); }
    }
  }
  replaceChildren(...children) {
    this.children = []; this._text = ''; this.append(...children);
    if (this.tagName === 'SELECT' && !this.children.some(child => child.value === this._value)) this._value = this.children[0]?.value || '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.focused = true; }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  matches(selector) { return selector === '.steps article' && this.isStep; }
  getBoundingClientRect() { return this.rect; }
  querySelector(selector) {
    if (selector === '.button-label') return this.children.find(child => child.classList.contains('button-label')) || null;
    if (selector === 'button[type=submit]') return this.children.find(child => child.tagName === 'BUTTON') || null;
    const option = selector.match(/^option\[value=(.+)\]$/);
    if (option) return this.children.find(child => child.value === option[1]) || null;
    throw new Error(`Unhandled element selector: ${selector}`);
  }
  animate(keyframes, options) {
    const finished = deferred();
    const animation = { keyframes, options, finished: finished.promise, cancelled: false, cancel() { this.cancelled = true; finished.reject(new Error('Cancelled')); }, finish: finished.resolve };
    this.animations.push(animation); return animation;
  }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const clone = value => JSON.parse(JSON.stringify(value));
const fixture = id => ({ id, task: `Continue ${id}`, pins: [`${id}-1`], messages: [{ id: `${id}-1`, role: 'user', content: `Keep ${id}` }, { id: `${id}-2`, role: 'assistant', content: `Working on ${id}` }], evaluation: { question: `What is ${id}?`, required: [[id]] } });
const fixtures = [fixture('first_case'), fixture('second_case')];
function run(provider) {
  return {
    manifest: { provider, memory_budget: 1024, requested_summarizer_model: 'local-test', metrics: [{ method: 'hybrid', passed_cases: 2, planned_cases: 2, completed_reader_cases: 2, mean_compaction_seconds: .25 }] },
    records: fixtures.map(item => ({ case_id: item.id, method: 'hybrid', status: 'ready', compaction_seconds: .25, memory_count: 30, grade: { passed: true }, reader_answer: { answer: item.id }, artifact: { status: 'ready', selected_ids: [item.messages[0].id], retained_ids: [item.messages[0].id], replacement_messages: [{ role: 'system', content: `${provider}: ${item.id}` }] } })),
  };
}
const data = { 'fixtures.json': fixtures, 'results.json': run('local'), 'claude-results.json': run('claude') };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return clone(value); } });

function environment({ local = false, fetcher, clipboard, reduced = false, motion = false } = {}) {
  const document = new Events(), window = new Events(), preference = new Events();
  const elements = new Map(), calls = [], tools = [], observers = [], timers = new Map(), pulseCalls = [], busyCalls = [];
  let timerId = 0;
  const selectors = ['#case-select', '#method-select', '#run-select', '#replay', '#load-example', '.lab-grid', '#session-input', '#editor-note', '#messages', '#source-count', '#lab-state', '#memory', '#memory-count', '#qa', '#local-form', '#results-content', '#threshold', '#threshold-value', '#meter-fill', '#threshold-note', '#copy-install', '#copy-status', '.code-block pre', '#local-instructions', '#local-result'];
  for (const selector of selectors) elements.set(selector, new Element(selector.includes('select') ? 'select' : selector === '#local-form' ? 'form' : 'div'));
  const submit = new Element('button'), label = new Element('span'); label.className = 'button-label'; label.textContent = 'Compact locally'; submit.append(label);
  elements.get('#local-form').append(submit); elements.get('#local-form').hidden = true;
  elements.set('#local-form button[type=submit]', submit);
  for (const key of ['claude', 'local']) { const option = new Element('option'); option.value = key; elements.get('#run-select').append(option); }
  elements.get('#run-select').value = 'claude'; elements.get('#method-select').value = 'original';
  elements.get('#threshold').value = '70'; elements.get('.code-block pre').textContent = 'loom attach';
  const controls = ['#case-select', '#run-select', '#method-select', '#replay', '#load-example'].map(selector => elements.get(selector));
  controls.forEach(element => { element.disabled = true; });
  const revealTargets = [new Element(), new Element('article')]; revealTargets[1].isStep = true;
  const steps = new Element(); steps.append(revealTargets[1]);
  const detail = new Element('details'); detail.append(new Element('summary'), new Element('div'));
  document.hidden = false;
  document.createElement = tag => new Element(tag);
  document.createDocumentFragment = () => new Element('#fragment');
  document.querySelector = selector => {
    if (!elements.has(selector)) throw new Error(`Unhandled document selector: ${selector}`);
    return elements.get(selector);
  };
  document.querySelectorAll = selector => {
    if (selector === '.lab-toolbar select, #replay, #load-example') return controls;
    if (selector === 'details') return [detail];
    if (selector.startsWith('.intro,')) return revealTargets;
    throw new Error(`Unhandled document selector list: ${selector}`);
  };
  document.modelContext = { registerTool(tool, options) { tools.push({ tool, signal: options.signal }); return Promise.resolve(); } };
  preference.matches = reduced;
  window.matchMedia = () => preference;
  window.LoomMotion = { pulse(element) { pulseCalls.push(element); }, watchBusy(element, value) { busyCalls.push({ element, value }); } };
  class IntersectionObserver {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); this.disconnected = false; observers.push(this); }
    observe(element) { this.targets.add(element); }
    unobserve(element) { this.targets.delete(element); }
    disconnect() { this.disconnected = true; this.targets.clear(); }
    send(entries) { this.callback(entries); }
  }
  window.IntersectionObserver = IntersectionObserver;
  const context = vm.createContext({ window, document, navigator: { clipboard: { writeText: clipboard || (() => Promise.resolve()) } }, location: { protocol: local ? 'https:' : 'http:', hostname: 'localhost' }, AbortController, IntersectionObserver, innerHeight: 800, innerWidth: 1200, console,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(file, options = {}) {
      calls.push({ file, options });
      return fetcher ? fetcher(file, options) : Promise.resolve(response(data[file]));
    },
  });
  vm.runInContext(motion ? motionSource : appSource, context, { filename: motion ? 'motion.js' : 'app.js' });
  return { context, document, window, preference, elements, calls, tools, observers, timers, pulseCalls, busyCalls, revealTargets, detail, controls,
    el: selector => elements.get(selector),
    async ready() { if (!motion) await vm.runInContext('initialize()', context); await settle(); },
    async tick() { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } await settle(); },
  };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('edited session input survives method, run, case and tool replay; explicit load replaces it', async () => {
  const rig = environment({ local: true }); await rig.ready();
  assert.match(rig.el('#session-input').value, /first_case/);
  rig.el('#session-input').value = '{"messages":[{"content":"my draft"}],"task":"mine"}';
  await rig.el('#session-input').emit('input');
  const draft = rig.el('#session-input').value;
  rig.el('#method-select').value = 'hybrid'; await rig.el('#method-select').emit('change');
  rig.el('#run-select').value = 'local'; await rig.el('#run-select').emit('change');
  rig.el('#case-select').value = 'second_case'; await rig.el('#case-select').emit('change');
  rig.tools[0].tool.execute({ case_id: 'first_case', method: 'hybrid', run: 'claude' });
  assert.equal(rig.el('#session-input').value, draft);
  assert.match(rig.el('#editor-note').textContent, /edited input is kept/);
  await rig.el('#load-example').emit('click');
  assert.match(rig.el('#session-input').value, /first_case/);
  assert.doesNotMatch(rig.el('#session-input').value, /my draft/);
});

test('untouched example follows the selected case but method changes retain source scroll', async () => {
  const rig = environment({ local: true }); await rig.ready();
  rig.el('#messages').scrollTop = 350; rig.el('#memory').scrollTop = 90;
  rig.el('#method-select').value = 'hybrid'; await rig.el('#method-select').emit('change');
  assert.equal(rig.el('#messages').scrollTop, 350); assert.equal(rig.el('#memory').scrollTop, 0);
  assert.match(rig.el('#session-input').value, /first_case/);
  rig.el('#case-select').value = 'second_case'; await rig.el('#case-select').emit('change');
  assert.equal(rig.el('#messages').scrollTop, 0);
  assert.match(rig.el('#session-input').value, /second_case/);
  assert.equal(rig.el('#messages').children.length, 2);
});

test('independent data loads start together while controls remain disabled', async () => {
  const pending = new Map();
  const rig = environment({ fetcher(file) { const gate = deferred(); pending.set(file, gate); return gate.promise; } });
  assert.deepEqual(rig.calls.map(call => call.file), ['fixtures.json', 'results.json', 'claude-results.json']);
  assert.ok(rig.controls.every(element => element.disabled));
  for (const [file, gate] of pending) gate.resolve(response(data[file]));
  await rig.ready(); assert.ok(rig.controls.every(element => !element.disabled));
  assert.equal(rig.el('.lab-grid').getAttribute('aria-busy'), 'false');
});

test('failed fixture load leaves explorer disabled and explains the failure', async () => {
  const rig = environment({ fetcher: file => file === 'fixtures.json' ? Promise.resolve(response({}, 503)) : Promise.resolve(response(data[file])) });
  await rig.ready();
  assert.ok(rig.controls.every(element => element.disabled));
  assert.match(rig.el('#lab-state').textContent, /Session data could not load/);
  assert.equal(rig.el('.lab-grid').getAttribute('aria-busy'), 'false');
  assert.equal(rig.tools.length, 0);
});

test('one failed result file keeps the available run usable and disables its unavailable option', async () => {
  const rig = environment({ fetcher: file => file === 'claude-results.json' ? Promise.reject(new Error('offline')) : Promise.resolve(response(data[file])) });
  await rig.ready();
  assert.equal(rig.el('#run-select').value, 'local');
  assert.equal(rig.el('#run-select').querySelector('option[value=claude]').disabled, true);
  assert.equal(rig.el('#run-select').querySelector('option[value=local]').disabled, false);
  rig.el('#method-select').value = 'hybrid'; await rig.el('#method-select').emit('change');
  assert.match(rig.el('#memory').textContent, /local: first_case/);
});

test('two failed result files still expose source and a transparent no-measurements state', async () => {
  const rig = environment({ fetcher: file => file === 'fixtures.json' ? Promise.resolve(response(data[file])) : Promise.reject(new Error('offline')) });
  await rig.ready();
  assert.equal(rig.el('#case-select').disabled, false);
  assert.equal(rig.el('#messages').children.length, 2);
  assert.match(rig.el('#results-content').textContent, /no measurements are invented/);
  rig.el('#method-select').value = 'hybrid'; await rig.el('#method-select').emit('change');
  assert.equal(rig.el('#memory-count').textContent, 'UNAVAILABLE');
});

test('copy feedback returns to its original state and older clipboard completions cannot win', async () => {
  const writes = [];
  const rig = environment({ clipboard: () => { const gate = deferred(); writes.push(gate); return gate.promise; } }); await rig.ready();
  const first = rig.el('#copy-install').emit('click'), second = rig.el('#copy-install').emit('click');
  writes[1].resolve(); await second;
  assert.equal(rig.el('#copy-install').textContent, 'Copied ✓');
  assert.equal(rig.timers.size, 1);
  writes[0].resolve(); await first; assert.equal(rig.timers.size, 1);
  await rig.tick();
  assert.equal(rig.el('#copy-install').textContent, 'Copy commands');
  assert.equal(rig.el('#copy-status').textContent, '');
  assert.equal(rig.el('#copy-install').classList.contains('is-copied'), false);
});

test('clipboard rejection explains the manual fallback and clears its announcement', async () => {
  const rig = environment({ clipboard: () => Promise.reject(new Error('denied')) }); await rig.ready();
  await rig.el('#copy-install').emit('click');
  assert.match(rig.el('#copy-status').textContent, /Select the commands/);
  await rig.tick(); assert.equal(rig.el('#copy-status').textContent, '');
});

test('invalid live input focuses its error without making an inference request', async () => {
  const rig = environment({ local: true }); await rig.ready();
  for (const invalid of ['not JSON', '{}', '[]', '{"messages":[],"task":"work"}', '{"messages":[{}],"task":" "}']) {
    rig.el('#session-input').value = invalid; await rig.el('#local-form').emit('submit');
    assert.equal(rig.el('#session-input').getAttribute('aria-invalid'), 'true');
    assert.match(rig.el('#local-result').textContent, /Check the session JSON/);
  }
  assert.equal(rig.calls.filter(call => call.file === '/v1/compact').length, 0);
  assert.equal(rig.el('#session-input').focused, true);
  assert.equal(rig.el('#local-form button[type=submit]').disabled, false);
});

test('live compaction blocks duplicate requests and preserves structured HTTP errors', async () => {
  const pending = deferred();
  const rig = environment({ local: true, fetcher: file => file === '/v1/compact' ? pending.promise : Promise.resolve(response(data[file])) }); await rig.ready();
  const submit = rig.el('#local-form').emit('submit');
  await rig.el('#local-form').emit('submit');
  assert.equal(rig.calls.filter(call => call.file === '/v1/compact').length, 1);
  assert.equal(rig.el('#local-form button[type=submit]').disabled, true);
  assert.equal(rig.el('#local-form').getAttribute('aria-busy'), 'true');
  assert.equal(rig.busyCalls.at(-1).value, true);
  pending.resolve(response({ error: 'model not available', detail: { stage: 'reranker' } }, 503)); await submit;
  assert.match(rig.el('#local-result').textContent, /HTTP 503/);
  assert.match(rig.el('#local-result').textContent, /"stage": "reranker"/);
  assert.equal(rig.el('#local-form button[type=submit]').disabled, false);
  assert.equal(rig.el('#local-form').getAttribute('aria-busy'), 'false');
  assert.equal(rig.busyCalls.at(-1).value, false);
});

test('page departure aborts live work and a stale response cannot replace interruption feedback', async () => {
  const pending = deferred();
  const rig = environment({ local: true, fetcher: file => file === '/v1/compact' ? pending.promise : Promise.resolve(response(data[file])) }); await rig.ready();
  const submit = rig.el('#local-form').emit('submit');
  const request = rig.calls.find(call => call.file === '/v1/compact');
  await rig.window.emit('pagehide');
  assert.equal(request.options.signal.aborted, true);
  assert.equal(rig.tools[0].signal.aborted, true);
  assert.equal(rig.el('#local-form button[type=submit]').disabled, false);
  pending.resolve(response({ replacement: 'stale' })); await submit;
  assert.match(rig.el('#local-result').textContent, /request was interrupted/);
  assert.doesNotMatch(rig.el('#local-result').textContent, /stale/);
  await rig.window.emit('pageshow', { persisted: true });
  assert.equal(rig.tools.length, 2); assert.equal(rig.tools[1].signal.aborted, false);
});

test('page departure invalidates pending clipboard work and clears feedback timers', async () => {
  const pending = deferred();
  const rig = environment({ clipboard: () => pending.promise }); await rig.ready();
  const copy = rig.el('#copy-install').emit('click');
  await rig.window.emit('pagehide'); pending.resolve(); await copy;
  assert.equal(rig.el('#copy-install').textContent, 'Copy commands');
  assert.equal(rig.timers.size, 0);
});

test('a restored page retries interrupted initial loading with fresh abort signals', async () => {
  let initial = true;
  const rig = environment({ fetcher(file, options) {
    if (!initial) return Promise.resolve(response(data[file]));
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await rig.window.emit('pagehide'); await settle();
  assert.ok(rig.calls.every(call => call.options.signal.aborted));
  initial = false; await rig.window.emit('pageshow', { persisted: true }); await rig.ready();
  assert.equal(rig.calls.length, 6); assert.equal(rig.el('#case-select').disabled, false);
  assert.equal(rig.tools.length, 1);
});

test('replay tool updates visible state synchronously and rejects unknown input', async () => {
  const rig = environment(); await rig.ready();
  const tool = rig.tools[0].tool;
  const state = tool.execute({ case_id: 'second_case', method: 'hybrid', run: 'local' });
  assert.equal(state.case_id, 'second_case'); assert.equal(state.status, 'ready');
  assert.match(rig.el('#memory').textContent, /local: second_case/);
  for (const input of [{ case_id: 'missing', method: 'hybrid' }, { case_id: 'first_case', method: 'invented' }, { case_id: 'first_case', method: 'hybrid', other: true }]) assert.throws(() => tool.execute(input), /Unknown session/);
});

test('threshold updates visible output and uses a transform rather than changing layout width', async () => {
  const rig = environment(); await rig.ready();
  rig.el('#threshold').value = '82'; await rig.el('#threshold').emit('input');
  assert.equal(rig.el('#threshold-value').textContent, '82%');
  assert.equal(rig.el('#meter-fill').style.transform, 'scaleX(0.82)');
  assert.equal(rig.el('#meter-fill').style.width, undefined);
  assert.match(rig.el('#threshold-note').textContent, /safe boundary required/);
});

test('rapid pulses cancel the old animation without releasing the newer active one', async () => {
  const rig = environment({ motion: true }), target = rig.revealTargets[0];
  rig.window.LoomMotion.pulse(target); const first = target.animations[0];
  rig.window.LoomMotion.pulse(target); const second = target.animations[1];
  assert.equal(first.cancelled, true); assert.equal(second.cancelled, false);
  assert.equal(target.getAttribute('data-motion-active'), 'true');
  await settle();
  rig.observers[0].send([{ target, isIntersecting: false }]);
  assert.equal(second.cancelled, true);
  assert.equal(target.getAttribute('data-motion-active'), null);
});

test('reduced-motion preference cancels active work and suppresses new motion', async () => {
  const rig = environment({ motion: true }), target = rig.revealTargets[0];
  rig.window.LoomMotion.pulse(target);
  rig.preference.matches = true; await rig.preference.emit('change');
  assert.equal(target.animations[0].cancelled, true);
  assert.ok(rig.observers.every(observer => observer.disconnected));
  rig.window.LoomMotion.pulse(target); assert.equal(target.animations.length, 1);
  const reduced = environment({ motion: true, reduced: true });
  reduced.window.LoomMotion.pulse(reduced.revealTargets[0]);
  assert.equal(reduced.observers.length, 0); assert.equal(reduced.revealTargets[0].animations.length, 0);
});

test('offscreen and hidden targets do not animate; visibility restore renews observers', async () => {
  const rig = environment({ motion: true }), target = rig.revealTargets[0];
  target.rect.top = 900; target.rect.bottom = 1000;
  rig.window.LoomMotion.pulse(target); assert.equal(target.animations.length, 0);
  target.rect.top = 40; target.rect.bottom = 140;
  rig.window.LoomMotion.pulse(target);
  rig.document.hidden = true; await rig.document.emit('visibilitychange');
  assert.equal(target.animations[0].cancelled, true);
  assert.ok(rig.observers.every(observer => observer.disconnected));
  rig.window.LoomMotion.pulse(target); assert.equal(target.animations.length, 1);
  rig.document.hidden = false; await rig.document.emit('visibilitychange');
  assert.equal(rig.observers.length, 6);
  rig.window.LoomMotion.pulse(target); assert.equal(target.animations.length, 2);
});

test('entry reveals happen once and finished animations stop being observed', async () => {
  const rig = environment({ motion: true }), target = rig.revealTargets[0];
  const entries = rig.observers[2], active = rig.observers[0];
  entries.send([{ target, isIntersecting: true }]);
  assert.equal(target.animations.length, 1); assert.equal(entries.targets.has(target), false);
  target.animations[0].finish(); await settle();
  assert.equal(active.targets.has(target), false);
  assert.equal(target.getAttribute('data-motion-active'), null);
  entries.send([{ target, isIntersecting: true }]); assert.equal(target.animations.length, 1);
  await rig.window.emit('pagehide'); assert.ok(rig.observers.every(observer => observer.disconnected));
  await rig.window.emit('pageshow', { persisted: true });
  assert.equal(rig.observers.at(-1).targets.has(target), false);
});

test('focus and disclosure closure cancel motion rather than obscure active content', async () => {
  const rig = environment({ motion: true }), detail = rig.detail, body = detail.children[1];
  detail.open = true; await detail.emit('toggle'); assert.equal(body.animations.length, 1);
  await rig.document.emit('focusin', { target: body }); assert.equal(body.animations[0].cancelled, true);
  rig.window.LoomMotion.pulse(body); detail.open = false; await detail.emit('toggle');
  assert.equal(body.animations[1].cancelled, true);
});

test('busy indicator runs only while its real request is visible and preference allows motion', async () => {
  const rig = environment({ motion: true }), button = rig.el('#local-form button[type=submit]');
  rig.window.LoomMotion.watchBusy(button, true);
  assert.equal(button.classList.contains('is-visible-busy'), true);
  assert.equal(rig.observers[1].targets.has(button), true);
  rig.observers[1].send([{ target: button, isIntersecting: false }]);
  assert.equal(button.classList.contains('is-visible-busy'), false);
  rig.observers[1].send([{ target: button, isIntersecting: true }]);
  assert.equal(button.classList.contains('is-visible-busy'), true);
  rig.document.hidden = true; await rig.document.emit('visibilitychange');
  assert.equal(button.classList.contains('is-visible-busy'), false);
  rig.document.hidden = false; await rig.document.emit('visibilitychange');
  assert.equal(rig.observers[4].targets.has(button), true);
  rig.observers[4].send([{ target: button, isIntersecting: true }]);
  assert.equal(button.classList.contains('is-visible-busy'), true);
  rig.preference.matches = true; await rig.preference.emit('change');
  assert.equal(button.classList.contains('is-visible-busy'), false);
  rig.window.LoomMotion.watchBusy(button, false);
  rig.preference.matches = false; await rig.preference.emit('change');
  assert.equal(rig.observers.at(-2).targets.has(button), false);
});
