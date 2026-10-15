import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AGENTS, type RunEvent, type RunInput, type RunState, type Emit, type ModelClient, type ProviderConfig } from '../shared/contracts.js';
import { ProviderStore, type SecretCodec } from './storage.js';
import { createModelClient, listModels, validateLocalBaseUrl, verifyModel } from './providers.js';
import { createToolExecutor } from './tools.js';
import { DEFAULT_GLSL } from './shader.js';
import { runHarness } from './harness.js';
import { runTeamHarness } from './team-harness.js';
import { TeamStore } from './team-store.js';
import { buildExperimentReport } from './experiment-report.js';
import { exportComparison, importComparison, inputHash } from './experiment-exchange.js';
import type { TeamProfile, TeamRunState } from '../shared/team-contracts.js';
import type { ExperimentState } from '../shared/experiment-contracts.js';
import { fileURLToPath } from 'node:url';

const Id = z.string().uuid();
const ProviderSchema = z.object({ id: Id.optional(), name: z.string().trim().min(1).max(80), kind: z.enum(['ollama', 'openai-compatible']), baseUrl: z.string().url().max(300), apiKey: z.string().max(500).optional() }).strict();
const RunSchema = z.object({
  providerId: Id, model: z.string().min(1).max(150), mode: z.enum(['fixed', 'orchestrated']),
  request: z.string().trim().min(1).max(8000), baseRunId: Id.optional(), maxRevisions: z.number().int().min(0).max(2).optional(),
  referenceImage: z.string().max(8_000_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).optional(),
  teamId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/).optional(),
}).strict();
const ExperimentSchema = RunSchema.omit({ mode: true, baseRunId: true, teamId: true }).extend({
  referenceImage: z.string().min(30).max(4_300_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
  maxRevisions: z.number().int().min(0).max(2).default(2),
  teamIds: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/)).min(1).max(10),
}).strict();
type LiveRun = { state: RunState; events: RunEvent[]; clients: Set<Response>; controller: AbortController; writes: Promise<void>; task?: Promise<void> };
export interface ServerOptions {
  dataDir: string; port?: number; uiDir?: string; devOrigin?: string; secretCodec?: SecretCodec;
  // Injection points used only by unit/integration tests, never selected from HTTP input.
  harnessRunner?: typeof runHarness; clientFactory?: (p: ProviderConfig, model: string) => ModelClient;
  teamHarnessRunner?: typeof runTeamHarness;
}

export async function startServer(options: ServerOptions) {
  // Local-only deployments must not inherit external tracing from the shell.
  process.env.LANGSMITH_TRACING = 'false';
  process.env.LANGCHAIN_TRACING_V2 = 'false';
  const store = new ProviderStore(options.dataDir, options.secretCodec);
  await store.init();
  const runsDir = path.join(options.dataDir, 'runs');
  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  const runs = new Map<string, LiveRun>();
  for (const id of (await readdir(runsDir)).filter(v => Id.safeParse(v).success)) {
    try {
      const state: RunState = JSON.parse(await readFile(path.join(runsDir, id, 'run.json'), 'utf8'));
      if (['queued', 'running'].includes(state.status)) { state.status = 'stopped'; state.stopReason = '앱 재시작으로 실행이 중단되었습니다. 새 요청을 시작하세요.'; }
      let events: RunEvent[] = [];
      try { events = (await readFile(path.join(runsDir, id, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(v => JSON.parse(v)).slice(-2000); } catch { /* no journal */ }
      runs.set(id, { state, events, clients: new Set(), controller: new AbortController(), writes: Promise.resolve() });
    } catch { /* Preserve unreadable run directory for diagnosis; do not treat it as live. */ }
  }
  const teams = new TeamStore(options.dataDir);
  await teams.init();
  const experimentsDir = path.join(options.dataDir, 'experiments');
  await mkdir(experimentsDir, { recursive: true, mode: 0o700 });
  const experiments = new Map<string, ExperimentState>();
  const experimentTasks = new Map<string, Promise<void>>();
  const persistExperiment = (experiment: ExperimentState) => writeFile(path.join(experimentsDir, experiment.id + '.json'), JSON.stringify(experiment, null, 2), { mode: 0o600 });
  for (const filename of await readdir(experimentsDir)) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(filename)) continue;
    try {
      const item: ExperimentState = JSON.parse(await readFile(path.join(experimentsDir, filename), 'utf8'));
      if (!Id.safeParse(item.id).success) continue;
      if (['running', 'queued'].includes(item.status)) { item.status = 'interrupted'; item.finishedAt = new Date().toISOString(); await persistExperiment(item); }
      experiments.set(item.id, item);
    } catch { /* Keep invalid persisted data for diagnosis. */ }
  }
  const app = express();
  app.disable('x-powered-by');
  let origin = '';
  app.use((req, res, next) => {
    const requestOrigin = req.headers.origin;
    const ownHost = origin ? new URL(origin).host : '';
    if (origin && req.headers.host !== ownHost && req.headers.host !== ownHost.replace('127.0.0.1', 'localhost')) { res.status(403).json({ error: 'HOST_DENIED' }); return; }
    if (requestOrigin && requestOrigin !== origin && requestOrigin !== options.devOrigin) { res.status(403).json({ error: 'ORIGIN_DENIED' }); return; }
    if (req.headers['sec-fetch-site'] === 'cross-site') { res.status(403).json({ error: 'CROSS_SITE_DENIED' }); return; }
    if (requestOrigin === options.devOrigin && requestOrigin) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    if (req.method === 'POST' && !req.is('application/json')) { res.status(415).json({ error: 'application/json 요청이 필요합니다.' }); return; }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '25mb' }));
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: express.NextFunction) => { Promise.resolve(fn(req, res)).catch(next); };
  const lookup = (req: Request) => { const id = Id.parse(req.params['id']); const live = runs.get(id); if (!live) throw Object.assign(new Error('실행을 찾을 수 없습니다.'), { status: 404 }); return live; };
  const provider = (req: Request) => { const p = store.get(Id.parse(req.params['id'])); if (!p) throw Object.assign(new Error('프로바이더를 찾을 수 없습니다.'), { status: 404 }); return p; };
  const expose = (state: RunState) => ({ ...state, artifacts: state.artifacts.map(a => ({ ...a, url: `/api/runs/${state.id}/artifacts/${encodeURIComponent(a.name)}` })) });
  const eventText = (event: RunEvent) => `id: ${event.id}\nevent: harness\ndata: ${JSON.stringify(event)}\n\n`;
  const active = () => [...runs.values()].some(r => ['queued', 'running'].includes(r.state.status)) || [...experiments.values()].some(e => ['queued', 'running'].includes(e.status));
  const verifiedProvider = (input: Pick<RunInput, 'providerId' | 'model'>) => {
    const p = store.get(input.providerId);
    if (!p) throw new Error('프로바이더가 없습니다.');
    if (!store.public(p.id).verifications.some(v => v.model === input.model && v.vision && v.structured && v.toolCall)) throw new Error('설정 화면에서 비전·JSON·도구 선택 검증을 통과한 모델을 선택하세요.');
    return p;
  };
  const experimentFor = (req: Request) => {
    const item = experiments.get(Id.parse(req.params['id']));
    if (!item) throw Object.assign(new Error('비교 실험을 찾을 수 없습니다.'), { status: 404 });
    return item;
  };
  const readArtifact = async (runId: string, filename: string) => {
    const run = runs.get(runId)?.state;
    if (!run || !/^[A-Za-z0-9_.-]+$/.test(filename) || filename.startsWith('.') || !run.artifacts.some(a => a.name === filename)) throw new Error('등록된 산출물만 읽을 수 있습니다.');
    return readFile(path.join(runsDir, runId, filename));
  };
  function emitter(live: LiveRun): Emit {
    return partial => {
      const state = live.state, runDir = path.join(runsDir, state.id);
      const nodeId = partial.nodeId ?? state.currentNodeId;
      const event: RunEvent = { ...partial, ...(nodeId ? { nodeId, nodeName: partial.nodeName ?? state.team?.nodes.find(n => n.id === nodeId)?.name } : {}), id: (live.events.at(-1)?.id ?? 0) + 1, runId: state.id, ts: new Date().toISOString(), revision: partial.revision ?? state.revision };
      live.events.push(event); if (live.events.length > 2000) live.events.shift();
      for (const client of live.clients) client.write(eventText(event));
      const snapshot = JSON.stringify(state, null, 2);
      live.writes = live.writes.then(async () => {
        await appendFile(path.join(runDir, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
        await writeFile(path.join(runDir, 'run.json'), snapshot, { mode: 0o600 });
      }).catch(error => { console.error('Run journal write failed:', error.message); live.controller.abort(new Error('실행 기록을 저장하지 못했습니다.')); });
    };
  }
  async function createLive(input: RunInput, team?: TeamProfile, experimentId?: string) {
    const base = input.baseRunId ? runs.get(input.baseRunId)?.state : undefined;
    if (input.baseRunId && !base) throw new Error('이전 실행을 찾을 수 없습니다.');
    const state: RunState = { id: randomUUID(), input: structuredClone(input), status: 'queued', createdAt: new Date().toISOString(), revision: 0, revisions: 0, maxRevisions: input.maxRevisions ?? 2, modelCalls: 0, glsl: base?.glsl, artifacts: [], stagnantRounds: 0,
      ...(team ? { team: structuredClone(team), nodeOutputs: [], history: [], executionPath: [] } : {}), ...(experimentId ? { experimentId, inputHash: experiments.get(experimentId)?.inputHash } : {}) };
    const live: LiveRun = { state, events: [], clients: new Set(), controller: new AbortController(), writes: Promise.resolve() };
    runs.set(state.id, live); // Reserve before the first await, including concurrent POSTs.
    try { await mkdir(path.join(runsDir, state.id), { mode: 0o700 }); await writeFile(path.join(runsDir, state.id, 'run.json'), JSON.stringify(state), { mode: 0o600 }); }
    catch (error) { runs.delete(state.id); throw error; }
    return live;
  }
  function executeLive(live: LiveRun, p: ProviderConfig) {
    const state = live.state, runDir = path.join(runsDir, state.id), emit = emitter(live), started = Date.now();
    const timeout = setTimeout(() => live.controller.abort(new DOMException('실행 시간 한도 15분 초과', 'TimeoutError')), 900_000);
    const toolExecutor = createToolExecutor({ runDir, signal: live.controller.signal, emit, revision: () => state.revision });
    const readImage = async (filename: string) => {
      if (path.basename(filename) !== filename || !/\.png$/i.test(filename)) throw new Error('INVALID_FRAME_PATH');
      return 'data:image/png;base64,' + (await readFile(path.join(runDir, filename))).toString('base64');
    };
    live.task = Promise.resolve().then(async () => {
      try {
        const deps = { client: (options.clientFactory ?? createModelClient)(p, state.input.model), tools: toolExecutor, emit, signal: live.controller.signal, readImage, runDir, maxModelCalls: 40 };
        if (state.team) await (options.teamHarnessRunner ?? runTeamHarness)(state as TeamRunState, deps);
        else await (options.harnessRunner ?? runHarness)(state, deps);
      } catch (error: any) {
        state.status = live.controller.signal.aborted ? 'cancelled' : 'failed'; state.stopReason = error.message;
        emit({ type: 'run.' + state.status, message: state.stopReason });
      } finally {
        clearTimeout(timeout); state.finishedAt ??= new Date().toISOString(); state.durationMs ??= Date.now() - started;
        delete state.currentAgent; delete state.currentNodeId;
        await live.writes;
        await writeFile(path.join(runDir, 'run.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
      }
    }).catch(error => { state.status = 'failed'; state.stopReason = '실행 기록 저장 실패: ' + error.message; console.error(state.stopReason); });
    return live.task;
  }
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/bootstrap', (_req, res) => res.json({ providers: store.list(), agents: AGENTS, defaultGlsl: DEFAULT_GLSL }));
  app.get('/api/teams', (_req, res) => res.json(teams.list()));
  app.post('/api/teams', wrap(async (req, res) => res.json(await teams.put({ ...req.body, id: req.body.id ?? randomUUID() }))));
  app.delete('/api/teams/:id', wrap(async (req, res) => { if (!await teams.remove(String(req.params['id']))) throw Object.assign(new Error('팀을 찾을 수 없습니다.'), { status: 404 }); res.json({ ok: true }); }));
  app.get('/api/samples/default-image', wrap(async (_req, res) => {
    const candidates = [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../samples/weather-reference.png'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../samples/weather-reference.png')];
    for (const file of candidates) { try { await stat(file); res.type('png').sendFile(file); return; } catch { /* Source and compiled layout. */ } }
    throw new Error('실습용 참조 이미지 파일이 없습니다.');
  }));
  app.get('/api/providers', (_req, res) => res.json(store.list()));
  app.post('/api/providers', wrap(async (req, res) => {
    const input = ProviderSchema.parse(req.body);
    await validateLocalBaseUrl(input.baseUrl);
    if (input.id && [...runs.values()].some(r => ['queued', 'running'].includes(r.state.status) && r.state.input.providerId === input.id)) throw Object.assign(new Error('사용 중인 프로바이더는 실행 종료 후 변경하세요.'), { status: 409 });
    res.json(await store.put({ ...input, id: input.id ?? randomUUID(), baseUrl: input.baseUrl.replace(/\/+$/, '') }));
  }));
  app.delete('/api/providers/:id', wrap(async (req, res) => {
    const p = provider(req);
    if ([...runs.values()].some(r => ['queued', 'running'].includes(r.state.status) && r.state.input.providerId === p.id)) throw Object.assign(new Error('실행 중인 프로바이더입니다.'), { status: 409 });
    await store.remove(p.id); res.json({ ok: true });
  }));
  app.post('/api/providers/:id/models', wrap(async (req, res) => {
    const p = provider(req); const models = await listModels(p, AbortSignal.timeout(30_000));
    res.json(models.map(m => ({ ...m, verified: store.public(p.id).verifications.some(v => v.model === m.id && v.vision && v.structured && v.toolCall) })));
  }));
  app.post('/api/providers/:id/verify', wrap(async (req, res) => {
    const p = provider(req); const { model } = z.object({ model: z.string().min(1).max(150) }).strict().parse(req.body);
    const result = await verifyModel(p, model, AbortSignal.timeout(300_000));
    // Provider may have changed while the long probe was in progress.
    if (store.get(p.id) !== p) throw new Error('설정이 변경되었습니다. 모델을 다시 검증하세요.');
    await store.verify(p.id, result); res.json(result);
  }));
  app.get('/api/runs', (_req, res) => res.json([...runs.values()].map(r => ({ ...expose(r.state), input: { ...r.state.input, referenceImage: undefined } })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200)));
  app.get('/api/runs/:id', wrap((req, res) => res.json(expose(lookup(req).state))));
  app.post('/api/runs', wrap(async (req, res) => {
    const input: RunInput = RunSchema.parse(req.body);
    if (active()) throw Object.assign(new Error('현재 실행을 마치거나 취소한 후 시작하세요.'), { status: 409 });
    const p = verifiedProvider(input);
    const team = input.teamId ? teams.get(input.teamId) : undefined;
    if (input.teamId && !team) throw new Error('등록된 팀 구성을 선택하세요.');
    if (team && !input.referenceImage) throw new Error('팀 실습에는 참조 이미지가 필요합니다.');
    if (team && input.baseRunId) throw new Error('팀 비교는 같은 초기 조건에서 새로 실행합니다.');
    if (team) input.mode = team.mode;
    const live = await createLive(input, team);
    void executeLive(live, p);
    res.status(202).json({ id: live.state.id });
  }));
  app.post('/api/runs/:id/cancel', wrap((req, res) => { lookup(req).controller.abort(new Error('사용자가 취소했습니다.')); res.json({ ok: true }); }));
  app.get('/api/runs/:id/events', wrap((req, res) => {
    const live = lookup(req);
    const afterRaw = req.headers['last-event-id'] ?? req.query['after'] ?? '0';
    const after = z.coerce.number().int().nonnegative().parse(afterRaw);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': connected\n\n');
    for (const event of live.events) if (event.id > after) res.write(eventText(event));
    live.clients.add(res);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => { clearInterval(heartbeat); live.clients.delete(res); });
  }));
  app.get('/api/runs/:id/artifacts/:filename', wrap(async (req, res) => {
    const live = lookup(req); const filename = z.string().regex(/^[A-Za-z0-9_.-]+$/).parse(req.params['filename']);
    if (filename.startsWith('.') || !live.state.artifacts.some(a => a.name === filename)) throw Object.assign(new Error('등록된 결과 파일이 아닙니다.'), { status: 404 });
    const file = path.join(runsDir, live.state.id, filename);
    await stat(file);
    if (/\.(glsl|agsl|json|txt)$/.test(filename)) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(file);
  }));
  app.get('/api/experiments', (_req, res) => res.json([...experiments.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))));
  app.get('/api/experiments/:id', wrap((req, res) => res.json(experimentFor(req))));
  app.post('/api/experiments', wrap(async (req, res) => {
    const parsed = ExperimentSchema.parse(req.body);
    if (active()) throw Object.assign(new Error('현재 실행을 마치거나 취소한 후 비교 실험을 시작하세요.'), { status: 409 });
    if (new Set(parsed.teamIds).size !== parsed.teamIds.length) throw new Error('중복 팀 선택입니다.');
    const selected = parsed.teamIds.map(id => { const team = teams.get(id); if (!team) throw new Error('등록되지 않은 팀입니다.'); return team; });
    const p = verifiedProvider(parsed);
    const { teamIds, ...input } = parsed;
    const experiment: ExperimentState = { id: randomUUID(), input, inputHash: inputHash(input), teamIds, teams: structuredClone(selected), runIds: [], status: 'queued', createdAt: new Date().toISOString() };
    experiments.set(experiment.id, experiment); // Reserves whole batch before I/O.
    const batch: LiveRun[] = [];
    try {
      for (const team of selected) { const live = await createLive({ ...input, mode: team.mode, teamId: team.id }, team, experiment.id); batch.push(live); experiment.runIds.push(live.state.id); }
      await persistExperiment(experiment);
    } catch (error) {
      experiment.status = 'interrupted'; experiment.finishedAt = new Date().toISOString();
      for (const live of batch) { live.state.status = 'stopped'; live.state.stopReason = '비교 실험 준비 중 저장 실패'; await writeFile(path.join(runsDir, live.state.id, 'run.json'), JSON.stringify(live.state)); }
      throw error;
    }
    const task = Promise.resolve().then(async () => {
      const cancelled = () => experiment.status === 'cancelled';
      try {
        experiment.status = 'running'; await persistExperiment(experiment);
        for (const live of batch) {
          if (cancelled() || live.controller.signal.aborted) {
            live.state.status = 'cancelled'; live.state.stopReason = '실행 전에 비교 실험이 취소되었습니다.'; live.state.finishedAt = new Date().toISOString();
            emitter(live)({ type: 'run.cancelled', message: live.state.stopReason }); await live.writes; continue;
          }
          await executeLive(live, p);
        }
        if (!cancelled()) experiment.status = 'completed';
      } catch (error) {
        experiment.status = 'interrupted';
        for (const live of batch) if (['queued', 'running'].includes(live.state.status)) { live.controller.abort(); live.state.status = 'stopped'; live.state.stopReason = '비교 실험이 중단되었습니다: ' + String(error); emitter(live)({ type: 'run.stopped', message: live.state.stopReason }); await live.writes; }
      } finally { experiment.finishedAt = new Date().toISOString(); await persistExperiment(experiment); }
    }).catch(error => console.error('Experiment persistence failed:', error.message));
    experimentTasks.set(experiment.id, task);
    res.status(202).json({ id: experiment.id });
  }));
  app.post('/api/experiments/:id/cancel', wrap(async (req, res) => {
    const item = experimentFor(req);
    if (['queued', 'running'].includes(item.status)) {
      item.status = 'cancelled';
      for (const id of item.runIds) runs.get(id)?.controller.abort(new Error('비교 실험을 취소했습니다.'));
      await persistExperiment(item);
    }
    res.json({ ok: true });
  }));
  app.get('/api/experiments/:id/report', wrap(async (req, res) => {
    const item = experimentFor(req), states = item.runIds.flatMap(id => runs.get(id)?.state ?? []);
    res.setHeader('Content-Disposition', `attachment; filename="team-comparison-${item.id.slice(0, 8)}.html"`);
    res.type('html').send(await buildExperimentReport(item, states, readArtifact));
  }));
  app.get('/api/experiments/:id/export', wrap(async (req, res) => {
    const item = experimentFor(req);
    if (['queued', 'running'].includes(item.status)) throw new Error('실행 종료 후 결과를 내보내세요.');
    res.setHeader('Content-Disposition', `attachment; filename="team-comparison-${item.id.slice(0, 8)}.json"`);
    res.json(await exportComparison(item, item.runIds.flatMap(id => runs.get(id)?.state ?? []), readArtifact));
  }));
  app.post('/api/experiments/import', wrap(async (req, res) => {
    if (active()) throw Object.assign(new Error('현재 실행 종료 후 결과를 가져오세요.'), { status: 409 });
    const imported = await importComparison(req.body, runsDir);
    for (const state of imported.runs) runs.set(state.id, { state, events: [], clients: new Set(), controller: new AbortController(), writes: Promise.resolve() });
    experiments.set(imported.experiment.id, imported.experiment); await persistExperiment(imported.experiment);
    res.status(201).json({ id: imported.experiment.id });
  }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API_NOT_FOUND' }));
  if (options.uiDir) {
    app.use((_req, res, next) => { res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'"); next(); });
    app.use(express.static(options.uiDir));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(options.uiDir!, 'index.html')));
  }
  app.use((error: any, _req: Request, res: Response, _next: express.NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    res.status(error.status ?? (error instanceof z.ZodError ? 400 : 400)).json({ error: error instanceof z.ZodError ? error.issues.map(v => `${v.path.join('.')}: ${v.message}`).join('; ') : String(error.message ?? '실행 오류') });
  });
  const server = await new Promise<Server>((resolve, reject) => { const srv = app.listen(options.port ?? 4317, '127.0.0.1', () => resolve(srv)); srv.once('error', reject); });
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : options.port}`;
  return {
    url: origin, server, store,
    async close() {
      for (const live of runs.values()) { live.controller.abort(new Error('앱 종료')); for (const client of live.clients) client.end(); }
      await Promise.allSettled([...experimentTasks.values(), ...[...runs.values()].map(live => live.task)]);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
