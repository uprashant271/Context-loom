import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configFromValues, prepareTranscript, selectOriginalMessages, mergeNativeResult,
  shouldTrigger, supportsVersion, workerUrl, fingerprint, recallText, snapshotId, safeHostError,
} from '../plugin/hooks/adapter.js';
import { register } from '../plugin/hooks/register.js';

const message = (role, text, handle, more = {}) => ({ role, text, handle, toolUses: [], ...more });
const source = [
  message('user', 'Use the existing public API.', 'h0'),
  message('assistant', '', 'h1', { toolUses: [{ tool_use_id: 'c1', tool: 'Read', input: { path: 'api.ts' } }] }),
  message('user', '', 'h2', { toolResults: [{ tool_use_id: 'c1', text: 'old API', isError: false }] }),
  message('assistant', 'An abandoned approach.', 'h3'),
  message('user', 'Fix the open bug next.', 'h4'),
];

test('host API diagnostics redact known bearer values and bound message size', () => {
  const diagnostic = safeHostError(new Error('method unsupported Bearer test-secret\n' + 'x'.repeat(400)), 'test-secret');
  assert.doesNotMatch(diagnostic, /test-secret/);
  assert.doesNotMatch(diagnostic, /\n/);
  assert.match(diagnostic, /unsupported/);
  assert.ok(diagnostic.length <= 240);
});

test('unknown usage never becomes zero or triggers a compaction', () => {
  assert.equal(shouldTrigger({}, { threshold: .7 }, { armed: true }), false);
  assert.equal(shouldTrigger({ percent: null }, { threshold: .7 }, { armed: true }), false);
  assert.equal(shouldTrigger({ percent: 70 }, { threshold: .7 }, { armed: true, busy: true }), false);
  assert.equal(shouldTrigger({ percent: 70 }, { threshold: .7 }, { armed: true }), true);
  assert.equal(shouldTrigger({ percent: 90 }, { threshold: .7 }, { armed: false }), false);
});

test('version gate and worker URL disallow unsupported and external endpoints', () => {
  assert.equal(supportsVersion('2.1.236'), false);
  assert.equal(supportsVersion('2.1.287'), true);
  assert.equal(supportsVersion('2.1.300-dev'), true);
  assert.equal(supportsVersion('unknown'), false);
  assert.equal(workerUrl('https://localhost:9999/'), 'https://localhost:9999');
  assert.throws(() => workerUrl('http://127.0.0.1:8787'));
  assert.throws(() => workerUrl('https://example.com'));
  assert.throws(() => workerUrl('http://user:secret@127.0.0.1:8787'));
});

test('configuration validates ratios and consistently defaults to four recent messages', () => {
  const config = configFromValues({});
  assert.equal(config.threshold, .7);
  assert.equal(config.target_ratio, .4);
  assert.equal(config.recent_messages, 4);
  assert.throws(() => configFromValues({ threshold: .2, target_ratio: .4 }));
  assert.throws(() => configFromValues({ recent_messages: -1 }));
  assert.throws(() => configFromValues({ recent_messages: 41 }));
});

test('recall gives an index first and bounds explicit historical evidence', () => {
  assert.equal(snapshotId('snapshot_123-abc'), 'snapshot_123-abc');
  assert.throws(() => snapshotId('../secrets'));
  const payload = { messages: [{ id: 'm0', role: 'user', content: 'Use API v1.' },
    { id: 'm1', role: 'assistant', content: 'obsolete scratchpad' }], retention: 'in_memory_60_minutes' };
  const index = recallText(payload, []);
  assert.match(index, /m0:user/);
  assert.doesNotMatch(index, /Use API/);
  const evidence = recallText(payload, ['m0']);
  assert.match(evidence, /Historical transcript evidence/);
  assert.match(evidence, /Use API v1/);
  assert.throws(() => recallText(payload, ['unknown']));
  assert.throws(() => recallText({ messages: [{ id: 'm0', role: 'user', content: 'x'.repeat(17000) }] }, ['m0']));
});

test('normalization keeps tool relationships and explicit pins stable across index shifts', () => {
  const key = fingerprint(source[0]);
  const before = prepareTranscript(source, [key]);
  assert.deepEqual(before.pins, ['m0']);
  assert.equal(before.messages[1].tool_calls[0].id, 'c1');
  assert.deepEqual(before.messages[2].tool_result_ids, ['c1']);
  const after = prepareTranscript([message('assistant', 'Summary.', 'new'), ...source], [key]);
  assert.deepEqual(after.pins, ['m1']);
});

test('selection unions protected messages, pins and recent messages and closes tool groups', () => {
  const normalized = prepareTranscript(source, [fingerprint(source[0])]);
  const plan = { status: 'ready', selected_ids: ['m1'], protected_ids: [], retained_ids: ['m1'], summary_instructions: 'Keep decisions.' };
  const selected = selectOriginalMessages(source, normalized, plan, 1);
  assert.deepEqual(selected.messages.map(m => m.handle), ['h0', 'h1', 'h2', 'h4']);
  assert.deepEqual(selected.retained.map(m => m.handle), ['h0', 'h1', 'h2', 'h4']);
  assert.equal(selected.messages[1], source[1]);
});

test('malformed worker plans, missing handles and unknown IDs fail closed', () => {
  const normalized = prepareTranscript(source, []);
  const plan = { status: 'ready', selected_ids: ['does-not-exist'], protected_ids: [], retained_ids: [], summary_instructions: 'Keep.' };
  assert.throws(() => selectOriginalMessages(source, normalized, plan, 1));
  assert.throws(() => selectOriginalMessages(source, normalized, { ...plan, status: 'blocked' }, 1));
  assert.throws(() => selectOriginalMessages(source.map(m => ({ ...m, handle: undefined })), normalized, { ...plan, selected_ids: ['m0'] }, 1));
});

test('native summary plus retained original handles preserve order and remove duplicates', () => {
  const summary = message('assistant', 'The current task is fixing the bug.', undefined);
  const native = { messages: [summary, source[4]], tokensBefore: 5000, tokensAfter: 20 };
  const merged = mergeNativeResult(native, [source[0], source[4]], 2000);
  assert.deepEqual(merged.messages, [summary, source[0], source[4]]);
  assert.equal(merged.tokensAfter, undefined, 'native count is stale after retaining extra rows');
});

test('new native summary handles remain valid while old non-retained handles are omitted', () => {
  const summary = message('assistant', 'Continuation summary.', 'native-summary');
  const merged = mergeNativeResult({ messages: [summary, source[3], source[4]] }, [source[0], source[4]], 2000, source);
  assert.deepEqual(merged.messages, [summary, source[0], source[4]]);
});

test('failed, skipped or oversized native summary is never promoted as custom success', () => {
  assert.throws(() => mergeNativeResult({ messages: [] }, [], 1000));
  assert.throws(() => mergeNativeResult({ messages: [message('assistant', 'x'.repeat(4000))] }, [], 500));
  const skipped = { skip: 'another plugin blocked compaction' };
  assert.equal(mergeNativeResult(skipped, [], 500), skipped);
});

function fakeHost(overrides = {}) {
  const handlers = new Map();
  const calls = { http: [], compact: [], registrations: [], logs: [], timers: [] };
  const state = { usage: { context: { percent: 72, window: 20000, tokens: 14400 } }, version: '2.1.300', token: 'test-only-token' };
  const api = {
    session: {
      version: async () => ({ version: state.version }), usage: async () => state.usage,
      messages: async () => source, compact: async (args) => { calls.compact.push(args); return {}; },
    },
    env: { get: async (key) => key === 'CONTEXT_LOOM_WORKER_TOKEN' ? state.token : undefined },
    command: { register: async (spec) => calls.registrations.push(spec.name) },
    ui: { log: async (value) => calls.logs.push(value), status: async (value) => calls.logs.push(value) },
    clock: { now: async () => 100000, after: (delay, fn) => { calls.timers.push(fn); return { cancel() {} }; } },
    http: { fetch: async (url, init) => {
      calls.http.push({ url, init });
      if (url.endsWith('/health')) return { ok: true, text: JSON.stringify({ status: 'ok' }) };
      if (url.includes('/v1/recall/')) return { ok: true, text: JSON.stringify({ messages: [{ id: 'm0', role: 'user', content: 'Synthetic historical constraint.' }], retention: 'in_memory_60_minutes' }) };
      return { ok: true, text: JSON.stringify({ status: 'ready', selected_ids: ['m0', 'm3'], protected_ids: ['m0'], retained_ids: ['m0'], summary_instructions: 'Keep the open task.', snapshot_id: 'snapshot_123-abc', token_accounting: { summary_budget_tokens: 2048 } }) };
    } },
  };
  Object.assign(api, overrides);
  register((name, matcher, handler) => {
    if (handler === undefined) { handler = matcher; matcher = {}; }
    handlers.set(name + ':' + (matcher.command || ''), handler);
  });
  const run = async (name, event = {}, next = async (e) => e) => handlers.get(name)(api, event, next);
  return { api, calls, state, run };
}

test('registered native adapter passes selected original handles to summarizer and retains pinned originals', async () => {
  const host = fakeHost();
  await host.run('session.start:');
  assert.deepEqual(host.calls.registrations, ['loom-status', 'loom-compact', 'loom-pin', 'loom-recall']);
  let observed;
  const result = await host.run('session.compact:', { trigger: 'manual', messages: source }, async (event) => {
    observed = event;
    return { messages: [message('assistant', 'The API constraint and open bug remain.')], tokensAfter: 40 };
  });
  assert.equal(observed.messages[0], source[0]);
  assert.match(observed.instructions, /Keep the open task/);
  assert.match(observed.instructions, /2048/);
  assert.match(observed.instructions, /snapshot_123-abc/);
  assert.deepEqual(result.messages.slice(1).map(m => m.handle), ['h0', 'h1', 'h2', 'h3', 'h4']);
  const request = host.calls.http.find(c => c.url.endsWith('/v1/plan'));
  assert.equal(request.init.headers.Authorization, 'Bearer test-only-token');
  assert.equal('signal' in request.init, false, 'Claude2.1.288 HttpInit does not support AbortSignal');
  assert.equal(JSON.parse(request.init.body).config.summary_reserve_tokens, 2048);
});

test('native plan target is capped at the worker limit even on a million token host', async () => {
  const host = fakeHost(); host.state.usage.context.window = 1000000;
  await host.run('session.start:');
  await host.run('session.compact:', { trigger: 'manual', messages: source }, async () => ({ messages: [message('assistant', 'Short summary.')] }));
  assert.equal(JSON.parse(host.calls.http[0].init.body).config.target_tokens, 200000);
});

test('recall validates snapshot path and authenticates before returning historical rows', async () => {
  const host = fakeHost(); await host.run('session.start:');
  const invalid = await host.run('command.run:loom-recall', { args: '../secrets m0' });
  assert.match(invalid.text, /snapshot/i); assert.equal(host.calls.http.length, 0);
  const recalled = await host.run('command.run:loom-recall', { args: 'snapshot_123-abc m0' });
  assert.match(recalled.text, /Historical transcript evidence/);
  assert.equal(host.calls.http[0].init.headers.Authorization, 'Bearer test-only-token');
});

test('manual compaction returns before calling the host and then runs at a deferred boundary', async () => {
  const host = fakeHost(); await host.run('session.start:');
  const queued = await host.run('command.run:loom-compact');
  assert.match(queued.text, /queued/i);
  assert.equal(host.calls.compact.length, 0, 'command.run must return before starting session.compact');
  assert.equal(host.calls.timers.length, 1);
  await host.calls.timers[0]();
  assert.equal(host.calls.compact.length, 1);
});

test('manual host boundary rejection retries finitely without duplicate pending timers', async () => {
  const host = fakeHost(); await host.run('session.start:');
  let attempts = 0;
  host.api.session.compact = async () => { attempts++; throw new Error('host command boundary active'); };
  await host.run('command.run:loom-compact');
  for (let index = 0; index < host.calls.timers.length; index++) await host.calls.timers[index]();
  assert.equal(attempts, 5);
  assert.equal(host.calls.timers.length, 5);
  const status = await host.run('command.run:loom-status');
  assert.match(status.text, /could not reach an idle boundary/i);
});

test('worker failure invokes native fallback exactly once with untouched event', async () => {
  const host = fakeHost({ http: { fetch: async () => { throw new Error('offline'); } } });
  await host.run('session.start:');
  const event = { trigger: 'manual', messages: source };
  let count = 0;
  const native = { messages: [message('assistant', 'Native fallback.')] };
  const result = await host.run('session.compact:', event, async (seen) => { count++; assert.equal(seen, event); return native; });
  assert.equal(count, 1);
  assert.equal(result, native);
});

test('a native summarizer error never causes a duplicate LLM call or clears the conversation', async () => {
  const host = fakeHost();
  await host.run('session.start:');
  let calls = 0;
  const result = await host.run('session.compact:', { trigger: 'manual', messages: source }, async () => {
    calls++; throw new Error('native provider offline');
  });
  assert.equal(calls, 1);
  assert.match(result.skip, /original context retained/i);
});

test('unsupported version never activates local worker or automatic compaction', async () => {
  const host = fakeHost(); host.state.version = '2.1.236';
  await host.run('session.start:');
  await host.run('session.measure:', { context: { percent: 80, window: 20000 } });
  for (const timer of host.calls.timers) await timer();
  assert.equal(host.calls.compact.length, 0);
  assert.equal(host.calls.http.length, 0);
});

test('threshold schedules safely, prevents bursts, and does not rearm on unknown usage', async () => {
  const host = fakeHost();
  await host.run('session.start:');
  await host.run('turn.start:', {});
  await host.run('session.measure:', { context: { percent: 80, window: 20000 } });
  assert.equal(host.calls.timers.length, 0);
  await host.run('turn.complete:', {});
  assert.equal(host.calls.timers.length, 1);
  await host.calls.timers[0]();
  await host.run('session.measure:', { context: { percent: 80, window: 20000 } });
  await host.run('session.measure:', { context: { percent: undefined, window: 20000 } });
  assert.equal(host.calls.compact.length, 1);
  assert.equal(host.calls.timers.length, 1);
});
