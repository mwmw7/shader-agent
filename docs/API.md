# 내부 API와 SSE 계약

Electron main이 Node 실행 서버를 `127.0.0.1`에 시작하고 Angular 화면을 같은 서버에서 제공합니다. UI에는 Node 권한을 주지 않습니다. 채팅·설정·취소는 HTTP 요청, 실행 이벤트는 SSE를 사용합니다. 개발 모드의 Angular 서버는 `proxy.conf.json`으로 API를 전달합니다.

| 메서드·경로 | 내용 |
|---|---|
| `GET /api/bootstrap` | 프로바이더, 노드 등록 목록, 기본 GLSL |
| `GET /api/providers` | 키 값이 제외된 프로바이더 목록 |
| `POST /api/providers` | `{id?,name,kind,baseUrl,apiKey?}` 등록/수정 |
| `DELETE /api/providers/:id` | 사용 중이 아닌 프로바이더 삭제 |
| `POST /api/providers/:id/models` | 실제 로컬 모델 목록 조회, 본문 `{}` |
| `POST /api/providers/:id/verify` | `{model}` 비전·JSON·도구 제안 검증 |
| `POST /api/runs` | 새 실행 생성, 아래 입력 예시 |
| `GET /api/runs` | 최근 50개 실행, 원본 이미지 데이터 제외 |
| `GET /api/runs/:id` | 현재 실행 스냅샷과 결과 파일 URL |
| `POST /api/runs/:id/cancel` | 취소, 본문 `{}` |
| `GET /api/runs/:id/events` | SSE 이벤트와 재연결 시 재전송 |
| `GET /api/runs/:id/artifacts/:filename` | 등록된 결과 파일만 제공 |
| `GET /api/health` | 서버 상태 |

POST는 `Content-Type: application/json`을 사용합니다. 상태 변경은 같은 출처의 UI에서 수행하며 서버는 지정되지 않은 Origin·Host를 거절합니다.

```json
{
  "providerId": "등록된 프로바이더 UUID",
  "model": "검증을 통과한 로컬 모델 이름",
  "mode": "fixed",
  "request": "서로 다른 깊이의 빗줄기가 내리는 저녁 하늘",
  "maxRevisions": 2
}
```

`mode`는 `fixed` 또는 `orchestrated`입니다. 선택 필드 `referenceImage`는 PNG/JPEG/WebP data URL, `baseRunId`는 기존 GLSL을 수정 시작점으로 사용할 실행 ID입니다. 이전 영상·평가를 새 실행의 증거로 재사용하지 않습니다. 응답은 HTTP 202와 `{id}`입니다. 동시에 하나의 실행만 허용합니다.

## SSE

```text
id: 12
event: harness
data: {"id":12,"runId":"...","type":"agent.started","ts":"...","revision":1,"agentId":"render"}

```

모든 SSE의 event 이름은 `harness`이며 구체적 종류는 JSON의 `type`입니다. `Last-Event-ID` 헤더를 우선 사용하고 최초 연결 시 `?after=12`도 사용할 수 있습니다. 이벤트 ID는 실행 안에서 증가합니다. Angular는 ID를 기준으로 중복을 무시합니다.

주요 종류: `run.started/completed/failed/stopped/cancelled`, `agent.started/completed/failed`, `tool.started/completed/failed`, `shader.updated`, `evaluation.completed`, `policy.blocked`, `log`.

SSE는 화면 갱신을 알리는 통로입니다. 전체 상태는 GET 스냅샷으로 복구합니다. 실행 중에는 15초 간격 heartbeat가 전송됩니다. 프로세스가 재시작되면 이전 실행은 중단으로 표시하며 자동 재실행하지 않습니다.

## 실행 정책을 바꿀 때

1. `shared/contracts.ts`: 등록 노드와 도구 권한
2. `harness-prompts.ts`: 역할·출력 JSON 계약
3. `harness-policy.ts`: 선행조건과 허용 다음 노드
4. `harness.ts`: 실제 노드와 그래프 연결
5. `tools.ts`: 고정 작업, 인자 스키마와 실행 경계
6. `tests/`: 허용 경로와 금지 경로를 함께 확인

소스의 agent ID는 하네스가 정합니다. 모델이 반환한 이름·도구 목록·코드·평가는 런타임 검사를 통과해야 합니다. 프롬프트 수정만으로 권한이 바뀌지 않습니다.

## 팀 실습 / 비교 API (1.1)

| 요청 | 역할 |
|---|---|
| `GET /api/teams` | 기본 10팀의 독립된 노드 구성 조회 |
| `POST /api/teams` | 전체 팀 구성 저장, `id` 생략 시 새 UUID |
| `DELETE /api/teams/:id` | 팀 설정 제거 (기존 실행 스냅샷 유지) |
| `GET /api/samples/default-image` | 번들 참조 PNG |
| `POST /api/experiments` | 동일 입력으로 선택 팀들을 순차 실행 |
| `GET /api/experiments` / `/:id` | 묶음 상태와 run IDs |
| `POST /api/experiments/:id/cancel` | 현재 실행 취소 + 대기 팀 실행 방지 |
| `GET /api/experiments/:id/report` | 실제 이미지가 포함된 독립 HTML |
| `GET /api/experiments/:id/export` | 종료된 실험의 PNG·코드·기록 JSON |
| `POST /api/experiments/import` | 같은 입력 해시의 여러 결과 병합 |

실험 생성 body: `{ providerId, model, request, referenceImage, maxRevisions, teamIds }`. 이미지 필수, 1~10팀, 수정 0~2회. 응답 `{id}`. 팀 프롬프트와 노드 배열은 실행 시점에 복사되어 이후 팀 편집의 영향을 받지 않습니다. `RunEvent`는 `nodeId`/`nodeName`을 포함하며 `agentId`는 툴 권한을 가진 기본 역할일 때만 있습니다. 상세 진행은 각 run의 기존 SSE API로 받습니다.

가져오기 body: `{ packages: [comparisonPackage, ...] }`, 응답 `{id}`. 입력 해시는 모델명·요청·이미지·수정 한도·공통 실행 조건을 포함하고 PC별 프로바이더 UUID는 제외합니다. 서로 다른 해시는 거절합니다. 해시는 실행 진위나 PC별 가중치의 동일성을 인증하지 않습니다. 가져오기는 LLM/툴/GPU를 실행하지 않고 새 실행 ID로 PNG와 기록을 보관합니다. MP4는 교환 파일에 포함하지 않습니다. 패키지 24 MB, 가져오기 HTTP body 25 MB 한도입니다. 팀 이름·프롬프트·이미지가 공유 파일에 포함됩니다.
