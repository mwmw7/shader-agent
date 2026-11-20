## For international engineering reviewers

**Shader Harness Studio** — a local-first educational/research prototype for **AI-assisted shader development and validation**, built with **Electron, Angular, TypeScript, LangGraph, local vision models, WebGL, Chromium, and FFmpeg**.

**Highlights:** multi-agent orchestration, role-based tool access, real render-and-evaluate loops, bounded revisions, failure handling, and automated tests. It uses local inference and should not be confused with a production customer deployment.

See [setup](#1-실행) and [testing](#5-개발테스트) for reproducible instructions.

---

# Shader Harness Studio · Team Lab

An **Electron + Angular + LangGraph** workshop project for 30 Air Force AI developers, organized into 10 teams of three. Given an image, an agent powered by a local vision model creates a shader, evaluates rendered video and frames, and revises the result up to twice. Teams use the same input to compare how task decomposition and node configuration affect the outcome.

The app has **two pages: Settings and Workbench**. Within the Workbench, **Run, Team Design, and Presentation Comparison** provide access to team configurations, images and requests, live node status, video, frames, code, and revision history. See [TEAM-LAB.md](docs/TEAM-LAB.md) for detailed workshop instructions.

## 1. Getting Started

Requirements:

- Node.js **24 recommended**, minimum 22.12, with npm.
- FFmpeg executable: use `brew install ffmpeg` on macOS or `sudo apt install ffmpeg` on Ubuntu. On Windows, add the FFmpeg installation's `bin` directory to PATH.
- A locally installed **model that accepts image input**, served by Ollama or an OpenAI-compatible inference server.
- Playwright Chromium, installed with the command below.

```bash
cd team-lab
npm ci
npm run setup:renderer
npm run doctor
npm start
```

`npm start` builds Angular and TypeScript, then opens the Electron window. The initial `npm ci` installs npm dependencies, and `setup:renderer` downloads Chromium. The Electron executable, approximately 100 MB or more, is downloaded **on the first `npm start`**, rather than by an installation script, so the first launch requires network access and takes longer. For an isolated network, prepare dependencies, Electron, Chromium, FFmpeg, and the model on a connected machine with the same OS and architecture. This repository does not include the multiple gigabytes of model, browser, and runtime files.

On **Ubuntu 23.10 or later, where AppArmor restricts unprivileged user namespaces**, configure the Electron sandbox helper with root ownership and setuid permissions before the first launch. Otherwise, `npm start` exits with `The SUID sandbox helper binary was found, but is not configured correctly`. Repeat this after running `npm ci`, which resets the permissions. This does not apply to macOS or Windows. The project does not use `--no-sandbox`.

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

For Ollama, apply the following setting to **the Ollama process itself**. Stop any existing Ollama process before restarting it:

```bash
OLLAMA_NO_CLOUD=1 ollama serve
```

Run `ollama list` in another terminal to check installed models. Choose a suitable vision model from the [Ollama model catalog](https://ollama.com/search?c=vision). Text-only models are not supported.

The app sends `think: false` in Ollama requests to disable the reasoning phase of thinking models and obtain JSON within the 180-second per-call limit. In validation performed on October 15, 2026, **gemma4:26b-a4b-it-qat** passed on the first attempt in approximately two minutes, and **qwen3.6** passed on the third attempt in approximately 3.5 minutes. Both completed a team experiment with three planning nodes. By contrast, qwen3.5 (9.7B) exhausted its revision budget without resolving compilation feedback. For the initial exercise, the workshop recommends a relatively large vision model such as gemma4:26b-a4b-it-qat. Details are recorded in [VALIDATION.md](docs/VALIDATION.md). “OpenAI-compatible” refers to **the local API format**; configurations pointing to external OpenAI servers are rejected.

## 2. Your First Task

The UI labels below are translated for this guide; the application itself retains its existing language.

1. In **Settings**, register a name, API type, and endpoint. Use `http://127.0.0.1:11434` for Ollama or an address such as `http://127.0.0.1:8000/v1` for a local compatible server.
2. **Fetch the model list**, then run **Validation** for the model you want to use. This checks two real-image inputs, JSON responses, and proposed tool selection.
3. In **Team Design**, select a team and edit its node names, specialist prompts, and hypothesis. The 10 default teams include baseline, divided-planning, and result-review configurations. You can add custom planning and review nodes.
4. In **Run**, choose the same vision model and request, a reference image in PNG/JPEG/WebP format up to 3 MB, a revision limit, and the teams to compare. **Sample Image** loads the bundled weather reference image.
5. Start the comparison to run the selected teams sequentially: image analysis → optional planning → code generation → actual rendering → optional review → evaluation → revision if needed. The harness enforces revision, call, and time limits independently of the evaluation result.
6. In **Presentation Comparison**, compare frames at the same timestamp, video for each code revision, actual call paths, decision records, revision counts, and costs. Completed, stopped, and failed runs are shown separately.
7. The presentation HTML is a standalone file with embedded images. You can also collect **Result JSON** files from team PCs and import them with **Merge Other Teams' Results**. Only results with matching input hashes can be merged. Importing does not execute models or tools. Exchange files include PNG images, code, and records; MP4 videos remain on the original execution PC.

Example request:

> Create a rainy evening sky. Let the clouds drift slowly, with thick, fast-moving rain nearby and thin, slower rain in the distance. Avoid flashes across the entire screen.

Code generation and visual evaluation can fail depending on the actual model and server configuration. The app reports the cause and stopped state rather than substituting a successful result. Initial model validation checks connectivity and basic capabilities; it does not guarantee output quality.

## 3. Roles and Execution Boundaries

| Agent | LLM Responsibility | Allowed Tools |
|---|---|---|
| 🧭 Orchestrator | Propose the next role based on the current state | None |
| 🖼️ Requirements Analysis | Turn the reference image and request into a requirements specification | None |
| 🔎 Example Search | Choose local-example search terms and tools | `examples.search` |
| 🎨 GLSL Generation | Write code and incorporate feedback | `rules.check` |
| 🎬 Render Validation | Choose a validation tool execution plan | `webgl.compile`, `render.video`, `video.extract_frames` |
| 🧪 Visual Evaluation | Inspect actual frames, assign scores, and request revisions | None |
| 📱 AGSL Porting | Choose a conversion and validation tool execution plan | `agsl.convert`, `rules.check` |

Tool calls are **structured JSON proposals** validated by the harness. The project does not depend on a provider's native function-calling API. Permissions are checked against the trusted context of the currently executing node, rather than an agent ID returned by the model.

Team runs require analysis, generation, rendering, and evaluation nodes. Example search and AGSL porting are optional. Teams can add up to three planning nodes and two review nodes. **Every enabled node executes.** Fixed mode follows the saved stage order; the orchestrator selects the next node from the allowed candidates within the current stage. Team prompts cannot change the registered nodes, tool permissions, or stage conditions. Planning and search repeat for each revision, and review repeats for each new render. The original single-harness API and tests are also retained.

Default limits are one initial generation plus up to two revisions, a maximum of 40 model calls, and 15 minutes overall. Invalid JSON gets one correction attempt. Passing evaluation requires both the model's `passed=true` and a score of at least 80. The video, evaluation, and GLSL revision must match. Cancellation propagates to model fetch requests, the browser, and FFmpeg. Restarting the app does not silently resume previous runs.

## 4. Actual Rendering and AGSL Scope

`render.video` renders Chromium WebGL frames at fixed time intervals and uses FFmpeg to produce an MP4. `video.extract_frames` **decodes that MP4**. Harness defaults are 640×360 resolution, three seconds, and 12 fps, with evaluation frames at 0, 1.25, and 2.75 seconds. The live on-screen preview is separate from the fixed-timestamp rendering used for evaluation.

Shader source follows this contract, wrapped by the host:

```glsl
vec4 effect(vec2 fragCoord) {
  vec2 uv = fragCoord / u_resolution;
  return vec4(uv, 0.5 + 0.5 * sin(u_time), 1.0);
}
```

The host provides `u_resolution`, `u_time`, and GLSL `main()`. User-defined `uniform` declarations, `main`, preprocessor directives, textures, multiple passes, loops, arrays, matrices, and recursion are not allowed. The supported subset is limited to float/vec/bool functions and supported mathematical operations. This is not a general-purpose converter for arbitrary Shadertoy code.

The AGSL tool preserves the supported subset while applying Android entry-point, coordinate-orientation, and premultiplied-alpha rules. **Android RuntimeShader compilation and physical-device validation are separate steps.** Add `examples/WeatherShaderView.kt` to an Android project targeting API 33 or later, and save the downloaded AGSL as `app/src/main/assets/weather.agsl`. Launch it with `setContentView(WeatherShaderView(this))` in your Activity. Update the package name to match your app.

The two bundled local examples are original MIT-licensed code included in this project. The app does not search Shadertoy online or download third-party code.

## 5. Development and Testing

```bash
npm run dev               # Angular development server and Electron; backend on port 4317
npm run serve             # Run the same API and UI in a browser
npm test                  # Provider, policy, ACL, API, and SSE tests
npm run test:render       # Actual Chromium and FFmpeg rendering and cancellation checks
npm run test:pipeline     # Integration checks for the original two graphs
npm run test:team-pipeline # Team decomposition, actual video/frames, and revision-history checks
npm run package:dir       # Create an Electron application directory for the current OS
npm run package           # Create an installer for the current OS; signing is separate
```

The ModelClient used in tests is an **explicitly injected test double**. The production app has no mock-model responses or automatic sample-success path. Validate actual vision-model inference and Android output in your own environment. Checks performed in the development environment are recorded in `docs/VALIDATION.md`.

You can set `CHROMIUM_PATH`, `FFMPEG_PATH`, `HARNESS_DATA_DIR`, and `HARNESS_PORT` as environment variables. `HARNESS_PORT` applies to browser mode. Standard Electron launches automatically select an available port; development mode uses 4317. Restart `npm run dev` after changing server-side TypeScript.

## 6. Files and Configuration

```text
electron/main.ts              Electron window, processes, and OS-backed encryption
src/app/                      Two-page Angular UI, SSE, and WebGL views
shared/contracts.ts           Agent registry and shared contracts
server/api.ts                 HTTP/SSE, run management, and result files
server/providers.ts           Ollama/compatible APIs and actual model validation
server/harness.ts             Two LangGraph graphs and agent execution
server/harness-policy.ts      Allowed nodes, conditions, and version checks
server/harness-prompts.ts     Role-specific prompts and JSON contracts
server/tools.ts               ACL, compilation, video, and frame tools
server/shader.ts              Supported GLSL syntax and original weather examples
server/agsl.ts                Rule-based AGSL conversion
tests/                        Fault injection and integration checks
shared/team-contracts.ts      Team-node and stage-history contracts
server/team-harness.ts        Per-team LangGraph graphs and actual revision loops
server/team-policy.ts         Registration, prerequisites, and permission enforcement
server/team-store.ts          Default configurations for 10 teams and persistence
server/experiment-exchange.ts Shared input hashes and result export/merging
server/experiment-report.ts   Standalone HTML presentation reports
samples/weather-reference.png Shared reference image
docs/TEAM-LAB.md               Team design, controlled experiments, and presentation workflow
```

Electron stores data under `app.getPath('userData')`; browser mode uses the project's `.harness-data` directory. Each `runs/<runId>/` directory contains source code, video, frames, evaluation JSON, `run.json`, and `events.jsonl`. Team configurations are stored in `teams.json`, and comparison groups in `experiments/`. Each run records a fixed snapshot of its team configuration. Full history is retained on local disk, so remove unneeded run directories after closing the app.

API keys are encrypted using the available OS secure-storage mechanism. If secure storage is unavailable, or when running in browser mode, keys are kept only in memory and must be entered again after a restart. The settings API never returns key values.

## 7. Troubleshooting

| Symptom | What to Check |
|---|---|
| Cannot fetch the model list | Inference-server status, URL/port, and whether the selected API type is Ollama or compatible |
| Model is listed but fails vision validation | Actual image-input support and multimodal configuration on the model/server |
| JSON validation fails | Server support for `response_format: json_schema`, or Ollama `format` |
| Chromium executable is missing | Run `npm run setup:renderer`. For Linux system libraries, use `npx playwright install-deps chromium` |
| FFmpeg is missing | Installation and PATH, or an absolute `FFMPEG_PATH` |
| Render tool fails or produces a black screen | `npm run doctor`, GPU/WebGL support, and compilation logs |
| GLSL syntax is blocked | Check the supported subset above. Update `harness-prompts.ts` and `shader.ts` together if changing it |
| Local model is slow | Adjust model size, context, or hardware. The default request timeout is 180 seconds and the Ollama context size is 16,384. Requests use `think: false` to disable the reasoning phase of thinking models |
| Generation exhausts the revision budget on the same error | Rule-check messages identify prohibited keywords, and WebGL logs report line numbers relative to the model's source. If the error keeps repeating, try a larger vision model that can incorporate the feedback |
| SUID sandbox error immediately after `npm start` | Apply the Ubuntu chrome-sandbox permissions described in Section 1 |
| AGSL fails only on Android | Check API level 33 or later, uniform names, and compilation logs from the actual device |

The client cannot determine whether a proxy at a local address internally forwards requests to an external API. External forwarding must also be disabled on the local server itself. The app rejects public addresses, cloud models, and redirects, and disables LangSmith tracing.

Official references: [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/graph-api), [Angular Version Compatibility](https://angular.dev/reference/versions), [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security), [Ollama Vision](https://docs.ollama.com/capabilities/vision), and [Android AGSL](https://developer.android.com/develop/ui/views/graphics/agsl/agsl-vs-glsl).

## 8. Changelog

See [CHANGELOG.md](CHANGELOG.md). Changes to harness policies, prompts, and tool messages are documented with their rationale.
