import type { Evaluation, RunState } from '../shared/contracts.js';
import type { ExperimentState } from '../shared/experiment-contracts.js';
import type { RevisionSnapshot, TeamProfile, TeamRunState } from '../shared/team-contracts.js';

type ArtifactReader = (runId: string, filename: string) => Promise<Buffer>;
const times = [0, 1250, 2750] as const;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const pre = (value: unknown): string => `<pre>${escape(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre>`;
const statusNames: Record<RunState['status'], string> = {
  queued: '대기', running: '실행 중', completed: '완료', stopped: '중단', failed: '실패', cancelled: '취소',
};
const experimentStatusNames: Record<ExperimentState['status'], string> = {
  queued: '대기', running: '실행 중', completed: '배치 처리 종료', cancelled: '배치 취소', interrupted: '재시작으로 중단',
};

function referenceImage(value: string | undefined): string | undefined {
  if (!value || value.length > 8 * 1024 * 1024) return undefined;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return undefined;
  const bytes = Buffer.from(match[2], 'base64');
  const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(pngSignature) :
    match[1] === 'jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff :
    bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return valid ? `data:image/${match[1]};base64,${bytes.toString('base64')}` : undefined;
}

function runtime(run: RunState & Partial<TeamRunState>): string {
  const duration = typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0
    ? run.durationMs : run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : NaN;
  if (!Number.isFinite(duration) || duration < 0) return '미기록';
  return duration < 60_000 ? `${(duration / 1000).toFixed(1)}초` : `${Math.floor(duration / 60_000)}분 ${((duration % 60_000) / 1000).toFixed(1)}초`;
}

function evaluation(value: Evaluation | undefined): string {
  if (!value) return '<p class="muted">시각 평가가 없습니다.</p>';
  return `<p><strong>자가평가 ${escape(value.score)} / 100</strong> · ${value.passed ? '자체 기준 통과' : '자체 기준 미통과'} · revision ${escape(value.revision)}</p>
    <p class="preserve">${escape(value.feedback)}</p>
    <ul>${value.evidence.map(item => `<li><code>${escape(item.frame)}</code>: ${escape(item.observation)}</li>`).join('')}</ul>`;
}

function configuration(team: TeamProfile | undefined): string {
  if (!team) return '<p class="muted">팀 구성 스냅샷이 없습니다.</p>';
  return `<p><strong>설계 가설</strong>: ${escape(team.hypothesis || '미기록')}</p>
    <p>실행 방식: ${team.mode === 'fixed' ? '고정 순서' : '오케스트레이터'} · 구성 ID: <code>${escape(team.id)}</code></p>
    <p class="muted">각 노드는 LLM 에이전트입니다. 툴 권한은 역할별 서버 정책으로 고정되며 아래 프롬프트로 변경되지 않습니다.</p>
    <table class="configuration"><thead><tr><th>노드</th><th>역할 / 상태</th><th>목적과 프롬프트</th></tr></thead><tbody>
      ${team.nodes.map(node => `<tr><td>${escape(node.icon)} ${escape(node.name)}<br><code>${escape(node.id)}</code></td>
        <td>${escape(node.role)}<br>${node.enabled ? '활성' : '비활성'}</td><td class="preserve">${escape(node.prompt)}</td></tr>`).join('')}
    </tbody></table>`;
}

/** One portable presentation file: escaped text, embedded actual PNGs, no JavaScript or remote assets. */
export async function buildExperimentReport(experiment: ExperimentState, runs: RunState[], readArtifact: ArtifactReader): Promise<string> {
  const images = new Map<string, Promise<string | undefined>>();
  function loadFrame(runId: string, filename: string): Promise<string | undefined> {
    const key = `${runId}/${filename}`;
    if (!images.has(key)) images.set(key, (async () => {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(runId) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(filename) || filename.includes('..')) return undefined;
      try {
        const bytes = await readArtifact(runId, filename);
        if (bytes.length > 12 * 1024 * 1024 || !bytes.subarray(0, 8).equals(pngSignature)) return undefined;
        return `data:image/png;base64,${bytes.toString('base64')}`;
      } catch { return undefined; }
    })());
    return images.get(key)!;
  }
  async function frameCells(runId: string, frames: string[]): Promise<string> {
    return (await Promise.all(times.map(async timestamp => {
      const filename = frames.find(name => name.endsWith(`-t${timestamp}.png`));
      const image = filename ? await loadFrame(runId, filename) : undefined;
      return image ? `<td class="frame"><img src="${image}" alt="${escape(`${timestamp / 1000}초 실제 추출 프레임`)}"><small>${escape(filename)}</small></td>` :
        `<td class="frame missing">${timestamp / 1000}초 실제 프레임 없음</td>`;
    }))).join('');
  }
  const frameHeader = '<tr><th>0초</th><th>1.25초</th><th>2.75초</th></tr>';
  async function revisionDetail(run: RunState, item: RevisionSnapshot): Promise<string> {
    return `<details class="revision"><summary>revision ${escape(item.revision)} · ${item.compileOk === true ? '컴파일 통과' : item.compileOk === false ? '컴파일 실패' : '컴파일 미확인'} · ${item.evaluation ? `자가평가 ${escape(item.evaluation.score)}` : '평가 없음'}</summary>
      <table class="frames"><thead>${frameHeader}</thead><tbody><tr>${await frameCells(run.id, item.frames)}</tr></tbody></table>
      ${evaluation(item.evaluation)}${item.feedback ? `<p class="preserve">${escape(item.feedback)}</p>` : ''}
      ${item.compileLog ? `<details><summary>컴파일 로그</summary>${pre(item.compileLog)}</details>` : ''}
      ${item.glsl ? `<details><summary>GLSL 소스</summary>${pre(item.glsl)}</details>` : ''}
      ${item.agsl ? `<details><summary>AGSL 소스 · Android 기기 검증 별도</summary>${pre(item.agsl)}</details>` : ''}
      ${item.nodeOutputs?.length ? `<details><summary>이 revision의 에이전트 판단 기록</summary>${pre(item.nodeOutputs)}</details>` : ''}
    </details>`;
  }
  const orderedRuns = experiment.runIds.map(id => runs.find(run => run.id === id)).filter((run): run is RunState => !!run);
  const rows: string[] = [];
  const details: string[] = [];
  for (const run of orderedRuns) {
    const extended = run as RunState & Partial<TeamRunState>;
    const index = experiment.runIds.indexOf(run.id);
    const team = extended.team ?? experiment.teams[index];
    const name = team?.name ?? `실행 ${index + 1}`;
    const route = (extended.executionPath ?? []).map(id => {
      const node = team?.nodes.find(candidate => candidate.id === id);
      return node ? `${node.name} (${node.role})` : id;
    }).join(' → ') || '경로 미기록';
    const score = run.evaluation ? `${run.evaluation.score} / 100` : '평가 없음';
    rows.push(`<tr><th scope="row">${escape(name)}<small>${escape(team?.hypothesis ?? '')}</small></th>
      <td><span class="status ${run.status === 'completed' ? 'completed' : 'other'}">${escape(statusNames[run.status] ?? run.status)}</span>
        <small>${escape(run.stopReason ?? '')}</small><small>자가평가: ${escape(score)}</small>
        <small>revision ${escape(run.revision)} · 수정 ${escape(run.revisions)}회</small>
        <small>${escape(runtime(extended))} · 모델 호출 ${escape(run.modelCalls)}회</small></td>
      ${await frameCells(run.id, run.frames ?? [])}</tr>`);
    const history = extended.history ?? [];
    details.push(`<section class="team"><h2>${escape(name)} — ${escape(statusNames[run.status] ?? run.status)}</h2>
      <p class="muted">실행 ID: <code>${escape(run.id)}</code> · 시작 ${escape(run.createdAt)} · 종료 ${escape(extended.finishedAt ?? '미기록')} · 소요 ${escape(runtime(extended))}</p>
      ${run.stopReason ? `<p class="notice">종료 사유: ${escape(run.stopReason)}</p>` : ''}
      <p><strong>실제 실행 경로</strong></p><p class="route">${escape(route)}</p>
      <p>최종 revision ${escape(run.revision)} · 수정 ${escape(run.revisions)} / ${escape(run.maxRevisions)}회 · 모델 호출 ${escape(run.modelCalls)}회</p>
      ${run.frames?.length && run.evidenceRevision !== run.revision ? '<p class="notice">현재 프레임은 최종 소스 revision과 일치하지 않습니다. 완료 증거로 사용하지 마세요.</p>' : ''}
      ${run.evaluation && run.evaluationRevision !== run.revision ? '<p class="notice">자가평가는 최종 소스 revision과 일치하지 않습니다.</p>' : ''}
      ${evaluation(run.evaluation)}
      <details><summary>팀 구성과 모든 노드 프롬프트</summary>${configuration(team)}</details>
      ${history.length ? `<h3>수정 이력</h3>${(await Promise.all(history.map(item => revisionDetail(run, item)))).join('')}` : '<p class="muted">revision별 이력은 기록되지 않았습니다.</p>'}
      ${run.glsl ? `<details><summary>최종 GLSL 소스</summary>${pre(run.glsl)}</details>` : ''}
      ${run.agsl ? `<details><summary>최종 AGSL 소스 · Android 기기 검증 별도</summary>${pre(run.agsl)}</details>` : ''}
      ${run.compileLog ? `<details><summary>최종 컴파일 로그</summary>${pre(run.compileLog)}</details>` : ''}
      ${extended.nodeOutputs?.length ? `<details><summary>전체 에이전트 판단과 호출 기록</summary>${pre(extended.nodeOutputs)}</details>` : ''}
    </section>`);
  }
  const missingTeams = experiment.teams.filter((_, index) => !experiment.runIds[index] || !orderedRuns.some(run => run.id === experiment.runIds[index]));
  const reference = referenceImage(experiment.input.referenceImage);
  const completed = orderedRuns.filter(run => run.status === 'completed').length;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>팀 실험 비교 — ${escape(experiment.id)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f1f4f9;color:#182333;font:16px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1600px;margin:auto;padding:42px 30px}h1{font-size:36px;line-height:1.2;margin:0 0 16px}h2{font-size:25px}h3{font-size:18px}.eyebrow{color:#415d87;letter-spacing:.08em;font-weight:700}section,.intro{background:#fff;border:1px solid #d8e0ec;border-radius:14px;padding:25px;margin:22px 0}.muted,small{color:#5b697b}.notice{background:#edf3ff;border-left:4px solid #527abf;padding:14px 18px}.preserve{white-space:pre-wrap;overflow-wrap:anywhere}.reference{max-width:560px;max-height:360px;object-fit:contain;background:#eef1f6;border-radius:8px}.request{font-size:19px}code{font-size:.88em;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:600px;overflow:auto;padding:16px;background:#101b2b;color:#e1ebff;border-radius:8px;font:13px/1.6 ui-monospace,monospace}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:12px;border:1px solid #dce3ed;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#eef3fa;font-size:14px}.comparison th:first-child{width:15%}.comparison th:nth-child(2){width:16%}small{display:block;margin-top:6px;font-size:12px}.frame img{display:block;width:100%;height:auto;background:#e9edf4}.frame{padding:8px}.missing{color:#687586;text-align:center;padding:35px 8px;background:#f6f8fb}.status{display:inline-block;font-size:13px;font-weight:700;padding:2px 10px;border-radius:20px}.completed{background:#ddf4e5;color:#205d37}.other{background:#fff0d9;color:#6a4c18}details{border:1px solid #dce3ed;border-radius:8px;padding:12px 16px;margin:12px 0}summary{cursor:pointer;font-weight:650}.route{background:#f0f4fa;border-radius:8px;padding:14px;overflow-wrap:anywhere}.configuration th:first-child{width:21%}.configuration th:nth-child(2){width:15%}.scroll{overflow-x:auto}.comparison{min-width:950px}footer{font-size:13px;color:#637084}@media(max-width:700px){main{padding:20px 12px}h1{font-size:28px}section,.intro{padding:16px}}@media print{body{background:#fff}main{max-width:none;padding:0}section,.intro{break-inside:avoid;border-radius:0}.comparison{min-width:0;font-size:11px}th,td{padding:6px}details{break-inside:avoid}pre{max-height:none}.scroll{overflow:visible}}
</style></head><body><main>
<p class="eyebrow">TEAM LAB / OFFLINE REPORT</p><h1>같은 입력, 다른 에이전트 구성</h1>
<p>${escape(experimentStatusNames[experiment.status] ?? experiment.status)} · 완료한 팀 ${completed} / ${experiment.teams.length} · 생성 ${escape(experiment.createdAt)}${experiment.finishedAt ? ` · 배치 종료 ${escape(experiment.finishedAt)}` : ''}</p>
<p class="notice"><strong>자가평가 점수는 공통 품질 순위가 아닙니다.</strong> 에이전트 구성과 프롬프트가 달라 자기 점수의 기준도 달라질 수 있습니다. 동일 입력 해시·모델·예산을 확인하고 최소 3회 반복한 뒤, 팀 정보를 가린 사람의 비교 투표로 품질을 판단하세요. 배치 처리 종료는 모든 팀의 성공을 뜻하지 않습니다.</p>
<section class="intro"><h2>공통 입력과 통제 조건</h2><p class="request preserve">${escape(experiment.input.request)}</p>
${reference ? `<img class="reference" src="${reference}" alt="모든 팀에 제공한 참고 이미지">` : '<p class="muted">유효한 참고 이미지가 포함되지 않았습니다.</p>'}
<p>모델: <strong>${escape(experiment.input.model)}</strong> · 공통 최대 수정: ${escape(experiment.input.maxRevisions)}회 · 렌더링: 640×360, 3초, 12fps</p>
<p>입력 해시: <code>${escape(experiment.inputHash)}</code></p><p class="muted">실험 ID: <code>${escape(experiment.id)}</code>${experiment.imported ? ' · 가져온 비교 자료' : ''}</p></section>
<section><h2>동일 시점 실제 영상 프레임</h2><p class="muted">각 실행의 최종 추출 프레임입니다. 없는 파일이나 중단된 실행을 예시 이미지로 대체하지 않습니다.</p>
<div class="scroll"><table class="comparison"><thead><tr><th>팀 / 설계 가설</th><th>실제 상태와 비용</th><th>0초</th><th>1.25초</th><th>2.75초</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
${missingTeams.length ? `<p class="notice">실행 기록 없음: ${missingTeams.map(team => escape(team.name)).join(', ')}. 실행 전 취소되었거나 기록이 누락되었습니다.</p>` : ''}</section>
${details.join('')}
${missingTeams.map(team => `<section class="team"><h2>${escape(team.name)} — 실행 기록 없음</h2><p>실행 전 취소되었거나 기록이 누락되었습니다.</p><details><summary>저장된 팀 구성과 프롬프트</summary>${configuration(team)}</details></section>`).join('')}
<footer>이 파일은 실제 기록과 포함된 이미지로 만든 오프라인 보고서입니다. 펼치기 항목에서 팀 설정·수정 이력·소스를 확인할 수 있습니다. 영상 전체의 움직임과 Android 결과는 별도로 확인해야 합니다. API 키와 프로바이더 비밀 설정은 포함하지 않습니다.</footer>
</main></body></html>`;
}
