import { AGENTS, type AgentId, type RunState, type WorkerId } from '../shared/contracts.js';

export class PolicyError extends Error {
  constructor(message: string) { super(message); this.name = 'PolicyError'; }
}

export const WORKERS = AGENTS.filter((agent) => agent.id !== 'orchestrator').map((agent) => agent.id) as WorkerId[];

export function assertRegisteredAgent(value: unknown): asserts value is AgentId {
  if (typeof value !== 'string' || !AGENTS.some((agent) => agent.id === value)) {
    throw new PolicyError(`등록되지 않은 에이전트 호출 거부: ${String(value)}`);
  }
}

export function hasFreshEvidence(state: RunState): boolean {
  return state.compileOk === true && !!state.video && !!state.frames?.length &&
    state.evidenceRevision === state.revision && state.revision > 0;
}

export function hasFreshEvaluation(state: RunState): boolean {
  return hasFreshEvidence(state) && !!state.evaluation &&
    state.evaluationRevision === state.revision && state.evaluation.revision === state.revision;
}

export function canFinish(state: RunState): boolean {
  return hasFreshEvaluation(state) && state.evaluation!.passed && !!state.agsl;
}

/** Runtime policy, not a prompt. The model can choose only among these candidates. */
export function permittedNext(state: RunState): (WorkerId | 'finish')[] {
  if (!state.analysis) return ['analyze'];
  if (!state.glsl || state.revision < 1) return state.examples ? ['generate'] : ['search', 'generate'];
  if (state.compileOk === false) return ['generate'];
  if (!hasFreshEvidence(state)) return ['render'];
  if (!hasFreshEvaluation(state)) return ['evaluate'];
  if (!state.evaluation!.passed) {
    return state.lastAgent === 'search' ? ['generate'] : ['generate', 'search'];
  }
  if (!state.agsl) return ['agsl'];
  return ['finish'];
}

export function assertPermittedNext(state: RunState, proposed: unknown): asserts proposed is WorkerId | 'finish' {
  if (proposed !== 'finish') assertRegisteredAgent(proposed);
  if (!permittedNext(state).includes(proposed as WorkerId | 'finish')) {
    throw new PolicyError(`현재 상태에서 ${String(proposed)} 호출 거부. 허용: ${permittedNext(state).join(', ')}`);
  }
}

export function assertWorkerPreconditions(state: RunState, agent: WorkerId): void {
  assertRegisteredAgent(agent);
  if (agent === 'analyze') return;
  if (!state.analysis) throw new PolicyError(`${agent}: 요구사항 분석이 먼저 필요합니다.`);
  if (agent === 'search' || agent === 'generate') return;
  if (!state.glsl || state.revision < 1) throw new PolicyError(`${agent}: GLSL 소스가 필요합니다.`);
  if (agent === 'render') {
    if (state.compileOk === false) throw new PolicyError('규칙/컴파일 검사에 실패한 소스는 수정 후 다시 렌더링해야 합니다.');
    return;
  }
  if (!hasFreshEvidence(state)) throw new PolicyError(`${agent}: 현재 리비전의 영상과 프레임 증거가 필요합니다.`);
  if (agent === 'agsl' && (!hasFreshEvaluation(state) || !state.evaluation!.passed)) {
    throw new PolicyError('AGSL 이식은 현재 리비전의 평가를 통과해야 가능합니다.');
  }
}

/** The trusted caller supplies agentId. No model-produced ID is accepted here. */
export function assertToolPlan(agentId: AgentId, actual: string[], required: string[]): void {
  assertRegisteredAgent(agentId);
  const allowed = AGENTS.find((agent) => agent.id === agentId)!.tools as readonly string[];
  if (actual.some((tool) => !allowed.includes(tool))) throw new PolicyError(`${agentId}의 권한을 벗어난 툴 호출을 거부했습니다.`);
  if (actual.length !== required.length || actual.some((tool, i) => tool !== required[i])) {
    throw new PolicyError(`${agentId}는 필수 툴 순서를 준수해야 합니다: ${required.join(' → ')}`);
  }
}
