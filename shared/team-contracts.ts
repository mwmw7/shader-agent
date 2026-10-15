import type { Evaluation, RunMode, RunState, WorkerId } from './contracts.js';

export type TeamRole = WorkerId | 'plan' | 'review';
export interface TeamNode {
  id: string;
  role: TeamRole;
  name: string;
  icon: string;
  prompt: string;
  enabled: boolean;
}
export interface TeamProfile {
  id: string;
  name: string;
  hypothesis: string;
  mode: RunMode;
  nodes: TeamNode[];
}
export interface NodeOutput {
  nodeId: string;
  nodeName: string;
  role: TeamRole;
  revision: number;
  output: unknown;
  startedAt: string;
  finishedAt: string;
  modelCalls: number;
  status: 'completed' | 'failed';
  error?: string;
}
export interface RevisionSnapshot {
  revision: number;
  glsl?: string;
  agsl?: string;
  compileOk?: boolean;
  compileLog?: string;
  video?: string;
  frames: string[];
  evaluation?: Evaluation;
  feedback?: string;
  nodeOutputs: NodeOutput[];
  createdAt: string;
}
export interface TeamRunState extends RunState {
  team: TeamProfile;
  nodeOutputs: NodeOutput[];
  history: RevisionSnapshot[];
  executionPath: string[];
  currentNodeId?: string;
  finishedAt?: string;
  durationMs?: number;
}

const node = (id: string, role: TeamRole, name: string, icon: string, prompt: string): TeamNode =>
  ({ id, role, name, icon, prompt, enabled: true });

/** Independent starting configurations; every run stores its own team snapshot. */
export const DEFAULT_TEAMS: TeamProfile[] = [
  {
    id: 'team-a', name: '팀 A · 기본 제작', hypothesis: '단순한 직렬 분업으로 빠르게 첫 결과를 만듭니다.', mode: 'fixed',
    nodes: [
      node('a-analyze', 'analyze', '이미지 분석가', '🖼️', '참고 이미지의 구도, 색상, 주요 형태와 요청한 움직임을 정리하세요.'),
      node('a-search', 'search', '예제 탐색가', '🔎', '요구사항에 맞는 로컬 셰이더 예제를 선택하세요.'),
      node('a-generate', 'generate', '셰이더 제작자', '🎨', '분석 결과를 작고 명확한 셰이더로 구현하세요.'),
      node('a-render', 'render', '렌더링 담당', '🎬', '실제 컴파일, MP4 렌더링, 프레임 추출 순서를 지키세요.'),
      node('a-evaluate', 'evaluate', '시각 평가자', '🧪', '실제 프레임과 참고 이미지를 비교해 수정 우선순위를 알려주세요.'),
      node('a-agsl', 'agsl', 'AGSL 이식 담당', '📱', '평가를 통과한 소스를 규칙에 따라 변환하세요.'),
    ],
  },
  {
    id: 'team-b', name: '팀 B · 시각 전문 분업', hypothesis: '구도·움직임 계획과 별도 시각 검토가 결과를 개선하는지 비교합니다.', mode: 'orchestrated',
    nodes: [
      node('b-analyze', 'analyze', '이미지 분석가', '🖼️', '참고 이미지의 색상, 형태, 공간 배치와 요청을 구체적으로 설명하세요.'),
      node('b-composition', 'plan', '구도 설계자', '🖼️', '참고 이미지의 구도와 색 분포를 좌표와 수치로 분해해 제작자에게 전달하세요.'),
      node('b-motion', 'plan', '움직임 설계자', '🎬', '3초 영상에서 시간에 따라 달라질 요소와 자연스러운 이동을 계획하세요.'),
      node('b-search', 'search', '예제 탐색가', '🔎', '로컬 예제에서 활용할 수 있는 패턴을 찾으세요.'),
      node('b-generate', 'generate', '셰이더 제작자', '🎨', '각 전문 계획을 종합하고 이전 평가의 구체적 피드백을 반영하세요.'),
      node('b-render', 'render', '렌더링 담당', '🎬', '컴파일, 영상 생성, 실제 영상 프레임 추출을 수행하세요.'),
      node('b-review', 'review', '형태·색상 검토자', '🔎', '참고 이미지와 세 프레임의 구도 및 색상 차이를 관찰하고 수정안을 제시하세요.'),
      node('b-evaluate', 'evaluate', '최종 시각 평가자', '🧪', '전문 검토 의견과 실제 프레임을 보고 요구사항 충족 여부를 판단하세요.'),
      node('b-agsl', 'agsl', 'AGSL 이식 담당', '📱', '승인된 소스를 변환하고 규칙 검사를 수행하세요.'),
    ],
  },
];
