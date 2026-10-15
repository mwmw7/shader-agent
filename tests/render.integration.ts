// Explicit integration test: real Chromium, WebGL, MP4 encoding and frame decoding.
// npm run setup:renderer && npm run test:render (ffmpeg must be installed)
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { DEFAULT_GLSL } from '../server/shader.js';
import { createToolExecutor } from '../server/tools.js';

test('actual WebGL frames become MP4, then distinct decoded evaluation frames', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-render-test-'));
  const tools = createToolExecutor({ runDir: dir, signal: new AbortController().signal, emit: () => {}, revision: () => 7 });
  try {
    const compile = await tools.execute('render', 'webgl.compile', { code: DEFAULT_GLSL });
    assert.equal(compile.ok, true, compile.log);
    // This passes the structural subset but must fail actual GLSL compilation.
    const broken = await tools.execute('render', 'webgl.compile', { code: 'vec4 effect(vec2 p) { return vec4(unknownValue); }' });
    assert.equal(broken.ok, false);
    const video = await tools.execute('render', 'render.video', { code: DEFAULT_GLSL, width: 128, height: 72, duration: 1, fps: 4 });
    assert.match(video.video, /^shader-r7-\d+\.mp4$/);
    const mp4 = await readFile(path.join(dir, video.video));
    assert.equal(mp4.subarray(4, 8).toString(), 'ftyp');
    const result = await tools.execute('render', 'video.extract_frames', { video: video.video, times: [0, 0.5, 1] });
    assert.equal(result.frames.length, 3);
    const images = await Promise.all(result.frames.map((name: string) => readFile(path.join(dir, name))));
    for (const image of images) {
      assert.equal(image.readUInt32BE(16), 128);
      assert.equal(image.readUInt32BE(20), 72);
    }
    const digests = images.map(image => createHash('sha256').update(image).digest('hex'));
    assert(new Set(digests).size > 1, 'Animated weather should change across decoded frames.');
    const decoded = await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', path.join(dir, result.frames[0]), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', '-'], { encoding: 'buffer' });
    const pixels = decoded.stdout;
    assert.equal(pixels.length, 128 * 72 * 3);
    assert(pixels.reduce((sum, value) => sum + value, 0) / pixels.length > 5, 'Rendered video must not be black.');
    assert(Math.max(...pixels) - Math.min(...pixels) > 15, 'Weather frame must contain spatial color variation.');
    assert(!(await readdir(dir)).some(name => name.startsWith('.frames-')), 'Temporary render frames must be removed.');
    await assert.rejects(tools.execute('render', 'video.extract_frames', { video: video.video, times: [2] }), /duration/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancelling during actual frame rendering closes the work and removes partial artifacts', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-render-cancel-'));
  const controller = new AbortController();
  const tools = createToolExecutor({ runDir: dir, signal: controller.signal, emit: () => {}, revision: () => 1 });
  try {
    const result = tools.execute('render', 'render.video', { code: DEFAULT_GLSL, width: 640, height: 360, duration: 3, fps: 12 })
      .then(() => ({ completed: true, error: undefined }), (error: Error) => ({ completed: false, error }));
    let beganRendering = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const dirs = (await readdir(dir)).filter(name => name.startsWith('.frames-'));
      for (const frameDir of dirs) {
        const files = await readdir(path.join(dir, frameDir)).catch(() => []);
        if (files.some(name => name.endsWith('.png'))) beganRendering = true;
      }
      if (beganRendering) break;
      await delay(10);
    }
    controller.abort(new Error('test cancelled active renderer'));
    const outcome = await result;
    assert(beganRendering, 'The cancellation test must reach real frame rendering.');
    assert.equal(outcome.completed, false);
    assert.match(outcome.error!.message, /cancelled/);
    assert.deepEqual(await readdir(dir), [], 'No incomplete MP4 or temporary frames should survive cancellation.');
  } finally { controller.abort(); await rm(dir, { recursive: true, force: true }); }
});
