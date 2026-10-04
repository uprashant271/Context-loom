"use strict";
const $ = selector => document.querySelector(selector);
const names = { original: 'Original conversation', hybrid: 'Context Loom hybrid', recency: 'Recency', protected_recency: 'Protected recency', full_llm_summary: 'Full LLM summary', llmlingua2: 'LLMLingua-2' };
let fixtures = [], results = null, currentCase = null, currentMethod = 'original', runs = {};
let ready = false, editorSeed = '', editorDirty = false, copyTimer = null, copyAttempt = 0;
let pageWork = new AbortController(), liveRequest = null, toolLifecycle = null, initialization = null;
const pulse = element => window.LoomMotion?.pulse(element);
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function recordFor(id, method) { return results?.records?.find(record => record.case_id === id && record.method === method); }
function enableExplorer(enabled) {
  for (const element of document.querySelectorAll('.lab-toolbar select, #replay, #load-example')) element.disabled = !enabled;
  $('.lab-grid').setAttribute('aria-busy', String(!enabled));
}
function loadExample() {
  if (!currentCase) return;
  editorSeed = JSON.stringify({ messages: currentCase.messages, task: currentCase.task, pins: currentCase.pins, config: { target_tokens: 1024, summary_reserve_tokens: 256, recent_turns: 2, max_source_tokens: 3000 } }, null, 2);
  $('#session-input').value = editorSeed;
  editorDirty = false;
  $('#session-input').removeAttribute('aria-invalid');
  $('#editor-note').textContent = 'Example loaded: ' + currentCase.id.replaceAll('_', ' ') + '.';
}
function render({ animate = true } = {}) {
  const previousCase = currentCase?.id;
  currentCase = fixtures.find(item => item.id === $('#case-select').value) || fixtures[0];
  if (!currentCase) return;
  currentMethod = $('#method-select').value;
  const record = recordFor(currentCase.id, currentMethod), artifact = record?.artifact;
  const chosen = new Set(artifact?.selected_ids || artifact?.retained_ids || (['full_llm_summary', 'llmlingua2'].includes(currentMethod) ? currentCase.messages.map(message => message.id) : []));
  const retained = new Set(artifact?.retained_ids || []), pins = new Set(currentCase.pins);
  const chunks = new Map();
  for (const chunk of artifact?.ranked_chunks || []) for (const id of chunk.source_ids) if (!chunks.has(id)) chunks.set(id, chunk);
  const source = document.createDocumentFragment(), qa = document.createDocumentFragment();
  const sourceScroll = previousCase === currentCase.id ? $('#messages').scrollTop : 0;
  $('#source-count').textContent = currentCase.messages.length + ' messages';
  for (const message of currentCase.messages) {
    const element = node('article', undefined, 'message' + (pins.has(message.id) ? ' pin' : currentMethod !== 'original' && artifact ? (chosen.has(message.id) ? ' selected' : ' dropped') : ''));
    const label = node('div', undefined, 'message-label');
    label.append(node('span', message.id), node('span', message.role.toUpperCase()));
    if (pins.has(message.id)) label.append(node('span', 'PINNED', 'tag'));
    else if (retained.has(message.id)) label.append(node('span', 'VERBATIM', 'tag'));
    else if (currentMethod !== 'original' && artifact) label.append(node('span', chosen.has(message.id) ? 'SELECTED' : 'OMITTED', 'tag'));
    const chunk = chunks.get(message.id);
    if (chunk) label.append(node('span', 'relevance ' + chunk.score.toFixed(3), 'tag'));
    element.append(label, node('p', message.content));
    source.append(element);
  }
  if (currentMethod === 'original') {
    $('#lab-state').textContent = currentCase.task + ' · synthetic session';
    $('#memory').textContent = 'Choose a memory method and replay its recorded trace.\n\nPins are declared explicitly in each example. The future question is kept out of the compactor’s input.';
    $('#memory-count').textContent = 'SOURCE VIEW';
  } else if (!record) {
    $('#lab-state').textContent = names[currentMethod] + ' · this measured trace is unavailable';
    $('#memory').textContent = 'No recorded output is available for this method and run. Choose another trace to inspect.';
    $('#memory-count').textContent = 'UNAVAILABLE';
  } else {
    $('#lab-state').textContent = names[currentMethod] + ' · compaction ' + (artifact?.status || record.status) + ' · ' + record.compaction_seconds.toFixed(2) + 's · reader ' + (record.grade ? 'completed' : record.error ? 'error' : 'unavailable');
    $('#memory-count').textContent = (record.memory_count ?? artifact?.compacted_tokens ?? '—') + ' budget tokens';
    $('#memory').textContent = artifact?.replacement_messages?.length
      ? artifact.replacement_messages.map(message => '[' + message.role + ']\n' + message.content).join('\n\n')
      : 'Replacement withheld. ' + (artifact?.reasons?.join(' ') || record.error || artifact?.reason || 'Model output did not pass validation.');
    qa.append(node('strong', 'Future question'), node('p', currentCase.evaluation.question));
    if (record.reader_answer) qa.append(node('strong', record.grade?.passed ? 'Automated QA check: passed' : 'Automated QA check: failed'), node('p', record.reader_answer.answer));
    else qa.append(node('p', 'Reader result unavailable. ' + (record.error || '')));
    qa.append(node('p', 'Required fields: ' + currentCase.evaluation.required.map(alternatives => alternatives[0]).join(' · ')));
    if (record.grade?.forbidden_matches?.length) qa.append(node('p', 'Forbidden-string match: ' + record.grade.forbidden_matches.join(', ') + '. A correct explanatory mention can cause a false failure; inspect the answer.'));
  }
  $('#messages').replaceChildren(source);
  $('#qa').replaceChildren(qa);
  $('#messages').scrollTop = sourceScroll;
  $('#memory').scrollTop = 0;
  if (!$('#local-form').hidden && previousCase !== currentCase.id) {
    if (!editorDirty) loadExample();
    else $('#editor-note').textContent = 'Your edited input is kept. Load the selected example to replace it.';
  }
  if (animate) { pulse($('#messages')); pulse($('#memory')); }
}
function renderResults({ animate = true } = {}) {
  const root = $('#results-content');
  if (!results) {
    root.className = 'lab-empty';
    root.textContent = 'Recorded results could not load. Reload the page to try again; no measurements are invented.';
    return;
  }
  root.className = '';
  const content = document.createDocumentFragment(), manifest = results.manifest;
  content.append(node('p', manifest.provider === 'claude' ? 'Development comparison with Claude Haiku 4.5 on previously inspected fixtures. These are descriptive results, not an independent test or proof of general superiority.' : 'Initial local run: no method passed all required facts in any of the six cases. The tiny reader missed multi-part answers and produced invalid JSON. This run does not establish a quality advantage for Context Loom.', 'warning'));
  content.append(node('p', 'Six synthetic histories · ' + manifest.memory_budget + ' token memory limit · ' + (manifest.provider === 'claude' ? 'Claude Haiku 4.5' : manifest.requested_summarizer_model + ' on MPS') + ' summarizer & reader · Qwen reranker on ' + (manifest.requested_reranker_device || 'recorded device'), 'metric-note'));
  const wrap = node('div', undefined, 'table-wrap'), table = node('table'), head = node('thead'), hr = node('tr');
  table.setAttribute('aria-label', 'Recorded benchmark comparison');
  for (const value of ['Method', 'Automated QA', 'Reader completed', 'Compaction avg.', 'Memory avg.']) {
    const cell = node('th', value); cell.scope = 'col'; hr.append(cell);
  }
  head.append(hr); table.append(head);
  const body = node('tbody');
  for (const metric of manifest.metrics || []) {
    const rows = results.records.filter(row => row.method === metric.method);
    const sizes = rows.map(row => row.memory_count ?? row.artifact?.compacted_tokens).filter(value => typeof value === 'number');
    const tr = node('tr', undefined, metric.method === 'hybrid' ? 'hybrid' : '');
    for (const value of [names[metric.method] || metric.method, metric.passed_cases + '/' + metric.planned_cases, metric.completed_reader_cases + '/' + metric.planned_cases, metric.mean_compaction_seconds?.toFixed(2) + 's', sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) + ' tokens' : '—']) tr.append(node('td', value));
    body.append(tr);
  }
  table.append(body); wrap.append(table); content.append(wrap);
  content.append(node('p', 'Failed, blocked, or invalid model outputs remain in the denominator. Latency includes the work measured by the runner and may include cold model loading. Token counts use the declared Qwen tokenizer plus framing; these are not native Claude usage.', 'metric-note'));
  const download = node('a', 'Download raw results JSON ↗', 'results-download');
  download.href = manifest.provider === 'claude' ? 'claude-results.json' : 'results.json';
  download.download = 'context-loom-results.json'; content.append(download);
  root.replaceChildren(content);
  if (animate) pulse(root);
}
const slider = $('#threshold');
slider.addEventListener('input', () => {
  $('#threshold-value').textContent = slider.value + '%';
  $('#meter-fill').style.transform = 'scaleX(' + Number(slider.value) / 100 + ')';
  $('#threshold-note').textContent = slider.value + '% of the context window · safe boundary required';
});
$('#case-select').addEventListener('change', () => render());
$('#method-select').addEventListener('change', () => render());
$('#replay').addEventListener('click', () => render());
$('#run-select').addEventListener('change', () => {
  results = runs[$('#run-select').value] || null; render(); renderResults();
});
function resetCopy() {
  clearTimeout(copyTimer); copyTimer = null;
  $('#copy-install').textContent = 'Copy commands';
  $('#copy-install').classList.remove('is-copied');
  $('#copy-status').textContent = '';
}
$('#copy-install').addEventListener('click', async () => {
  const attempt = ++copyAttempt;
  resetCopy();
  try {
    await navigator.clipboard.writeText($('.code-block pre').textContent);
    if (attempt !== copyAttempt || pageWork.signal.aborted) return;
    $('#copy-install').textContent = 'Copied ✓';
    $('#copy-install').classList.add('is-copied');
    $('#copy-status').textContent = 'Install commands copied.';
  } catch (_) {
    if (attempt !== copyAttempt || pageWork.signal.aborted) return;
    $('#copy-status').textContent = 'Copy unavailable. Select the commands above and copy them.';
  }
  copyTimer = setTimeout(resetCopy, 2400);
});
if (location.protocol === 'https:' && ['localhost', '127.0.0.1'].includes(location.hostname)) {
  $('#local-form').hidden = false;
  $('#local-instructions').textContent = 'You are using the local worker. Paste session JSON below and run real compaction. The first local summary may load its model.';
}
$('#session-input').addEventListener('input', () => {
  editorDirty = $('#session-input').value !== editorSeed;
  $('#session-input').removeAttribute('aria-invalid');
  $('#editor-note').textContent = editorDirty ? 'Using your edited input.' : 'Using the selected example.';
});
$('#load-example').addEventListener('click', loadExample);
function restoreSubmit() {
  const button = $('#local-form button[type=submit]');
  button.disabled = false;
  button.classList.remove('is-busy');
  window.LoomMotion?.watchBusy(button, false);
  button.querySelector('.button-label').textContent = 'Compact locally';
  $('#local-form').setAttribute('aria-busy', 'false');
}
$('#local-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (liveRequest) return;
  let data;
  try {
    data = JSON.parse($('#session-input').value);
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.messages) || !data.messages.length || typeof data.task !== 'string' || !data.task.trim()) throw new Error('Include a nonempty messages array and task string.');
  } catch (error) {
    $('#session-input').setAttribute('aria-invalid', 'true');
    $('#local-result').textContent = 'Check the session JSON. ' + error.message;
    $('#session-input').focus();
    return;
  }
  const request = new AbortController(), button = event.target.querySelector('button[type=submit]');
  liveRequest = request;
  button.disabled = true; button.classList.add('is-busy');
  window.LoomMotion?.watchBusy(button, true);
  button.querySelector('.button-label').textContent = 'Compacting…';
  event.target.setAttribute('aria-busy', 'true');
  $('#local-result').textContent = 'Running local relevance and summary models. The first run may take longer while models load…';
  try {
    const response = await fetch('/v1/compact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(data), signal: request.signal });
    const result = await response.json();
    if (request.signal.aborted) return;
    $('#local-result').textContent = (response.ok ? '' : 'Compaction unavailable (HTTP ' + response.status + ').\n') + JSON.stringify(result, null, 2);
    pulse($('#local-result'));
  } catch (error) {
    if (!request.signal.aborted) $('#local-result').textContent = 'Compaction unavailable: ' + error.message;
  } finally {
    if (liveRequest === request) { liveRequest = null; restoreSubmit(); }
  }
});
async function readJSON(file, signal) {
  const response = await fetch(file, { signal });
  if (!response.ok) throw new Error('Could not load ' + file);
  return response.json();
}
async function initialize() {
  if (initialization) return initialization;
  const controller = pageWork;
  enableExplorer(false);
  initialization = (async () => {
    const data = await Promise.allSettled(['fixtures.json', 'results.json', 'claude-results.json'].map(file => readJSON(file, controller.signal)));
    if (controller.signal.aborted) return;
    if (data[0].status !== 'fulfilled' || !Array.isArray(data[0].value) || !data[0].value.length) {
      $('#lab-state').textContent = 'Session data could not load. Reload this page to try again.';
      $('#results-content').textContent = 'Recorded benchmark data is unavailable.';
      $('.lab-grid').setAttribute('aria-busy', 'false');
      return;
    }
    fixtures = data[0].value;
    $('#case-select').replaceChildren(...fixtures.map(item => {
      const option = node('option', item.id.replaceAll('_', ' ')); option.value = item.id; return option;
    }));
    for (const [index, key] of [[1, 'local'], [2, 'claude']]) {
      if (data[index].status === 'fulfilled' && data[index].value?.manifest && Array.isArray(data[index].value.records)) runs[key] = data[index].value;
      $('#run-select').querySelector('option[value=' + key + ']').disabled = !runs[key];
    }
    $('#run-select').value = runs.claude ? 'claude' : 'local';
    results = runs[$('#run-select').value] || null;
    ready = true; enableExplorer(true);
    render({ animate: false }); renderResults({ animate: false });
    registerReplayTool();
  })().finally(() => { if (pageWork === controller) initialization = null; });
  return initialization;
}
function registerReplayTool() {
  const modelContext = document.modelContext;
  if (!ready || !modelContext?.registerTool || (toolLifecycle && !toolLifecycle.signal.aborted)) return;
  toolLifecycle = new AbortController();
  const tool = {
    name: 'replay_context_trace', title: 'Replay context trace', description: 'Choose a synthetic session, evaluation run and memory method, then display its recorded model trace. Does not run inference.',
    inputSchema: { type: 'object', properties: { case_id: { type: 'string' }, method: { type: 'string', enum: Object.keys(names) }, run: { type: 'string', enum: ['claude', 'local'] } }, required: ['case_id', 'method'], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    execute(input) {
      if (!input || Object.keys(input).some(key => !['case_id', 'method', 'run'].includes(key)) || !fixtures.some(item => item.id === input.case_id) || !Object.hasOwn(names, input.method) || (input.run !== undefined && !runs[input.run])) throw new Error('Unknown session, method or run');
      const previousRun = $('#run-select').value;
      if (input.run) { $('#run-select').value = input.run; results = runs[input.run]; }
      $('#case-select').value = input.case_id; $('#method-select').value = input.method;
      render(); if (previousRun !== $('#run-select').value) renderResults();
      return { case_id: currentCase.id, method: currentMethod, run: $('#run-select').value, status: currentMethod === 'original' ? 'source' : recordFor(currentCase.id, currentMethod)?.status || 'unavailable' };
    }
  };
  Promise.resolve(modelContext.registerTool(tool, { signal: toolLifecycle.signal })).catch(() => {});
}
window.addEventListener('pagehide', () => {
  pageWork.abort(); toolLifecycle?.abort(); ++copyAttempt; resetCopy();
  if (liveRequest) {
    liveRequest.abort(); liveRequest = null; restoreSubmit();
    $('#local-result').textContent = 'The request was interrupted when you left the page. Run it again when ready.';
  }
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  pageWork = new AbortController(); initialization = null;
  if (!ready) initialize(); else registerReplayTool();
});
initialize();
