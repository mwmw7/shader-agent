import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer, type ServerOptions } from '../server/api.js';
import type { RunEvent, Verification } from '../shared/contracts.js';
import type { ComparisonPackage, ExperimentState } from '../shared/experiment-contracts.js';
import type { TeamProfile, TeamRunState } from '../shared/team-contracts.js';

type TeamRunner = NonNullable<ServerOptions['teamHarnessRunner']>;
const MODEL = 'explicit-team-api-test-vision';
// A genuine 1 x 1 PNG; the injected runner tests transport, not model inference.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=', 'base64');
const REFERENCE = `data:image/png;base64,${PNG.toString('base64')}`;
const verified: Verification = { model: MODEL, vision: true, structured: true, toolCall: true,
  checkedAt: new Date().toISOString(), detail: 'Explicit trusted test fixture; no real model inference.' };

async function request(url: string, method = 'GET', body?: unknown) {
  const response = await fetch(url, { method, signal: AbortSignal.timeout(5000),
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as any };
}

async function fixture(t: TestContext, teamHarnessRunner: TeamRunner) {
  const directory = await mkdtemp(path.join(tmpdir(), 'shader-team-api-'));
  const api = await startServer({ dataDir: directory, port: 0, teamHarnessRunner,
    clientFactory: () => ({ complete: async () => { throw new Error('The injected API test runner must not call a model.'); } }) });
  t.after(async () => { await api.close(); await rm(directory, { recursive: true, force: true }); });
  const provider = await request(`${api.url}/api/providers`, 'POST', {
    name: 'Explicit API fixture', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434',
  });
  assert.equal(provider.status, 200);
  // Trusted test injection only: production HTTP verification remains mandatory.
  await api.store.verify(provider.data.id, verified);
  const teams = await request(`${api.url}/api/teams`);
  assert.equal(teams.status, 200);
  const input = { providerId: provider.data.id, model: MODEL, request: 'Match the shared weather image with moving rain.',
    referenceImage: REFERENCE, maxRevisions: 1 };
  return { ...api, directory, teams: teams.data as TeamProfile[], input };
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean, message: string): Promise<T> {
  const deadline = Date.now() + 5000;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function experiment(api: { url: string }, id: string): Promise<ExperimentState> {
  const response = await request(`${api.url}/api/experiments/${id}`);
  assert.equal(response.status, 200);
  return response.data;
}

async function run(api: { url: string }, id: string): Promise<TeamRunState> {
  const response = await request(`${api.url}/api/runs/${id}`);
  assert.equal(response.status, 200);
  return response.data;
}

function controlledRunner() {
  const started: TeamRunState[] = [];
  const releases: (() => void)[] = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const runner: TeamRunner = async (state, deps) => {
    inFlight++;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    state.status = 'running';
    deps.emit({ type: 'run.started' });
    const node = state.team.nodes.find(item => item.role === 'analyze')!;
    state.currentNodeId = node.id;
    state.currentAgent = 'analyze';
    deps.emit({ type: 'agent.started', agentId: 'analyze' });
    started.push(structuredClone(state));
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(deps.signal.reason);
        releases.push(() => { deps.signal.removeEventListener('abort', abort); resolve(); });
        if (deps.signal.aborted) abort();
        else deps.signal.addEventListener('abort', abort, { once: true });
      });
      state.status = 'completed';
      deps.emit({ type: 'run.completed' });
      return state;
    } finally { inFlight--; }
  };
  return { runner, started, releases, maximumInFlight: () => maximumInFlight };
}

async function replay(url: string, count: number): Promise<RunEvent[]> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: RunEvent[] = [];
  let buffer = '';
  try {
    while (events.length < count) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = /^data: (.+)$/m.exec(block);
        if (data) events.push(JSON.parse(data[1]));
      }
    }
  } finally { await reader.cancel(); }
  assert.equal(events.length, count);
  return events;
}

const completeWithArtifacts: TeamRunner = async (state, deps) => {
  state.status = 'running';
  deps.emit({ type: 'run.started' });
  state.revision = 1;
  state.frames = ['frame-0.png', 'frame-1.png', 'frame-2.png'];
  state.video = 'render.mp4';
  for (const filename of state.frames) await writeFile(path.join(deps.runDir, filename), PNG);
  // Export must not embed MP4 bytes, even for a registered video artifact.
  await writeFile(path.join(deps.runDir, state.video), Buffer.from('explicit test-only video transport fixture'));
  state.artifacts = [...state.frames.map(name => ({ name, kind: 'frame' as const })), { name: state.video, kind: 'video' }];
  state.compileOk = true;
  state.evidenceRevision = state.evaluationRevision = 1;
  state.evaluation = { revision: 1, score: 87, passed: true, feedback: 'Explicit test evaluation.',
    evidence: state.frames.map(frame => ({ frame, observation: 'Transport fixture PNG.' })) };
  state.history = [{ revision: 1, frames: [...state.frames], video: state.video,
    evaluation: structuredClone(state.evaluation), nodeOutputs: [], createdAt: new Date().toISOString() }];
  state.status = 'completed';
  deps.emit({ type: 'run.completed' });
  return state;
};

test('team API seeds ten independent profiles, supports CRUD and rejects invalid mandatory nodes', async t => {
  const api = await fixture(t, completeWithArtifacts);
  assert.equal(api.teams.length, 10);
  assert.equal(new Set(api.teams.map(team => team.id)).size, 10);
  assert.equal(new Set(api.teams.map(team => team.name)).size, 10);
  for (const team of api.teams) for (const role of ['analyze', 'generate', 'render', 'evaluate']) {
    assert.equal(team.nodes.filter(node => node.role === role && node.enabled).length, 1);
  }
  const original = api.teams[0];
  const custom = { ...structuredClone(original), id: 'api-custom-team', name: 'Editable API team', hypothesis: 'Test an independently editable prompt.' };
  assert.equal((await request(`${api.url}/api/teams`, 'POST', custom)).status, 200);
  const edited = { ...custom, name: 'Renamed API team' };
  edited.nodes[0].prompt = 'A changed analysis prompt.';
  assert.equal((await request(`${api.url}/api/teams`, 'POST', edited)).status, 200);
  for (const role of ['analyze', 'generate', 'render', 'evaluate']) {
    const missing = { ...structuredClone(edited), nodes: edited.nodes.filter(node => node.role !== role) };
    assert.equal((await request(`${api.url}/api/teams`, 'POST', missing)).status, 400, `Removing ${role} must fail.`);
    const disabled = structuredClone(edited);
    disabled.nodes.find(node => node.role === role)!.enabled = false;
    assert.equal((await request(`${api.url}/api/teams`, 'POST', disabled)).status, 400, `Disabling ${role} must fail.`);
  }
  const duplicate = structuredClone(edited);
  duplicate.nodes[1].id = duplicate.nodes[0].id;
  assert.equal((await request(`${api.url}/api/teams`, 'POST', duplicate)).status, 400);
  assert.equal((await request(`${api.url}/api/teams`, 'POST', { ...edited, execute: 'arbitrary code' })).status, 400);
  const saved = (await request(`${api.url}/api/teams`)).data as TeamProfile[];
  assert.deepEqual(saved.find(team => team.id === edited.id), edited, 'Invalid edits must preserve the last valid profile.');
  assert.deepEqual(saved.find(team => team.id === original.id), original, 'Editing a new profile must not mutate the seeded team.');
  assert.equal((await request(`${api.url}/api/teams/${edited.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`${api.url}/api/teams/${edited.id}`, 'DELETE')).status, 404);
  assert.equal((await request(`${api.url}/api/teams`)).data.length, 10);
});

test('experiment API runs sequentially with shared input and frozen team snapshots and emits custom node IDs', async t => {
  const control = controlledRunner();
  const api = await fixture(t, control.runner);
  const selected = structuredClone(api.teams.slice(0, 2));
  selected[0].nodes[0].id = 'custom-image-inspector';
  selected[0].nodes[0].name = 'Custom image inspector';
  assert.equal((await request(`${api.url}/api/teams`, 'POST', selected[0])).status, 200);
  const body = { ...api.input, teamIds: selected.map(team => team.id) };
  assert.equal((await request(`${api.url}/api/experiments`, 'POST', { ...body, referenceImage: undefined })).status, 400);
  assert.equal((await request(`${api.url}/api/experiments`, 'POST', { ...body, teamIds: [selected[0].id, selected[0].id] })).status, 400);
  const created = await request(`${api.url}/api/experiments`, 'POST', body);
  assert.equal(created.status, 202);
  await eventually(async () => control.started.length, count => count === 1, 'First team never started.');
  const initial = await experiment(api, created.data.id);
  assert.equal(initial.runIds.length, 2);
  assert.equal((await run(api, initial.runIds[1])).status, 'queued');
  assert.equal((await request(`${api.url}/api/experiments/${initial.id}/export`)).status, 400, 'Active experiments cannot be exported.');
  const events = await replay(`${api.url}/api/runs/${initial.runIds[0]}/events`, 2);
  assert.deepEqual(events.map(event => event.id), [1, 2]);
  assert.equal(events[1].nodeId, 'custom-image-inspector');
  assert.equal(events[1].nodeName, 'Custom image inspector');
  assert.equal(events[1].agentId, 'analyze');
  const laterEdit = structuredClone(selected[1]);
  laterEdit.name = 'Edited after batch submission';
  laterEdit.nodes[0].prompt = 'This edit belongs to future experiments only.';
  assert.equal((await request(`${api.url}/api/teams`, 'POST', laterEdit)).status, 200);
  control.releases[0]();
  await eventually(async () => control.started.length, count => count === 2, 'Second team never started.');
  assert.deepEqual(control.started[1].team, selected[1]);
  control.releases[1]();
  const completed = await eventually(() => experiment(api, initial.id), state => state.status === 'completed', 'Batch never completed.');
  assert.equal(control.maximumInFlight(), 1, 'Local model runs must never overlap.');
  assert.deepEqual(completed.teams, selected);
  for (let index = 0; index < completed.runIds.length; index++) {
    const state = await run(api, completed.runIds[index]);
    assert.equal(state.status, 'completed');
    assert.deepEqual(state.team, selected[index]);
    const { mode, teamId, ...sharedInput } = state.input;
    assert.deepEqual(sharedInput, api.input);
    assert.equal(mode, selected[index].mode);
    assert.equal(teamId, selected[index].id);
  }
});

test('simultaneous batch POST reserves one experiment and batch cancellation prevents queued teams from executing', async t => {
  const control = controlledRunner();
  const api = await fixture(t, control.runner);
  const body = { ...api.input, teamIds: api.teams.slice(0, 3).map(team => team.id) };
  const responses = await Promise.all([
    request(`${api.url}/api/experiments`, 'POST', body),
    request(`${api.url}/api/experiments`, 'POST', body),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [202, 409]);
  const id = responses.find(response => response.status === 202)!.data.id;
  await eventually(async () => control.started.length, count => count === 1, 'The accepted batch never started.');
  const current = await experiment(api, id);
  assert.equal((await request(`${api.url}/api/experiments`)).data.length, 1);
  assert.equal((await request(`${api.url}/api/runs`)).data.length, 3, 'The rejected POST must not leave extra runs.');
  assert.equal((await request(`${api.url}/api/experiments/${id}/cancel`, 'POST', {})).status, 200);
  const states = await eventually(() => Promise.all(current.runIds.map(runId => run(api, runId))),
    values => values.every(state => state.status === 'cancelled'), 'Queued batch runs were not cancelled.');
  assert.equal((await experiment(api, id)).status, 'cancelled');
  assert.equal(control.started.length, 1, 'Queued teams must not call the injected harness after cancellation.');
  for (const state of states) assert.ok(state.finishedAt);
  assert.equal(control.maximumInFlight(), 1);
});

test('portable comparison round trip preserves PNG evidence, remaps IDs and never executes imported runs', async t => {
  let calls = 0;
  const api = await fixture(t, async (state, deps) => { calls++; return completeWithArtifacts(state, deps); });
  const created = await request(`${api.url}/api/experiments`, 'POST', { ...api.input, teamIds: [api.teams[0].id] });
  assert.equal(created.status, 202);
  const source = await eventually(() => experiment(api, created.data.id), item => item.status === 'completed', 'Source experiment never completed.');
  const exported = await request(`${api.url}/api/experiments/${source.id}/export`);
  assert.equal(exported.status, 200);
  const portable = exported.data as ComparisonPackage;
  assert.equal(portable.format, 'shader-harness-comparison');
  assert.equal(portable.version, 1);
  assert.equal(portable.runs.length, 1);
  const fileEntries = Object.entries(portable.files[source.runIds[0]]);
  assert.equal(fileEntries.length, 3);
  for (const [filename, image] of fileEntries) {
    assert.match(filename, /\.png$/);
    assert.ok(image.startsWith('data:image/png;base64,'));
    assert.deepEqual(Buffer.from(image.split(',')[1], 'base64'), PNG);
  }
  assert.equal(JSON.stringify(portable.files).includes('render.mp4'), false);
  const importedResponse = await request(`${api.url}/api/experiments/import`, 'POST', { packages: [portable] });
  assert.equal(importedResponse.status, 201);
  const imported = await experiment(api, importedResponse.data.id);
  assert.notEqual(imported.id, source.id);
  assert.equal(imported.imported, true);
  assert.equal(imported.inputHash, source.inputHash);
  assert.deepEqual(imported.input, source.input);
  assert.equal(imported.runIds.length, 1);
  assert.notEqual(imported.runIds[0], source.runIds[0]);
  const importedRun = await run(api, imported.runIds[0]);
  assert.equal(importedRun.imported, true);
  assert.equal(importedRun.experimentId, imported.id);
  assert.equal(importedRun.video, undefined, 'Imported PNG evidence must not advertise an absent MP4.');
  assert.equal(importedRun.artifacts.some(artifact => artifact.kind === 'video'), false);
  assert.deepEqual(importedRun.team, portable.runs[0].team);
  assert.deepEqual(importedRun.evaluation, portable.runs[0].evaluation);
  assert.equal(importedRun.history.length, 1);
  for (const frame of importedRun.frames!) {
    const artifact = await fetch(`${api.url}/api/runs/${importedRun.id}/artifacts/${frame}`);
    assert.equal(artifact.status, 200);
    assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), PNG);
  }
  assert.equal(calls, 1, 'Importing saved evidence must not execute the harness.');
  const reexport = await request(`${api.url}/api/experiments/${imported.id}/export`);
  assert.equal(reexport.status, 200);
  assert.deepEqual(reexport.data.files[importedRun.id], portable.files[source.runIds[0]]);
});

test('combining comparison packages rejects different input hashes without creating partial imports', async t => {
  let calls = 0;
  const api = await fixture(t, async (state, deps) => { calls++; return completeWithArtifacts(state, deps); });
  const packages: ComparisonPackage[] = [];
  for (const prompt of ['Shared rainy image request.', 'A different sunny image request.']) {
    const created = await request(`${api.url}/api/experiments`, 'POST', {
      ...api.input, request: prompt, teamIds: [api.teams[0].id],
    });
    assert.equal(created.status, 202);
    await eventually(() => experiment(api, created.data.id), item => item.status === 'completed', 'Export source never completed.');
    const exported = await request(`${api.url}/api/experiments/${created.data.id}/export`);
    assert.equal(exported.status, 200);
    packages.push(exported.data);
  }
  assert.notEqual(packages[0].experiment.inputHash, packages[1].experiment.inputHash);
  const rejected = await request(`${api.url}/api/experiments/import`, 'POST', { packages });
  assert.equal(rejected.status, 400);
  assert.equal((await request(`${api.url}/api/experiments`)).data.length, 2);
  assert.equal((await request(`${api.url}/api/runs`)).data.length, 2);
  assert.equal(calls, 2, 'Rejected imports must not launch any model work.');
});
