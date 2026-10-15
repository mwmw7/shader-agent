import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import type { Artifact, RunState } from '../../shared/contracts';
import type { ExperimentState } from '../../shared/experiment-contracts';
import type { TeamProfile } from '../../shared/team-contracts';

interface ComparisonEntry {
  key: string;
  team: TeamProfile | null;
  run: RunState | null;
  name: string;
  hypothesis: string;
  nodes: string[];
  path: string[];
  scores: { revision: number; score: number; x: number; y: number }[];
  scoreLine: string;
}

@Component({
  selector: 'app-experiment-comparison',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="comparison" aria-label="팀 실험 결과 비교">
      <header class="comparison-heading">
        <div><span class="eyebrow">EXPERIMENT COMPARISON</span><h2>같은 입력, 다른 팀의 결과</h2><p>실제 렌더링과 실행 기록을 나란히 확인하세요.</p></div>
        <div class="exports" *ngIf="experiment?.id">
          <a class="button" [href]="exportUrl('report')" download>보고서 다운로드 <span aria-hidden="true">↓</span></a>
          <a class="button quiet" [href]="exportUrl('export')" download>JSON 내보내기</a>
        </div>
      </header>

      <ng-container *ngIf="experiment; else noExperiment">
        <section class="shared-input" aria-label="모든 팀에 전달한 공통 입력">
          <div class="reference" *ngIf="experiment.input.referenceImage; else noReference">
            <img [src]="experiment.input.referenceImage" alt="모든 팀에 전달한 동일한 참고 이미지">
          </div>
          <ng-template #noReference><div class="reference missing-reference"><span aria-hidden="true">▧</span><span>참고 이미지 없음</span></div></ng-template>
          <div class="input-copy">
            <div class="input-title"><strong>공통 입력</strong><span class="status" [class.active]="experiment.status === 'running' || experiment.status === 'queued'">{{ statusLabel(experiment.status) }}</span></div>
            <p class="request">{{ experiment.input.request || '입력 설명이 기록되지 않았습니다.' }}</p>
            <div class="input-meta"><span><b>모델</b> {{ experiment.input.model || '기록 없음' }}</span><span><b>수정 한도</b> {{ experiment.input.maxRevisions }}회</span><span>{{ experiment.createdAt | date:'yyyy.MM.dd HH:mm' }}</span></div>
            <p class="mismatch" *ngIf="!sameInput">일부 실행의 입력 또는 모델이 이 실험과 다릅니다. 직접 비교하기 전에 실행 상세를 확인하세요.</p>
          </div>
        </section>

        <div class="comparison-toolbar" *ngIf="entries.length">
          <div class="segmented" role="group" aria-label="결과 표시 방식"><button type="button" [class.selected]="viewMode === 'frames'" [attr.aria-pressed]="viewMode === 'frames'" (click)="viewMode = 'frames'">동일 시점 프레임</button><button type="button" [class.selected]="viewMode === 'video'" [attr.aria-pressed]="viewMode === 'video'" (click)="viewMode = 'video'">실제 MP4 영상</button></div>
          <div class="time-selection" *ngIf="viewMode === 'frames'" role="group" aria-label="모든 팀의 비교 시점"><span>공통 시점</span><button *ngFor="let time of frameTimes; let i = index" type="button" [class.selected]="frameIndex === i" [attr.aria-pressed]="frameIndex === i" (click)="frameIndex = i">{{ time }}s</button></div>
          <span class="playback-note" *ngIf="viewMode === 'video'">각 영상을 개별 재생합니다.</span>
          <div class="pagination" *ngIf="pageCount > 1"><button class="page-button" type="button" (click)="changePage(-1)" [disabled]="page === 0" aria-label="이전 팀 보기">←</button><span aria-live="polite">{{ page + 1 }} / {{ pageCount }}</span><button class="page-button" type="button" (click)="changePage(1)" [disabled]="page + 1 >= pageCount" aria-label="다음 팀 보기">→</button></div>
        </div>

        <div class="results-summary" *ngIf="entries.length"><span>{{ entries.length }}개 팀 중 {{ page * pageSize + 1 }}–{{ visibleEnd }}번째 팀</span><span>실험에 선택한 순서로 표시 · 최대 3팀 동시 비교</span></div>
        <div class="comparison-grid" [style.--columns]="visibleEntries.length || 1" *ngIf="entries.length; else noResults">
          <article class="team-result" *ngFor="let entry of visibleEntries; trackBy: trackEntry">
            <header class="team-heading"><div class="team-title"><span class="team-marker" aria-hidden="true">{{ entry.name.slice(0, 1) }}</span><h3>{{ entry.name }}</h3></div><span class="status" [class.active]="entry.run?.status === 'running' || entry.run?.status === 'queued'" [class.failed]="entry.run?.status === 'failed'">{{ entry.run ? statusLabel(entry.run.status) : '실행 대기' }}</span></header>
            <p class="hypothesis">{{ entry.hypothesis || '기록된 가설이 없습니다.' }}</p>
            <div class="team-nodes"><span class="section-label">팀 구성</span><div class="node-list" *ngIf="entry.nodes.length; else noNodes"><span *ngFor="let node of entry.nodes">{{ node }}</span></div><ng-template #noNodes><p class="subtle">구성 기록 없음</p></ng-template></div>

            <div class="media" *ngIf="viewMode === 'frames'">
              <ng-container *ngIf="frameUrl(entry.run) as url; else missingFrame"><img *ngIf="!mediaErrors.has(url); else brokenFrame" [src]="url" [alt]="entry.name + '의 실제 렌더링 프레임, ' + frameTimes[frameIndex] + '초'" (error)="mediaErrors.add(url)"><ng-template #brokenFrame><div class="media-empty"><span aria-hidden="true">▧</span><strong>프레임을 불러오지 못했습니다</strong><p>실행 상세에서 파일 상태를 확인하세요.</p></div></ng-template></ng-container>
              <ng-template #missingFrame><div class="media-empty"><span aria-hidden="true">▧</span><strong>아직 렌더링 프레임이 없습니다</strong><p>{{ pendingMessage(entry.run) }}</p></div></ng-template>
              <span class="media-caption">t = {{ frameTimes[frameIndex] }}s · {{ evidenceLabel(entry.run) }}</span>
            </div>
            <div class="media" *ngIf="viewMode === 'video'">
              <ng-container *ngIf="videoUrl(entry.run) as url; else missingVideo"><video *ngIf="!mediaErrors.has(url); else brokenVideo" [src]="url" controls playsinline preload="metadata" [attr.aria-label]="entry.name + '의 실제 렌더링 MP4 영상'" (error)="mediaErrors.add(url)"></video><ng-template #brokenVideo><div class="media-empty"><span aria-hidden="true">▷</span><strong>영상을 불러오지 못했습니다</strong><p>아래 파일 목록에서 MP4를 다운로드해 확인하세요.</p></div></ng-template></ng-container>
              <ng-template #missingVideo><div class="media-empty"><span aria-hidden="true">▷</span><strong>아직 렌더링 영상이 없습니다</strong><p>{{ pendingMessage(entry.run) }}</p></div></ng-template>
              <span class="media-caption">실제 MP4 · {{ evidenceLabel(entry.run) }}</span>
            </div>

            <div class="result-body">
              <dl class="metrics"><div><dt>모델 호출</dt><dd>{{ entry.run?.modelCalls ?? '—' }}<small *ngIf="entry.run">회</small></dd></div><div><dt>실행 시간</dt><dd>{{ durationLabel(entry.run) }}</dd></div><div><dt>현재 리비전</dt><dd>{{ entry.run ? 'r' + entry.run.revision : '—' }}</dd></div></dl>

              <section class="evaluation" *ngIf="entry.run?.evaluation as evaluation; else noEvaluation"><div class="evaluation-heading"><span>LLM 자체 평가 <small>r{{ evaluation.revision }}</small></span><strong>{{ evaluation.score }}<small>/100</small></strong></div><p>{{ evaluation.feedback || '평가 피드백이 기록되지 않았습니다.' }}</p></section>
              <ng-template #noEvaluation><div class="evaluation empty-evaluation"><strong>아직 평가 결과가 없습니다</strong><p>실제 프레임 평가가 완료되면 점수와 피드백이 표시됩니다.</p></div></ng-template>

              <section class="trend" *ngIf="entry.scores.length"><div class="section-heading"><span class="section-label">리비전별 자체 평가</span><span class="subtle">0–100점</span></div><svg *ngIf="entry.scores.length > 1" viewBox="0 0 240 82" role="img" [attr.aria-label]="trendDescription(entry)"><line x1="12" y1="19.2" x2="228" y2="19.2" stroke="#dce6f5" stroke-dasharray="4 4"></line><line x1="12" y1="64" x2="228" y2="64" stroke="#e7edf5"></line><polyline [attr.points]="entry.scoreLine" fill="none" stroke="#397af0" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline><circle *ngFor="let score of entry.scores" [attr.cx]="score.x" [attr.cy]="score.y" r="3.5" fill="#397af0" stroke="#fff" stroke-width="1.5"></circle></svg><ol class="score-list"><li *ngFor="let score of entry.scores"><span>r{{ score.revision }}</span><strong>{{ score.score }}점</strong></li></ol></section>

              <section class="execution-path"><span class="section-label">실제 실행 경로</span><ol *ngIf="entry.path.length; else noPath"><li *ngFor="let node of entry.path; let last = last"><span>{{ node }}</span><span class="arrow" *ngIf="!last" aria-hidden="true">→</span></li></ol><ng-template #noPath><p class="subtle">아직 기록된 노드 실행이 없습니다.</p></ng-template></section>
              <p class="stop-reason" *ngIf="entry.run?.stopReason as reason">{{ reason }}</p>
              <details class="downloads" *ngIf="entry.run?.artifacts?.length as artifactCount"><summary>결과 파일 <span>{{ artifactCount }}개</span></summary><div class="download-list"><a *ngFor="let artifact of entry.run?.artifacts" [href]="artifactUrl(entry.run, artifact)" download><span class="file-kind">{{ artifact.kind || 'FILE' }}</span><span class="filename">{{ artifact.name }}</span><span aria-hidden="true">↓</span></a></div></details>
              <button *ngIf="entry.run" class="button details-button" type="button" (click)="openRun.emit(entry.run.id)">실행 상세 · 로그 보기 <span aria-hidden="true">↗</span></button>
            </div>
          </article>
        </div>
        <ng-template #noResults><div class="empty-state"><span class="empty-symbol" aria-hidden="true">▥</span><h3>아직 비교할 실행 결과가 없습니다</h3><p>팀 실험을 실행하면 실제 렌더링, 노드 경로, 평가 기록이 이곳에 표시됩니다.</p></div></ng-template>
        <p class="score-caveat"><span aria-hidden="true">ⓘ</span><span>LLM 자체 평가 점수는 품질 순위가 아닙니다. 같은 시점의 실제 프레임과 영상, 피드백을 함께 확인하세요. 정지 프레임만으로 영상의 부드러움이나 전체 품질을 판단할 수 없습니다.</span></p>
      </ng-container>
      <ng-template #noExperiment><div class="empty-state"><span class="empty-symbol" aria-hidden="true">▥</span><h3>비교할 실험을 선택하세요</h3><p>동일한 이미지와 모델로 실행한 팀의 결과를 최대 3개씩 나란히 살펴볼 수 있습니다.</p></div></ng-template>
    </section>
  `,
  styles: [`
    :host { display: block; min-width: 0; color: #263b59; font-size: 13px; line-height: 1.6; }
    * { box-sizing: border-box; } h2, h3, p, dl, dd { margin: 0; } button, a { font: inherit; } button { cursor: pointer; } button:disabled { cursor: not-allowed; opacity: .42; } button:focus-visible, a:focus-visible, summary:focus-visible { outline: 3px solid #8bb4ff; outline-offset: 3px; } a { color: inherit; } .comparison { min-width: 0; }
    .comparison-heading { display: flex; justify-content: space-between; gap: 20px; align-items: center; margin-bottom: 24px; } .eyebrow { display: block; color: #5b79a3; font-size: 12px; letter-spacing: 1.7px; font-weight: 700; margin-bottom: 7px; } h2 { font-size: 23px; letter-spacing: -.7px; line-height: 1.4; } .comparison-heading p { color: #687e9b; margin-top: 7px; font-size: 13px; } .exports { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .button { display: inline-flex; align-items: center; justify-content: center; gap: 10px; border: 1px solid #cfdef3; background: #edf4ff; color: #285faf; border-radius: 8px; padding: 9px 12px; text-decoration: none; font-size: 12px; font-weight: 650; line-height: 1.5; } .button:hover { background: #e0edff; } .button.quiet { background: #fff; color: #536d90; }
    .shared-input { display: flex; gap: 18px; padding: 20px; border: 1px solid #dce6f2; background: #fff; border-radius: 13px; margin-bottom: 22px; } .reference { flex: 0 0 120px; width: 120px; height: 96px; background: #f3f6fc; border: 1px solid #e0e8f3; border-radius: 8px; overflow: hidden; } .reference img { display: block; width: 100%; height: 100%; object-fit: contain; } .missing-reference { display: flex; flex-direction: column; align-items: center; justify-content: center; color: #7488a2; font-size: 12px; gap: 2px; } .missing-reference > span:first-child { font-size: 28px; color: #91a9c9; } .input-copy { min-width: 0; flex: 1; } .input-title { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; } .input-title > strong { font-size: 13px; } .request { white-space: pre-wrap; overflow-wrap: anywhere; color: #425978; font-size: 13px; line-height: 1.7; max-height: 120px; overflow: auto; } .input-meta { display: flex; flex-wrap: wrap; gap: 5px 18px; margin-top: 10px; color: #667c98; font-size: 12px; overflow-wrap: anywhere; } .input-meta b { color: #455e80; font-weight: 600; margin-right: 4px; } .mismatch { color: #986126; background: #fff7e9; border-radius: 6px; padding: 7px 10px; margin-top: 10px; font-size: 12px; }
    .comparison-toolbar { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; margin-bottom: 12px; } .segmented { display: flex; background: #eaf0fa; border-radius: 8px; padding: 4px; gap: 3px; } .segmented button { border: 1px solid transparent; background: transparent; color: #627b9d; font-size: 12px; padding: 8px 11px; border-radius: 6px; font-weight: 600; } .segmented button.selected { background: #fff; color: #2c68c3; border-color: #d9e5f6; box-shadow: 0 2px 3px #2d507309; } .time-selection { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #617897; } .time-selection > span { margin-right: 3px; } .time-selection button { padding: 7px 10px; border: 1px solid #dce5f2; background: #fff; color: #5e7799; border-radius: 7px; font-size: 12px; font-variant-numeric: tabular-nums; } .time-selection button.selected { border-color: #397af0; color: #fff; background: #397af0; } .playback-note { color: #647d9b; font-size: 12px; } .pagination { display: flex; gap: 10px; align-items: center; margin-left: auto; color: #5c7494; font-size: 12px; } .page-button { border: 1px solid #d6e1f1; border-radius: 7px; background: #fff; color: #40638f; padding: 6px 10px; } .results-summary { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 5px; font-size: 12px; color: #7489a3; margin: 0 1px 12px; }
    .comparison-grid { display: grid; grid-template-columns: repeat(var(--columns), minmax(0, 1fr)); gap: 16px; align-items: stretch; } .team-result { min-width: 0; background: #fff; border: 1px solid #dde6f2; border-radius: 13px; overflow: hidden; box-shadow: 0 3px 12px #27436a05; } .team-heading { display: flex; align-items: center; justify-content: space-between; gap: 9px; padding: 18px 17px 10px; } .team-title { display: flex; gap: 9px; align-items: center; min-width: 0; } .team-marker { display: grid; place-items: center; flex: 0 0 31px; width: 31px; height: 31px; background: #e9f1ff; border-radius: 9px; color: #447cca; font-size: 15px; font-weight: 700; } h3 { font-size: 15px; line-height: 1.45; overflow-wrap: anywhere; letter-spacing: -.3px; } .status { display: inline-flex; align-items: center; padding: 3px 7px; border-radius: 5px; background: #eff3f8; color: #667d99; font-size: 12px; white-space: nowrap; font-weight: 500; } .status.active { background: #eaf2ff; color: #316cc5; } .status.failed { background: #fff0ee; color: #b35646; } .hypothesis { padding: 0 17px; font-size: 12px; color: #617b9a; min-height: 43px; overflow-wrap: anywhere; } .team-nodes { padding: 12px 17px 16px; min-height: 98px; } .section-label { font-size: 12px; font-weight: 650; color: #516e93; } .node-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; } .node-list > span { color: #5c7598; background: #f3f6fb; padding: 2px 6px; border-radius: 4px; font-size: 12px; } .subtle { color: #7489a3; font-size: 12px; } .team-nodes > .subtle { margin-top: 6px; }
    .media { position: relative; background: #f3f6fc; border-top: 1px solid #e8edf5; border-bottom: 1px solid #e5ebf4; } .media > img, .media video { display: block; width: 100%; aspect-ratio: 16/9; object-fit: contain; background: #13243b; } .media video { max-height: 370px; } .media-empty { display: flex; aspect-ratio: 16/9; min-height: 172px; flex-direction: column; justify-content: center; align-items: center; padding: 20px 15px; text-align: center; background: #f6f8fc; } .media-empty > span { font-size: 26px; color: #9fb4d1; margin-bottom: 5px; } .media-empty strong { font-size: 13px; color: #69809f; font-weight: 600; } .media-empty p { color: #7c91ac; font-size: 12px; margin-top: 6px; line-height: 1.6; } .media-caption { display: block; padding: 8px 15px; color: #657e9d; font-size: 12px; background: #f8faff; }
    .result-body { padding: 16px; } .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding-bottom: 15px; border-bottom: 1px solid #edf1f7; gap: 8px; } .metrics dt { color: #788da8; font-size: 12px; } .metrics dd { color: #395879; font-size: 16px; font-weight: 650; margin-top: 5px; font-variant-numeric: tabular-nums; } .metrics small { font-size: 12px; color: #8699b2; font-weight: 400; margin-left: 4px; } .evaluation { background: #f3f7fe; border: 1px solid #e1eafa; border-radius: 9px; padding: 12px; margin: 15px 0; } .evaluation-heading { display: flex; justify-content: space-between; gap: 8px; align-items: center; color: #5275a2; font-size: 12px; font-weight: 600; } .evaluation-heading > span small { margin-left: 4px; color: #7b91ad; font-size: 12px; font-weight: 400; } .evaluation-heading > strong { color: #356fcc; font-size: 23px; line-height: 1.4; font-variant-numeric: tabular-nums; } .evaluation-heading > strong small { color: #7c95b5; font-size: 12px; font-weight: 400; margin-left: 2px; } .evaluation > p { font-size: 12px; color: #647e9e; margin-top: 7px; overflow-wrap: anywhere; white-space: pre-wrap; max-height: 150px; overflow-y: auto; } .empty-evaluation { background: #f9fbfd; border-style: dashed; } .empty-evaluation > strong { color: #7289a6; font-size: 12px; font-weight: 600; }
    .trend { margin: 17px 0; } .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; } .trend svg { display: block; width: 100%; height: 90px; } .score-list { list-style: none; padding: 0; margin: 7px 0 0; display: flex; gap: 7px; flex-wrap: wrap; } .score-list li { display: flex; gap: 6px; border-radius: 5px; padding: 3px 7px; background: #f2f6fd; font-size: 12px; } .score-list li > span { color: #8397b2; } .score-list strong { font-weight: 600; color: #5278ad; } .execution-path { margin: 17px 0; } .execution-path ol { display: flex; flex-wrap: wrap; list-style: none; padding: 0; margin: 7px 0 0; gap: 4px; font-size: 12px; color: #627e9f; } .execution-path li { display: flex; gap: 5px; align-items: center; } .execution-path li > span:first-child { border-bottom: 1px solid #e0e8f4; overflow-wrap: anywhere; } .execution-path .arrow { color: #a0b3cb; } .execution-path p { margin-top: 7px; } .stop-reason { padding: 9px 10px; font-size: 12px; color: #9c6942; background: #fff7ed; border-radius: 7px; overflow-wrap: anywhere; margin-bottom: 12px; }
    .downloads { border-top: 1px solid #e9eef6; padding-top: 12px; } .downloads summary { color: #58769d; cursor: pointer; font-size: 12px; font-weight: 600; } .downloads summary > span { color: #8a9db6; margin-left: 5px; font-weight: 400; } .download-list { display: flex; flex-direction: column; gap: 4px; margin-top: 9px; max-height: 200px; overflow-y: auto; } .download-list a { display: flex; align-items: center; gap: 7px; padding: 6px; font-size: 12px; text-decoration: none; color: #527cb5; border-radius: 5px; } .download-list a:hover { background: #f1f6ff; } .file-kind { text-transform: uppercase; flex: 0 0 auto; color: #7f96b3; font-size: 12px; } .filename { flex: 1; min-width: 0; overflow-wrap: anywhere; } .details-button { width: 100%; margin-top: 16px; background: #fff; justify-content: space-between; }
    .score-caveat { display: flex; gap: 9px; margin-top: 17px; border: 1px solid #dce8f8; border-radius: 9px; padding: 13px 15px; background: #edf4fd; color: #6a83a4; font-size: 12px; line-height: 1.7; } .score-caveat > span:first-child { color: #5785c4; flex-shrink: 0; } .empty-state { border: 1px dashed #cfdff2; border-radius: 13px; background: #fff; padding: 50px 25px; text-align: center; } .empty-symbol { display: block; color: #91afd7; font-size: 36px; margin-bottom: 12px; } .empty-state h3 { color: #567499; font-size: 17px; } .empty-state p { color: #7b91ac; font-size: 13px; margin: 10px auto 0; max-width: 450px; }
    @supports (grid-template-rows: subgrid) { .comparison-grid { grid-template-rows: auto auto auto auto auto; row-gap: 0; } .team-result { display: grid; grid-template-rows: subgrid; grid-row: span 5; } }
    @media (max-width: 1050px) { .comparison-heading { align-items: flex-start; } .exports { max-width: 220px; } .team-heading { align-items: flex-start; flex-direction: column; } .metrics { grid-template-columns: 1fr 1fr; } .metrics > div:last-child { grid-column: 1/-1; } .media-empty { min-height: 160px; } }
    @media (max-width: 760px) { .comparison-heading { flex-direction: column; } .exports { max-width: none; justify-content: flex-start; } .comparison-grid { grid-template-columns: 1fr; row-gap: 16px; } .team-result { display: block; grid-row: auto; } .team-heading { flex-direction: row; align-items: center; } .team-nodes { min-height: auto; } .hypothesis { min-height: auto; } .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); } .metrics > div:last-child { grid-column: auto; } .media > img, .media video { max-height: 340px; } .shared-input { gap: 12px; padding: 15px; } .reference { flex-basis: 90px; width: 90px; height: 86px; } .missing-reference { font-size: 12px; text-align: center; } .time-selection { flex-wrap: wrap; } .pagination { margin-left: 0; } h2 { font-size: 21px; } }
  `],
})
export class ExperimentComparisonComponent implements OnChanges {
  @Input() experiment: ExperimentState | null = null;
  @Input() runs: RunState[] = [];
  @Output() openRun = new EventEmitter<string>();

  readonly pageSize = 3;
  readonly frameTimes = [0, 1.25, 2.75];
  page = 0;
  frameIndex = 0;
  viewMode: 'frames' | 'video' = 'frames';
  entries: ComparisonEntry[] = [];
  sameInput = true;
  mediaErrors = new Set<string>();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['experiment'] && changes['experiment'].previousValue?.id !== this.experiment?.id) {
      this.page = 0;
      this.mediaErrors.clear();
    }
    this.buildEntries();
    this.page = Math.min(this.page, Math.max(0, this.pageCount - 1));
  }

  get pageCount(): number { return Math.ceil(this.entries.length / this.pageSize); }
  get visibleEntries(): ComparisonEntry[] { return this.entries.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize); }
  get visibleEnd(): number { return Math.min((this.page + 1) * this.pageSize, this.entries.length); }
  changePage(delta: number): void { this.page = Math.max(0, Math.min(this.page + delta, this.pageCount - 1)); }
  trackEntry(_index: number, entry: ComparisonEntry): string { return entry.key; }
  exportUrl(kind: 'report' | 'export'): string { return `/api/experiments/${encodeURIComponent(this.experiment?.id || '')}/${kind}`; }

  statusLabel(status: string | undefined): string {
    const labels: Record<string, string> = { queued: '대기 중', running: '실행 중', completed: '완료', stopped: '한도 종료', failed: '실패', cancelled: '취소됨', interrupted: '중단됨' };
    return status ? (labels[status] || status) : '기록 없음';
  }

  artifactUrl(run: RunState | null, artifact: Artifact): string {
    if (!run?.id || !artifact?.name) return '';
    return artifact.url || `/api/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.name)}`;
  }

  frameUrl(run: RunState | null): string {
    const name = run?.frames?.[this.frameIndex];
    if (!name) return '';
    const artifact = run?.artifacts?.find(item => item.name === name && item.kind === 'frame');
    return artifact ? this.artifactUrl(run, artifact) : '';
  }

  videoUrl(run: RunState | null): string {
    if (!run?.video) return '';
    const artifact = run.artifacts.find(item => item.name === run.video && item.kind === 'video');
    return artifact ? this.artifactUrl(run, artifact) : '';
  }

  evidenceLabel(run: RunState | null): string { return run?.evidenceRevision !== undefined ? `r${run.evidenceRevision} 렌더링 근거` : (run?.frames?.length || run?.video ? `r${run.revision} 렌더링 근거` : '렌더링 대기'); }
  pendingMessage(run: RunState | null): string {
    if (!run || run.status === 'queued') return '팀 실행이 시작되면 실제 결과를 수집합니다.';
    if (run.status === 'running') return '현재 실행에서 실제 렌더링 결과를 기다리고 있습니다.';
    return '이 실행에서 생성된 결과가 없습니다. 실행 기록을 확인하세요.';
  }

  durationLabel(run: RunState | null): string {
    if (!run) return '—';
    let duration = typeof run.durationMs === 'number' ? run.durationMs : undefined;
    if (duration === undefined && run.createdAt && run.finishedAt) duration = Date.parse(run.finishedAt) - Date.parse(run.createdAt);
    if (duration === undefined || !Number.isFinite(duration) || duration < 0) return run.status === 'running' ? '진행 중' : '—';
    const seconds = Math.floor(duration / 1000);
    if (seconds < 60) return `${seconds}초`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
    return `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분`;
  }

  trendDescription(entry: ComparisonEntry): string { return entry.scores.map(item => `리비전 ${item.revision}: ${item.score}점`).join(', '); }

  private buildEntries(): void {
    if (!this.experiment) { this.entries = []; return; }
    const ids = this.experiment.runIds;
    const teams = this.experiment.teams;
    const teamIds = this.experiment.teamIds;
    const relatedRuns = ids.map(id => this.runs.find(run => run.id === id) || null);
    this.sameInput = relatedRuns.every(run => !run || ((!run.inputHash || run.inputHash === this.experiment?.inputHash) && run.input.model === this.experiment?.input.model && run.input.request === this.experiment?.input.request && (run.input.maxRevisions ?? run.maxRevisions) === this.experiment?.input.maxRevisions));
    const count = Math.max(ids.length, teams.length, teamIds.length);
    this.entries = Array.from({ length: count }, (_, index) => {
      const run = relatedRuns[index] || null;
      const team = run?.team || teams.find(candidate => candidate.id === teamIds[index]) || teams[index] || null;
      const nodes = team?.nodes || [];
      const nameOf = (id: string): string => {
        const node = nodes.find(candidate => candidate.id === id);
        return node?.name || id;
      };
      const path = (run?.executionPath || []).map(nameOf);
      const history = run?.history || [];
      const scoreMap = new Map<number, number>();
      for (const snapshot of history) {
        if (typeof snapshot?.evaluation?.score === 'number' && Number.isFinite(snapshot.evaluation.score)) scoreMap.set(snapshot.evaluation.revision ?? snapshot.revision, snapshot.evaluation.score);
      }
      if (typeof run?.evaluation?.score === 'number' && Number.isFinite(run.evaluation.score)) scoreMap.set(run.evaluation.revision ?? run.revision, run.evaluation.score);
      const scorePairs = [...scoreMap.entries()].sort((a, b) => a[0] - b[0]);
      const scores = scorePairs.map(([revision, score], i) => ({ revision, score, x: scorePairs.length > 1 ? 12 + i * 216 / (scorePairs.length - 1) : 120, y: 64 - Math.max(0, Math.min(100, score)) * .56 }));
      return {
        key: ids[index] || team?.id || teamIds[index] || `team-${index}`,
        team, run,
        name: team?.name || `팀 ${index + 1}`,
        hypothesis: team?.hypothesis || '',
        nodes: nodes.filter(node => node.enabled !== false).map(node => node.name || node.id),
        path, scores, scoreLine: scores.map(score => `${score.x},${score.y}`).join(' '),
      };
    });
  }
}
