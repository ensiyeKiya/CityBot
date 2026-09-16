const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the actual handlers without starting production servers or paid model calls.
const source = fs.readFileSync('src/llmThing.ts', 'utf8');
const ast = ts.createSourceFile('llmThing.ts', source, ts.ScriptTarget.Latest, true);
function handler(receiver, method, name) {
  let result;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === `${receiver}.${method}` &&
        node.arguments[0]?.text === name) result = node.arguments[node.arguments.length - 1].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(result, `handler ${name} exists`);
  return ts.transpile(`(${result})`, { target: ts.ScriptTarget.ES2020 });
}
const quiet = { log() {}, warn() {}, error() {} };
function activity() {
  const context = { exports: {} };
  vm.runInNewContext(ts.transpile(fs.readFileSync('src/requestActivity.ts', 'utf8'), {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020
  }), context);
  return new context.exports.RequestActivity();
}

test('input waits for LLM and MQTT, and stays disabled on disconnect/unlock', () => {
  const elements = Object.fromEntries(['messageInput', 'sendButton', 'micButton', 'presetMenuButton', 'connectionStatus']
    .map(id => [id, { disabled: false, textContent: '' }]));
  const window = { llmThing: null, addMessage() {} };
  vm.runInNewContext(fs.readFileSync('static/js/citybot/connection.js', 'utf8'), {
    window, document: { getElementById: id => elements[id] }
  });
  assert.equal(elements.sendButton.disabled, true);
  assert.equal(window.requireCitybotReady(), false);
  window.llmThing = { invokeAction() {} };
  window.setCitybotConnection(true);
  assert.equal(elements.sendButton.disabled, true);
  window.setCitybotTransportReady(true);
  assert.equal(window.requireCitybotReady(), true);
  assert.equal(elements.sendButton.disabled, false);
  window.setCitybotBusy(true);
  assert.equal(elements.sendButton.disabled, true);
  assert.equal(window.requireCitybotReady(), false);
  window.setCitybotTransportReady(false);
  window.setCitybotBusy(false);
  assert.equal(elements.sendButton.disabled, true);
  window.setCitybotTransportReady(true);
  assert.equal(elements.sendButton.disabled, false);
  window.setCitybotConnection(false, 'Connection failed');
  assert.equal(elements.sendButton.disabled, true);
});

function browserFunction(name) {
  const text = fs.readFileSync('static/js/citybot/chat.js', 'utf8');
  const tree = ts.createSourceFile('chat.js', text, ts.ScriptTarget.Latest, true);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found);
  return `(${found})`;
}

for (const started of [true, false]) {
  test(`send ${started ? 'stays busy until final event' : 'unlocks on rejected start'}`, async () => {
    const busy = [];
    const window = {
      requireCitybotReady: () => true, setCitybotBusy: value => busy.push(value),
      requireLoggedInUserId: () => 1, getLlmContextPayload: () => ({}),
      llmThing: { invokeAction: async () => ({ started, requestId: 'test', error: 'unavailable' }) }
    };
    const send = vm.runInNewContext(browserFunction('sendMessageStream'), {
      window, console: quiet, messageInput: { value: 'hello', focus() {} },
      addMessage: () => ({ remove() {} })
    });
    await send();
    assert.deepEqual(busy, started ? [true] : [true, false]);
  });
}

function eventSubscription() {
  const { EventEmitter } = require('node:events');
  const client = new EventEmitter();
  client.options = { clientId: 'test' };
  client.subscribe = (topics, callback) => { client.topics = topics; client.ack = callback; };
  client.publish = () => {};
  client.end = () => {};
  const ready = [];
  const window = { thing: {}, currentUserId: 1, setCitybotTransportReady: value => ready.push(value) };
  vm.runInNewContext(fs.readFileSync('static/js/citybot/events.js', 'utf8').replace(/^import .*\n/, ''), {
    window, console: quiet, mqtt: { connect: () => client }, appConfig: { SERVER_NAME: 'example.invalid' },
    Cesium: { Color: { BLUE: { withAlpha: () => ({}) } } },
    setTimeout, clearTimeout, navigator: { userAgent: 'test' },
    document: { getElementById: () => ({ addEventListener() {} }) }
  });
  const pending = window.subscribeToWoTEvents();
  client.emit('connect');
  return { pending, client, ready };
}

test('startup waits for every MQTT subscription acknowledgement and disables on disconnect', async () => {
  const { pending, client, ready } = eventSubscription();
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(ready, [false]);
  client.ack(null, client.topics.map(topic => ({ topic, qos: 0 })));
  await pending;
  assert.deepEqual(ready, [false, true]);
  client.emit('close');
  assert.equal(ready.at(-1), false);
});

test('a denied MQTT subscription rejects startup instead of announcing readiness', async () => {
  const { pending, client, ready } = eventSubscription();
  client.ack(null, client.topics.map(topic => ({ topic, qos: 128 })));
  await assert.rejects(pending, /Event subscription rejected/);
  assert.ok(!ready.includes(true));
});

test('activity tracks overlapping requests and idempotent completion', () => {
  const a = activity(), end1 = a.begin(1), end2 = a.begin(1);
  end1(); end1();
  assert.equal(a.isActive(1), true);
  assert.equal(a.isActive(2), false);
  end2();
  assert.equal(a.isActive(1), false);
});

async function runStream({ planningError, finalStreamError, persistenceError, toolEvidence } = {}) {
  const traces = [], events = [], a = activity();
  const modelInputs = [];
  let planningCalls = 0;
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const context = {
    console: quiet, process: { stdout: { isTTY: false } }, global: {},
    Date, Math, Error, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    tracer: { startSpan: () => ({ end() {} }) }, parseUserId: Number,
    userContextKey: String, registerSessionOwner() {}, requestActivity: {
      begin(id) { const end = a.begin(id); return () => { end(); complete(); }; }
    },
    syncContextFromClientInput: () => ({ mapState: {}, building: {} }),
    runtimeManifest: { buildId: 'artifact-test', gatewaySha256: 'abc' },
    latestResetReceiptByUser: new Map([[1, { resetId: 'reset-test' }]]),
    uiStatusReportsByRequestId: {
      get: () => [{ kind: 'sensors', status: 'applied', details: { visibleSensorIds: ['A1'] } }],
      delete() {}
    },
    loadSystemPrompt: () => 'test prompt', loadUserHistory: async () => {}, getUserHistory: () => [],
    toModelMessages: x => x, getReusableConversationHistory: x => x, logPreview: String,
    toolSpecs: [{ function: { name: 'loadSensors' } }], model_name: 'test-model', temperature: 0, max_tokens: 100,
    emitLLMEvent: (_id, _type, payload) => events.push(payload),
    withOpenAiRetry: (_name, fn) => fn(),
    invokeDomainAction: async () => ({ success: true, userMessage: 'Sensors loaded', _evaluationEvidence: toolEvidence }),
    enrichToolResultWithUiStatus: async (_name, _id, result) => result,
    localModel: { chat: { completions: { create: async params => {
      modelInputs.push(params);
      if (params.stream) throw finalStreamError;
      if (planningError) throw planningError;
      if (toolEvidence && planningCalls++ === 0) {
        return { choices: [{ message: { content: '', tool_calls: [{ id: 'tc1', function: { name: 'loadSensors', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
      }
      return { choices: [{ message: { content: 'Please select a building.' }, finish_reason: 'stop' }] };
    } } } },
    formatUserFacingModelError: err => err.message,
    resolveFinalAnswerFromTools: () => finalStreamError ? { source: 'none' } : { source: 'model', content: 'Please select a building.' },
    stripLeakedToolMarker: x => x, trimConversationHistory: x => x, userConversationHistories: new Map(),
    saveChatMessage: async () => {}, saveConversationTrace: async trace => {
      traces.push(trace);
      if (persistenceError) throw new Error('database unavailable');
    }
  };
  const fn = vm.runInNewContext(handler('llmThing', 'setActionHandler', 'processConversationStream'), context);
  const response = await fn({ message: 'Tell me about this building', userId: 1, sessionId: 'test' });
  assert.equal(response.started, true);
  await done;
  assert.equal(a.isActive(1), false);
  assert.equal(traces.length, 1);
  return { trace: traces[0], events, modelInputs };
}

test('planning failure preserves input, model settings and offered tools', async () => {
  const { trace } = await runStream({ planningError: new Error('model unavailable') });
  assert.equal(trace.status, 'failed');
  assert.equal(trace.error.message, 'model unavailable');
  assert.equal(trace.planning_steps[0].input_messages.at(-1).content, 'Tell me about this building');
  assert.equal(trace.offered_tools[0].function.name, 'loadSensors');
  assert.equal(trace.model_parameters.temperature, 0);
  assert.equal(trace.runtime_manifest.buildId, 'artifact-test');
  assert.equal(trace.reset_receipt.resetId, 'reset-test');
  assert.equal(trace.ui_reports[0].details.visibleSensorIds[0], 'A1');
  assert.equal(trace.initial_context.sessionId, 'test');
});
test('planning timeout is retained as timed_out', async () => {
  const { trace } = await runStream({ planningError: new Error('Planning model call timeout after 60 seconds') });
  assert.equal(trace.status, 'timed_out');
});
test('successful text-only turn is retained in planning_steps', async () => {
  const { trace } = await runStream();
  assert.equal(trace.status, 'completed');
  assert.equal(trace.planning_steps.length, 1);
  assert.equal(trace.planning_steps[0].assistant_content, 'Please select a building.');
});
test('final streaming failure cannot generate a fabricated success message', async () => {
  const { trace, events } = await runStream({ finalStreamError: new Error('stream disconnected') });
  assert.equal(trace.status, 'failed');
  assert.equal(trace.error.message, 'stream disconnected');
  assert.ok(events.some(event => event.isFinal && event.error));
  assert.ok(!JSON.stringify(events).includes('successfully executed'));
});
test('a trace write failure still releases request activity', async () => {
  await runStream({ persistenceError: true });
});

test('evaluation evidence is persisted but omitted from model-visible tool results', async () => {
  const evidence = { type: 'sensor-stations', sensors: [{ id: 'A1' }] };
  const { trace, modelInputs } = await runStream({ toolEvidence: evidence });
  assert.equal(trace.planning_steps[0].tool_results[0].evaluation_evidence.sensors[0].id, 'A1');
  const modelPayload = JSON.stringify(modelInputs);
  assert.ok(!modelPayload.includes('_evaluationEvidence'));
  assert.ok(!modelPayload.includes('sensor-stations'));
});

test('study export is authenticated-user scoped and bounded', async () => {
  let seen;
  const exportHandler = vm.runInNewContext(handler('app', 'get', '/api/study/executions'), {
    sessionUserId: () => 7,
    getConversationTracesForUser: async (userId, options) => {
      seen = { userId, options };
      return [{ request_id: 'r1', created_at: '2026-09-16T00:00:00.000Z', trace: {} }];
    },
    console: quiet, Date, Number
  });
  const req = { query: { limit: '500', since: '2026-09-16T00:00:00Z' } };
  const res = {
    code: 200, headers: {}, status(code) { this.code = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; }
  };
  await exportHandler(req, res);
  assert.equal(seen.userId, 7);
  assert.equal(seen.options.limit, 100);
  assert.equal(res.body.schemaVersion, 'citybot-study-bundle-v1');
  assert.equal(res.body.records[0].request_id, 'r1');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('reset rejects in-flight work and then clears context without deleting archived chats', () => {
  const a = activity(), end = a.begin(1), map = new Map(), building = new Map(), owners = new Map([['old', 1]]);
  const receipts = new Map();
  let cleared = false;
  const reset = vm.runInNewContext(handler('app', 'post', '/api/session/start'), {
    sessionUserId: () => 1, requestActivity: a, userContextKey: String,
    clearInMemorySessionsForUser: () => { cleared = true; }, sessionOwners: owners,
    perUserSelectedBuilding: building, perUserMapState: map,
    EMPTY_SELECTED_BUILDING: () => ({ gmlId: null }), DEFAULT_MAP_STATE: () => ({ latitude: 42.6977 }),
    getUserSelectedBuilding: key => building.get(key), getUserMapState: key => map.get(key),
    earlyUiStatusReports: new Map(), uiStatusReportsByRequestId: new Map(),
    latestResetReceiptByUser: receipts, runtimeManifest: { buildId: 'artifact-test' }, Date, Math
  });
  const res = { code: 200, status(c) { this.code = c; return this; }, json(body) { this.body = body; return this; } };
  reset({}, res);
  assert.equal(res.code, 409);
  assert.equal(cleared, false);
  end(); res.code = 200; reset({}, res);
  assert.equal(res.body.success, true);
  assert.equal(cleared, true);
  assert.equal(owners.size, 0);
  assert.equal(res.body.reset.selectedBuilding.gmlId, null);
  assert.equal(res.body.reset.buildId, 'artifact-test');
  assert.equal(receipts.get(1).resetId, res.body.reset.resetId);
});
