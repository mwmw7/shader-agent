import type { TeamProfile, NodeOutput, RevisionSnapshot } from './team-contracts.js';

export const AGENTS = [
  { id: 'orchestrator', icon: '🧭', name: '오케스트레이터', tools: [] },
  { id: 'analyze', icon: '🖼️', name: '요구사항 분석', tools: [] },
  { id: 'search', icon: '🔎', name: '예제 탐색', tools: ['examples.search'] },
  { id: 'generate', icon: '🎨', name: 'GLSL 제작', tools: ['rules.check'] },
  { id: 'render', icon: '🎬', name: '렌더링 검증', tools: ['webgl.compile', 'render.video', 'video.extract_frames'] },
  { id: 'evaluate', icon: '🧪', name: '시각 평가', tools: [] },
  { id: 'agsl', icon: '📱', name: 'AGSL 이식', tools: ['agsl.convert', 'rules.check'] },
] as const;
export type AgentId = typeof AGENTS[number]['id'];
export type WorkerId = Exclude<AgentId, 'orchestrator'>;
export type RunMode = 'fixed' | 'orchestrated';
export type ProviderKind = 'ollama' | 'openai-compatible';
export interface ProviderConfig { id: string; name: string; kind: ProviderKind; baseUrl: string; apiKey?: string; }
export interface Verification { model: string; vision: boolean; structured: boolean; toolCall: boolean; detail: string; checkedAt: string; }
export interface PublicProvider extends Omit<ProviderConfig, 'apiKey'> { hasApiKey: boolean; verifications: Verification[]; }
export interface ModelInfo { id: string; vision?: boolean; verified?: boolean; }
export interface CompletionRequest { system: string; prompt: string; images?: string[]; schema?: Record<string, unknown>; signal: AbortSignal; }
export interface ModelClient { complete(request: CompletionRequest): Promise<unknown>; }
export interface RunInput { providerId: string; model: string; mode: RunMode; request: string; referenceImage?: string; baseRunId?: string; maxRevisions?: number; teamId?: string; }
export interface Evaluation { score: number; passed: boolean; feedback: string; evidence: { frame: string; observation: string }[]; revision: number; }
export interface Artifact { name: string; kind: 'video' | 'frame' | 'glsl' | 'agsl' | 'log'; url?: string; }
export type RunStatus = 'queued' | 'running' | 'completed' | 'stopped' | 'failed' | 'cancelled';
export interface RunState {
  id: string; input: RunInput; status: RunStatus; createdAt: string;
  revision: number; revisions: number; maxRevisions: number; modelCalls: number;
  analysis?: string; examples?: unknown; glsl?: string; agsl?: string;
  compileOk?: boolean; compileLog?: string; video?: string; frames?: string[];
  evidenceRevision?: number; evaluation?: Evaluation; evaluationRevision?: number;
  artifacts: Artifact[]; feedback?: string; stopReason?: string; currentAgent?: AgentId;
  lastAgent?: AgentId; next?: WorkerId | 'finish'; stagnantRounds: number;
  team?: TeamProfile; nodeOutputs?: NodeOutput[]; history?: RevisionSnapshot[];
  executionPath?: string[]; currentNodeId?: string; finishedAt?: string; durationMs?: number;
  experimentId?: string; inputHash?: string; imported?: boolean;
}
export interface RunEvent {
  id: number; runId: string; type: string; ts: string; revision: number;
  agentId?: AgentId; nodeId?: string; nodeName?: string; tool?: string; message?: string; data?: unknown;
}
export type Emit = (event: Omit<RunEvent, 'id' | 'runId' | 'ts' | 'revision'> & { revision?: number }) => void;
export interface ToolExecutor { execute(agent: AgentId, name: string, args: unknown): Promise<any>; }
export interface HarnessDeps {
  client: ModelClient; tools: ToolExecutor; emit: Emit; signal: AbortSignal;
  readImage: (filename: string) => Promise<string>; runDir: string;
  maxModelCalls?: number;
}
