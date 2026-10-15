# 검증 기록

## 2026-10-15 · 1.1.1

Linux arm64 / Ubuntu 24.04 / Node.js 24.21.0 (npm 11.19) / FFmpeg 6.1.1 / Playwright Chromium 1208 / Ollama 0.32.1 환경에서 [CHANGELOG](../CHANGELOG.md) 1.1.1 변경 후 확인했습니다.

| 항목 | 결과 | 범위 |
|---|---|---|
| `npm test` | 53개 통과 | 기존 51개 + 역할별 툴 enum 스키마 1개 + 컴파일 로그 줄 번호 보정 1개. 규칙 검사 메시지 검사는 기존 툴 테스트를 확장 |
| `test:render` / `test:pipeline` / `test:team-pipeline` | 2 / 2 / 1 통과 | 실제 Chromium WebGL → MP4 → PNG, 두 LangGraph, 팀 수정 루프 |
| 새 복사본에서 `npm ci` → `npm run build` | Node 24와 Node 22 모두 통과 | Electron 실행 파일은 첫 `npm start` 때 지연 다운로드됨 |
| Electron 데스크톱 창 | 통과 | chrome-sandbox root 4755 적용 후 창 표시. 설정 등록, 모델 목록 조회, 실제 호출 검증, 실험 실행을 창 안에서 조작 |
| 실제 로컬 비전 모델 추론 | 통과 | Ollama, 02팀(기획 3노드) 구성, 번들 참조 이미지, 수정 2회. gemma4:26b-a4b-it-qat 1회차 95점 통과(110초, 8회 호출), qwen3.6 3회차 90점 통과(201초, 18회 호출), qwen3.5 수정 예산 소진(r2 컴파일 오류를 r3에서 그대로 반복) |
| Android RuntimeShader 실행 | 미검증 | 변동 없음 |

자동 테스트는 총 58개입니다. 모델 점수는 각 실행의 자가평가이며 모델 간 품질 순위가 아닙니다. 1.1.1 이전 버전에서는 같은 조건의 qwen3.5 실행이 180초 타임아웃 또는 `tools` 권한 거부로 제작 노드에서 실패했습니다.

## 2026-09-24 · 1.1.0

Linux / Node.js 24.19.0 / FFmpeg 6.1.1 / Chromium 153 환경에서 확인했습니다. 이 실행 환경에서는 Playwright 다운로드 CDN 대신 별도로 준비한 headless Chromium 실행 파일을 `CHROMIUM_PATH`로 지정했습니다. 일반 사용자는 `npm run setup:renderer`로 Playwright Chromium을 설치합니다.

| 항목 | 결과 | 범위 |
|---|---|---|
| Angular production build | 통과 | 엄격한 템플릿 검사 포함 |
| Electron·서버 TypeScript build | 통과 | 실제 Electron 타입·API 계약 |
| `npm test` | 51개 통과 | 기존 27개 + 팀 정책·그래프 19개 + 팀/비교 API 5개. 허용 노드, ACL, 순서, 수정, SSE, 취소, 저장·교환 검사 |
| 실제 렌더 통합 | 2개 통과 | WebGL → MP4 → PNG, 검은 화면 여부·시간별 변화, 취소 시 정리 |
| 전체 파이프라인 통합 | 2개 통과 | 실제 툴 + 두 LangGraph, 평가 실패 후 재렌더링, revision 연결 |
| 팀 파이프라인 통합 | 1개 통과 | 기본 고정 순서와 전문 계획·검토 오케스트레이터 비교. 실제 영상·프레임 3회 생성, 피드백 수정, 비활성 노드 차단, 코드·판단 이력 연결 |
| `npm run doctor` | 통과 | Node·FFmpeg·Chromium·실제 WebGL 컨텍스트 |
| Angular 실제 브라우저 조작 | 통과 | 팀 이름·프롬프트·노드 편집, 공통 이미지로 3팀 실행, 실시간 이벤트, 실제 영상·프레임, 수정 이력, HTML/JSON 다운로드·3팀 결과 가져오기 |
| 화면·콘솔 검사 | 통과 | 1440·1280·1024px에서 가로 넘침 없음. 페이지·콘솔 오류와 실패 요청 없음. 엄격한 CSP 유지 |
| Electron 실행 파일 | 버전 확인 | 44.4.5 다운로드·버전 실행 확인 |
| Electron 데스크톱 창 | 이 환경에서 미검증 | 호스트의 Unix socket 제한으로 Chromium singleton 초기화가 차단됨 |
| 실제 로컬 비전 모델 추론 | 미검증 | 설치된 모델 서버가 없어 HTTP fixture·명시적 테스트 ModelClient 사용 |
| Android RuntimeShader 실행 | 미검증 | API 33+ 실기기/에뮬레이터에서 별도 실행 필요 |

프로덕션 코드에는 테스트 모델 대역이 없으며, 실제 모델 검증과 실행 요청은 등록된 로컬 서버로 전달됩니다. 테스트에서 모델 대역을 사용하는 이유는 시각 품질을 주장하기 위해서가 아니라 호출 순서·권한·루프·증거 연결을 재현하기 위해서입니다.

자동 테스트는 총 56개입니다. 추가 브라우저 점검에서도 명시적으로 주입한 ModelClient를 사용했으며 LangGraph, WebGL, FFmpeg, 파일 저장은 실제로 실행했습니다. 세 팀 중 두 팀의 수정 루프와 리비전별 6개 PNG를 확인했습니다. 결과 가져오기는 모델을 호출하거나 셰이더를 다시 실행하지 않았으며, 가져온 실행의 SSE는 유휴 상태였습니다. 이 기록은 실제 모델의 시각 품질이나 팀 구성의 우열을 입증하지 않습니다.

Electron 검증을 시도할 때 사용한 `--no-sandbox`는 컨테이너의 root 실행 점검용 플래그입니다. 프로젝트의 실행 스크립트와 앱 설정에는 넣지 않았으며, 일반 실행은 sandbox를 사용합니다.

재검증:

```bash
npm ci
npm run setup:renderer
npm run build
npm test
npm run test:render
npm run test:pipeline
npm run test:team-pipeline
npm run doctor
npm start
```

실제 모델이 있는 환경에서 설정 화면의 검증을 통과한 후, 같은 이미지·요청으로 두 실행 모드를 실행하고 결과를 비교하세요. 초기 비전 연결 검사, 프레임의 시각 평가, Android 렌더 검증은 각각 별개의 결과입니다.
