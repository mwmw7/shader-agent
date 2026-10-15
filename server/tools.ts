import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { z } from 'zod';
import { AGENTS, type AgentId, type Emit, type ToolExecutor } from '../shared/contracts.js';
import { convertToAgsl, validateAgslSource } from './agsl.js';
import { buildFragmentShader, DEFAULT_GLSL, SIMPLE_GLSL, validateShaderSource, relocateCompileLog } from './shader.js';

const codeSchema = z.string().min(10).max(20000);
const schemas = {
  'examples.search': z.object({ query: z.string().min(1).max(1000) }).strict(),
  'rules.check': z.object({ code: z.string().min(1).max(22000), target: z.enum(['glsl', 'agsl']) }).strict(),
  'webgl.compile': z.object({ code: codeSchema }).strict(),
  'render.video': z.object({
    code: codeSchema,
    width: z.number().int().min(64).max(640).refine(n => n % 2 === 0, 'Width must be even').default(480),
    height: z.number().int().min(64).max(360).refine(n => n % 2 === 0, 'Height must be even').default(270),
    duration: z.number().min(0.25).max(3).default(3),
    fps: z.number().int().min(1).max(12).default(12),
  }).strict(),
  'video.extract_frames': z.object({
    video: z.string().regex(/^shader-r\d+-\d+\.mp4$/),
    times: z.array(z.number().min(0).max(3)).min(1).max(4),
  }).strict(),
  'agsl.convert': z.object({ code: codeSchema }).strict(),
};
type ToolName = keyof typeof schemas;

const EXAMPLES = [
  { id: 'original-rain', title: '비와 구름 · 절차적 날씨', code: DEFAULT_GLSL, license: 'MIT' as const, tags: 'rain cloud weather 비 구름 날씨 실사' },
  { id: 'original-clear', title: '맑은 날 · 단순 그라데이션', code: SIMPLE_GLSL, license: 'MIT' as const, tags: 'sun clear simple weather 맑음 태양 단순 날씨' },
];

function aborted(signal: AbortSignal): never {
  throw signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled.');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) aborted(signal);
}

async function scoped<T>(outer: AbortSignal, ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  assertActive(outer);
  const controller = new AbortController();
  const onAbort = () => controller.abort(outer.reason);
  outer.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Tool timeout after ${ms / 1000}s.`)), ms);
  timer.unref();
  try { return await run(controller.signal); }
  finally { clearTimeout(timer); outer.removeEventListener('abort', onAbort); }
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  assertActive(signal);
  let onAbort: () => void = () => {};
  const cancel = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled.'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([promise, cancel]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function withPage<T>(signal: AbortSignal, work: (page: Page) => Promise<T>): Promise<T> {
  assertActive(signal);
  let browser: Browser | undefined;
  const launch = chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    timeout: 25000,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
  });
  // If cancellation wins the launch race, close the browser once it is available.
  void launch.then(async b => { if (signal.aborted) await b.close().catch(() => {}); }).catch(() => {});
  const closeOnAbort = () => { void browser?.close().catch(() => {}); };
  signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    browser = await raceAbort(launch, signal);
    assertActive(signal);
    const page = await raceAbort(browser.newPage(), signal);
    // Shader source is evaluated as WebGL source, never inserted into executable HTML.
    await page.route('**/*', route => route.abort());
    await page.setContent('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
    // tsx/esbuild preserves local function names with this helper. Compiled tsc
    // builds do not need it; defining it also makes the source integration tests portable.
    await page.evaluate('globalThis.__name = (fn) => fn;');
    return await raceAbort(work(page), signal);
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    await browser?.close().catch(() => {});
  }
}

async function setupCanvas(page: Page, code: string, width: number, height: number): Promise<{ ok: boolean; log: string }> {
  const fragment = buildFragmentShader(code);
  return page.evaluate(({ fragment, width, height }) => {
    const canvas = document.querySelector('canvas')!;
    canvas.width = width;
    canvas.height = height;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, alpha: false, antialias: false });
    if (!gl) return { ok: false, log: 'WebGL 1 is unavailable in Chromium. Check renderer/GPU installation.' };
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) || 'Shader compilation failed.';
        gl.deleteShader(shader);
        throw new Error(log);
      }
      return shader;
    };
    try {
      const vs = compile(gl.VERTEX_SHADER, 'attribute vec2 a_position; void main(){gl_Position=vec4(a_position,0.0,1.0);}');
      const fs = compile(gl.FRAGMENT_SHADER, fragment);
      const program = gl.createProgram()!;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Program link failed.');
      gl.useProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, 'a_position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), width, height);
      const timeLocation = gl.getUniformLocation(program, 'u_time');
      gl.viewport(0, 0, width, height);
      (window as any).__harnessFrame = (time: number) => {
        gl.uniform1f(timeLocation, time);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.finish();
        if (gl.isContextLost()) throw new Error('WebGL context lost during render.');
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw new Error(`WebGL render error ${error}.`);
        return canvas.toDataURL('image/png');
      };
      return { ok: true, log: 'GLSL compiled and linked in Chromium WebGL 1.' };
    } catch (error) {
      return { ok: false, log: String(error) };
    }
  }, { fragment, width, height });
}

async function ffmpeg(args: string[], signal: AbortSignal): Promise<void> {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    // No shell: filenames and arguments are passed directly to the process.
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-6000); });
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
    };
    child.on('error', error => { cleanup(); reject(new Error(`Cannot run ffmpeg: ${error.message}. Install ffmpeg or set FFMPEG_PATH.`)); });
    child.on('close', code => {
      cleanup();
      if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled.'));
      else if (code !== 0) reject(new Error(`ffmpeg failed (${code}): ${stderr}`));
      else resolve();
    });
  });
}

export function createToolExecutor(options: { runDir: string; signal: AbortSignal; emit: Emit; revision: () => number }): ToolExecutor {
  const root = path.resolve(options.runDir);
  const videos = new Map<string, { duration: number; fps: number }>();
  let sequence = 0;
  function nextBase(): string {
    const revision = options.revision();
    if (!Number.isInteger(revision) || revision < 0 || revision > 10000) throw new Error('Invalid shader revision.');
    return `shader-r${revision}-${++sequence}`;
  }
  async function safeVideo(name: string): Promise<string> {
    if (path.basename(name) !== name || !videos.has(name)) throw new Error('Video must have been generated by this executor in the current run.');
    const target = path.join(root, name);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Video is not a regular file.');
    return target;
  }
  async function invoke(name: ToolName, args: any, signal: AbortSignal): Promise<unknown> {
    assertActive(signal);
    if (name === 'examples.search') {
      const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      const ranked = [...EXAMPLES].sort((a, b) => words.filter((word: string) => b.tags.includes(word)).length - words.filter((word: string) => a.tags.includes(word)).length);
      return { examples: ranked.map(({ tags: _tags, ...example }) => example) };
    }
    if (name === 'rules.check') {
      try {
        if (args.target === 'glsl') validateShaderSource(args.code);
        else validateAgslSource(args.code);
        return { ok: true, issues: [] };
      } catch (error) { return { ok: false, issues: [(error as Error).message] }; }
    }
    if (name === 'agsl.convert') return convertToAgsl(args.code);
    if (name === 'webgl.compile') {
      try { validateShaderSource(args.code); }
      catch (error) { return { ok: false, log: (error as Error).message }; }
      const compiled = await withPage(signal, page => setupCanvas(page, args.code, 128, 72));
      // The generate agent repairs from this log; numbers must match the lines it wrote.
      if (!compiled.ok && typeof compiled.log === 'string') compiled.log = relocateCompileLog(compiled.log);
      return compiled;
    }
    if (name === 'render.video') {
      validateShaderSource(args.code);
      await mkdir(root, { recursive: true });
      const base = nextBase();
      const work = await mkdtemp(path.join(root, '.frames-'));
      const video = `${base}.mp4`;
      const output = path.join(root, video);
      try {
        const frameCount = Math.max(1, Math.ceil(args.duration * args.fps));
        await withPage(signal, async page => {
          const compiled = await setupCanvas(page, args.code, args.width, args.height);
          if (!compiled.ok) throw new Error(compiled.log);
          for (let index = 0; index < frameCount; index++) {
            assertActive(signal);
            const image = await page.evaluate(time => (window as any).__harnessFrame(time) as string, index / args.fps);
            if (!image.startsWith('data:image/png;base64,')) throw new Error('Renderer did not return a PNG frame.');
            await writeFile(path.join(work, `frame-${String(index).padStart(4, '0')}.png`), Buffer.from(image.split(',')[1], 'base64'));
          }
        });
        await ffmpeg(['-framerate', String(args.fps), '-i', path.join(work, 'frame-%04d.png'), '-frames:v', String(frameCount), '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], signal);
        videos.set(video, { duration: frameCount / args.fps, fps: args.fps });
        return { video };
      } catch (error) {
        await rm(output, { force: true });
        throw error;
      } finally { await rm(work, { recursive: true, force: true }); }
    }
    if (name === 'video.extract_frames') {
      const source = await safeVideo(args.video);
      const metadata = videos.get(args.video)!;
      const base = nextBase();
      const frames: string[] = [];
      try {
        for (let index = 0; index < args.times.length; index++) {
          const requested = args.times[index];
          if (requested > metadata.duration + 0.001) throw new Error('Requested frame timestamp exceeds the video duration.');
          // An end-boundary request (e.g. 3.0s on a 3s clip) uses the last encoded frame.
          const timestamp = Math.min(requested, Math.max(0, metadata.duration - 1 / metadata.fps));
          const name = `${base}-frame-${index}-t${Math.round(timestamp * 1000)}.png`;
          frames.push(name);
          await ffmpeg(['-ss', timestamp.toFixed(6), '-i', source, '-frames:v', '1', '-threads', '1', path.join(root, name)], signal);
          const file = await readFile(path.join(root, name));
          if (!file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Decoded frame is not a PNG file.');
        }
        return { frames };
      } catch (error) {
        await Promise.all(frames.map(file => rm(path.join(root, file), { force: true })));
        throw error;
      }
    }
    throw new Error(`Unknown tool: ${name}`);
  }
  return {
    async execute(agent: AgentId, name: string, args: unknown): Promise<any> {
      assertActive(options.signal);
      // Agent identity is a trusted executor argument, never taken from LLM JSON.
      const registered = AGENTS.find(candidate => candidate.id === agent);
      if (!registered || !(registered.tools as readonly string[]).includes(name)) {
        options.emit({ type: 'policy.blocked', agentId: agent, tool: name, message: `Tool denied for agent ${agent}: ${name}` });
        throw new Error(`Tool denied for agent ${agent}: ${name}`);
      }
      if (!Object.hasOwn(schemas, name)) throw new Error(`Unknown tool: ${name}`);
      const tool = name as ToolName;
      // strict() rejects injected path/options/agent fields before side effects.
      const parsed = schemas[tool].parse(args);
      options.emit({ type: 'tool.started', agentId: agent, tool });
      try {
        const result = await scoped(options.signal, tool === 'render.video' ? 120000 : 45000, signal => invoke(tool, parsed, signal));
        assertActive(options.signal);
        options.emit({ type: 'tool.completed', agentId: agent, tool, data: result });
        return result;
      } catch (error) {
        options.emit({ type: 'tool.failed', agentId: agent, tool, message: (error as Error).message });
        throw error;
      }
    },
  };
}
