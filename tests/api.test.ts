import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer, type ServerOptions } from '../server/api.js';
import type { PublicProvider, RunEvent, RunState, Verification } from '../shared/contracts.js';

const MODEL = 'explicit-local-test-vision';
const verified: Verification = { model: MODEL, vision: true, structured: true, toolCall: true, checkedAt: new Date().toISOString(), detail: 'Explicit trusted test fixture; no real model inference.' };

const completingRunner: NonNullable<ServerOptions['harnessRunner']> = async (state, deps) => {
  state.status = 'running'; deps.emit({ type: 'run.started', message: 'Injected test runner' });
  state.status = 'completed'; deps.emit({ type: 'run.completed' });
  return state;
};
const cancellableRunner: NonNullable<ServerOptions['harnessRunner']> = async (state, deps) => {
  state.status = 'running'; deps.emit({ type: 'run.started', message: 'Injected test runner' });
  state.currentAgent = 'analyze'; deps.emit({ type: 'agent.started', agentId: 'analyze' });
  await new Promise<void>((_resolve, reject) => {
    if (deps.signal.aborted) reject(deps.signal.reason);
    else deps.signal.addEventListener('abort', () => reject(deps.signal.reason), { once: true });
  });
  return state;
};
async function fixture(t: TestContext, harnessRunner = completingRunner) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shader-api-test-'));
  const api = await startServer({
    dataDir: directory, port: 0, harnessRunner,
    clientFactory: () => ({ complete: async () => { throw new Error('Explicit test client must never be called by fixture runner'); } }),
  });
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...api, directory };
}
async function jsonRequest(url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method, headers: { ...(['GET', 'DELETE'].includes(method) ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, data: await response.json() as any, headers: response.headers };
}
async function addProvider(api: Awaited<ReturnType<typeof fixture>>, apiKey?: string) {
  const response = await jsonRequest(`${api.url}/api/providers`, 'POST', { name: '  Test local vision  ', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/', ...(apiKey ? { apiKey } : {}) });
  assert.equal(response.status, 200);
  return response.data as PublicProvider;
}
async function addVerifiedProvider(api: Awaited<ReturnType<typeof fixture>>) {
  const provider = await addProvider(api);
  await api.store.verify(provider.id, { ...verified });
  return provider;
}
const input = (id: string) => ({ providerId: id, model: MODEL, mode: 'fixed', request: 'Create rainy weather shader for explicit API test.' });
async function waitForStatus(url: string, status: RunState['status']): Promise<RunState> {
  const until = Date.now() + 3000;
  do {
    const response = await jsonRequest(url);
    assert.equal(response.status, 200);
    if (response.data.status === status) return response.data;
    await delay(10);
  } while (Date.now() < until);
  throw new Error(`Run did not reach ${status}`);
}
async function readEvents(url: string, count: number, headers: Record<string, string> = {}): Promise<RunEvent[]> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder(); const events: RunEvent[] = []; let buffer = '';
  try {
    while (events.length < count) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = /^data: (.+)$/m.exec(block);
        if (!data) continue;
        assert.match(block, /^event: harness$/m);
        const event = JSON.parse(data[1]) as RunEvent;
        assert.match(block, new RegExp(`^id: ${event.id}$`, 'm'));
        events.push(event);
      }
    }
  } finally { await reader.cancel(); }
  assert.equal(events.length, count);
  return events;
}

test('API provider CRUD hides keys and resets verification only when connection changes', async t => {
  const api = await fixture(t);
  const provider = await addProvider(api, 'never-return-or-save-plaintext');
  assert.equal(provider.name, 'Test local vision'); assert.equal(provider.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(provider.hasApiKey, true); assert.equal('apiKey' in provider, false);
  await api.store.verify(provider.id, { ...verified });
  let response = await jsonRequest(`${api.url}/api/providers`, 'POST', { id: provider.id, name: 'Renamed', kind: 'ollama', baseUrl: provider.baseUrl });
  assert.equal(response.status, 200); assert.equal(response.data.verifications.length, 1); assert.equal(response.data.hasApiKey, true);
  response = await jsonRequest(`${api.url}/api/bootstrap`);
  assert.equal(response.status, 200); assert.equal(response.data.agents.length, 7); assert.match(response.data.defaultGlsl, /vec4 effect/);
  assert.equal(JSON.stringify(response.data).includes('never-return-or-save-plaintext'), false);
  assert.equal((await readFile(path.join(api.directory, 'providers.json'), 'utf8')).includes('never-return-or-save-plaintext'), false);
  response = await jsonRequest(`${api.url}/api/providers`, 'POST', { id: provider.id, name: 'Renamed', kind: 'ollama', baseUrl: 'http://127.0.0.1:11435' });
  assert.equal(response.status, 200); assert.deepEqual(response.data.verifications, []);
  assert.equal((await jsonRequest(`${api.url}/api/providers/${provider.id}`, 'DELETE')).status, 200);
  assert.deepEqual((await jsonRequest(`${api.url}/api/providers`)).data, []);
  assert.equal((await jsonRequest(`${api.url}/api/providers/${provider.id}`, 'DELETE')).status, 404);
});

test('API rejects non-JSON mutations, cross-origin requests, unexpected fields and cloud endpoints', async t => {
  const api = await fixture(t);
  const providerBody = { name: 'Test', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' };
  let response = await fetch(`${api.url}/api/providers`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(providerBody) });
  assert.equal(response.status, 415); await response.body?.cancel();
  response = await fetch(`${api.url}/api/providers`, { method: 'POST' });
  assert.equal(response.status, 415); await response.body?.cancel();
  assert.equal((await jsonRequest(`${api.url}/api/providers`, 'POST', providerBody, { Origin: 'https://outside.example' })).status, 403);
  assert.equal((await jsonRequest(`${api.url}/api/providers`, 'POST', providerBody, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await jsonRequest(`${api.url}/api/providers`, 'POST', { ...providerBody, untrusted: true })).status, 400);
  assert.equal((await jsonRequest(`${api.url}/api/providers`, 'POST', { ...providerBody, baseUrl: 'https://api.openai.com/v1' })).status, 400);
  response = await fetch(`${api.url}/api/providers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad json' });
  assert.equal(response.status, 400); await response.body?.cancel();
  assert.equal((await jsonRequest(`${api.url}/api/providers`, 'POST', providerBody, { Origin: api.url })).status, 200);
});

test('run creation requires all three verification flags for the selected model', async t => {
  const api = await fixture(t); const provider = await addProvider(api);
  let response = await jsonRequest(`${api.url}/api/runs`, 'POST', input(provider.id));
  assert.equal(response.status, 400); assert.match(response.data.error, /검증/);
  await api.store.verify(provider.id, { ...verified, toolCall: false });
  assert.equal((await jsonRequest(`${api.url}/api/runs`, 'POST', input(provider.id))).status, 400);
  await api.store.verify(provider.id, { ...verified });
  assert.equal((await jsonRequest(`${api.url}/api/runs`, 'POST', { ...input(provider.id), model: 'not-verified' })).status, 400);
  response = await jsonRequest(`${api.url}/api/runs`, 'POST', input(provider.id));
  assert.equal(response.status, 202);
  const state = await waitForStatus(`${api.url}/api/runs/${response.data.id}`, 'completed');
  assert.equal(state.input.model, MODEL);
  const replay = await readEvents(`${api.url}/api/runs/${state.id}/events`, 2);
  assert.deepEqual(replay.map(event => event.type), ['run.started', 'run.completed']);
});

test('SSE replays ordered IDs, streams cancellation, protects active provider and persists journal', async t => {
  const api = await fixture(t, cancellableRunner); const provider = await addVerifiedProvider(api);
  const created = await jsonRequest(`${api.url}/api/runs`, 'POST', input(provider.id));
  assert.equal(created.status, 202); const id = created.data.id;
  await waitForStatus(`${api.url}/api/runs/${id}`, 'running');
  assert.equal((await jsonRequest(`${api.url}/api/runs`, 'POST', input(provider.id))).status, 409);
  assert.equal((await jsonRequest(`${api.url}/api/providers/${provider.id}`, 'DELETE')).status, 409);
  assert.equal((await jsonRequest(`${api.url}/api/providers`, 'POST', { id: provider.id, name: 'Unsafe in-flight edit', kind: 'ollama', baseUrl: provider.baseUrl })).status, 409);
  const initial = await readEvents(`${api.url}/api/runs/${id}/events?after=1`, 1);
  assert.equal(initial[0].id, 2); assert.equal(initial[0].type, 'agent.started');
  const future = readEvents(`${api.url}/api/runs/${id}/events?after=2`, 1);
  assert.equal((await jsonRequest(`${api.url}/api/runs/${id}/cancel`, 'POST', {})).status, 200);
  const cancelled = await future;
  assert.equal(cancelled[0].id, 3); assert.equal(cancelled[0].type, 'run.cancelled');
  const state = await waitForStatus(`${api.url}/api/runs/${id}`, 'cancelled');
  assert.match(state.stopReason ?? '', /취소/);
  // The standard Last-Event-ID takes priority over the initial query cursor.
  const replay = await readEvents(`${api.url}/api/runs/${id}/events?after=0`, 2, { 'Last-Event-ID': '1' });
  assert.deepEqual(replay.map(event => event.id), [2, 3]);
  assert.equal((await jsonRequest(`${api.url}/api/runs/${id}/events?after=-1`)).status, 400);
  assert.equal((await jsonRequest(`${api.url}/api/runs/${id}/artifacts/not-registered.png`)).status, 404);
  // close() flushes the journal before persistent-state assertions.
  await api.close();
  const journal = (await readFile(path.join(api.directory, 'runs', id, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(journal.map(event => event.id), [1, 2, 3]);
  assert.equal(JSON.parse(await readFile(path.join(api.directory, 'runs', id, 'run.json'), 'utf8')).status, 'cancelled');
});

test('simultaneous run submissions reserve exactly one active run', async t => {
  const api = await fixture(t, cancellableRunner); const provider = await addVerifiedProvider(api);
  const responses = await Promise.all([
    jsonRequest(`${api.url}/api/runs`, 'POST', input(provider.id)),
    jsonRequest(`${api.url}/api/runs`, 'POST', input(provider.id)),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  const states = (await jsonRequest(`${api.url}/api/runs`)).data as RunState[];
  assert.equal(states.filter(state => ['queued', 'running'].includes(state.status)).length, 1);
});
