# 변경 이력

## 1.1.1 · 2026-10-15

실제 로컬 비전 모델(Ollama)로 팀 실험을 돌리며 찾은 하네스 문제 4건을 고쳤습니다. 노드 등록 목록, 툴 권한, 단계 조건은 바뀌지 않았습니다.

- **Ollama 요청에 `think: false` 추가** (`server/providers.ts`). thinking 모델(qwen3.5 등)이 JSON 답 앞에 수 분간 사고 토큰을 생성해 호출당 180초 제한을 넘겼습니다. 같은 제작 프롬프트가 198초에서 35초로 줄었습니다. thinking을 지원하지 않는 모델도 이 값을 무시하고 정상 응답합니다.
- **툴 제안 스키마를 역할별 허용 툴 enum으로 제한** (`server/harness-prompts.ts`). 자유 문자열 배열이던 `tools`에 모델이 노드 ID(`node-1-analyze`)나 오타(`rules-check`)를 넣어 ACL이 거부하고 실행이 즉시 실패했습니다. 이제 구조화 출력 단계에서 등록된 툴 ID만 생성됩니다. 권한 검사(`harness-policy.ts`)는 그대로 두 번째 방어선으로 남습니다.
- **규칙 검사 메시지가 위반 키워드를 열거** (`server/shader.ts`). "Unsupported GLSL…" 한 줄만으로는 모델이 루프를 지우고도 `main()`을 그대로 두는 식으로 수정이 멈췄습니다. 이제 `for, int, void, main`처럼 거부된 토큰과 `vec4 effect(vec2 fragCoord)` 요구사항을 함께 알려줍니다.
- **WebGL 컴파일 로그 줄 번호 보정** (`server/shader.ts`, `server/tools.ts`). 호스트가 앞에 3줄(precision, uniform 2개)을 붙이므로 오류 줄 번호가 모델이 쓴 소스와 어긋났습니다. `relocateCompileLog()`가 모델 소스 기준으로 바꿉니다.
- 테스트: 단위 53개(툴 enum 스키마, 줄 번호 보정 신규), 통합 5개 통과. README에 Ubuntu chrome-sandbox 권한과 Electron 지연 다운로드 안내 추가.

## 1.1.0 · 2026-09-24

3명 × 10팀 실습용 팀 하네스, 실험 비교·교환·HTML 보고서 추가. 단일 하네스 API와 테스트는 유지.
