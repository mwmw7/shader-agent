import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';
import { createModelClient, listModels, ModelOutputError, validateLocalBaseUrl, verifyModel } from '../server/providers.js';
import type { ProviderConfig } from '../shared/contracts.js';

async function fakeServer(handler: (req: IncomingMessage, res: ServerResponse, body: any) => void | Promise<void>) {
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString();
      await handler(req, res, text ? JSON.parse(text) : undefined);
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }),
  };
}
function json(res: ServerResponse, value: unknown) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); }
function config(baseUrl: string, kind: ProviderConfig['kind'] = 'ollama'): ProviderConfig { return { id: 'test', name: 'Explicit test fixture', kind, baseUrl }; }
const objectSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };

test('local-only URL validation rejects cloud, metadata, credentials, DNS names and redirect tricks', async () => {
  for (const value of ['http://localhost:11434', 'http://127.0.0.1:1234/v1', 'http://10.1.2.3', 'http://172.16.0.1', 'http://192.168.0.5', 'http://[::1]:11434', 'https://[fd12::1]']) {
    await assert.doesNotReject(validateLocalBaseUrl(value), value);
  }
  for (const value of ['https://api.openai.com/v1', 'https://ollama.com', 'http://169.254.169.254', 'http://8.8.8.8', 'http://172.32.0.1', 'http://0.0.0.0', 'file:///tmp/test', 'http://localhost.evil.test', 'http://private.lan', 'http://user:password@127.0.0.1', 'http://127.0.0.1?next=https://evil.test', 'http://127.0.0.1/proxy']) {
    await assert.rejects(validateLocalBaseUrl(value), undefined, value);
  }
});

test('real local HTTP listing filters cloud names/metadata, then rejects redirects without following them', async () => {
  let redirected = false;
  const server = await fakeServer((req, res) => {
    if (req.url === '/api/tags' && !redirected) {
      json(res, { models: [{ name: 'qwen-local' }, { name: 'big:cloud' }, { name: 'hidden', remote_host: 'https://remote.test' }, { name: 'qwen-local' }] });
    } else { res.statusCode = 302; res.setHeader('Location', 'https://example.com/'); res.end(); }
  });
  try {
    assert.deepEqual(await listModels(config(server.url)), [{ id: 'qwen-local' }]);
    redirected = true;
    await assert.rejects(listModels(config(server.url)), /fetch failed/);
  } finally { await server.close(); }
});

test('Ollama passes images separately and malformed/extra fields raise ModelOutputError', async () => {
  let output = '```json\n{"ok":true}\n```';
  let chats = 0, shows = 0;
  const image = 'data:image/png;base64,aGVsbG8=';
  const server = await fakeServer((req, res, body) => {
    if (req.url === '/api/show') { shows++; json(res, { capabilities: ['completion', 'vision'] }); return; }
    assert.equal(req.url, '/api/chat'); assert.equal(body.stream, false); assert.deepEqual(body.format, objectSchema);
    // Thinking models (qwen3.5 etc.) otherwise spend the 180s budget on hidden reasoning before the JSON answer.
    assert.equal(body.think, false);
    assert.deepEqual(body.messages[1].images, ['aGVsbG8=']); chats++;
    json(res, { message: { content: output } });
  });
  try {
    const client = createModelClient(config(server.url), 'qwen-local');
    const request = { system: 'Inspect', prompt: 'Please inspect', images: [image], schema: objectSchema, signal: new AbortController().signal };
    assert.deepEqual(await client.complete(request), { ok: true });
    output = '{"ok":true,"unexpected":"must reject"}';
    await assert.rejects(client.complete(request), ModelOutputError);
    output = 'I think {"ok": true}';
    await assert.rejects(client.complete(request), ModelOutputError);
    assert.equal(chats, 3); assert.equal(shows, 1);
  } finally { await server.close(); }
});

test('compatible endpoint uses data URL multimodal content and native JSON schema', async () => {
  const server = await fakeServer((req, res, body) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer local-secret');
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.messages[1].content[1].image_url.url, 'data:image/png;base64,aGVsbG8=');
    json(res, { choices: [{ message: { content: '{"ok":true}' } }] });
  });
  try {
    const provider = { ...config(`${server.url}/v1`, 'openai-compatible'), apiKey: 'local-secret' };
    assert.deepEqual(await createModelClient(provider, 'local/vision').complete({ system: '', prompt: '', images: ['data:image/png;base64,aGVsbG8='], schema: objectSchema, signal: new AbortController().signal }), { ok: true });
  } finally { await server.close(); }
});

test('Ollama cloud alias is rejected from actual metadata before completion', async () => {
  let chats = 0;
  const server = await fakeServer((req, res) => {
    if (req.url === '/api/show') json(res, { remote_host: 'https://ollama.com', remote_model: 'large' });
    else { chats++; json(res, {}); }
  });
  try {
    const client = createModelClient(config(server.url), 'innocent-alias');
    await assert.rejects(client.complete({ system: '', prompt: '', signal: new AbortController().signal }), /원격 실행/);
    assert.equal(chats, 0);
    assert.throws(() => createModelClient(config(server.url), 'giant:cloud'), /클라우드/);
  } finally { await server.close(); }
});

test('cancelled requests do not contact the model', async () => {
  const controller = new AbortController(); controller.abort(new Error('User cancelled'));
  const client = createModelClient(config('http://127.0.0.1:1'), 'local');
  await assert.rejects(client.complete({ system: '', prompt: '', signal: controller.signal }), /User cancelled/);
});

// Read the actual transmitted PNG bytes; this fixture never sees the random expected answer.
function readPanelColors(base64: string): { left: string; right: string } {
  const png = Buffer.from(base64, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const width = png.readUInt32BE(16);
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(idat));
  const classify = (offset: number) => {
    const [r, g, b] = pixels.subarray(offset, offset + 3);
    if (r > 240 && g > 240 && b > 240) return 'white';
    if (r > 200 && g > 180 && b < 50) return 'yellow';
    return r > g && r > b ? 'red' : g > r && g > b ? 'green' : 'blue';
  };
  return { left: classify(1 + 20 * 3), right: classify(1 + (width - 20) * 3) };
}

test('verification runs two image challenges, JSON test and a tool proposal (without executing tools)', async () => {
  let imageCalls = 0;
  const server = await fakeServer((req, res, body) => {
    if (req.url === '/api/tags') { json(res, { models: [{ name: 'local-vision' }] }); return; }
    if (req.url === '/api/show') { json(res, { capabilities: ['vision'] }); return; }
    const message = body.messages[1];
    let output: unknown;
    if (message.images) { imageCalls++; output = readPanelColors(message.images[0]); }
    else if (message.content.includes('Copy nonce ')) output = { nonce: /Copy nonce (\S+) exactly/.exec(message.content)![1], answer: 42 };
    else output = { tool: 'video.extract_frames', args: { video: 'probe.mp4', times: [0, 1] } };
    json(res, { message: { content: JSON.stringify(output) } });
  });
  try {
    const verification = await verifyModel(config(server.url), 'local-vision');
    assert.equal(verification.vision, true); assert.equal(verification.structured, true); assert.equal(verification.toolCall, true);
    assert.match(verification.detail, /native function calling 검증이 아닙니다/); assert.equal(imageCalls, 2);
  } finally { await server.close(); }
});
