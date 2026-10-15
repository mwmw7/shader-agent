import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import type { AgentId, Artifact, HarnessDeps, RunState, WorkerId } from '../shared/contracts.js';
import { assertPermittedNext, assertToolPlan, assertWorkerPreconditions, canFinish, hasFreshEvidence, hasFreshEvaluation, permittedNext, PolicyError, WORKERS } from './harness-policy.js';
import { evaluationSchema, routingSchema, SCHEMAS, systemPrompt } from './harness-prompts.js';

const GraphState = Annotation.Root({ run: Annotation<RunState>() });
const toolNames = z.array(z.string()).min(1).max(3);
const text = z.string().trim().min(1).max(32000);
const decisions = {
  analyze: z.object({ analysis: text }).strict(),
  search: z.object({ query: text, tools: toolNames }).strict(),
  generate: z.object({ code: text, rationale: text, tools: toolNames }).strict(),
  render: z.object({ rationale: text, tools: toolNames }).strict(),
  evaluate: z.object({ score: z.number().min(0).max(100), passed: z.boolean(), feedback: text,
    evidence: z.array(z.object({ frame: text, observation: text }).strict()).min(1).max(4) }).strict(),
  agsl: z.object({ rationale: text, tools: toolNames }).strict(),
  orchestrator: z.object({ next: z.string(), reason: text }).strict(),
};

class BudgetStop extends Error { constructor(message: string) { super(message); this.name = 'BudgetStop'; } }

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return JSON.parse(value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

function asMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** All calls go through registered LangGraph nodes, whose trusted closures supply IDs. */
export async function runHarness(initial: RunState, deps: HarnessDeps): Promise<RunState> {
  const state = initial;
  const maxCalls = Math.max(1, Math.min(40, deps.maxModelCalls ?? 40));
  state.maxRevisions = Math.max(0, Math.min(2, state.maxRevisions ?? 2));
  state.modelCalls ||= 0;
  state.revisions ||= 0;
  state.stagnantRounds ||= 0;
  let previousScore: number | undefined;

  function checkAbort(): void { deps.signal.throwIfAborted(); }
  function artifact(name: string, kind: Artifact['kind']): void {
    if (!state.artifacts.some((item) => item.name === name)) state.artifacts.push({ name, kind });
  }
  async function save(name: string, content: string, kind: Artifact['kind']): Promise<void> {
    checkAbort();
    await writeFile(join(deps.runDir, name), content, 'utf8');
    artifact(name, kind);
  }
  function canRepair(): boolean {
    if (state.revisions >= state.maxRevisions) {
      state.stopReason = `수정 예산 ${state.maxRevisions}회를 모두 사용했습니다. 디자이너 검토가 필요합니다.`;
      return false;
    }
    if (state.stagnantRounds >= 2) {
      state.stopReason = '두 번 연속 평가 점수가 개선되지 않았습니다. 디자이너 검토가 필요합니다.';
      return false;
    }
    return true;
  }
  function repairOrFinish(): 'generate' | 'finish' {
    if (canRepair()) return 'generate';
    state.status = 'stopped';
    return 'finish';
  }
  async function decide<T>(agent: AgentId, prompt: string, schema: Record<string, unknown>, validator: z.ZodType<T>, images: string[] = []): Promise<T> {
    let lastError = '';
    // One JSON/schema repair retry. Every request consumes the same global budget.
    for (let attempt = 0; attempt < 2; attempt++) {
      checkAbort();
      if (state.modelCalls >= maxCalls) throw new BudgetStop(`모델 호출 예산 ${maxCalls}회를 모두 사용했습니다.`);
      state.modelCalls++;
      try {
        const raw = await deps.client.complete({ system: systemPrompt(agent),
          prompt: prompt + (attempt ? `\nPrevious response was invalid: ${lastError}. Return corrected JSON only.` : ''),
          schema, images, signal: deps.signal });
        checkAbort();
        return validator.parse(parseJson(raw));
      } catch (error) {
        checkAbort();
        const malformed = error instanceof z.ZodError || error instanceof SyntaxError ||
          (error instanceof Error && error.name === 'ModelOutputError');
        if (!malformed) throw error;
        lastError = asMessage(error).slice(0, 1200);
        if (attempt === 1) throw new Error(`${agent}: 두 번의 응답 모두 JSON 계약을 위반했습니다. ${lastError}`);
        deps.emit({ type: 'log', agentId: agent, message: 'JSON 응답 계약 위반: 한 번만 교정 요청합니다.' });
      }
    }
    throw new Error('Unreachable decision branch');
  }

  const context = () => JSON.stringify({ request: state.input.request, analysis: state.analysis,
    revision: state.revision, feedback: state.feedback, examples: state.examples });

  const workers: Record<WorkerId, () => Promise<void>> = {
    async analyze() {
      const result = await decide('analyze', JSON.stringify({ request: state.input.request }), SCHEMAS.analyze,
        decisions.analyze, state.input.referenceImage ? [state.input.referenceImage] : []);
      state.analysis = result.analysis;
      deps.emit({ type: 'log', agentId: 'analyze', message: result.analysis });
    },
    async search() {
      const result = await decide('search', context(), SCHEMAS.search, decisions.search);
      assertToolPlan('search', result.tools, ['examples.search']);
      state.examples = await deps.tools.execute('search', 'examples.search', { query: result.query });
    },
    async generate() {
      if (state.revision > 0 && !canRepair()) throw new BudgetStop(state.stopReason!);
      const result = await decide('generate', context() + '\nCurrent GLSL:\n' + (state.glsl ?? '(none)'),
        SCHEMAS.generate, decisions.generate);
      assertToolPlan('generate', result.tools, ['rules.check']);
      if (state.revision > 0) state.revisions++;
      state.revision++;
      state.glsl = result.code;
      // Invalidate every downstream result before accepting a new revision.
      delete state.compileOk; delete state.compileLog; delete state.video; delete state.frames;
      delete state.evidenceRevision; delete state.evaluation; delete state.evaluationRevision; delete state.agsl;
      const resultCheck = await deps.tools.execute('generate', 'rules.check', { code: state.glsl, target: 'glsl' });
      await save(`shader-r${state.revision}.glsl`, state.glsl, 'glsl');
      if (resultCheck.ok !== true) {
        state.compileOk = false;
        state.compileLog = (resultCheck.issues ?? ['GLSL 규칙 검사 실패']).join('\n');
        state.feedback = `GLSL 규칙 검사 실패. 다음 위반을 수정하세요:\n${state.compileLog}`;
      } else {
        deps.emit({ type: 'shader.updated', agentId: 'generate', data: { code: state.glsl } });
      }
    },
    async render() {
      const result = await decide('render', JSON.stringify({ revision: state.revision, width: 640, height: 360, duration: 3, fps: 12 }),
        SCHEMAS.render, decisions.render);
      assertToolPlan('render', result.tools, ['webgl.compile', 'render.video', 'video.extract_frames']);
      delete state.video; delete state.frames; delete state.evidenceRevision;
      delete state.evaluation; delete state.evaluationRevision; delete state.agsl;
      const compilation = await deps.tools.execute('render', 'webgl.compile', { code: state.glsl });
      state.compileOk = compilation.ok === true;
      state.compileLog = String(compilation.log ?? '');
      if (!state.compileOk) {
        state.feedback = `실제 WebGL 컴파일 실패. 로그에 따라 소스를 수정하세요:\n${state.compileLog}`;
        return;
      }
      const video = await deps.tools.execute('render', 'render.video', { code: state.glsl, width: 640, height: 360, duration: 3, fps: 12 });
      if (typeof video.video !== 'string') throw new Error('렌더러가 영상 파일을 반환하지 않았습니다.');
      state.video = video.video;
      artifact(video.video, 'video');
      const extracted = await deps.tools.execute('render', 'video.extract_frames', { video: video.video, times: [0, 1.25, 2.75] });
      if (!Array.isArray(extracted.frames) || extracted.frames.length !== 3 || extracted.frames.some((frame: unknown) => typeof frame !== 'string')) {
        throw new Error('실제 영상에서 평가용 프레임 3장을 추출하지 못했습니다.');
      }
      state.frames = extracted.frames;
      state.evidenceRevision = state.revision;
      for (const frame of state.frames!) artifact(frame, 'frame');
    },
    async evaluate() {
      if (!hasFreshEvidence(state)) throw new PolicyError('오래된 렌더링 증거로 평가할 수 없습니다.');
      const frames = state.frames!;
      const frameImages = await Promise.all(frames.map((frame) => deps.readImage(frame)));
      const images = [...(state.input.referenceImage ? [state.input.referenceImage] : []), ...frameImages];
      const result = await decide('evaluate', JSON.stringify({ request: state.input.request, analysis: state.analysis,
        revision: state.revision, frames, imageOrder: state.input.referenceImage ? ['reference image', ...frames] : frames,
        passThreshold: 80 }), evaluationSchema(frames), decisions.evaluate, images);
      const observed = new Set(result.evidence.map((item) => item.frame));
      if (observed.size !== frames.length || result.evidence.length !== frames.length ||
          frames.some((frame) => !observed.has(frame))) {
        throw new PolicyError('평가가 실제 추출한 모든 프레임을 정확히 참조해야 합니다.');
      }
      if (previousScore !== undefined) state.stagnantRounds = result.score <= previousScore ? state.stagnantRounds + 1 : 0;
      previousScore = result.score;
      state.evaluation = { ...result, passed: result.passed && result.score >= 80, revision: state.revision };
      state.evaluationRevision = state.revision;
      state.feedback = result.feedback;
      await save(`evaluation-r${state.revision}.json`, JSON.stringify(state.evaluation, null, 2), 'log');
      deps.emit({ type: 'evaluation.completed', agentId: 'evaluate', data: state.evaluation });
    },
    async agsl() {
      const result = await decide('agsl', JSON.stringify({ revision: state.revision, evaluation: state.evaluation }), SCHEMAS.agsl, decisions.agsl);
      assertToolPlan('agsl', result.tools, ['agsl.convert', 'rules.check']);
      const converted = await deps.tools.execute('agsl', 'agsl.convert', { code: state.glsl });
      if (typeof converted.code !== 'string' || converted.androidVerified !== false) throw new Error('AGSL 변환 툴 응답 계약이 잘못되었습니다.');
      const checked = await deps.tools.execute('agsl', 'rules.check', { code: converted.code, target: 'agsl' });
      if (checked.ok !== true) throw new Error(`AGSL 규칙 검사 실패: ${(checked.issues ?? []).join(', ')}`);
      state.agsl = converted.code;
      await save(`shader-r${state.revision}.agsl`, converted.code, 'agsl');
      deps.emit({ type: 'log', agentId: 'agsl', message: 'AGSL 규칙 변환 완료. Android RuntimeShader 컴파일/기기 검증은 별도로 수행해야 합니다.' });
    },
  };

  function node(agent: WorkerId | 'orchestrator') {
    return async () => {
      checkAbort();
      state.currentAgent = agent;
      deps.emit({ type: 'agent.started', agentId: agent });
      try {
        if (agent === 'orchestrator') {
          const candidates = permittedNext(state);
          if (candidates.includes('generate') && state.revision > 0 && !canRepair()) {
            state.status = 'stopped'; state.next = 'finish';
          } else {
            const result = await decide('orchestrator', JSON.stringify({ allowedNext: candidates, analysis: state.analysis,
              revision: state.revision, lastAgent: state.lastAgent, compileOk: state.compileOk,
              freshEvidence: hasFreshEvidence(state), freshEvaluation: hasFreshEvaluation(state),
              evaluation: state.evaluation, feedback: state.feedback, agslReady: !!state.agsl }),
            routingSchema(candidates), decisions.orchestrator);
            assertPermittedNext(state, result.next);
            state.next = result.next;
            deps.emit({ type: 'log', agentId: agent, message: result.reason, data: { next: state.next, allowedNext: candidates } });
          }
        } else {
          assertWorkerPreconditions(state, agent);
          await workers[agent]();
          state.lastAgent = agent;
        }
        checkAbort();
        deps.emit({ type: 'agent.completed', agentId: agent });
        delete state.currentAgent;
        return { run: state };
      } catch (error) {
        if (error instanceof PolicyError) deps.emit({ type: 'policy.blocked', agentId: agent, message: error.message });
        deps.emit({ type: 'agent.failed', agentId: agent, message: asMessage(error) });
        throw error;
      }
    };
  }

  try {
    checkAbort();
    await mkdir(deps.runDir, { recursive: true });
    state.status = 'running';
    deps.emit({ type: 'run.started', message: `${state.input.mode === 'fixed' ? '고정 순서' : '오케스트레이터'} 실행 시작` });
    // Registered nodes are built statically. No dynamic node name becomes executable code.
    const graph = new StateGraph(GraphState)
      .addNode('analyze', node('analyze')).addNode('search', node('search'))
      .addNode('generate', node('generate')).addNode('render', node('render'))
      .addNode('evaluate', node('evaluate')).addNode('agsl', node('agsl'));
    if (state.input.mode === 'fixed') {
      graph.addEdge(START, 'analyze').addEdge('analyze', 'search').addEdge('search', 'generate');
      graph.addConditionalEdges('generate', () => state.compileOk === false ? repairOrFinish() : 'render', { generate: 'generate', render: 'render', finish: END });
      graph.addConditionalEdges('render', () => state.compileOk ? 'evaluate' : repairOrFinish(), { evaluate: 'evaluate', generate: 'generate', finish: END });
      graph.addConditionalEdges('evaluate', () => state.evaluation!.passed ? 'agsl' : repairOrFinish(), { agsl: 'agsl', generate: 'generate', finish: END });
      graph.addEdge('agsl', END);
      // No orchestration node is activated in the fixed graph.
      await graph.compile().invoke({ run: state }, { recursionLimit: 100, signal: deps.signal });
    } else {
      const orchestrated = graph.addNode('orchestrator', node('orchestrator'));
      orchestrated.addEdge(START, 'orchestrator');
      for (const worker of WORKERS) orchestrated.addEdge(worker, 'orchestrator');
      orchestrated.addConditionalEdges('orchestrator', () => state.next!, {
        analyze: 'analyze', search: 'search', generate: 'generate', render: 'render',
        evaluate: 'evaluate', agsl: 'agsl', finish: END,
      });
      await orchestrated.compile().invoke({ run: state }, { recursionLimit: 100, signal: deps.signal });
    }
    // Graph superstep ceiling is separate from model-call and revision budgets.
    checkAbort();
    if (state.status === 'running') {
      if (!canFinish(state)) throw new PolicyError('신선한 평가와 AGSL 결과 없이 완료할 수 없습니다.');
      state.status = 'completed';
    }
    deps.emit({ type: state.status === 'completed' ? 'run.completed' : 'run.stopped', message: state.stopReason ?? '평가 및 AGSL 규칙 변환 완료' });
  } catch (error) {
    if (deps.signal.aborted) {
      const reason = deps.signal.reason;
      const isTimeout = reason instanceof Error && reason.name === 'TimeoutError';
      state.status = isTimeout ? 'stopped' : 'cancelled';
      state.stopReason = reason instanceof Error && reason.name !== 'AbortError' ? reason.message :
        typeof reason === 'string' ? reason : '실행 취소 요청을 처리했습니다.';
      deps.emit({ type: isTimeout ? 'run.stopped' : 'run.cancelled', message: state.stopReason });
    } else if (error instanceof BudgetStop) {
      state.status = 'stopped'; state.stopReason = error.message;
      deps.emit({ type: 'run.stopped', message: state.stopReason });
    } else {
      state.status = 'failed'; state.stopReason = asMessage(error);
      deps.emit({ type: 'run.failed', message: state.stopReason });
    }
  } finally {
    delete state.currentAgent;
    delete state.next;
  }
  return state;
}
