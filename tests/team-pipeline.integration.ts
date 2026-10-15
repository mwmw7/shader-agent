/**
 * Test-only injected ModelClient; every tool uses the production implementation.
 * Exercises team routing, actual WebGL, MP4 encoding, PNG decoding and revision
 * history. This does not test or claim access to an actual vision language model.
 * Requires Chromium and ffmpeg. Set CHROMIUM_PATH / FFMPEG_PATH when needed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import type { CompletionRequest, Emit, ModelClient } from '../shared/contracts.js';
import type { RevisionSnapshot, TeamNode, TeamProfile, TeamRole, TeamRunState } from '../shared/team-contracts.js';
import { validateAgslSource } from '../server/agsl.js';
import { hasFreshEvaluation } from '../server/harness-policy.js';
import { DEFAULT_GLSL } from '../server/shader.js';
import { runTeamHarness } from '../server/team-harness.js';
import { canFinishTeam, hasTeamEvidence } from '../server/team-policy.js';
import { createToolExecutor } from '../server/tools.js';

const REFERENCE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const FEEDBACK = 'Increase foreground rain intensity to 0.52 and render a new video.';
const REVIEW = 'Specialist checked actual frame contrast';
type Role = TeamRole | 'orchestrator';

const node = (id: string, role: TeamRole, enabled = true): TeamNode =>
  ({ id, role, enabled, name: id, icon: '🧪', prompt: `TEST_NODE_${id}: apply the role specialization.` });

function profile(specialized: boolean): TeamProfile {
  return { id: specialized ? 'integration-specialists' : 'integration-basic',
    name: specialized ? 'Test specialist team' : 'Test basic team',
    hypothesis: 'Explicit integration fixture; compare real artifacts after deterministic injected judgments.',
    mode: specialized ? 'orchestrated' : 'fixed',
    nodes: [node('inspect', 'analyze'),
      ...(specialized ? [node('contrast-plan', 'plan'), node('motion-plan', 'plan'), node('disabled-plan', 'plan', false)] : []),
      node('paint', 'generate'), node('film', 'render'),
      ...(specialized ? [node('contrast-review', 'review')] : []),
      node('score', 'evaluate'), node('export', 'agsl')] };
}

function initial(team: TeamProfile): TeamRunState {
  return { id: team.id, team, input: { providerId: 'injected-test-only', model: 'explicit-test-client',
    mode: team.mode, request: 'Rainy sky with drifting clouds and visible foreground rain.', referenceImage: REFERENCE },
    status: 'queued', createdAt: new Date().toISOString(), revision: 0, revisions: 0, maxRevisions: 2,
    modelCalls: 0, stagnantRounds: 0, artifacts: [], nodeOutputs: [], history: [], executionPath: [] };
}

function imageEvidence(request: CompletionRequest, frames: string[]) {
  assert.equal(frames.length, 3);
  assert.equal(request.images?.length, 4, 'Vision reviewers receive the reference and three actual decoded frames');
  assert.equal(request.images[0], REFERENCE);
  for (const dataUrl of request.images.slice(1)) {
    assert.ok(dataUrl.startsWith('data:image/png;base64,'));
    const image = Buffer.from(dataUrl.split(',')[1], 'base64');
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(image.readUInt32BE(16), 640);
    assert.equal(image.readUInt32BE(20), 360);
  }
}

/** Production does not load this client or any of these prescribed judgments. */
function injectedClient(specialized: boolean) {
  const requests: { role: Role; request: CompletionRequest }[] = [];
  let evaluated = 0;
  const client: ModelClient = { async complete(request) {
    request.signal.throwIfAborted();
    const role = /^You are the (\w+) agent/.exec(request.system)![1] as Role;
    assert.ok(!request.system.includes('TEST_NODE_disabled-plan'), 'Disabled nodes cannot call the model');
    requests.push({ role, request });
    const data = JSON.parse(request.prompt);
    if (role === 'orchestrator') {
      assert.ok(!data.allowedNext.includes('disabled-plan'));
      // Choose the last candidate, visibly reversing the two planning nodes.
      return { next: data.allowedNext.at(-1), reason: 'Choose only an offered registered node.' };
    }
    if (role === 'analyze') {
      assert.deepEqual(request.images, [REFERENCE]);
      return { analysis: 'Drifting clouds, diagonal rain and darker background.' };
    }
    if (role === 'plan') {
      assert.deepEqual(request.images, [REFERENCE]);
      const revision = data.revision + 1;
      if (revision === 2) assert.equal(data.feedback, FEEDBACK);
      if (request.system.includes('TEST_NODE_contrast-plan')) {
        return { summary: `CONTRAST_PLAN_R${revision}`, recommendations: [`rainIntensity=${revision === 1 ? '0.38' : '0.52'}`] };
      }
      assert.ok(request.system.includes('TEST_NODE_motion-plan'));
      return { summary: `MOTION_PLAN_R${revision}`, recommendations: ['Preserve time-dependent drifting cloud and rain motion.'] };
    }
    if (role === 'generate') {
      assert.deepEqual(request.images, [REFERENCE]);
      let code = DEFAULT_GLSL;
      if (specialized) {
        const plans = data.nodeOutputs.filter((output: { role: string }) => output.role === 'plan');
        assert.equal(plans.length, 2, 'Both custom planning judgments reach generation');
        const contrast = plans.find((output: { nodeId: string }) => output.nodeId === 'contrast-plan');
        assert.equal(contrast.revision, data.revision + 1);
        const intensity = /^rainIntensity=(0\.\d+)$/.exec(contrast.output.recommendations[0])![1];
        // Source content is selected from the actual upstream node output.
        code = DEFAULT_GLSL.replace('* 0.28 + rain', `* ${intensity} + rain`);
        assert.notEqual(code, DEFAULT_GLSL);
        if (data.revision === 1) {
          assert.equal(data.feedback, FEEDBACK);
          assert.ok(request.prompt.includes(REVIEW), 'Previous specialized review remains available during repair');
        }
      } else assert.equal(data.nodeOutputs.some((output: { role: string }) => output.role === 'plan'), false);
      return { code, rationale: 'Test-only source decision driven by upstream planning and feedback.', tools: ['rules.check'] };
    }
    if (role === 'render') return { rationale: 'Execute the real compiler, video renderer and frame extractor.', tools: ['webgl.compile', 'render.video', 'video.extract_frames'] };
    if (role === 'review') {
      imageEvidence(request, data.frames);
      return { summary: `${REVIEW} r${data.revision}.`, recommendations: ['Compare foreground rain contrast with the supplied reference.'],
        evidence: data.frames.map((frame: string) => ({ frame, observation: 'Explicit test judgment on the supplied real decoded frame.' })) };
    }
    if (role === 'evaluate') {
      evaluated++;
      imageEvidence(request, data.frames);
      if (specialized) assert.ok(request.prompt.includes(`${REVIEW} r${data.revision}`), 'Current specialized review reaches evaluation');
      const repair = specialized && evaluated === 1;
      return { score: repair ? 54 : 92, passed: !repair, feedback: repair ? FEEDBACK : 'Explicit injected evaluation passes.',
        evidence: data.frames.map((frame: string) => ({ frame, observation: 'Test client received this actual video frame as a PNG attachment.' })) };
    }
    assert.equal(role, 'agsl');
    return { rationale: 'Convert the approved source with actual production tools.', tools: ['agsl.convert', 'rules.check'] };
  } };
  return { client, requests };
}

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function inspectRevision(dir: string, snapshot: RevisionSnapshot) {
  assert.equal(snapshot.compileOk, true);
  assert.ok(snapshot.video?.startsWith(`shader-r${snapshot.revision}-`));
  assert.equal(snapshot.frames.length, 3);
  assert.ok(snapshot.frames.every(frame => frame.startsWith(`shader-r${snapshot.revision}-`)));
  assert.equal(snapshot.evaluation?.revision, snapshot.revision);
  assert.deepEqual(snapshot.evaluation!.evidence.map(item => item.frame), snapshot.frames);
  const video = await readFile(join(dir, snapshot.video!));
  assert.ok(video.length > 1000);
  assert.equal(video.subarray(4, 8).toString(), 'ftyp', 'Renderer produces a real MP4 container');
  const frames = await Promise.all(snapshot.frames.map(frame => readFile(join(dir, frame))));
  for (const frame of frames) {
    assert.deepEqual([...frame.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(frame.readUInt32BE(16), 640);
    assert.equal(frame.readUInt32BE(20), 360);
  }
  const hashes = frames.map(hash);
  assert.ok(new Set(hashes).size > 1, 'The actual rendered shader changes over time');
  assert.equal(await readFile(join(dir, `shader-r${snapshot.revision}.glsl`), 'utf8'), snapshot.glsl);
  assert.deepEqual(JSON.parse(await readFile(join(dir, `evaluation-r${snapshot.revision}.json`), 'utf8')), snapshot.evaluation);
  return { videoHash: hash(video), frameHashes: hashes };
}

test('actual basic and specialist team pipelines produce distinct MP4/frame artifacts and preserve one feedback repair', { timeout: 300000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'team-real-pipeline-'));
  const outcomes: { state: TeamRunState; hashes: Awaited<ReturnType<typeof inspectRevision>>[] }[] = [];
  try {
    for (const specialized of [false, true]) {
      const state = initial(profile(specialized));
      const dir = join(root, state.team.id);
      const controller = new AbortController();
      const events: Parameters<Emit>[0][] = [];
      const emit: Emit = event => events.push(event);
      const tools = createToolExecutor({ runDir: dir, signal: controller.signal, emit, revision: () => state.revision });
      const model = injectedClient(specialized);
      try {
        const result = await runTeamHarness(state, { client: model.client, tools, emit, runDir: dir, signal: controller.signal,
          readImage: async filename => {
            assert.equal(basename(filename), filename);
            return `data:image/png;base64,${(await readFile(join(dir, filename))).toString('base64')}`;
          } });
        assert.equal(result.status, 'completed', result.stopReason);
        assert.equal(result.revision, specialized ? 2 : 1);
        assert.equal(result.revisions, specialized ? 1 : 0);
        assert.equal(hasTeamEvidence(result), true);
        assert.equal(hasFreshEvaluation(result), true);
        assert.equal(canFinishTeam(result), true);
        assert.equal(result.evidenceRevision, result.revision);
        assert.equal(result.evaluationRevision, result.revision);
        assert.ok(result.evaluation?.passed);
        assert.ok(result.finishedAt);
        assert.ok(result.durationMs! > 0);
        assert.equal(result.modelCalls, model.requests.length);
        assert.ok(result.modelCalls <= 40);
        assert.equal(events.some(event => event.type === 'policy.blocked' || event.type === 'run.failed'), false);
        assert.equal(events.filter(event => event.type === 'run.completed').length, 1);
        const workerPath = result.executionPath.filter(id => id !== 'orchestrator');
        assert.deepEqual(workerPath, specialized
          ? ['inspect', 'motion-plan', 'contrast-plan', 'paint', 'film', 'contrast-review', 'score',
            'motion-plan', 'contrast-plan', 'paint', 'film', 'contrast-review', 'score', 'export']
          : ['inspect', 'paint', 'film', 'score', 'export']);
        assert.equal(result.executionPath.includes('orchestrator'), specialized);
        assert.equal(result.nodeOutputs.some(output => output.nodeId === 'disabled-plan'), false);
        for (const id of state.team.nodes.filter(item => item.enabled).map(item => item.id)) {
          assert.ok(result.nodeOutputs.some(output => output.nodeId === id && output.status === 'completed'));
        }
        const revisions = result.history.filter(snapshot => snapshot.revision > 0);
        assert.equal(revisions.length, specialized ? 2 : 1);
        const hashes = [];
        for (const snapshot of revisions) hashes.push(await inspectRevision(dir, snapshot));
        if (specialized) {
          const [first, second] = revisions;
          assert.equal(first.evaluation?.passed, false);
          assert.equal(first.feedback, FEEDBACK);
          assert.equal(first.agsl, undefined);
          assert.equal(second.evaluation?.passed, true);
          assert.notEqual(first.glsl, second.glsl);
          assert.notEqual(first.video, second.video);
          assert.notEqual(hashes[0].videoHash, hashes[1].videoHash);
          assert.notDeepEqual(hashes[0].frameHashes, hashes[1].frameHashes);
          for (const snapshot of revisions) {
            for (const id of ['contrast-plan', 'motion-plan', 'paint', 'film', 'contrast-review', 'score']) {
              assert.ok(snapshot.nodeOutputs.some(output => output.nodeId === id && output.revision === snapshot.revision));
            }
          }
        }
        validateAgslSource(result.agsl!);
        assert.equal(await readFile(join(dir, `shader-r${result.revision}.agsl`), 'utf8'), result.agsl);
        assert.deepEqual(JSON.parse(await readFile(join(dir, 'revision-history.json'), 'utf8')), JSON.parse(JSON.stringify(result.history)));
        assert.deepEqual(JSON.parse(await readFile(join(dir, 'node-outputs.json'), 'utf8')), JSON.parse(JSON.stringify(result.nodeOutputs)));
        for (const artifact of result.artifacts) assert.ok((await stat(join(dir, artifact.name))).size > 0);
        outcomes.push({ state: result, hashes });
      } finally { controller.abort(); }
    }
    assert.equal(outcomes[0].state.input.referenceImage, outcomes[1].state.input.referenceImage);
    assert.equal(outcomes[0].state.input.request, outcomes[1].state.input.request);
    assert.notEqual(outcomes[0].state.glsl, outcomes[1].state.glsl);
    assert.notDeepEqual(outcomes[0].hashes[0].frameHashes, outcomes[1].hashes[0].frameHashes,
      'The planning output changes actual rendered pixels compared with the same-input basic team');
  } finally { await rm(root, { recursive: true, force: true }); }
});
