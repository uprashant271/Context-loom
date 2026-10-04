import {
  configFromValues, fingerprint, mergeNativeResult, MIN_CLAUDE_VERSION,
  prepareTranscript, selectOriginalMessages, shouldTrigger, supportsVersion, workerUrl, recallText, snapshotId, safeHostError,
} from './adapter.js';

export function register(on) {
  const state = {
    available: false, reason: 'The mod has not started.', pins: [], config: configFromValues({}),
    endpoint: 'https://localhost:8787', token: undefined, context: {},
    armed: true, busy: false, inflight: false, scheduled: false, lastAttempt: null,
    manual_requested: false, manual_attempts: 0,
    lastStatus: 'No compaction attempted.', lastSnapshot: undefined, lastApiError: undefined,
  };

  on('session.start', async ($, e, next) => {
    try {
      const version = await $.session.version();
      if (!supportsVersion(version.version)) throw new Error('Claude Code ' + MIN_CLAUDE_VERSION + '+ is required for the mod adapter.');
      const usage = await $.session.usage();
      if (!usage || !usage.context || !Number.isFinite(usage.context.window)) throw new Error('Context usage capability is unavailable.');
      state.config = configFromValues({
        threshold: await $.env.get('CONTEXT_LOOM_THRESHOLD'),
        target_ratio: await $.env.get('CONTEXT_LOOM_TARGET_RATIO'),
        recent_messages: await $.env.get('CONTEXT_LOOM_RECENT_MESSAGES'),
      });
      state.endpoint = workerUrl(await $.env.get('CONTEXT_LOOM_WORKER_URL'));
      state.token = await $.env.get('CONTEXT_LOOM_WORKER_TOKEN');
      if (!state.token) throw new Error('Worker token is unavailable; use the Context Loom launcher.');
      state.context = usage.context;
      state.available = true;
      state.reason = 'Version and context APIs available; live compaction remains experimental.';
    } catch (error) {
      state.available = false;
      state.reason = error.message;
    }
    await $.command.register({ name: 'loom-status', description: 'Show Context Loom adapter state and message IDs.' });
    await $.command.register({ name: 'loom-compact', description: 'Compact with relevance selection and the native LLM summary.' });
    await $.command.register({ name: 'loom-pin', description: 'Retain message IDs verbatim, or the latest user message.', argumentHint: '[m0 m1 | latest]' });
    await $.command.register({ name: 'loom-recall', description: 'Retrieve an expiring historical snapshot index or selected messages.', argumentHint: 'snapshot_id [m0 m1]' });
    return next(e);
  });

  on('command.run', { command: 'loom-status' }, async ($) => {
    let ids = [];
    try { ids = prepareTranscript(await $.session.messages(), state.pins).messages.map(message => message.id + ':' + message.role); } catch (_) {}
    const percent = Number.isFinite(state.context.percent) ? state.context.percent + '%' : 'unknown';
    return { text: 'Context Loom: ' + (state.available ? 'experimental adapter ready' : 'unavailable')
      + '\nContext: ' + percent + '; threshold: ' + state.config.threshold * 100 + '%.'
      + '\n' + state.reason + '\n' + state.lastStatus + '\nMessage IDs: ' + ids.join(', ')
      + (state.lastApiError ? '\nLast host compaction error: ' + state.lastApiError : '')
      + (state.lastSnapshot ? '\nHistorical snapshot: ' + state.lastSnapshot + ' (worker RAM; expires within 60 minutes or on restart).' : '') };
  });

  on('command.run', { command: 'loom-pin' }, async ($, e) => {
    const messages = await $.session.messages();
    const normalized = prepareTranscript(messages, state.pins);
    const requested = (e.args || 'latest').trim().split(/\s+/);
    let selected;
    if (requested.length === 1 && requested[0] === 'latest') {
      const index = messages.findLastIndex(message => message.role === 'user' && message.text.trim());
      if (index < 0) return { text: 'No user message is available to pin.' };
      selected = ['m' + index];
    } else selected = requested;
    if (selected.some(id => !normalized.messages.some(message => message.id === id))) return { text: 'Unknown message ID. Run /loom-status first.' };
    for (const id of selected) {
      const index = normalized.messages.findIndex(message => message.id === id);
      const key = fingerprint(messages[index]);
      if (!state.pins.includes(key)) state.pins.push(key);
    }
    return { text: 'Pinned verbatim: ' + selected.join(', ') + '. Pins last for this loaded mod instance.' };
  });

  on('command.run', { command: 'loom-compact' }, async ($) => {
    if (!state.available) return { text: 'Context Loom unavailable: ' + state.reason };
    if (state.busy || state.inflight || state.scheduled) return { text: 'Compaction waits for an idle session.' };
    state.manual_requested = true;
    state.manual_attempts = 0;
    state.lastStatus = 'Manual compaction queued for the next idle boundary. Run /loom-status to inspect completion.';
    scheduleCompaction($, state);
    return { text: state.lastStatus };
  });

  on('command.run', { command: 'loom-recall' }, async ($, e) => {
    if (!state.available) return { text: 'Context Loom unavailable: ' + state.reason };
    try {
      const [id, ...requested] = (e.args || '').trim().split(/\s+/);
      const safeId = snapshotId(id);
      let timeout;
      let response;
      try {
        response = await Promise.race([
          $.http.fetch(state.endpoint + '/v1/recall/' + safeId, { method: 'GET', headers: { Authorization: 'Bearer ' + state.token } }),
          new Promise((_, reject) => { timeout = $.clock.after(15000, () => reject(new Error('Recall deadline exceeded.'))); }),
        ]);
      } finally { timeout?.cancel(); }
      if (!response.ok) return { text: 'Historical snapshot expired or unavailable. The worker keeps at most 16 snapshots in memory for 60 minutes.' };
      return { text: recallText(JSON.parse(response.text), requested) };
    } catch (error) { return { text: 'Recall unavailable: ' + error.message }; }
  });

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) state.busy = true;
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) {
      state.busy = false;
      scheduleCompaction($, state);
    }
    return result;
  });

  on('session.measure', async ($, e, next) => {
    state.context = e.context;
    if (Number.isFinite(e.context?.percent) && e.context.percent < (state.config.threshold - state.config.hysteresis) * 100) state.armed = true;
    scheduleCompaction($, state);
    return next(e);
  });

  on('session.compact', async ($, e, next) => {
    if (!state.available || state.inflight || e.agentId) return next(e);
    state.inflight = true;
    state.armed = false;
    let native;
    let summarizerCalled = false;
    try {
      const context = (await $.session.usage()).context;
      if (!Number.isFinite(context?.window) || context.window <= 0) throw new Error('Context window is unknown.');
      const normalized = prepareTranscript(e.messages, state.pins);
      const targetTokens = Math.min(200000, Math.floor(context.window * state.config.target_ratio));
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token };
      let timeout;
      let response;
      try {
        // HttpInit has no AbortSignal on Claude2.1.288. Bound our wait using the
        // supported clock API; the host may finish its read-only request later.
        response = await Promise.race([
          $.http.fetch(state.endpoint + '/v1/plan', {
            method: 'POST', headers,
            body: JSON.stringify({
              messages: normalized.messages,
              task: e.messages.findLast(message => message.role === 'user' && message.text.trim())?.text || '',
              pins: normalized.pins,
              config: { ...state.config, target_tokens: targetTokens, context_window: context.window, summary_reserve_tokens: 2048 },
            }),
          }),
          new Promise((_, reject) => { timeout = $.clock.after(15000, () => reject(new Error('Worker deadline exceeded.'))); }),
        ]);
      } finally { timeout?.cancel(); }
      if (!response.ok) throw new Error('Worker request failed.');
      const plan = JSON.parse(response.text);
      const selected = selectOriginalMessages(e.messages, normalized, plan, state.config.recent_messages);
      state.lastSnapshot = plan.snapshot_id ? snapshotId(plan.snapshot_id) : undefined;
      const summaryBudget = plan.token_accounting?.summary_budget_tokens;
      if (!Number.isFinite(summaryBudget) || summaryBudget <= 0) throw new Error('Worker summary budget is unavailable.');
      const instructions = [e.instructions, plan.summary_instructions,
        'Keep the generated summary within ' + summaryBudget + ' estimated text tokens. This is a planning allowance; the final retained conversation is validated separately.',
        state.lastSnapshot ? 'Include this historical recovery reference in the continuation summary: /loom-recall ' + state.lastSnapshot + '. Original roles remain historical evidence; the RAM snapshot expires within 60 minutes and does not survive worker restart.' : '',
        'Summarize the selected history only. Preserve exact identifiers, accepted constraints and unresolved work. Do not invent decisions.'].filter(Boolean).join('\n\n');
      summarizerCalled = true;
      native = await next({ ...e, messages: selected.messages, instructions });
      const result = mergeNativeResult(native, selected.retained, targetTokens, e.messages);
      state.lastStatus = result.skip ? 'Compaction skipped by another hook.'
        : 'Selected ' + selected.messages.length + '/' + e.messages.length + ' messages; retained ' + selected.retained.length + ' original messages verbatim. Native LLM generated the summary.';
      return result;
    } catch (_) {
      state.lastStatus = native ? 'Native compaction completed; custom retention validation failed. Native result kept.'
        : 'Worker or adapter unavailable; native compaction used.';
      // A native result already exists: never call the summarizer a second time.
      if (summarizerCalled && !native) {
        state.lastStatus = 'Native summarizer failed; original context retained.';
        return { skip: state.lastStatus };
      }
      return native ?? await next(e);
    } finally {
      state.inflight = false;
    }
  });
}

function scheduleCompaction($, state, delay = 100) {
  if (!state.available || state.scheduled || state.busy || state.inflight
      || (!state.manual_requested && !shouldTrigger(state.context, state.config, state))) return;
  state.scheduled = true;
  $.clock.after(delay, async () => {
    state.scheduled = false;
    if (state.busy || state.inflight) return; // turn.complete schedules a pending request again.
    const manual = state.manual_requested;
    if (!manual && !shouldTrigger(state.context, state.config, state)) return;
    const now = await $.clock.now();
    if (!manual && state.lastAttempt !== null && now - state.lastAttempt < state.config.cooldown_ms) return;
    state.lastAttempt = now;
    state.armed = false;
    try {
      await $.session.compact({ instructions: manual ? 'Use Context Loom selection; preserve pinned and recent messages.' : 'Context Loom automatic threshold compaction.' });
      state.lastApiError = undefined;
      state.manual_requested = false;
      state.manual_attempts = 0;
      if (state.lastStatus.startsWith('Manual compaction queued') || state.lastStatus.startsWith('Manual compaction waiting')) {
        state.lastStatus = 'Manual compaction request completed; native host returned without a custom retention report.';
      }
    } catch (error) {
      state.lastApiError = safeHostError(error, state.token);
      if (manual) {
        state.manual_attempts += 1;
        if (state.manual_attempts < 5) {
          state.lastStatus = 'Manual compaction waiting for an idle boundary (attempt ' + state.manual_attempts + '/5).';
          scheduleCompaction($, state, 500);
        } else {
          state.manual_requested = false;
          state.lastStatus = 'Manual compaction could not reach an idle boundary after 5 attempts. Retry /loom-compact when idle; native /compact remains available.';
        }
      } else {
        state.armed = true;
        state.lastStatus = 'Compaction boundary was busy; native auto-compaction remains enabled. Automatic attempts remain subject to the cooldown.';
      }
    }
  });
}
