import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AGENTS } from '../../shared/contracts';
import type { AgentId, Artifact, ModelInfo, ProviderKind, PublicProvider, RunEvent, RunState, Verification } from '../../shared/contracts';
import type { RevisionSnapshot, TeamNode, TeamProfile, TeamRole } from '../../shared/team-contracts';
import type { ExperimentState } from '../../shared/experiment-contracts';
import { ApiService } from './api.service';
import { ShaderPreviewComponent } from './shader-preview.component';
import { ExperimentComparisonComponent } from './experiment-comparison.component';

type AgentStatus = 'idle' | 'running' | 'completed' | 'failed';
interface ModelChoice { key: string; providerId: string; model: string; label: string; }

@Component({
  selector: 'app-root', standalone: true,
  imports: [CommonModule, FormsModule, ShaderPreviewComponent, ExperimentComparisonComponent],
  templateUrl: './app.component.html', styleUrl: './app.component.css',
})
export class AppComponent implements OnInit, OnDestroy {
  page: 'workbench' | 'settings' = 'workbench';
  tab: 'run' | 'teams' | 'compare' = 'run';
  agents = AGENTS;
  providers: PublicProvider[] = [];
  models: Record<string, ModelInfo[]> = {};
  providerForm = { name: '', kind: 'ollama' as ProviderKind, baseUrl: 'http://127.0.0.1:11434', apiKey: '' };
  modelChoices: ModelChoice[] = [];
  selectedModel = '';
  request = '';
  maxRevisions = 2;
  referenceImage = '';
  referenceName = '';
  defaultGlsl = '';
  shader = '';
  run: RunState | null = null;
  runs: RunState[] = [];
  teams: TeamProfile[] = [];
  selectedTeamIds: string[] = [];
  teamDraft: TeamProfile | null = null;
  teamBusy = false;
  experiments: ExperimentState[] = [];
  experiment: ExperimentState | null = null;
  compareExperimentId = '';
  events: RunEvent[] = [];
  agentStates: Record<string, AgentStatus> = {};
  busy = '';
  booting = true;
  starting = false;
  cancelling = false;
  sampling = false;
  importing = false;
  error = '';
  notice = '';
  sseStatus: 'idle' | 'connecting' | 'connected' | 'reconnecting' = 'idle';
  showCode = false;
  showEvents = false;
  private source?: EventSource;
  private lastEvent = 0;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private experimentTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private followingExperiment = true;

  constructor(private api: ApiService) {}
  async ngOnInit() {
    try {
      const [bootstrap, teams, runs, experiments] = await Promise.all([this.api.bootstrap(), this.api.teams(), this.api.runs(), this.api.experiments()]);
      this.providers = bootstrap.providers; this.defaultGlsl = bootstrap.defaultGlsl; this.shader = bootstrap.defaultGlsl;
      this.teams = teams; this.runs = runs; this.experiments = experiments; this.updateModelChoices();
      this.selectedTeamIds = teams.slice(0, 1).map(team => team.id);
      if (teams[0]) this.editTeam(teams[0]);
      const saved = localStorage.getItem('shader-harness-last-experiment');
      const recovery = experiments.find(item => ['queued', 'running'].includes(item.status)) || experiments.find(item => item.id === saved) || experiments[0];
      if (recovery) { await this.selectExperiment(recovery.id); this.compareExperimentId = recovery.id; }
      else {
        const savedRun = localStorage.getItem('shader-harness-last-run');
        const previous = runs.find(item => item.id === savedRun) || runs.find(item => ['queued', 'running'].includes(item.status));
        if (previous) await this.loadRun(previous.id);
      }
    } catch (error) { this.error = this.message(error); }
    finally { this.booting = false; this.scheduleRefresh(); }
  }
  ngOnDestroy() { this.destroyed = true; this.source?.close(); clearTimeout(this.snapshotTimer); clearTimeout(this.experimentTimer); }
  get runActive() { return !!this.run && ['queued', 'running'].includes(this.run.status); }
  get batchActive() { return this.experiments.some(item => ['queued', 'running'].includes(item.status)); }
  get active() { return this.batchActive || this.runActive; }
  get canStart() { return !!this.selectedModel && !!this.request.trim() && !!this.referenceImage && this.selectedTeamIds.length > 0 && !this.active && !this.starting && !this.booting; }
  get selectedTeams() { return this.selectedTeamIds.flatMap(id => this.teams.filter(team => team.id === id)); }
  get currentNodes() { return (this.run?.team || this.selectedTeams[0])?.nodes.filter(node => node.enabled) || []; }
  get toolEvents() { return this.events.filter(event => event.type.startsWith('tool.') || event.type === 'policy.blocked').slice(-16).reverse(); }
  get recentEvents() { return this.events.filter(event => event.message || event.type === 'agent.completed').slice(-6).reverse(); }
  get videoArtifacts() { return this.run?.artifacts.filter(artifact => artifact.kind === 'video') || []; }
  get frameArtifacts() { return this.run?.artifacts.filter(artifact => artifact.kind === 'frame') || []; }
  get codeArtifacts() { return this.run?.artifacts.filter(artifact => ['glsl', 'agsl'].includes(artifact.kind)) || []; }
  get revisionHistory() { return (this.run?.history || []).filter(snapshot => snapshot.revision > 0); }
  get orchestrated() { return (this.run?.team || this.selectedTeams[0])?.mode === 'orchestrated'; }
  get orchestratorState(): AgentStatus { return this.runActive && this.run?.currentAgent === 'orchestrator' ? 'running' : this.agentStates['orchestrator'] || 'idle'; }
  get orchestratorLabel() { return ({ idle: '대기', running: '경로 선택 중', completed: '선택 완료', failed: '실패' })[this.orchestratorState]; }
  get latestVideo() { return this.videoArtifacts.find(artifact => artifact.name === this.run?.video); }
  get latestFrames() { return (this.run?.frames || []).flatMap(name => this.frameArtifacts.filter(artifact => artifact.name === name)); }
  get streamLabel() { return ({ idle: '실행 대기', connecting: '연결 중', connected: '실시간 연결', reconnecting: '재연결 중' })[this.sseStatus]; }
  get currentTeamName() { return this.run?.team?.name || this.selectedTeams[0]?.name || '팀을 선택하세요'; }
  get compareExperiment() { return this.experiments.find(item => item.id === this.compareExperimentId) || null; }
  get comparisonRuns() { const ids = this.compareExperiment?.runIds || []; return ids.flatMap(id => this.runs.filter(run => run.id === id)); }
  get experimentRuns() { return (this.experiment?.runIds || []).flatMap(id => this.runs.filter(run => run.id === id)); }
  get completedTeamCount() { return this.experimentRuns.filter(run => !['queued', 'running'].includes(run.status)).length; }
  private message(error: unknown) { return error instanceof Error ? error.message : String(error); }
  clearMessages() { this.error = ''; this.notice = ''; }
  setPage(page: 'workbench' | 'settings') { this.page = page; this.clearMessages(); }
  onKindChange() {
    this.providerForm.baseUrl = this.providerForm.kind === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:8000/v1';
  }
  private updateModelChoices() {
    this.modelChoices = this.providers.flatMap(provider => provider.verifications
      .filter(check => check.vision && check.structured && check.toolCall)
      .map(check => ({ key: JSON.stringify([provider.id, check.model]), providerId: provider.id, model: check.model, label: `${provider.name} · ${check.model}` })));
    if (!this.modelChoices.some(choice => choice.key === this.selectedModel)) this.selectedModel = this.modelChoices[0]?.key || '';
  }
  async saveProvider() {
    if (this.busy) return;
    this.clearMessages(); this.busy = 'save';
    try {
      const provider = await this.api.saveProvider({ ...this.providerForm, name: this.providerForm.name.trim(), baseUrl: this.providerForm.baseUrl.trim() });
      this.providers = await this.api.providers();
      this.providerForm.name = ''; this.providerForm.apiKey = '';
      this.notice = `${provider.name}을 등록했습니다. 모델 목록을 불러온 뒤 검증하세요.`;
      this.updateModelChoices();
    } catch (error) { this.error = this.message(error); }
    finally { this.busy = ''; }
  }
  async deleteProvider(provider: PublicProvider) {
    if (this.busy || this.active) return;
    this.clearMessages(); this.busy = `delete:${provider.id}`;
    try {
      await this.api.deleteProvider(provider.id);
      this.providers = this.providers.filter(item => item.id !== provider.id);
      delete this.models[provider.id]; this.updateModelChoices();
    } catch (error) { this.error = this.message(error); }
    finally { this.busy = ''; }
  }
  async loadModels(provider: PublicProvider) {
    if (this.busy) return;
    this.clearMessages(); this.busy = `models:${provider.id}`;
    try {
      this.models[provider.id] = await this.api.models(provider.id);
      if (!this.models[provider.id].length) this.notice = '서버에 등록된 모델이 없습니다. 로컬 서버에서 비전 모델을 준비하세요.';
    } catch (error) { this.error = this.message(error); }
    finally { this.busy = ''; }
  }
  async verify(provider: PublicProvider, model: string) {
    if (this.busy) return;
    this.clearMessages(); this.busy = `verify:${provider.id}:${model}`;
    try {
      const result = await this.api.verify(provider.id, model);
      this.providers = await this.api.providers(); this.updateModelChoices();
      this.notice = result.vision && result.structured && result.toolCall ? `${model} 검증 통과. 워크벤치에서 선택할 수 있습니다.` : `검증을 통과하지 못했습니다. ${result.detail}`;
    } catch (error) { this.error = this.message(error); }
    finally { this.busy = ''; }
  }
  verification(provider: PublicProvider, model: string): Verification | undefined { return provider.verifications.find(value => value.model === model); }
  visibleModels(provider: PublicProvider): ModelInfo[] {
    const items = this.models[provider.id] || [];
    return [...items, ...provider.verifications.filter(check => !items.some(item => item.id === check.model)).map(check => ({ id: check.model }))];
  }
  async uploadReference(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error = '';
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 3 * 1024 * 1024) {
      this.error = '3 MB 이하의 PNG, JPEG, WebP 이미지를 선택하세요.'; input.value = ''; return;
    }
    try { this.referenceImage = await this.readDataUrl(file); this.referenceName = file.name; }
    catch (error) { this.error = this.message(error); }
    input.value = '';
  }
  private readDataUrl(blob: Blob) { return new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.')); reader.readAsDataURL(blob);
  }); }
  removeReference() { this.referenceImage = ''; this.referenceName = ''; }
  async useExample() {
    if (this.active || this.sampling) return;
    this.sampling = true; this.clearMessages();
    try {
      const response = await fetch('/api/samples/default-image');
      if (!response.ok) throw new Error('샘플 이미지를 불러오지 못했습니다. 이미지를 직접 첨부하세요.');
      this.referenceImage = await this.readDataUrl(await response.blob()); this.referenceName = '워크숍 공통 샘플.png';
      this.request = '참고 이미지의 색감과 구도를 살려 움직이는 셰이더를 만들어 주세요. 주요 형태는 유지하고, 빛과 표면이 자연스럽게 천천히 움직이도록 표현해 주세요.';
      this.notice = '샘플 이미지를 준비했습니다. 팀과 모델을 선택하면 실제 에이전트가 실행됩니다.';
    } catch (error) { this.error = this.message(error); }
    finally { this.sampling = false; }
  }
  toggleTeam(id: string) {
    if (this.active) return;
    this.selectedTeamIds = this.selectedTeamIds.includes(id) ? this.selectedTeamIds.filter(value => value !== id) : [...this.selectedTeamIds, id];
  }
  async startRun() {
    if (!this.canStart) return;
    const selection = this.modelChoices.find(choice => choice.key === this.selectedModel);
    if (!selection) return;
    this.clearMessages(); this.starting = true;
    try {
      const result = await this.api.startExperiment({ providerId: selection.providerId, model: selection.model, request: this.request.trim(), referenceImage: this.referenceImage, maxRevisions: this.maxRevisions, teamIds: this.selectedTeamIds });
      this.experiments = await this.api.experiments(); this.followingExperiment = true;
      await this.selectExperiment(result.id); this.compareExperimentId = result.id;
      this.notice = `${this.selectedTeamIds.length}개 팀이 같은 입력으로 차례대로 실행됩니다. 실행 시점의 팀 설계가 함께 보관됩니다.`;
    } catch (error) { this.error = this.message(error); }
    finally { this.starting = false; }
  }
  async cancelRun() {
    if (!this.active || this.cancelling) return;
    this.cancelling = true; this.clearMessages();
    try {
      const activeExperiment = this.experiments.find(item => ['queued', 'running'].includes(item.status));
      if (activeExperiment) await this.api.cancelExperiment(activeExperiment.id);
      else if (this.run) await this.api.cancel(this.run.id);
      await this.refreshWorkspace();
    } catch (error) { this.error = this.message(error); }
    finally { this.cancelling = false; }
  }
  async selectExperiment(id: string) {
    if (!id) return;
    this.clearMessages();
    try {
      this.experiment = await this.api.experiment(id); this.followingExperiment = true;
      this.request = this.experiment.input.request; this.referenceImage = this.experiment.input.referenceImage; this.referenceName = '저장된 실험의 참고 이미지'; this.maxRevisions = this.experiment.input.maxRevisions;
      this.selectedTeamIds = this.experiment.teamIds.filter(id => this.teams.some(team => team.id === id));
      const selection = this.modelChoices.find(choice => choice.providerId === this.experiment!.input.providerId && choice.model === this.experiment!.input.model); if (selection) this.selectedModel = selection.key;
      localStorage.setItem('shader-harness-last-experiment', id);
      this.runs = await this.api.runs();
      const current = this.experimentRuns.find(run => ['queued', 'running'].includes(run.status)) || this.experimentRuns[0];
      if (current) await this.loadRun(current.id, true);
      else { this.source?.close(); this.run = null; this.events = []; this.shader = this.defaultGlsl; }
    } catch (error) { this.error = this.message(error); }
  }
  async loadRun(id: string, following = false) {
    if (!id) return;
    this.followingExperiment = following;
    this.source?.close(); clearTimeout(this.snapshotTimer); this.lastEvent = 0;
    this.events = []; this.agentStates = {}; this.sseStatus = 'connecting';
    try {
      this.run = await this.api.run(id); this.shader = this.run.glsl || this.defaultGlsl;
      if (this.run.currentNodeId && this.runActive) this.agentStates[this.run.currentNodeId] = 'running';
      localStorage.setItem('shader-harness-last-run', id);
      const imported = this.experiments.some(experiment => experiment.imported && experiment.runIds.includes(id));
      if (imported) this.sseStatus = 'idle'; else this.attachEvents(id);
    } catch (error) { this.error = this.message(error); this.sseStatus = 'idle'; }
  }
  async openComparisonRun(id: string) { this.tab = 'run'; await this.loadRun(id); }
  private attachEvents(id: string) {
    const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events?after=${this.lastEvent}`); this.source = source;
    source.onopen = () => { if (this.run?.id === id) this.sseStatus = 'connected'; };
    source.onerror = () => { if (this.run?.id === id) this.sseStatus = 'reconnecting'; };
    source.addEventListener('harness', message => {
      if (this.run?.id !== id || this.destroyed) return;
      try {
        const event = JSON.parse((message as MessageEvent<string>).data) as RunEvent;
        if (event.runId !== id || !Number.isFinite(event.id) || event.id <= this.lastEvent) return;
        this.lastEvent = event.id; this.events = [...this.events.slice(-499), event];
        const key = event.nodeId || event.agentId;
        if (key) {
          if (event.type === 'agent.started') { this.agentStates[key] = 'running'; this.run.currentAgent = event.agentId; this.run.currentNodeId = event.nodeId; }
          if (event.type === 'agent.completed') this.agentStates[key] = 'completed';
          if (event.type === 'agent.failed') this.agentStates[key] = 'failed';
        }
        if (event.type === 'shader.updated' && typeof (event.data as { code?: unknown })?.code === 'string') this.shader = (event.data as { code: string }).code;
        if (event.type.startsWith('run.') || event.type === 'agent.completed' || event.type === 'tool.completed' || event.type === 'evaluation.completed' || event.type === 'shader.updated') this.queueSnapshot();
        if (['run.completed', 'run.failed', 'run.stopped', 'run.cancelled'].includes(event.type)) { source.close(); this.sseStatus = 'idle'; }
      } catch { this.error = '서버 이벤트를 읽지 못했습니다. 실행을 다시 선택해 상태를 복구하세요.'; }
    });
  }
  private queueSnapshot() { clearTimeout(this.snapshotTimer); this.snapshotTimer = setTimeout(() => void this.refreshRun(), 150); }
  private async refreshRun() {
    const id = this.run?.id; if (!id) return;
    try {
      const snapshot = await this.api.run(id);
      if (this.run?.id !== id || this.destroyed) return;
      this.run = snapshot; this.shader = snapshot.glsl || this.defaultGlsl;
      this.runs = [snapshot, ...this.runs.filter(item => item.id !== id)];
    } catch (error) { this.error = this.message(error); }
  }
  private scheduleRefresh() { clearTimeout(this.experimentTimer); if (!this.destroyed) this.experimentTimer = setTimeout(() => void this.refreshWorkspace(), 2400); }
  async refreshWorkspace() {
    try {
      const [experiments, runs] = await Promise.all([this.api.experiments(), this.api.runs()]);
      if (this.destroyed) return;
      this.experiments = experiments; this.runs = runs;
      if (this.experiment) this.experiment = experiments.find(item => item.id === this.experiment!.id) || this.experiment;
      if (this.run) {
        const snapshot = runs.find(item => item.id === this.run!.id);
        if (snapshot) { this.run = snapshot; this.shader = snapshot.glsl || this.defaultGlsl; }
      }
      if (this.followingExperiment && this.experiment) {
        const live = this.experimentRuns.find(item => ['queued', 'running'].includes(item.status));
        if (live && live.id !== this.run?.id) await this.loadRun(live.id, true);
        else if (!this.run && this.experimentRuns[0]) await this.loadRun(this.experimentRuns[0].id, true);
      }
    } catch { /* Keep the visible snapshot; SSE and next refresh can recover. */ }
    finally { this.scheduleRefresh(); }
  }
  editTeam(team: TeamProfile) { this.teamDraft = structuredClone(team); this.clearMessages(); }
  newTeam() {
    const base = this.teams[0];
    this.teamDraft = base ? { ...structuredClone(base), id: '', name: `${this.teams.length + 1}팀`, hypothesis: '' } : {
      id: '', name: '새 팀', hypothesis: '', mode: 'fixed', nodes: this.agents.filter(agent => agent.id !== 'orchestrator').map(agent => ({ id: agent.id, role: agent.id as TeamRole, name: agent.name, icon: agent.icon, prompt: '', enabled: true })),
    };
    this.clearMessages();
  }
  cloneTeam() { if (this.teamDraft) { this.teamDraft = { ...structuredClone(this.teamDraft), id: '', name: `${this.teamDraft.name} 복사` }; this.notice = '복사한 설계를 저장하면 새 팀으로 등록됩니다.'; } }
  async saveTeam() {
    if (!this.teamDraft || this.teamBusy || !this.teamDraft.name.trim()) return;
    this.teamBusy = true; this.clearMessages();
    try {
      const draft = { ...this.teamDraft, name: this.teamDraft.name.trim(), nodes: this.canonicalNodes(this.teamDraft.nodes) };
      const saved = await this.api.saveTeam(draft.id ? draft : { ...draft, id: undefined });
      this.teams = await this.api.teams(); this.teamDraft = structuredClone(saved);
      if (!this.selectedTeamIds.length) this.selectedTeamIds = [saved.id];
      this.notice = `${saved.name} 설계를 저장했습니다. 다음 실험부터 적용됩니다.`;
    } catch (error) { this.error = this.message(error); }
    finally { this.teamBusy = false; }
  }
  async deleteTeam() {
    if (!this.teamDraft?.id || this.teamBusy || this.active) return;
    const id = this.teamDraft.id; this.teamBusy = true; this.clearMessages();
    try {
      await this.api.deleteTeam(id); this.teams = await this.api.teams(); this.selectedTeamIds = this.selectedTeamIds.filter(value => value !== id);
      this.teamDraft = this.teams[0] ? structuredClone(this.teams[0]) : null; this.notice = '팀 설계를 삭제했습니다. 이전 실험의 설계 기록은 유지됩니다.';
    } catch (error) { this.error = this.message(error); }
    finally { this.teamBusy = false; }
  }
  requiredRole(role: string) { return ['analyze', 'generate', 'render', 'evaluate'].includes(role); }
  customRole(role: string) { return role === 'plan' || role === 'review'; }
  countRole(role: string) { return this.teamDraft?.nodes.filter(node => node.role === role).length || 0; }
  addNode(role: 'plan' | 'review') {
    if (!this.teamDraft || this.countRole(role) >= (role === 'plan' ? 3 : 2)) return;
    this.teamDraft.nodes = this.canonicalNodes([...this.teamDraft.nodes, { id: `${role}-${crypto.randomUUID().slice(0, 8)}`, role, name: role === 'plan' ? '새 기획 노드' : '새 검토 노드', icon: role === 'plan' ? '🖼️' : '🧪', prompt: '', enabled: true }]);
  }
  addOptionalNode(role: 'search' | 'agsl') {
    if (!this.teamDraft || this.countRole(role)) return;
    const agent = this.agents.find(agent => agent.id === role)!;
    this.teamDraft.nodes = this.canonicalNodes([...this.teamDraft.nodes, { id: `${role}-${crypto.randomUUID().slice(0, 8)}`, role, name: agent.name, icon: agent.icon, prompt: '', enabled: true }]);
  }
  removeNode(id: string) { if (this.teamDraft) this.teamDraft.nodes = this.teamDraft.nodes.filter(node => node.id !== id || !this.customRole(node.role)); }
  private phaseOrder(role: string) { return ({ analyze: 0, search: 1, plan: 1, generate: 2, render: 3, review: 4, evaluate: 5, agsl: 6 } as Record<string, number>)[role] ?? 99; }
  private canonicalNodes(nodes: TeamNode[]) { return [...nodes].sort((a, b) => this.phaseOrder(a.role) - this.phaseOrder(b.role)); }
  moveNode(node: TeamNode, direction: -1 | 1) {
    if (!this.teamDraft) return;
    const nodes = this.teamDraft.nodes; const index = nodes.indexOf(node); const next = index + direction;
    if (next >= 0 && next < nodes.length && this.phaseOrder(nodes[next].role) === this.phaseOrder(node.role)) [nodes[index], nodes[next]] = [nodes[next], nodes[index]];
  }
  canMove(node: TeamNode, direction: number) { const nodes = this.teamDraft?.nodes || []; const next = nodes[nodes.indexOf(node) + direction]; return !!next && this.phaseOrder(next.role) === this.phaseOrder(node.role); }
  exportTeam() {
    if (!this.teamDraft) return;
    const blob = new Blob([JSON.stringify(this.teamDraft, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `${this.teamDraft.name.replace(/[^a-zA-Z0-9가-힣_-]/g, '-') || 'team'}-design.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async importTeam(event: Event) {
    const input = event.target as HTMLInputElement; const file = input.files?.[0]; if (!file) return;
    this.clearMessages();
    try {
      if (file.size > 250000) throw new Error('팀 설계 JSON은 250 KB 이하로 선택하세요.');
      const data = JSON.parse(await file.text()) as TeamProfile;
      if (!data || typeof data.name !== 'string' || !['fixed', 'orchestrated'].includes(data.mode) || !Array.isArray(data.nodes)) throw new Error('팀 이름, 실행 방식, 노드가 포함된 설계 JSON을 선택하세요.');
      const roles = ['analyze', 'search', 'generate', 'render', 'evaluate', 'agsl', 'plan', 'review'];
      if (data.nodes.some(node => !node || !roles.includes(node.role) || typeof node.id !== 'string' || typeof node.name !== 'string' || typeof node.prompt !== 'string' || typeof node.enabled !== 'boolean')) throw new Error('올바르지 않은 노드 설정입니다.');
      this.teamDraft = { id: '', name: data.name, hypothesis: typeof data.hypothesis === 'string' ? data.hypothesis : '', mode: data.mode, nodes: this.canonicalNodes(data.nodes.map(node => ({ ...node, icon: typeof node.icon === 'string' ? node.icon : '◈' }))) };
      this.tab = 'teams'; this.notice = '설계를 불러왔습니다. 검토 후 저장하면 새 팀으로 등록됩니다.';
    } catch (error) { this.error = this.message(error); }
    finally { input.value = ''; }
  }
  async importResults(event: Event) {
    const input = event.target as HTMLInputElement; const files = Array.from(input.files || []); if (!files.length) return;
    this.clearMessages(); this.importing = true;
    try {
      if (files.length > 10 || files.reduce((total, file) => total + file.size, 0) > 24 * 1024 * 1024) throw new Error('결과 JSON은 최대 10개, 전체 24 MB 이하로 선택하세요.');
      const packages = await Promise.all(files.map(async file => {
        return JSON.parse(await file.text());
      }));
      const result = await this.api.request<{ id: string }>('/experiments/import', 'POST', { packages });
      await this.refreshWorkspace(); this.compareExperimentId = result.id; this.tab = 'compare';
      this.notice = '같은 입력을 사용한 팀 결과를 합쳤습니다. 가져온 프레임과 설계로 비교할 수 있습니다.';
    } catch (error) { this.error = this.message(error); }
    finally { this.importing = false; input.value = ''; }
  }
  roleLabel(role: string) { return ({ analyze: '이미지 분석', search: '예제 탐색', plan: '생성 전 기획', generate: 'GLSL 생성', render: '실제 렌더링', review: '렌더 후 검토', evaluate: '비전 평가', agsl: 'AGSL 변환' } as Record<string, string>)[role] || role; }
  roleTools(role: string) { return this.agents.find(agent => agent.id === role)?.tools.join(' · ') || 'LLM 판단'; }
  stateFor(node: TeamNode): AgentStatus {
    if (this.run?.currentNodeId === node.id && this.runActive) return 'running';
    const saved = this.run?.nodeOutputs?.filter(output => output.nodeId === node.id).at(-1);
    return this.agentStates[node.id] || this.agentStates[node.role] || (saved?.status === 'completed' ? 'completed' : saved?.status === 'failed' ? 'failed' : 'idle');
  }
  nodeStatusText(node: TeamNode) { return ({ idle: '대기', running: '실행 중', completed: '완료', failed: '실패' })[this.stateFor(node)]; }
  agentName(id?: AgentId) { return this.agents.find(agent => agent.id === id)?.name || '하네스'; }
  runStatus(status?: string) { return ({ queued: '대기', running: '실행 중', completed: '완료', stopped: '중단', failed: '실패', cancelled: '취소됨', interrupted: '중단됨' } as Record<string, string>)[status || ''] || '준비'; }
  toolStatus(event: RunEvent) { return event.type === 'policy.blocked' ? '차단' : event.type.endsWith('started') ? '시작' : event.type.endsWith('completed') ? '완료' : '실패'; }
  revisionVideo(snapshot: RevisionSnapshot) { return this.run?.artifacts.find(artifact => artifact.kind === 'video' && artifact.name === snapshot.video); }
  revisionFrames(snapshot: RevisionSnapshot) { return snapshot.frames.flatMap(name => (this.run?.artifacts || []).filter(artifact => artifact.kind === 'frame' && artifact.name === name)); }
  artifactUrl(artifact: Artifact) { return `/api/runs/${encodeURIComponent(this.run!.id)}/artifacts/${encodeURIComponent(artifact.name)}`; }
  eventText(event: RunEvent) { return event.message || (event.type === 'agent.completed' ? `${event.nodeName || this.agentName(event.agentId)} 작업 완료` : event.type); }
  shortRun(run: RunState) { return `${run.team?.name || '단일 실행'} · ${this.runStatus(run.status)} · ${new Date(run.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`; }
  shortExperiment(experiment: ExperimentState) { return `${new Date(experiment.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${experiment.teamIds.length}팀 · ${this.runStatus(experiment.status)} · ${experiment.input.request.slice(0, 28)}`; }
  duration(run: RunState | null) { if (!run?.durationMs) return '—'; return `${(run.durationMs / 1000).toFixed(1)}초`; }
  nodePath(run: RunState) { return (run.executionPath || []).map(id => run.team?.nodes.find(node => node.id === id)?.name || id).join(' → '); }
  enabledCount(team: TeamProfile) { return team.nodes.filter(node => node.enabled).length; }
}
