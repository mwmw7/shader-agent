## For international engineering reviewers

**Shader Harness Studio** — a local-first educational/research prototype for **AI-assisted shader development and validation**, built with **Electron, Angular, TypeScript, LangGraph, local vision models, WebGL, Chromium, and FFmpeg**.

**Highlights:** multi-agent orchestration, role-based tool access, real render-and-evaluate loops, bounded revisions, failure handling, and automated tests. It uses local inference and should not be confused with a production customer deployment.

See [setup](#1-실행) and [testing](#5-개발테스트) for reproducible instructions.

---

# Shader Harness Studio · Team Lab

공군 AI 개발자 30명(3명 × 10팀) 실습용 **Electron + Angular + LangGraph** 프로젝트입니다. 이미지를 넣으면 로컬 비전 모델 에이전트가 셰이더를 제작하고, 실제 영상·프레임을 평가해 최대 2회 수정합니다. 팀별 업무 분해와 노드 구성이 결과에 미치는 영향을 같은 입력으로 비교합니다.

**설정 / 워크벤치의 2개 페이지**를 유지합니다. 워크벤치 안의 **실행 / 팀 설계 / 발표 비교**에서 팀별 구성, 이미지와 요청, 실제 노드 상태, 영상·프레임·코드, 수정 이력을 확인합니다. 자세한 실습 운영은 [TEAM-LAB.md](docs/TEAM-LAB.md)를 보세요.

## 1. 실행

필수 환경:

- Node.js **24 권장** (최소 22.12), npm
- FFmpeg 실행 파일: macOS `brew install ffmpeg`, Ubuntu `sudo apt install ffmpeg`; Windows는 FFmpeg 설치 디렉터리의 `bin`을 PATH에 추가
- 로컬에 설치된 **이미지 입력이 가능한 모델**과 Ollama 또는 OpenAI 호환 추론 서버
- Playwright Chromium: 아래 설치 명령 실행

```bash
cd team-lab
npm ci
npm run setup:renderer
npm run doctor
npm start
```

`npm start`는 Angular·TypeScript를 빌드하고 Electron 창을 엽니다. 최초 `npm ci`는 npm 의존성을, `setup:renderer`는 Chromium을 내려받습니다. Electron 실행 파일(약 100 MB 이상)은 설치 스크립트가 아니라 **첫 `npm start` 때** 내려받으므로 처음 한 번은 네트워크가 필요하고 시간이 더 걸립니다. 폐쇄망에서는 연결 가능한 동일 OS/아키텍처 환경에서 의존성·Electron·Chromium·FFmpeg·모델을 먼저 준비해야 합니다. 이 저장소에 수 GB의 모델/브라우저/런타임은 포함하지 않았습니다.

**Ubuntu 23.10 이상(AppArmor의 비특권 user namespace 제한)** 에서는 첫 실행 전에 Electron sandbox 헬퍼에 root 소유권과 setuid 권한을 줘야 합니다. 없으면 `npm start` 직후 `The SUID sandbox helper binary was found, but is not configured correctly` 오류로 종료됩니다. `npm ci`를 다시 실행하면 권한이 초기화되므로 그때마다 반복합니다. macOS·Windows는 해당하지 않습니다. 이 프로젝트는 `--no-sandbox`를 사용하지 않습니다.

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Ollama 사용 시 **Ollama 프로세스 자체**에 다음 설정을 적용합니다. 이미 실행 중인 Ollama가 있으면 먼저 종료하고 재실행하세요.

```bash
OLLAMA_NO_CLOUD=1 ollama serve
```

다른 터미널에서 `ollama list`로 설치된 모델을 확인하세요. 비전 모델 설치는 [Ollama 모델 목록](https://ollama.com/search?c=vision)에서 환경에 맞는 모델을 준비합니다. 텍스트 전용 모델은 사용할 수 없습니다.

앱은 Ollama 요청에 `think: false`를 보내 thinking 모델의 사고 단계를 끄고 호출당 180초 제한 안에 JSON을 받습니다. 참고로 2026-10-15 검증에서 **gemma4:26b-a4b-it-qat**(1회차 통과, 약 2분)와 **qwen3.6**(3회차 통과, 약 3.5분)은 기획 노드 3개가 있는 팀 실험을 완주했고, qwen3.5(9.7B)는 컴파일 오류 피드백을 반영하지 못해 수정 예산을 소진했습니다. 처음 실습에는 gemma4:26b-a4b-it-qat처럼 비교적 큰 비전 모델을 권장합니다. 자세한 기록은 [VALIDATION.md](docs/VALIDATION.md)에 있습니다. OpenAI 호환이라는 말은 **로컬 API의 형식**을 뜻하며 외부 OpenAI 서버를 연결하는 설정은 거절합니다.

## 2. 첫 작업

1. **설정** → 이름, API 종류, 주소 등록. Ollama는 `http://127.0.0.1:11434`, 로컬 호환 서버는 예를 들어 `http://127.0.0.1:8000/v1`.
2. **모델 목록 조회** → 사용할 모델의 **검증** 실행. 실제 이미지 2회, JSON 응답, 도구 선택 제안을 각각 검사합니다.
3. **팀 설계**에서 팀을 선택하고 노드 이름·전문 프롬프트·가설을 바꿉니다. 기본 10팀은 기본형, 계획 분업형, 결과 검토형으로 나뉩니다. 사용자 정의 계획·검토 노드를 추가할 수 있습니다.
4. **실행**에서 같은 비전 모델과 요청, 참조 이미지(PNG/JPEG/WebP, 최대 3 MB), 수정 한도를 정하고 비교할 팀들을 선택합니다. **샘플 이미지**로 번들 날씨 참조 이미지를 불러올 수도 있습니다.
5. 비교 실행을 시작하면 선택한 팀들이 순서대로 실행됩니다. 이미지 분석 → 계획(선택) → 코드 제작 → 실제 렌더 → 검토(선택) → 평가 → 필요 시 수정 순서입니다. 평가 통과와 별개로 수정·호출·시간 한도는 하네스가 관리합니다.
6. **발표 비교**에서 같은 시각의 프레임, 코드 버전별 영상, 실제 호출 경로, 판단 기록, 수정 횟수와 비용을 비교합니다. 완료·중단·실패를 구분합니다.
7. 발표용 HTML은 이미지가 포함된 독립 파일입니다. 팀별 PC의 **결과 JSON**을 모아 **다른 팀 결과 합치기**로 가져올 수도 있습니다. 같은 입력 해시만 합쳐지며, 가져오기는 모델이나 툴을 실행하지 않습니다. 교환 파일에는 PNG와 코드·기록이 포함되고 MP4는 원래 실행 PC에서 확인합니다.

예시 요청:

> 저녁의 비 오는 하늘을 만들어 주세요. 구름은 천천히 흐르고 가까운 빗줄기는 굵고 빠르게, 먼 빗줄기는 가늘고 느리게 보여 주세요. 화면 전체가 번쩍이지 않게 해 주세요.

실제 모델의 코드 생성·시각 평가는 모델과 서버 설정에 따라 실패할 수 있습니다. 실패를 성공으로 대체하지 않고 원인·중단 상태를 표시합니다. 초기 모델 검증은 연결·기본 능력을 확인하는 검사이며 작업 품질 보증은 아닙니다.

## 3. 역할과 실행 경계

| 에이전트 | LLM의 역할 | 허용 툴 |
|---|---|---|
| 🧭 오케스트레이터 | 현재 상태에서 다음 역할 제안 | 없음 |
| 🖼️ 요구사항 분석 | 참조 이미지·요청을 요구 명세로 정리 | 없음 |
| 🔎 예제 탐색 | 로컬 예제 검색어·툴 선택 | `examples.search` |
| 🎨 GLSL 제작 | 코드 작성·피드백 반영 | `rules.check` |
| 🎬 렌더링 검증 | 검증 툴 실행 계획 선택 | `webgl.compile`, `render.video`, `video.extract_frames` |
| 🧪 시각 평가 | 실제 프레임 관찰·점수·수정 지시 | 없음 |
| 📱 AGSL 이식 | 변환·검사 툴 실행 계획 선택 | `agsl.convert`, `rules.check` |

툴 호출은 **구조화된 JSON 제안**을 하네스가 검사하는 방식입니다. 프로바이더의 native function calling API에 의존하지 않습니다. 모델이 반환한 에이전트 ID로 권한을 결정하지 않으며, 현재 실행 중인 노드의 신뢰된 문맥으로 ACL을 검사합니다.

팀 실행에서 분석·제작·렌더링·평가 노드는 필수이고, 예제 탐색·AGSL 이식은 선택입니다. 계획 노드는 최대 3개, 검토 노드는 최대 2개를 추가할 수 있습니다. **활성화한 노드는 모두 실행**하며, 고정 모드는 저장된 단계 순서를 따릅니다. 오케스트레이터는 같은 단계의 허용 후보 중 다음 노드를 고릅니다. 등록된 노드·도구 권한·단계 조건은 어떤 팀 프롬프트로도 변경되지 않습니다. 계획·탐색은 수정마다, 검토는 새 렌더마다 다시 수행합니다. 기존 단일 하네스 API와 테스트도 남겨 두었습니다.

기본 한도: 최초 제작 + 최대 2회 수정, 최대 40회 모델 호출, 전체 15분, 잘못된 JSON은 한 번 교정. 평가 통과는 모델의 `passed=true`와 점수 80 이상을 모두 요구합니다. 영상·평가·GLSL revision이 일치해야 합니다. 취소는 모델 fetch, 브라우저, FFmpeg에 전달됩니다. 앱 재시작 후 기존 실행을 몰래 재개하지 않습니다.

## 4. 실제 렌더링과 AGSL 범위

`render.video`는 고정 시간 간격으로 Chromium WebGL 프레임을 렌더링하고 FFmpeg로 MP4를 만듭니다. `video.extract_frames`는 **그 MP4를 디코딩**합니다. 하네스 기본값은 640×360, 3초, 12 fps이며 0 / 1.25 / 2.75초 프레임으로 평가합니다. 화면의 실시간 미리보기와 평가용 고정 시간 렌더링은 구분됩니다.

소스는 호스트가 감싸는 다음 계약을 따릅니다.

```glsl
vec4 effect(vec2 fragCoord) {
  vec2 uv = fragCoord / u_resolution;
  return vec4(uv, 0.5 + 0.5 * sin(u_time), 1.0);
}
```

호스트가 `u_resolution`, `u_time`, GLSL `main()`을 제공합니다. 직접 작성하는 `uniform`, `main`, 전처리기, 텍스처, 다중 패스, 루프, 배열, 행렬, 재귀는 허용하지 않습니다. float/vec/bool 함수와 지원 수학 연산으로 범위를 제한합니다. 일반 Shadertoy 코드를 그대로 넣는 범용 변환기가 아닙니다.

AGSL 툴은 지원 부분집합을 유지하면서 Android 진입점, 좌표 방향, premultiplied alpha 규칙을 적용합니다. **Android RuntimeShader 컴파일·실기기 검증은 별도**입니다. `examples/WeatherShaderView.kt`를 API 33 이상 Android 프로젝트에 넣고 다운로드한 AGSL을 `app/src/main/assets/weather.agsl`로 저장하세요. Activity의 `setContentView(WeatherShaderView(this))`로 실행할 수 있습니다. 패키지명은 앱에 맞게 변경합니다.

로컬 예제 2개는 이 프로젝트에 포함된 원본 MIT 코드입니다. 인터넷 Shadertoy 검색이나 제3자 코드를 내려받는 기능은 포함하지 않습니다.

## 5. 개발·테스트

```bash
npm run dev             # Angular 개발 서버 + Electron (백엔드 4317)
npm run serve           # 동일 API와 UI를 브라우저에서 실행
npm test                # 프로바이더/정책/ACL/API/SSE 테스트
npm run test:render     # 실제 Chromium + FFmpeg 렌더·취소 검사
npm run test:pipeline   # 기존 두 그래프 통합 검사
npm run test:team-pipeline # 팀별 분해 + 실제 영상/프레임 + 수정 이력 검사
npm run package:dir     # 현재 OS용 Electron 앱 디렉터리 생성
npm run package         # 현재 OS용 설치 패키지 생성(서명 별도)
```

테스트의 ModelClient는 **명시적으로 주입한 테스트 대역**입니다. 운영 앱에 모의 모델 응답이나 자동 샘플 성공 경로는 없습니다. 실제 비전 모델 추론과 Android 결과는 사용 환경에서 추가 검증하세요. 이 환경에서 확인한 항목은 `docs/VALIDATION.md`에 기록합니다.

`CHROMIUM_PATH`, `FFMPEG_PATH`, `HARNESS_DATA_DIR`, `HARNESS_PORT`를 환경변수로 지정할 수 있습니다. `HARNESS_PORT`는 브라우저 실행 모드에서 사용합니다. Electron 일반 실행은 빈 포트를 자동으로 선택하고, 개발 모드는 4317을 사용합니다. 개발 중 서버 TypeScript 수정 후 `npm run dev`를 재시작하세요.

## 6. 파일과 설정

```text
electron/main.ts              Electron 창·프로세스·OS 암호화
src/app/                      Angular 2페이지·SSE·WebGL 화면
shared/contracts.ts           에이전트 등록 목록·공유 계약
server/api.ts                 HTTP/SSE·실행 관리·결과 파일
server/providers.ts           Ollama/호환 API·실제 모델 검증
server/harness.ts              두 LangGraph·에이전트 실행
server/harness-policy.ts       허용 노드·조건·버전 검사
server/harness-prompts.ts      역할별 프롬프트·JSON 계약
server/tools.ts                ACL·컴파일·영상·프레임 툴
server/shader.ts               GLSL 지원 문법·원본 날씨 예제
server/agsl.ts                 AGSL 규칙 변환
tests/                        실패 주입·통합 검사
shared/team-contracts.ts      팀 노드·단계별 이력 계약
server/team-harness.ts         팀별 LangGraph와 실제 수정 루프
server/team-policy.ts          등록·선행 조건·권한 통제
server/team-store.ts           10팀 기본 구성과 저장
server/experiment-exchange.ts  공통 입력 해시·결과 내보내기/합치기
server/experiment-report.ts    독립 실행 HTML 발표 보고서
samples/weather-reference.png 공통 참조 이미지
docs/TEAM-LAB.md               팀 설계·통제 실험·발표 진행
```

Electron 데이터는 `app.getPath('userData')`, 브라우저 실행은 프로젝트의 `.harness-data`에 저장됩니다. `runs/<runId>/` 안에 소스, 영상, 프레임, 평가 JSON, `run.json`, `events.jsonl`이 남습니다. 팀 구성은 `teams.json`, 비교 묶음은 `experiments/`에 저장되고 실행마다 팀 설정 스냅샷이 고정됩니다. 전체 이력은 로컬 디스크에 보관하므로 필요 없는 실행 폴더는 앱 종료 후 정리하세요.

API 키는 사용 가능한 OS 보안 저장소로 암호화합니다. 보안 저장소가 없는 환경과 브라우저 실행 모드에서는 키를 메모리에만 보관하므로 재시작 후 다시 등록해야 합니다. 설정 API는 키 값을 반환하지 않습니다.

## 7. 오류 해결

| 증상 | 확인할 것 |
|---|---|
| 모델 목록 조회 실패 | 추론 서버 실행, URL/포트, Ollama 또는 호환 API 종류 |
| 목록에는 있지만 비전 검사 실패 | 실제 이미지 입력 지원, 모델/서버 멀티모달 설정 |
| JSON 검사 실패 | 서버의 `response_format: json_schema` 또는 Ollama `format` 지원 |
| Chromium 실행 파일 없음 | `npm run setup:renderer`; Linux 시스템 라이브러리는 `npx playwright install-deps chromium` |
| FFmpeg 없음 | 설치 및 PATH, 또는 절대 경로 `FFMPEG_PATH` |
| 렌더 툴 실패/검은 화면 | `npm run doctor`, GPU/WebGL 지원, 컴파일 로그 |
| GLSL 문법 차단 | 위 지원 부분집합 확인, `harness-prompts.ts`와 `shader.ts`를 함께 변경 |
| 로컬 모델이 느림 | 모델 크기/컨텍스트/장비 조정; 기본 요청 제한 180초, Ollama 컨텍스트 16,384. Ollama에는 `think: false`를 보내므로 thinking 모델의 사고 단계는 꺼집니다 |
| 제작 노드가 같은 오류로 수정 예산을 소진 | 규칙 검사 메시지는 위반 키워드를, WebGL 로그는 모델 소스 기준 줄 번호를 돌려줍니다. 그래도 반복되면 모델이 피드백을 반영하지 못하는 것이므로 더 큰 비전 모델로 바꾸세요 |
| `npm start` 직후 SUID sandbox 오류 | 위 1절의 Ubuntu chrome-sandbox 권한 설정 |
| AGSL만 Android에서 오류 | API 33 이상, uniform 이름, 실제 기기의 컴파일 로그 확인 |

로컬 주소의 프록시가 내부적으로 외부 API로 중계하는지는 클라이언트만으로 확정할 수 없습니다. 로컬 서버 자체도 외부 중계를 비활성화해야 합니다. 앱은 공인 주소·cloud 모델·리디렉션을 거절하고 LangSmith 추적을 끕니다.

공식 참고: [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/graph-api), [Angular 호환 버전](https://angular.dev/reference/versions), [Electron 보안](https://www.electronjs.org/docs/latest/tutorial/security), [Ollama 비전](https://docs.ollama.com/capabilities/vision), [Android AGSL](https://developer.android.com/develop/ui/views/graphics/agsl/agsl-vs-glsl).

## 8. 변경 이력

[CHANGELOG.md](CHANGELOG.md)를 보세요. 하네스 정책·프롬프트·툴 메시지 변경은 이유와 함께 기록합니다.
