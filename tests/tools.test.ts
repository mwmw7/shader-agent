import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { convertToAgsl, validateAgslSource } from '../server/agsl.js';
import { buildFragmentShader, DEFAULT_GLSL, SIMPLE_GLSL, validateShaderSource } from '../server/shader.js';
import { createToolExecutor } from '../server/tools.js';
import type { Emit } from '../shared/contracts.js';

test('original teaching shaders pass the restricted subset and preserve the host contract', () => {
  for (const source of [DEFAULT_GLSL, SIMPLE_GLSL]) {
    validateShaderSource(source);
    const fragment = buildFragmentShader(source);
    assert.match(fragment, /uniform vec2 u_resolution/);
    assert.match(fragment, /gl_FragColor = effect\(gl_FragCoord.xy\)/);
  }
});

test('subset validation rejects loop/comment bypass, recursion, globals and arbitrary GPU features', () => {
  const cases = [
    'vec4 effect(vec2 p) { while(true) {} return vec4(1.0); }',
    '// /*\nvec4 effect(vec2 p) { while(true) {} return vec4(1.0); }\n// */',
    'vec4 effect(vec2 p) { for(float a=0.0; a<1.0; a+=0.1) {} return vec4(1.0); }',
    'vec4 effect(vec2 p) { return effect(p); }',
    'float a(float x) { return b(x); } float b(float x) { return a(x); } vec4 effect(vec2 p) { return vec4(a(p.x)); }',
    'float globalValue; vec4 effect(vec2 p) { return vec4(1.0); }',
    '#define HIDDEN while\nvec4 effect(vec2 p) { return vec4(1.0); }',
    'vec4 effect(vec2 p) { return texture2D(u_texture, p); }',
    'vec4 effect(vec2 p) { float a[2]; return vec4(1.0); }',
    'vec4 effect(vec2 p) { return vec4(gl_FragCoord.x); }',
    'void main() { }',
  ];
  for (const source of cases) assert.throws(() => validateShaderSource(source), undefined, source);
  validateShaderSource('// while and /* are only comment text\nvec4 effect(vec2 p) { return vec4(1.0); }');
});

test('AGSL conversion flips coordinates and premultiplies output without claiming Android verification', () => {
  const converted = convertToAgsl(SIMPLE_GLSL);
  assert.equal(converted.androidVerified, false);
  assert.match(converted.code, /effect\(vec2\(p.x, u_resolution.y - p.y\)\)/);
  assert.match(converted.code, /half4\(c.rgb \* c.a, c.a\)/);
  assert(converted.code.includes(SIMPLE_GLSL));
  validateAgslSource(converted.code);
  assert.throws(() => validateAgslSource(converted.code.replace('c.rgb * c.a', 'c.rgb')));
});

test('tool executor uses trusted agent ACL and rejects path/argument injection before side effects', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-tool-test-'));
  const events: Parameters<Emit>[0][] = [];
  const controller = new AbortController();
  const tools = createToolExecutor({ runDir: dir, signal: controller.signal, revision: () => 1, emit: event => events.push(event) });
  try {
    await assert.rejects(tools.execute('evaluate', 'render.video', { code: DEFAULT_GLSL }), /denied/);
    await assert.rejects(tools.execute('orchestrator', 'agsl.convert', { code: DEFAULT_GLSL }), /denied/);
    await assert.rejects(tools.execute('render', 'video.extract_frames', { video: '../private.mp4', times: [0] }));
    await assert.rejects(tools.execute('render', 'video.extract_frames', { video: 'shader-r1-1.mp4', times: [0] }), /generated/);
    await assert.rejects(tools.execute('render', 'render.video', { code: DEFAULT_GLSL, agent: 'agsl', output: '/tmp/overwrite' }));
    await assert.rejects(tools.execute('render', 'render.video', { code: DEFAULT_GLSL, width: 10000 }));
    assert.deepEqual(await readdir(dir), []);
    assert(events.some(event => event.type === 'policy.blocked'));
    const result = await tools.execute('search', 'examples.search', { query: '비 구름' });
    assert.equal(result.examples[0].id, 'original-rain');
    assert(result.examples.every((example: any) => example.license === 'MIT'));
    const checked = await tools.execute('generate', 'rules.check', { code: 'vec4 effect(vec2 p){ while(true){} return vec4(0.0); }', target: 'glsl' });
    assert.equal(checked.ok, false);
    // The repair loop only works if the model is told WHICH construct was rejected; a generic message let qwen3.5
    // remove a loop but keep main()/gl_FragColor through every revision.
    assert.match(checked.issues[0], /\bwhile\b/);
    const entry = await tools.execute('generate', 'rules.check', { code: 'void main(){ for(int i=0;i<2;i++){} gl_FragColor = vec4(1.0); }', target: 'glsl' });
    assert.equal(entry.ok, false);
    assert.match(entry.issues[0], /\bvoid\b.*\bmain\b|\bmain\b.*\bvoid\b/);
    assert.match(entry.issues[0], /\bfor\b/);
    assert.match(entry.issues[0], /vec4 effect\(vec2 fragCoord\)/);
    controller.abort(new Error('user cancelled'));
    await assert.rejects(tools.execute('search', 'examples.search', { query: 'rain' }), /user cancelled/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
