import { z } from 'zod';
import type { TeamNode, TeamProfile, TeamRunState } from '../shared/team-contracts.js';
import { hasFreshEvaluation, PolicyError } from './harness-policy.js';

const nodeId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const profileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  hypothesis: z.string().trim().max(2000),
  mode: z.enum(['fixed', 'orchestrated']),
  nodes: z.array(z.object({
    id: nodeId,
    role: z.enum(['analyze', 'search', 'generate', 'render', 'evaluate', 'agsl', 'plan', 'review']),
    name: z.string().trim().min(1).max(80),
    icon: z.string().trim().min(1).max(20),
    prompt: z.string().trim().max(8000),
    enabled: z.boolean(),
  }).strict()).min(4).max(11),
}).strict();

const stages = { analyze: 0, plan: 1, search: 1, generate: 2, render: 3, review: 4, evaluate: 5, agsl: 6 } as const;

/** Team data can specialize prompts and registered node order, never tool permissions. */
export function parseTeamProfile(value: unknown): TeamProfile {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new PolicyError(`팀 구성 형식이 잘못되었습니다: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  const team = parsed.data;
  const ids = new Set<string>();
  for (const node of team.nodes) {
    if (ids.has(node.id)) throw new PolicyError(`중복 노드 ID: ${node.id}`);
    if (['orchestrator', 'finish'].includes(node.id)) throw new PolicyError(`예약된 노드 ID: ${node.id}`);
    ids.add(node.id);
  }
  for (const role of ['analyze', 'generate', 'render', 'evaluate'] as const) {
    const selected = team.nodes.filter(node => node.role === role);
    if (selected.length !== 1 || !selected[0].enabled) throw new PolicyError(`필수 ${role} 노드는 정확히 하나 있어야 하며 비활성화할 수 없습니다.`);
  }
  for (const [role, maximum] of [['search', 1], ['agsl', 1], ['plan', 3], ['review', 2]] as const) {
    if (team.nodes.filter(node => node.role === role).length > maximum) throw new PolicyError(`${role} 노드는 최대 ${maximum}개입니다.`);
  }
  for (let index = 1; index < team.nodes.length; index++) {
    if (stages[team.nodes[index].role] < stages[team.nodes[index - 1].role]) {
      throw new PolicyError('노드 순서는 분석 → 계획/탐색 → 제작 → 렌더링 → 검토 → 평가 → 이식을 지켜야 합니다.');
    }
  }
  return team;
}

export function hasTeamEvidence(state: TeamRunState): boolean {
  return state.compileOk === true && typeof state.video === 'string' && !!state.video &&
    state.frames?.length === 3 && new Set(state.frames).size === 3 &&
    state.evidenceRevision === state.revision && state.revision > 0;
}

function done(state: TeamRunState, node: TeamNode, revision: number): boolean {
  return state.nodeOutputs.some(output => output.nodeId === node.id && output.role === node.role &&
    output.revision === revision && output.status === 'completed');
}

export function canFinishTeam(state: TeamRunState): boolean {
  if (!hasTeamEvidence(state) || !hasFreshEvaluation(state) || !state.evaluation?.passed) return false;
  return state.team.nodes.filter(node => node.enabled).every(node => {
    if (node.role === 'agsl' && !state.agsl) return false;
    return done(state, node, node.role === 'analyze' ? 0 : state.revision);
  });
}

/** IDs come from this run's validated team snapshot; candidate stages cannot be skipped. */
export function permittedTeamNext(state: TeamRunState): string[] {
  const enabled = state.team.nodes.filter(node => node.enabled);
  const one = (role: TeamNode['role']) => enabled.find(node => node.role === role)!;
  const analyze = one('analyze');
  if (!state.analysis || !done(state, analyze, 0)) return [analyze.id];
  const needsGeneration = !state.glsl || state.revision < 1 || state.compileOk === false ||
    (hasFreshEvaluation(state) && state.evaluation?.passed === false);
  if (needsGeneration) {
    const pending = enabled.filter(node => (node.role === 'plan' || node.role === 'search') && !done(state, node, state.revision + 1));
    return pending.length ? pending.map(node => node.id) : [one('generate').id];
  }
  if (!hasTeamEvidence(state)) return [one('render').id];
  const pendingReviews = enabled.filter(node => node.role === 'review' && !done(state, node, state.revision));
  if (pendingReviews.length) return pendingReviews.map(node => node.id);
  if (!hasFreshEvaluation(state)) return [one('evaluate').id];
  const agsl = enabled.find(node => node.role === 'agsl');
  if (agsl && (!state.agsl || !done(state, agsl, state.revision))) return [agsl.id];
  return canFinishTeam(state) ? ['finish'] : [];
}

export function assertPermittedTeamNext(state: TeamRunState, proposed: unknown): asserts proposed is string {
  if (typeof proposed !== 'string' || (proposed !== 'finish' && !state.team.nodes.some(node => node.enabled && node.id === proposed))) {
    throw new PolicyError(`등록되지 않았거나 비활성화된 팀 노드 호출 거부: ${String(proposed)}`);
  }
  const allowed = permittedTeamNext(state);
  if (!allowed.includes(proposed)) throw new PolicyError(`현재 상태에서 ${proposed} 호출 거부. 허용: ${allowed.join(', ')}`);
}
