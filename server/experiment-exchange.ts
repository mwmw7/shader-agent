import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ComparisonPackage, ExperimentInput, ExperimentState } from '../shared/experiment-contracts.js';
import type { RunState } from '../shared/contracts.js';
import type { RevisionSnapshot } from '../shared/team-contracts.js';
import { parseTeamProfile } from './team-policy.js';

const Text = z.string().max(32000);
const Name = z.string().max(150).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const Image = z.string().max(4_300_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/);
const Input = z.object({ providerId: z.string().max(100), model: z.string().min(1).max(150), request: z.string().trim().min(1).max(8000), referenceImage: Image, maxRevisions: z.number().int().min(0).max(2) });
const Evaluation = z.object({ score: z.number().min(0).max(100), passed: z.boolean(), feedback: Text, revision: z.number().int().min(1).max(3), evidence: z.array(z.object({ frame: Name, observation: Text })).max(4) });
const Output = z.object({ nodeId: z.string().max(64), nodeName: z.string().max(100), role: z.enum(['analyze', 'search', 'generate', 'render', 'evaluate', 'agsl', 'plan', 'review']), revision: z.number().int().min(0).max(3), output: z.unknown(), startedAt: z.string().max(40), finishedAt: z.string().max(40), modelCalls: z.number().int().min(0).max(40), status: z.enum(['completed', 'failed']), error: Text.optional() });
const History = z.object({ revision: z.number().int().min(0).max(3), glsl: Text.optional(), agsl: Text.optional(), compileOk: z.boolean().optional(), compileLog: Text.optional(), frames: z.array(Name).max(3), evaluation: Evaluation.optional(), feedback: Text.optional(), nodeOutputs: z.array(Output).max(40), createdAt: z.string().max(40) });
const Run = z.object({
  id: z.string().uuid(), team: z.unknown(), status: z.enum(['completed', 'stopped', 'failed', 'cancelled']), createdAt: z.string().max(40), finishedAt: z.string().max(40).optional(), durationMs: z.number().nonnegative().max(900_000 * 2).optional(),
  revision: z.number().int().min(0).max(3), revisions: z.number().int().min(0).max(2), maxRevisions: z.number().int().min(0).max(2), modelCalls: z.number().int().min(0).max(40), stagnantRounds: z.number().int().min(0).max(3),
  analysis: Text.optional(), glsl: Text.optional(), agsl: Text.optional(), compileOk: z.boolean().optional(), compileLog: Text.optional(), frames: z.array(Name).max(3).optional(),
  evidenceRevision: z.number().int().min(1).max(3).optional(), evaluation: Evaluation.optional(), evaluationRevision: z.number().int().min(1).max(3).optional(), feedback: Text.optional(), stopReason: Text.optional(),
  nodeOutputs: z.array(Output).max(40).default([]), history: z.array(History).max(4).default([]), executionPath: z.array(z.string().max(64)).max(100).default([]),
});
const Package = z.object({ format: z.literal('shader-harness-comparison'), version: z.literal(1), experiment: z.object({ input: Input, inputHash: z.string().length(64), status: z.enum(['completed', 'cancelled', 'interrupted']) }), runs: z.array(Run).min(1).max(10), files: z.record(z.string().uuid(), z.record(Name, z.string().max(6_000_000))) });

/** Provider ID intentionally excluded: the same local model may live on each team's PC. */
export function inputHash(input: ExperimentInput): string {
  return createHash('sha256').update(JSON.stringify({ model: input.model, request: input.request.trim(), image: input.referenceImage, maxRevisions: input.maxRevisions, modelCallBudget: 40, render: { width: 640, height: 360, duration: 3, fps: 12, times: [0, 1.25, 2.75] } })).digest('hex');
}
function png(buffer: Buffer): void {
  if (buffer.length < 33 || buffer.length > 4_000_000 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('유효한 PNG 프레임이 아닙니다.');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 1280 || height > 1280) throw new Error('프레임 크기 범위를 벗어났습니다.');
}
export async function exportComparison(experiment: ExperimentState, runs: RunState[], readArtifact: (runId: string, filename: string) => Promise<Buffer>): Promise<ComparisonPackage> {
  const files: ComparisonPackage['files'] = {};
  let byteCount = 0;
  for (const run of runs) {
    files[run.id] = {};
    const names = new Set([...(run.frames ?? []), ...(run.history ?? []).flatMap(h => h.frames)]);
    for (const name of names) {
      Name.parse(name); if (!name.endsWith('.png')) throw new Error('PNG 프레임만 비교 패키지에 넣습니다.');
      const bytes = await readArtifact(run.id, name); png(bytes); byteCount += bytes.length;
      if (byteCount > 14_000_000) throw new Error('결과가 너무 큽니다. 팀을 나누어 내보내세요.');
      files[run.id][name] = 'data:image/png;base64,' + bytes.toString('base64');
    }
  }
  const portableRuns = structuredClone(runs).map(run => ({ ...run, input: { ...run.input, referenceImage: undefined } }));
  const result: ComparisonPackage = { format: 'shader-harness-comparison', version: 1, experiment: structuredClone(experiment), runs: portableRuns, files };
  if (Buffer.byteLength(JSON.stringify(result)) > 24_000_000) throw new Error('비교 패키지가 24 MB를 넘습니다. 작은 이미지와 더 적은 팀으로 나누어 실행하세요.');
  return result;
}

/** Strict data import. No model calls, tool calls, WebGL compilation, or arbitrary filenames. */
export async function importComparison(value: unknown, runsDir: string): Promise<{ experiment: ExperimentState; runs: RunState[] }> {
  const request = z.object({ packages: z.array(Package).min(1).max(10) }).strict().parse(value);
  const packages = request.packages;
  const common = packages[0].experiment.input;
  const hash = inputHash(common);
  for (const item of packages) {
    if (item.experiment.inputHash !== inputHash(item.experiment.input) || item.experiment.inputHash !== hash) throw new Error('같은 이미지·요청·모델·수정 한도의 결과만 합칠 수 있습니다. 입력 해시를 확인하세요.');
  }
  if (packages.reduce((sum, p) => sum + p.runs.length, 0) > 10) throw new Error('발표 비교는 한 번에 최대 10개 팀 실행을 합칩니다.');
  const experiment: ExperimentState = { id: randomUUID(), input: common, inputHash: hash, teamIds: [], teams: [], runIds: [], status: 'completed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), imported: true };
  const prepared: { state: RunState; images: Map<string, Buffer> }[] = [];
  let bytesTotal = 0;
  for (const item of packages) for (const raw of item.runs) {
    const team = parseTeamProfile(raw.team);
    const registered = new Set(team.nodes.filter(n => n.enabled).map(n => n.id));
    if (raw.executionPath.some(id => id !== 'orchestrator' && !registered.has(id))) throw new Error('실행 경로에 등록되지 않은 노드가 있습니다.');
    const images = new Map<string, Buffer>();
    const names = new Set([...(raw.frames ?? []), ...raw.history.flatMap(h => h.frames)]);
    for (const name of names) {
      const data = item.files[raw.id]?.[name];
      if (!name.endsWith('.png') || !data?.startsWith('data:image/png;base64,')) throw new Error('실제 프레임 데이터가 빠진 비교 결과입니다.');
      const buffer = Buffer.from(data.slice('data:image/png;base64,'.length), 'base64'); png(buffer);
      bytesTotal += buffer.length; if (bytesTotal > 14_000_000) throw new Error('가져올 프레임의 합계가 너무 큽니다.'); images.set(name, buffer);
    }
    const id = randomUUID();
    const state: RunState = { ...raw, id, input: { ...common, mode: team.mode, teamId: team.id }, team, history: raw.history as RevisionSnapshot[], artifacts: [...names].map(name => ({ name, kind: 'frame' })), experimentId: experiment.id, inputHash: hash, imported: true };
    prepared.push({ state, images }); experiment.runIds.push(id); experiment.teamIds.push(team.id); experiment.teams.push(team);
  }
  const created: string[] = [];
  try {
    for (const { state, images } of prepared) {
      const dir = path.join(runsDir, state.id); await mkdir(dir, { mode: 0o700 }); created.push(dir);
      for (const [name, bytes] of images) await writeFile(path.join(dir, name), bytes, { mode: 0o600 });
      for (const h of state.history ?? []) for (const [extension, value] of [['glsl', h.glsl], ['agsl', h.agsl]] as const) {
        if (!value || h.revision === 0) continue;
        const name = `shader-r${h.revision}.${extension}`; await writeFile(path.join(dir, name), value, { mode: 0o600 }); state.artifacts.push({ name, kind: extension });
      }
      await writeFile(path.join(dir, 'run.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
    }
  } catch (error) { await Promise.all(created.map(dir => rm(dir, { recursive: true, force: true }))); throw error; }
  return { experiment, runs: prepared.map(p => p.state) };
}
