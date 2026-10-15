import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentId, CompletionRequest, HarnessDeps, ModelClient, RunState, ToolExecutor } from '../shared/contracts.js';
import { runHarness } from '../server/harness.js';
import { assertPermittedNext, assertWorkerPreconditions, hasFreshEvidence, hasFreshEvaluation, permittedNext } from '../server/harness-policy.js';
import { SCHEMAS } from '../server/harness-prompts.js';
import { buildFragmentShader, relocateCompileLog } from '../server/shader.js';
import { AGENTS } from '../shared/contracts.js';

const CODE = 'vec4 effect(vec2 fragCoord) { return vec4(fragCoord/u_resolution,0.5,1.0); }';
function initial(mode: 'fixed' | 'orchestrated' = 'fixed'): RunState {
  return { id: 'test-run', input: { providerId: 'local', model: 'test-only-injected-client', mode, request: '비 내리는 배경을 만들어 주세요.' },
    status: 'queued', createdAt: new Date().toISOString(), revision: 0, revisions: 0, maxRevisions: 2, modelCalls: 0, artifacts: [], stagnantRounds: 0 };
}

/** Explicit test-only injected client. Production never uses canned model responses. */
function clientFor(scores: number[] = [90], override?: (role: AgentId, request: CompletionRequest) => unknown): ModelClient {
  let evaluationIndex = 0;
  return { async complete(request) {
    const role = request.system.match(/^You are the (\w+) agent/)![1] as AgentId;
    const alternate = override?.(role, request);
    if (alternate !== undefined) return alternate;
    if (role === 'orchestrator') {
      const data = JSON.parse(request.prompt);
      return { next: data.allowedNext[0], reason: '등록된 후보 중 다음 단계를 선택합니다.' };
    }
    if (role === 'analyze') return { analysis: '어두운 하늘과 빗줄기를 시간에 따라 이동시킵니다.' };
    if (role === 'search') return { query: 'rain', tools: ['examples.search'] };
    if (role === 'generate') return { code: CODE, rationale: '요구사항과 피드백을 반영합니다.', tools: ['rules.check'] };
    if (role === 'render') return { rationale: '실제 렌더링 증거를 생성합니다.', tools: ['webgl.compile', 'render.video', 'video.extract_frames'] };
    if (role === 'evaluate') {
      const data = JSON.parse(request.prompt);
      const score = scores[Math.min(evaluationIndex++, scores.length - 1)];
      assert.equal(request.images?.length, 3);
      return { score, passed: score >= 80, feedback: score >= 80 ? '요구사항 충족' : '비의 대비를 높이세요.',
        evidence: data.frames.map((frame: string) => ({ frame, observation: '제공된 프레임의 비 대비를 확인했습니다.' })) };
    }
    return { rationale: '규칙 기반 변환과 검사를 호출합니다.', tools: ['agsl.convert', 'rules.check'] };
  } };
}

async function fixture(state = initial(), client = clientFor()) {
  const runDir = await mkdtemp(join(tmpdir(), 'harness-policy-test-'));
  const events: Parameters<HarnessDeps['emit']>[0][] = [];
  const tools: { agent: AgentId; name: string; args: any }[] = [];
  const controller = new AbortController();
  const executor: ToolExecutor = { async execute(agent, name, args) {
    tools.push({ agent, name, args });
    switch (name) {
      case 'examples.search': return { examples: [{ id: 'rain', title: 'Original rain', code: CODE, license: 'MIT' }] };
      case 'rules.check': return { ok: true, issues: [] };
      case 'webgl.compile': return { ok: true, log: '' };
      case 'render.video': return { video: `render-r${state.revision}.mp4` };
      case 'video.extract_frames': return { frames: [0, 1, 2].map((i) => `frame-r${state.revision}-${i}.png`) };
      case 'agsl.convert': return { code: 'half4 main(float2 p) { return half4(1); }', androidVerified: false };
      default: throw new Error(`Unexpected test tool ${name}`);
    }
  } };
  const deps: HarnessDeps = { client, tools: executor, emit: (event) => events.push(event), signal: controller.signal,
    runDir, readImage: async () => 'data:image/png;base64,dGVzdC1vbmx5' };
  return { state, deps, events, tools, controller, cleanup: () => rm(runDir, { recursive: true, force: true }) };
}

test('fixed graph executes all six agents with trusted tool roles and produces revision-matched artifacts', async () => {
  const f = await fixture();
  try {
    const result = await runHarness(f.state, f.deps);
    assert.equal(result, f.state, 'API snapshots must observe the same state instance');
    assert.equal(result.status, 'completed', result.stopReason);
    assert.deepEqual(f.events.filter((event) => event.type === 'agent.started').map((event) => event.agentId),
      ['analyze', 'search', 'generate', 'render', 'evaluate', 'agsl']);
    assert.equal(result.revision, 1);
    assert.equal(result.modelCalls, 6);
    assert.equal(result.evaluationRevision, 1);
    assert.equal(result.evidenceRevision, 1);
    assert.equal(await readFile(join(f.deps.runDir, 'shader-r1.glsl'), 'utf8'), CODE);
    assert.ok(result.artifacts.some((artifact) => artifact.kind === 'agsl'));
    assert.ok(f.tools.filter((tool) => tool.name.startsWith('video.')).every((tool) => tool.agent === 'render'));
  } finally { await f.cleanup(); }
});

test('failed evaluation feeds back into generation, invalidates evidence, and renders the new revision', async () => {
  const f = await fixture(initial(), clientFor([55, 90]));
  try {
    await runHarness(f.state, f.deps);
    assert.equal(f.state.status, 'completed', f.state.stopReason);
    assert.equal(f.state.revision, 2);
    assert.equal(f.state.revisions, 1);
    assert.equal(f.state.evaluationRevision, 2);
    assert.equal(f.state.evidenceRevision, 2);
    assert.ok(f.state.frames?.every((frame) => frame.includes('r2')));
    assert.equal(f.events.filter((event) => event.type === 'evaluation.completed').length, 2);
    assert.equal(f.tools.filter((tool) => tool.name === 'render.video').length, 2);
  } finally { await f.cleanup(); }
});

test('orchestrated graph can skip optional search but cannot bypass render and fresh evaluation', async () => {
  const f = await fixture(initial('orchestrated'), clientFor([90], (role, request) => {
    if (role !== 'orchestrator') return undefined;
    const data = JSON.parse(request.prompt);
    return { next: data.allowedNext.includes('generate') ? 'generate' : data.allowedNext[0], reason: '필요한 노드만 선택' };
  }));
  try {
    await runHarness(f.state, f.deps);
    assert.equal(f.state.status, 'completed', f.state.stopReason);
    assert.equal(f.tools.filter((tool) => tool.name === 'examples.search').length, 0);
    assert.ok(f.events.some((event) => event.agentId === 'orchestrator'));
    assert.equal(f.state.evaluationRevision, f.state.revision);
  } finally { await f.cleanup(); }
});

test('orchestrator proposal for an unknown node is denied before executing any worker or tool', async () => {
  const f = await fixture(initial('orchestrated'), clientFor([90], (role) =>
    role === 'orchestrator' ? { next: 'shell.execute', reason: 'untrusted model proposal' } : undefined));
  try {
    await runHarness(f.state, f.deps);
    assert.equal(f.state.status, 'failed');
    assert.equal(f.tools.length, 0);
    assert.ok(f.events.some((event) => event.type === 'policy.blocked'));
    assert.match(f.state.stopReason!, /등록되지 않은/);
  } finally { await f.cleanup(); }
});

test('stale or absent evidence cannot authorize evaluation, AGSL conversion, or finish', () => {
  const s = initial('orchestrated');
  Object.assign(s, { status: 'running', analysis: 'requirements', glsl: CODE, revision: 2, compileOk: true,
    video: 'render-r1.mp4', frames: ['frame-r1.png'], evidenceRevision: 1,
    evaluationRevision: 1, evaluation: { score: 95, passed: true, feedback: 'old', evidence: [], revision: 1 } });
  assert.equal(hasFreshEvidence(s), false);
  assert.equal(hasFreshEvaluation(s), false);
  assert.deepEqual(permittedNext(s), ['render']);
  assert.throws(() => assertWorkerPreconditions(s, 'evaluate'), /현재 리비전/);
  assert.throws(() => assertWorkerPreconditions(s, 'agsl'), /현재 리비전/);
  assert.throws(() => assertPermittedNext(s, 'finish'), /호출 거부/);
  s.evidenceRevision = 2;
  assert.equal(hasFreshEvaluation(s), false);
  assert.deepEqual(permittedNext(s), ['evaluate']);
});

test('only two rewrites are allowed and failed evidence never exports AGSL', async () => {
  const f = await fixture(initial(), clientFor([40, 50, 60]));
  try {
    await runHarness(f.state, f.deps);
    assert.equal(f.state.status, 'stopped', f.state.stopReason);
    assert.equal(f.state.revision, 3);
    assert.equal(f.state.revisions, 2);
    assert.equal(f.tools.filter((tool) => tool.name === 'agsl.convert').length, 0);
  } finally { await f.cleanup(); }
});

test('global call budget stops execution separately from graph recursion limits', async () => {
  const f = await fixture();
  f.deps.maxModelCalls = 2;
  try {
    await runHarness(f.state, f.deps);
    assert.equal(f.state.status, 'stopped');
    assert.equal(f.state.modelCalls, 2);
    assert.match(f.state.stopReason!, /모델 호출 예산/);
  } finally { await f.cleanup(); }
});

test('cancellation interrupts a model call and prevents subsequent tool execution', async () => {
  const f = await fixture();
  f.deps.client = { complete: async ({ signal }) => {
    queueMicrotask(() => f.controller.abort());
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } };
  try {
    await runHarness(f.state, f.deps);
    assert.equal(f.state.status, 'cancelled');
    assert.equal(f.tools.length, 0);
    assert.equal(f.events.filter((event) => event.type === 'run.cancelled').length, 1);
  } finally { await f.cleanup(); }
});

test('base run GLSL is a seed, not a consumed repair or permission to reuse old results', async () => {
  const state = initial('orchestrated'); state.glsl = CODE; state.maxRevisions = 0;
  const f = await fixture(state);
  try {
    await runHarness(f.state, f.deps);
    assert.equal(f.state.status, 'completed', f.state.stopReason);
    assert.equal(f.state.revisions, 0);
    assert.equal(f.state.revision, 1);
    assert.equal(f.state.evaluationRevision, 1);
  } finally { await f.cleanup(); }
});

test('malformed model output retries once, consumes budget, and fails closed if still invalid', async () => {
  const f = await fixture();
  f.deps.client = { complete: async () => '{broken-json' };
  try {
    await runHarness(f.state, f.deps);
    assert.equal(f.state.status, 'failed');
    assert.equal(f.state.modelCalls, 2);
    assert.equal(f.tools.length, 0);
    assert.match(f.state.stopReason!, /두 번의 응답 모두/);
  } finally { await f.cleanup(); }
});

test('evaluation cannot invent evidence names or authorize export with unobserved frames', async () => {
  const f = await fixture(initial(), clientFor([90], (role) => role === 'evaluate' ? {
    score: 100, passed: true, feedback: 'fabricated response',
    evidence: [{ frame: 'nonexistent.png', observation: 'not actual evidence' }],
  } : undefined));
  try {
    await runHarness(f.state, f.deps);
    assert.equal(f.state.status, 'failed');
    assert.ok(f.events.some((event) => event.type === 'policy.blocked'));
    assert.equal(f.tools.filter((tool) => tool.name === 'agsl.convert').length, 0);
  } finally { await f.cleanup(); }
});

test('tool-using output schemas constrain tools to the registered tool IDs of that role', () => {
  // A free-form string array let qwen3.5 fill tools with node IDs ("node-1-analyze") or near-misses ("rules-check"),
  // which the ACL rejected after a full model call. The schema must make such values impossible at generation time.
  for (const agent of AGENTS) {
    if (!agent.tools.length) continue;
    const schema = (SCHEMAS as Record<string, any>)[agent.id];
    assert(schema, `schema for ${agent.id}`);
    const tools = schema.properties.tools;
    assert.deepEqual(tools.items.enum, [...agent.tools], `${agent.id} tools enum`);
    assert.equal(tools.minItems, 1);
    assert.equal(tools.maxItems, agent.tools.length, `${agent.id} cannot propose more tools than it owns`);
  }
});

test('WebGL compile log line numbers are relocated to the agent source, not the host-wrapped program', () => {
  const headerLines = buildFragmentShader(CODE).split('\n').indexOf(CODE);
  assert.equal(headerLines, 3);
  const log = "ERROR: 0:4: 'noise' : no matching overloaded function found\nERROR: 0:23: '=' : dimension mismatch\nERROR: 0:2: header";
  assert.equal(relocateCompileLog(log), "ERROR: 0:1: 'noise' : no matching overloaded function found\nERROR: 0:20: '=' : dimension mismatch\nERROR: 0:2: header");
});
