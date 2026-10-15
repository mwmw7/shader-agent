import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { AgentId, CompletionRequest, HarnessDeps, ModelClient, ToolExecutor } from '../shared/contracts.js';
import { DEFAULT_TEAMS, type TeamNode, type TeamProfile, type TeamRole, type TeamRunState } from '../shared/team-contracts.js';
import { runTeamHarness } from '../server/team-harness.js';
import { assertPermittedTeamNext, canFinishTeam, parseTeamProfile, permittedTeamNext } from '../server/team-policy.js';

const CODE = 'vec4 effect(vec2 fragCoord) { return vec4(fragCoord/u_resolution,0.5,1.0); }';
const REFERENCE = 'data:image/png;base64,dGVzdC1yZWZlcmVuY2U=';
type Role = TeamRole | 'orchestrator';
type CapturedRequest = { role: Role; request: CompletionRequest };

function node(id: string, role: TeamRole, enabled = true): TeamNode {
  return { id, role, enabled, name: `Test ${id}`, icon: '🧪', prompt: `CUSTOM_INSTRUCTION_${id}: describe the visible rain.` };
}

function team(mode: TeamProfile['mode'] = 'fixed'): TeamProfile {
  return { id: 'test-team', name: 'Injected test team', hypothesis: 'Explicit synthetic test fixtures only.', mode,
    nodes: [node('inspect', 'analyze'), node('composition', 'plan'), node('motion', 'plan'), node('examples', 'search'),
      node('paint', 'generate'), node('film', 'render'), node('contrast', 'review'), node('score', 'evaluate'), node('export', 'agsl')] };
}

function initial(profile = team()): TeamRunState {
  return { id: 'team-test-run', team: profile, input: { providerId: 'local', model: 'injected-test-client-only',
    mode: profile.mode, request: 'Create a rainy sky using the provided reference image.', referenceImage: REFERENCE },
    status: 'queued', createdAt: new Date().toISOString(), revision: 0, revisions: 0, maxRevisions: 2,
    modelCalls: 0, artifacts: [], stagnantRounds: 0, nodeOutputs: [], history: [], executionPath: [] };
}

/** These clients and tools are injected test doubles; no real model or renderer is used. */
function clientFor(scores: number[] = [90], override?: (role: Role, request: CompletionRequest) => unknown) {
  const requests: CapturedRequest[] = [];
  let evaluationIndex = 0;
  const client: ModelClient = { async complete(request) {
    const match = /^You are the (\w+) agent/.exec(request.system);
    assert.ok(match, 'System prompts must identify their trusted role before custom instructions');
    const role = match[1] as Role;
    requests.push({ role, request });
    const alternate = override?.(role, request);
    if (alternate !== undefined) return alternate;
    if (role === 'orchestrator') {
      const data = JSON.parse(request.prompt);
      return { next: data.allowedNext[0], reason: 'Choose one registered runtime candidate.' };
    }
    if (role === 'analyze') return { analysis: 'Dark sky, diagonal rain, and visible motion.' };
    if (role === 'plan') return { summary: `Visible rain plan ${requests.length}`, recommendations: ['Keep bright diagonal streaks.'] };
    if (role === 'search') return { query: 'rain', tools: ['examples.search'] };
    if (role === 'generate') return { code: CODE, rationale: 'Apply supplied planning and feedback.', tools: ['rules.check'] };
    if (role === 'render') return { rationale: 'Produce actual frame evidence.', tools: ['webgl.compile', 'render.video', 'video.extract_frames'] };
    if (role === 'review') {
      const data = JSON.parse(request.prompt);
      return { summary: 'Contrast review of actual frames.', recommendations: ['Preserve bright foreground rain.'],
        evidence: data.frames.map((frame: string) => ({ frame, observation: 'Bright streaks are visible against a dark sky.' })) };
    }
    if (role === 'evaluate') {
      const data = JSON.parse(request.prompt);
      const score = scores[Math.min(evaluationIndex++, scores.length - 1)];
      return { score, passed: score >= 80, feedback: score >= 80 ? 'Visual requirements satisfied.' : 'Increase visible rain contrast.',
        evidence: data.frames.map((frame: string) => ({ frame, observation: 'Observed contrast and streak placement.' })) };
    }
    assert.equal(role, 'agsl');
    return { rationale: 'Convert only approved GLSL.', tools: ['agsl.convert', 'rules.check'] };
  } };
  return { client, requests };
}

async function fixture(t: TestContext, state = initial(), model = clientFor()) {
  const runDir = await mkdtemp(join(tmpdir(), 'team-harness-test-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  const events: Parameters<HarnessDeps['emit']>[0][] = [];
  const tools: { agent: AgentId; name: string; args: unknown }[] = [];
  const controller = new AbortController();
  const executor: ToolExecutor = { async execute(agent, name, args) {
    tools.push({ agent, name, args });
    switch (name) {
      case 'examples.search': return { examples: [{ id: 'rain', title: 'Original test rain', code: CODE, license: 'MIT' }] };
      case 'rules.check': return { ok: true, issues: [] };
      case 'webgl.compile': return { ok: true, log: '' };
      case 'render.video': return { video: `render-r${state.revision}.mp4` };
      case 'video.extract_frames': return { frames: [0, 1, 2].map(i => `frame-r${state.revision}-${i}.png`) };
      case 'agsl.convert': return { code: 'half4 main(float2 p) { return half4(1); }', androidVerified: false };
      default: throw new Error(`Unexpected injected test tool: ${name}`);
    }
  } };
  const deps: HarnessDeps = { client: model.client, tools: executor, emit: event => events.push(event), signal: controller.signal,
    runDir, readImage: async filename => `data:image/png;base64,${Buffer.from(filename).toString('base64')}` };
  return { state, deps, events, tools, controller, requests: model.requests };
}

function startedNodes(events: Parameters<HarnessDeps['emit']>[0][]) {
  return events.filter(event => event.type === 'agent.started' && event.agentId !== 'orchestrator').map(event => event.nodeId);
}

test('default team profiles meet the runtime profile contract', () => {
  for (const profile of DEFAULT_TEAMS) assert.deepEqual(parseTeamProfile(profile), profile);
});

test('fixed teams execute custom node IDs in order with custom prompts, attached images, and downstream context', async t => {
  const f = await fixture(t);
  const result = await runTeamHarness(f.state, f.deps);
  assert.equal(result, f.state, 'Run snapshots must observe the original state instance');
  assert.equal(result.status, 'completed', result.stopReason);
  assert.deepEqual(startedNodes(f.events), f.state.team.nodes.map(item => item.id));
  assert.deepEqual(result.executionPath, f.state.team.nodes.map(item => item.id));
  assert.equal(result.modelCalls, f.state.team.nodes.length);
  assert.equal(result.nodeOutputs.filter(output => output.status === 'completed').length, f.state.team.nodes.length);
  assert.equal(canFinishTeam(result), true);
  assert.equal(await readFile(join(f.deps.runDir, 'shader-r1.glsl'), 'utf8'), CODE);

  for (const member of f.state.team.nodes) {
    const request = f.requests.find(item => item.request.system.includes(member.prompt));
    assert.ok(request, `Custom instructions for ${member.id} must reach the model`);
    assert.equal(request.role, member.role, 'A custom node name must not change its trusted role');
  }
  for (const { role, request } of f.requests) {
    if (role === 'analyze' || role === 'plan') assert.ok(request.images?.includes(REFERENCE));
    if (role === 'review' || role === 'evaluate') {
      assert.equal(request.images?.length, 4);
      assert.equal(request.images[0], REFERENCE);
      assert.deepEqual(request.images.slice(1), result.frames!.map(frame => `data:image/png;base64,${Buffer.from(frame).toString('base64')}`));
    }
  }
  assert.match(f.requests.find(item => item.role === 'generate')!.request.prompt, /Visible rain plan/);
  assert.match(f.requests.find(item => item.role === 'evaluate')!.request.prompt, /Contrast review of actual frames/);
  assert.deepEqual(new Set(f.tools.map(tool => tool.agent)), new Set(['search', 'generate', 'render', 'agsl']));
  assert.ok(f.tools.filter(tool => tool.name.startsWith('video.')).every(tool => tool.agent === 'render'));
});

test('orchestrated teams may reorder planning candidates but execute every enabled node before finishing', async t => {
  const f = await fixture(t, initial(team('orchestrated')), clientFor([90], (role, request) => {
    if (role !== 'orchestrator') return undefined;
    const data = JSON.parse(request.prompt);
    return { next: data.allowedNext.at(-1), reason: 'Choose the last permitted candidate to change planning order.' };
  }));
  await runTeamHarness(f.state, f.deps);
  assert.equal(f.state.status, 'completed', f.state.stopReason);
  const path = startedNodes(f.events);
  assert.deepEqual(path, ['inspect', 'examples', 'motion', 'composition', 'paint', 'film', 'contrast', 'score', 'export']);
  assert.ok(f.events.some(event => event.agentId === 'orchestrator'));
  assert.equal(f.state.nodeOutputs.filter(output => output.role === 'plan').length, 2);
});

test('disabled optional nodes are skipped and a passing team can finish without AGSL', async t => {
  const profile = team();
  for (const member of profile.nodes) if (['plan', 'search', 'review', 'agsl'].includes(member.role)) member.enabled = false;
  const f = await fixture(t, initial(profile));
  await runTeamHarness(f.state, f.deps);
  assert.equal(f.state.status, 'completed', f.state.stopReason);
  assert.deepEqual(startedNodes(f.events), ['inspect', 'paint', 'film', 'score']);
  assert.equal(f.state.agsl, undefined);
  assert.equal(canFinishTeam(f.state), true);
  assert.equal(f.tools.some(tool => tool.name === 'examples.search' || tool.name === 'agsl.convert'), false);
});

test('failed evaluation reruns all planning and review nodes, preserving revision-specific snapshots', async t => {
  const f = await fixture(t, initial(), clientFor([55, 90]));
  await runTeamHarness(f.state, f.deps);
  assert.equal(f.state.status, 'completed', f.state.stopReason);
  assert.equal(f.state.revision, 2);
  assert.equal(f.state.revisions, 1);
  assert.deepEqual(startedNodes(f.events), ['inspect', 'composition', 'motion', 'examples', 'paint', 'film', 'contrast', 'score',
    'composition', 'motion', 'examples', 'paint', 'film', 'contrast', 'score', 'export']);
  for (const id of ['composition', 'motion', 'examples', 'paint', 'film', 'contrast', 'score']) {
    assert.deepEqual(f.state.nodeOutputs.filter(output => output.nodeId === id).map(output => output.revision), [1, 2]);
  }
  const first = f.state.history.find(snapshot => snapshot.revision === 1)!;
  const second = f.state.history.find(snapshot => snapshot.revision === 2)!;
  assert.ok(first && second, 'Both rendered revisions must remain inspectable');
  assert.equal(first.evaluation?.score, 55);
  assert.equal(first.evaluation?.passed, false);
  assert.equal(second.evaluation?.score, 90);
  assert.ok(first.frames.every(frame => frame.includes('r1')));
  assert.ok(second.frames.every(frame => frame.includes('r2')));
  assert.ok(first.nodeOutputs.some(output => output.nodeId === 'contrast'));
  assert.equal(first.agsl, undefined);
  assert.ok(second.agsl);
  assert.notEqual(first.frames, second.frames);
  const planCalls = f.requests.filter(item => item.role === 'plan');
  assert.ok(planCalls.slice(2).every(item => item.request.prompt.includes('Increase visible rain contrast.')));
  assert.equal(f.tools.filter(tool => tool.name === 'render.video').length, 2);
  assert.equal(f.tools.filter(tool => tool.name === 'agsl.convert').length, 1);
});

test('a compile failure reruns planning and requires new rendering before any visual assessment', async t => {
  const f = await fixture(t);
  const execute = f.deps.tools.execute.bind(f.deps.tools);
  f.deps.tools.execute = async (agent, name, args) => {
    const result = await execute(agent, name, args);
    return name === 'webgl.compile' && f.state.revision === 1 ? { ok: false, log: 'Injected GLSL compilation failure.' } : result;
  };
  await runTeamHarness(f.state, f.deps);
  assert.equal(f.state.status, 'completed', f.state.stopReason);
  assert.equal(f.state.revision, 2);
  assert.deepEqual(startedNodes(f.events), ['inspect', 'composition', 'motion', 'examples', 'paint', 'film',
    'composition', 'motion', 'examples', 'paint', 'film', 'contrast', 'score', 'export']);
  assert.equal(f.tools.filter(tool => tool.name === 'render.video').length, 1);
  assert.ok(f.state.frames!.every(frame => frame.includes('r2')));
  const first = f.state.history.find(snapshot => snapshot.revision === 1)!;
  assert.equal(first.compileOk, false);
  assert.deepEqual(first.frames, []);
  assert.equal(first.evaluation, undefined);
});

test('profile policy rejects missing or disabled core roles, role duplicates, unsafe IDs, and invalid stage order', () => {
  const invalid: TeamProfile[] = [];
  for (const role of ['analyze', 'generate', 'render', 'evaluate'] as const) {
    const missing = team(); missing.nodes = missing.nodes.filter(member => member.role !== role); invalid.push(missing);
    const disabled = team(); disabled.nodes.find(member => member.role === role)!.enabled = false; invalid.push(disabled);
  }
  for (const role of ['analyze', 'search', 'generate', 'render', 'evaluate', 'agsl'] as const) {
    const duplicate = team();
    const index = duplicate.nodes.findIndex(member => member.role === role);
    duplicate.nodes.splice(index, 0, node(`extra-${role}`, role)); invalid.push(duplicate);
  }
  const duplicateId = team(); duplicateId.nodes[1].id = duplicateId.nodes[0].id; invalid.push(duplicateId);
  const unsafeId = team(); unsafeId.nodes[1].id = '../../escape'; invalid.push(unsafeId);
  const reservedId = team(); reservedId.nodes[1].id = 'finish'; invalid.push(reservedId);
  const wrongOrder = team(); [wrongOrder.nodes[4], wrongOrder.nodes[5]] = [wrongOrder.nodes[5], wrongOrder.nodes[4]]; invalid.push(wrongOrder);
  const tooManyPlans = team(); tooManyPlans.nodes.splice(2, 0, node('plan-three', 'plan'), node('plan-four', 'plan')); invalid.push(tooManyPlans);
  const tooManyReviews = team(); tooManyReviews.nodes.splice(7, 0, node('review-two', 'review'), node('review-three', 'review')); invalid.push(tooManyReviews);
  for (const profile of invalid) assert.throws(() => parseTeamProfile(profile), undefined, `Invalid profile was accepted: ${JSON.stringify(profile.nodes)}`);
  const supported = team(); supported.nodes.splice(2, 0, node('plan-three', 'plan'));
  supported.nodes.splice(supported.nodes.findIndex(member => member.role === 'evaluate'), 0, node('review-two', 'review'));
  assert.equal(parseTeamProfile(supported).nodes.length, 11);
});

test('routing policy permits only registered nodes whose prerequisites are complete', () => {
  const state = initial(team('orchestrated'));
  assert.deepEqual(permittedTeamNext(state), ['inspect']);
  assert.throws(() => assertPermittedTeamNext(state, 'shell.execute'));
  assert.throws(() => assertPermittedTeamNext(state, 'paint'));
  assert.throws(() => assertPermittedTeamNext(state, 'score'));
  assert.throws(() => assertPermittedTeamNext(state, 'finish'));
  assert.equal(canFinishTeam(state), false);
});

for (const proposed of ['shell.execute', 'paint', 'finish']) {
  test(`orchestrator cannot route to ${proposed} before analysis`, async t => {
    const f = await fixture(t, initial(team('orchestrated')), clientFor([90], role => role === 'orchestrator' ?
      { next: proposed, reason: 'Untrusted proposal must be checked by runtime policy.' } : undefined));
    await runTeamHarness(f.state, f.deps);
    assert.equal(f.state.status, 'failed');
    assert.deepEqual(startedNodes(f.events), []);
    assert.equal(f.tools.length, 0);
    assert.ok(f.events.some(event => event.type === 'policy.blocked'));
  });
}

test('a custom generate node cannot request a tool outside its trusted role', async t => {
  const f = await fixture(t, initial(), clientFor([90], role => role === 'generate' ?
    { code: CODE, rationale: 'Attempt to escalate a custom node.', tools: ['agsl.convert'] } : undefined));
  await runTeamHarness(f.state, f.deps);
  assert.equal(f.state.status, 'failed');
  assert.equal(f.tools.some(tool => tool.agent === 'generate'), false);
  assert.equal(f.tools.some(tool => tool.name === 'agsl.convert'), false);
  assert.ok(f.events.some(event => event.type === 'policy.blocked'));
});

for (const role of ['review', 'evaluate'] as const) {
  test(`${role} must reference every actual frame exactly once, including failed assessments`, async t => {
    const f = await fixture(t, initial(), clientFor([20], (calledRole, request) => {
      if (calledRole !== role) return undefined;
      const data = JSON.parse(request.prompt);
      const evidence = [data.frames[0], data.frames[0], 'invented-frame.png'].map(frame => ({ frame, observation: 'Untrusted observation.' }));
      return role === 'review' ? { summary: 'Invalid review.', recommendations: ['Fix contrast.'], evidence } :
        { score: 20, passed: false, feedback: 'Failure does not permit fabricated evidence.', evidence };
    }));
    await runTeamHarness(f.state, f.deps);
    assert.equal(f.state.status, 'failed');
    assert.ok(f.events.some(event => event.type === 'policy.blocked'));
    assert.equal(f.tools.some(tool => tool.name === 'agsl.convert'), false);
    if (role === 'review') assert.equal(f.requests.some(request => request.role === 'evaluate'), false);
  });
}

test('stale rendering evidence cannot authorize review, evaluation, export, or finish', async t => {
  const f = await fixture(t);
  await runTeamHarness(f.state, f.deps);
  assert.equal(f.state.status, 'completed', f.state.stopReason);
  f.state.evidenceRevision = 0;
  assert.equal(canFinishTeam(f.state), false);
  for (const id of ['contrast', 'score', 'export', 'finish']) assert.throws(() => assertPermittedTeamNext(f.state, id));
});

test('global model call budget stops before the next worker can invoke tools', async t => {
  const f = await fixture(t);
  f.deps.maxModelCalls = 2;
  await runTeamHarness(f.state, f.deps);
  assert.equal(f.state.status, 'stopped');
  assert.equal(f.state.modelCalls, 2);
  assert.equal(f.tools.length, 0);
  assert.match(f.state.stopReason!, /모델 호출 예산/);
});

test('revision budget limits repairs and prevents AGSL export of a failed revision', async t => {
  const state = initial(); state.maxRevisions = 1;
  const f = await fixture(t, state, clientFor([40, 50]));
  await runTeamHarness(f.state, f.deps);
  assert.equal(f.state.status, 'stopped', f.state.stopReason);
  assert.equal(f.state.revision, 2);
  assert.equal(f.state.revisions, 1);
  assert.equal(f.tools.filter(tool => tool.name === 'render.video').length, 2);
  assert.equal(f.tools.some(tool => tool.name === 'agsl.convert'), false);
  assert.equal(f.state.history.find(snapshot => snapshot.revision === 2)?.evaluation?.passed, false);
});

test('malformed custom output gets one correction attempt counted against the shared budget', async t => {
  const f = await fixture(t, initial(), clientFor([90], role => role === 'plan' ? { summary: 123, recommendations: [] } : undefined));
  await runTeamHarness(f.state, f.deps);
  assert.equal(f.state.status, 'failed');
  assert.equal(f.state.modelCalls, 3, 'One analysis call plus two invalid plan calls');
  assert.equal(f.requests.filter(request => request.role === 'plan').length, 2);
  assert.equal(f.tools.length, 0);
  assert.match(f.state.stopReason!, /두 번의 응답 모두/);
});

test('cancellation during a model request prevents every subsequent tool call', async t => {
  const f = await fixture(t);
  f.deps.client = { complete: async ({ signal }) => {
    queueMicrotask(() => f.controller.abort());
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } };
  await runTeamHarness(f.state, f.deps);
  assert.equal(f.state.status, 'cancelled');
  assert.equal(f.tools.length, 0);
  assert.equal(f.events.filter(event => event.type === 'run.cancelled').length, 1);
  assert.equal(f.state.currentNodeId, undefined);
});
