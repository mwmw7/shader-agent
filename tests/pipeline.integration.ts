/**
 * Cross-module integration test: the ModelClient alone is explicitly injected.
 * LangGraph, runtime policy, WebGL compilation/rendering, MP4 encoding, PNG
 * decoding, artifact writes and AGSL conversion all use production modules.
 * No fake model/provider is reachable from the shipped application.
 * Requires Chromium + ffmpeg; optionally set CHROMIUM_PATH and FFMPEG_PATH.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import type { AgentId, Emit, ModelClient, RunMode, RunState } from '../shared/contracts.js';
import { validateAgslSource } from '../server/agsl.js';
import { runHarness } from '../server/harness.js';
import { hasFreshEvidence, hasFreshEvaluation } from '../server/harness-policy.js';
import { DEFAULT_GLSL } from '../server/shader.js';
import { createToolExecutor } from '../server/tools.js';

const FEEDBACK = '첫 렌더링의 빗줄기 대비를 높인 뒤 새 영상을 생성하세요.';

function injectedClient(mode: RunMode): ModelClient {
  let generated = 0;
  let evaluated = 0;
  return {
    async complete(request) {
      request.signal.throwIfAborted();
      const agent = request.system.match(/^You are the (\w+) agent/)![1] as AgentId;
      if (agent === 'orchestrator') {
        const data = JSON.parse(request.prompt);
        // Prefer generation when local examples are unnecessary, exercising a
        // genuinely different permitted path from the hard-wired fixed graph.
        return { next: data.allowedNext.includes('generate') ? 'generate' : data.allowedNext[0], reason: '현재 허용된 다음 작업을 선택합니다.' };
      }
      if (agent === 'analyze') return { analysis: '구름이 있는 어두운 하늘에 시간에 따라 흐르는 빗줄기를 렌더링합니다.' };
      if (agent === 'search') return { query: 'rain cloud weather', tools: ['examples.search'] };
      if (agent === 'generate') {
        generated++;
        if (generated > 1) assert.ok(request.prompt.includes(FEEDBACK), 'Generation must receive the prior evaluation feedback.');
        return { code: generated > 1 ? DEFAULT_GLSL.replace('* 0.28 + rain', '* 0.38 + rain') : DEFAULT_GLSL,
          rationale: '테스트용 명시적 모델 응답: 실제 툴에 원본 교육 셰이더를 전달합니다.', tools: ['rules.check'] };
      }
      if (agent === 'render') return { rationale: '실제 컴파일, 영상, 프레임 툴을 호출합니다.', tools: ['webgl.compile', 'render.video', 'video.extract_frames'] };
      if (agent === 'evaluate') {
        evaluated++;
        const data = JSON.parse(request.prompt);
        assert.equal(request.images?.length, 3);
        for (const dataUrl of request.images!) {
          assert.ok(dataUrl.startsWith('data:image/png;base64,'));
          const image = Buffer.from(dataUrl.split(',')[1], 'base64');
          assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
          assert.equal(image.readUInt32BE(16), 640);
          assert.equal(image.readUInt32BE(20), 360);
        }
        const failed = mode === 'fixed' && evaluated === 1;
        return { score: failed ? 55 : 92, passed: !failed, feedback: failed ? FEEDBACK : '명시적 테스트 평가 통과',
          evidence: data.frames.map((frame: string) => ({ frame, observation: '실제 영상에서 디코딩한 프레임을 테스트 입력으로 확인했습니다.' })) };
      }
      return { rationale: '실제 규칙 기반 AGSL 변환을 요청합니다.', tools: ['agsl.convert', 'rules.check'] };
    },
  };
}

for (const mode of ['fixed', 'orchestrated'] as const) {
  test(`actual ${mode} pipeline produces video, fresh frame evaluation and AGSL${mode === 'fixed' ? ' after one feedback loop' : ''}`,
    { timeout: 240000 }, async () => {
      const dir = await mkdtemp(join(tmpdir(), `harness-pipeline-${mode}-`));
      const controller = new AbortController();
      const state: RunState = { id: `integration-${mode}`, input: { providerId: 'injected-test-only', model: 'explicit-test-client', mode,
        request: '구름과 비가 움직이는 날씨 배경' }, status: 'queued', createdAt: new Date().toISOString(), revision: 0, revisions: 0,
        maxRevisions: 2, modelCalls: 0, artifacts: [], stagnantRounds: 0 };
      const events: Parameters<Emit>[0][] = [];
      const emit: Emit = (event) => events.push(event);
      const tools = createToolExecutor({ runDir: dir, signal: controller.signal, emit, revision: () => state.revision });
      try {
        const final = await runHarness(state, { client: injectedClient(mode), tools, emit, runDir: dir, signal: controller.signal,
          readImage: async (name) => {
            assert.equal(basename(name), name);
            return `data:image/png;base64,${(await readFile(join(dir, name))).toString('base64')}`;
          } });
        assert.equal(final.status, 'completed', final.stopReason);
        assert.equal(final.revision, mode === 'fixed' ? 2 : 1);
        assert.equal(final.revisions, mode === 'fixed' ? 1 : 0);
        assert.equal(hasFreshEvidence(final), true);
        assert.equal(hasFreshEvaluation(final), true);
        assert.equal(final.evaluation?.passed, true);
        assert.equal(final.evaluationRevision, final.revision);
        assert.equal(final.evidenceRevision, final.revision);
        assert.equal(final.frames?.length, 3);
        assert.ok(final.video);
        const video = await readFile(join(dir, final.video!));
        assert.ok(video.length > 1000);
        assert.equal(video.subarray(4, 8).toString(), 'ftyp');
        const images = await Promise.all(final.frames!.map((name) => readFile(join(dir, name))));
        const hashes = images.map((image) => createHash('sha256').update(image).digest('hex'));
        assert.ok(new Set(hashes).size > 1, 'The actual weather shader must change over time.');
        const agsl = await readFile(join(dir, `shader-r${final.revision}.agsl`), 'utf8');
        validateAgslSource(agsl);
        assert.equal(agsl, final.agsl);
        const glsl = await readFile(join(dir, `shader-r${final.revision}.glsl`), 'utf8');
        assert.equal(glsl, final.glsl);
        const evaluation = JSON.parse(await readFile(join(dir, `evaluation-r${final.revision}.json`), 'utf8'));
        assert.deepEqual(evaluation, final.evaluation);
        for (const artifact of final.artifacts) assert.ok((await stat(join(dir, artifact.name))).size > 0);
        assert.equal(events.filter((event) => event.type === 'evaluation.completed').length, mode === 'fixed' ? 2 : 1);
        assert.equal(events.filter((event) => event.type === 'run.completed').length, 1);
        assert.equal(events.some((event) => event.type === 'policy.blocked'), false);
        assert.equal(events.some((event) => event.type === 'agent.started' && event.agentId === 'orchestrator'), mode === 'orchestrated');
      } finally {
        controller.abort();
        await rm(dir, { recursive: true, force: true });
      }
    });
}
