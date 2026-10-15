import { randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { deflateSync } from 'node:zlib';
import type { CompletionRequest, ModelClient, ModelInfo, ProviderConfig, Verification } from '../shared/contracts.js';

/** Bad model output is distinct from network/abort errors; the harness may repair it once. */
export class ModelOutputError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelOutputError'; }
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MODEL_TIMEOUT_MS = 180_000;

type JsonSchema = Record<string, unknown>;
type JsonObject = Record<string, any>;

function isLocalAddress(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(host) === 6) return host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host);
  return false;
}

/** No arbitrary DNS names: a validated lookup followed by a fresh fetch lookup permits DNS rebinding. */
export async function validateLocalBaseUrl(value: string): Promise<void> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('올바른 로컬 서버 URL을 입력하세요.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('http(s) URL만 허용합니다. 인증정보·쿼리·프래그먼트는 URL에 넣을 수 없습니다.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!isLocalAddress(host)) {
    throw new Error('로컬 전용: localhost, 루프백 또는 사설 LAN IP만 허용합니다. 호스트명 대신 사설 IP를 입력하세요.');
  }
  if (!['', '/', '/api', '/api/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('기본 URL 경로는 /, /api 또는 /v1만 허용합니다.');
  }
}

function validateModel(model: string): void {
  if (!model || model.length > 256 || /\s|[?&#\\]/.test(model) || model.includes('://') ||
      /(?:^|[-/:_.])(?:cloud|remote)(?:$|[-/:_.])/i.test(model)) {
    throw new Error('클라우드/원격 모델 이름은 사용할 수 없습니다. 설치된 로컬 모델을 선택하세요.');
  }
}

function isCloudMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const object = value as JsonObject;
  return Boolean(object.remote_host || object.remote_model || object.remoteHost || object.remoteModel ||
    object.details?.remote_host || object.details?.remote_model);
}

function endpoint(provider: ProviderConfig, path: string): string {
  const url = new URL(provider.baseUrl);
  url.pathname = `${provider.kind === 'ollama' ? '/api' : '/v1'}/${path}`;
  return url.toString();
}

async function requestJson(provider: ProviderConfig, path: string, body: unknown | undefined,
  signal?: AbortSignal, timeout = 15_000): Promise<JsonObject> {
  await validateLocalBaseUrl(provider.baseUrl);
  const combined = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const response = await fetch(endpoint(provider, path), {
    method: body === undefined ? 'GET' : 'POST', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: combined, redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`로컬 모델 서버가 HTTP ${response.status}를 반환했습니다. 모델 설치·서버 API 호환성·인증을 확인하세요.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('모델 서버 응답 본문이 없습니다.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('모델 서버 응답 크기 제한을 초과했습니다.'); }
    chunks.push(next.value);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('모델 서버가 JSON API 응답을 반환하지 않았습니다. 기본 URL과 API 종류를 확인하세요.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('모델 서버 API 응답 형식이 잘못되었습니다.');
  return parsed as JsonObject;
}

export async function listModels(provider: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
  const response = await requestJson(provider, provider.kind === 'ollama' ? 'tags' : 'models', undefined, signal);
  const models: unknown = provider.kind === 'ollama' ? response.models : response.data;
  if (!Array.isArray(models)) throw new Error('모델 목록 API의 응답 형식이 올바르지 않습니다.');
  const result: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const row of models as JsonObject[]) {
    if (!row || typeof row !== 'object' || isCloudMetadata(row)) continue;
    const id: unknown = provider.kind === 'ollama' ? (row.name ?? row.model) : row.id;
    if (typeof id !== 'string' || seen.has(id)) continue;
    try { validateModel(id); } catch { continue; }
    seen.add(id);
    // A model name or advertised metadata is not evidence of working vision capability.
    result.push({ id });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function imageData(image: string): { base64: string; url: string } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match || match[2].length % 4 !== 0 || Buffer.byteLength(match[2], 'base64') > MAX_IMAGE_BYTES) {
    throw new Error('이미지는 8MB 이하 PNG/JPEG/WebP base64 data URL이어야 합니다. 외부 이미지 URL은 허용하지 않습니다.');
  }
  return { base64: match[2], url: image };
}

/** Validate the JSON Schema subset used by the agents, independently of provider-side enforcement. */
function validateOutput(value: unknown, schema: JsonSchema, path = '$'): void {
  const fail = (why: string): never => { throw new ModelOutputError(`${path}: ${why}`); };
  if (schema.enum && !(schema.enum as unknown[]).some(v => JSON.stringify(v) === JSON.stringify(value))) fail('enum 값이 아닙니다.');
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) fail('const 값과 다릅니다.');
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('object가 필요합니다.');
      const object = value as JsonObject;
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(object, key)) fail(`필수 필드 ${key}가 없습니다.`);
      for (const [key, field] of Object.entries(object)) {
        if (Object.hasOwn(props, key)) validateOutput(field, props[key], `${path}.${key}`);
        else if (schema.additionalProperties === false) fail(`허용되지 않은 필드 ${key}입니다.`);
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) fail('array가 필요합니다.');
      const values = value as unknown[];
      if (typeof schema.minItems === 'number' && values.length < schema.minItems) fail('배열이 너무 짧습니다.');
      if (typeof schema.maxItems === 'number' && values.length > schema.maxItems) fail('배열이 너무 깁니다.');
      if (schema.items) values.forEach((v, i) => validateOutput(v, schema.items as JsonSchema, `${path}[${i}]`));
      break;
    }
    case 'string':
      if (typeof value !== 'string') fail('string이 필요합니다.');
      if (typeof schema.minLength === 'number' && (value as string).length < schema.minLength) fail('문자열이 너무 짧습니다.');
      if (typeof schema.maxLength === 'number' && (value as string).length > schema.maxLength) fail('문자열이 너무 깁니다.');
      break;
    case 'number': case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) fail('유효한 숫자가 필요합니다.');
      if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) fail('최솟값보다 작습니다.');
      if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) fail('최댓값보다 큽니다.');
      break;
    case 'boolean': if (typeof value !== 'boolean') fail('boolean이 필요합니다.'); break;
    case 'null': if (value !== null) fail('null이 필요합니다.'); break;
    case undefined: break;
    default: fail(`지원하지 않는 출력 스키마 type: ${String(schema.type)}`);
  }
}

function parseModelOutput(content: unknown, schema?: JsonSchema): unknown {
  // Some compatible servers return a text-block array; only text is accepted, never function execution.
  if (Array.isArray(content)) content = content.filter(v => v?.type === 'text').map(v => v.text).join('');
  if (typeof content !== 'string' || !content.trim()) throw new ModelOutputError('모델이 비어 있는 JSON 응답을 반환했습니다.');
  let raw = content.trim().replace(/^\uFEFF/, '');
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(raw);
  if (fence) raw = fence[1].trim();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ModelOutputError('모델 출력이 단일 JSON 값이 아닙니다. 설명 문장 없이 JSON만 반환해야 합니다.'); }
  if (schema) validateOutput(parsed, schema);
  return parsed;
}

export function createModelClient(provider: ProviderConfig, model: string): ModelClient {
  validateModel(model);
  // Freeze a snapshot so settings edits cannot change an in-flight run's endpoint/model.
  const config = { ...provider };
  let localMetadataChecked = false;
  return {
    async complete(request: CompletionRequest): Promise<unknown> {
      request.signal.throwIfAborted();
      const images = (request.images ?? []).map(imageData);
      if (images.length > 5) throw new Error('한 번에 최대 5장까지만 모델에 전달할 수 있습니다.');
      if (config.kind === 'ollama' && !localMetadataChecked) {
        const info = await requestJson(config, 'show', { model }, request.signal);
        if (isCloudMetadata(info)) throw new Error('이 Ollama 모델은 원격 실행 모델입니다. 로컬 모델만 사용할 수 있습니다.');
        localMetadataChecked = true;
      }
      const system = `${request.system}\nReturn exactly one JSON value. No markdown or commentary.\n${request.schema ? `JSON schema: ${JSON.stringify(request.schema)}` : 'Use a JSON object.'}`;
      let body: unknown;
      if (config.kind === 'ollama') {
        body = {
          // Thinking-capable models (qwen3.5/3.6, gemma4) otherwise reason for minutes before the JSON answer and exceed MODEL_TIMEOUT_MS.
          model, stream: false, think: false, format: request.schema ?? 'json',
          options: { temperature: 0, num_predict: 8192, num_ctx: 16384 },
          messages: [{ role: 'system', content: system }, {
            role: 'user', content: request.prompt,
            ...(images.length ? { images: images.map(image => image.base64) } : {}),
          }],
        };
      } else {
        body = {
          model, stream: false, temperature: 0, max_tokens: 8192,
          response_format: request.schema ? { type: 'json_schema', json_schema: { name: 'harness_response', strict: true, schema: request.schema } } : { type: 'json_object' },
          messages: [{ role: 'system', content: system }, {
            role: 'user', content: images.length ? [
              { type: 'text', text: request.prompt },
              ...images.map(image => ({ type: 'image_url', image_url: { url: image.url } })),
            ] : request.prompt,
          }],
        };
      }
      const result = await requestJson(config, config.kind === 'ollama' ? 'chat' : 'chat/completions', body, request.signal, MODEL_TIMEOUT_MS);
      const message = config.kind === 'ollama' ? result.message : result.choices?.[0]?.message;
      // Tool proposals are data in the validated JSON contract; native tool calls never bypass the harness ACL.
      return parseModelOutput(message?.content, request.schema);
    },
  };
}

const COLORS = [
  ['red', [235, 30, 30]], ['blue', [25, 55, 240]], ['green', [20, 200, 40]],
  ['yellow', [245, 220, 10]], ['white', [250, 250, 250]],
] as const;

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type); const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([header, name, data, checksum]);
}
/** A fresh two-panel image: the textual prompt never reveals either panel's color. */
function probeImage(left: readonly number[], right: readonly number[]): string {
  const width = 256, height = 128;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = x < width / 2 ? left : right;
    const offset = y * (1 + width * 3) + 1 + x * 3;
    for (let c = 0; c < 3; c++) pixels[offset + c] = color[c];
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

export async function verifyModel(provider: ProviderConfig, model: string, signal?: AbortSignal): Promise<Verification> {
  validateModel(model);
  const requestSignal = signal ?? new AbortController().signal;
  const known = await listModels(provider, requestSignal);
  if (!known.some(m => m.id === model)) throw new Error('목록에서 확인된 설치 로컬 모델만 검증할 수 있습니다. 목록을 새로고침하세요.');
  const client = createModelClient(provider, model);
  const result: Verification = { model, vision: false, structured: false, toolCall: false, detail: '', checkedAt: new Date().toISOString() };
  const details: string[] = [];
  const probe = async (label: string, job: () => Promise<void>): Promise<boolean> => {
    try { requestSignal.throwIfAborted(); await job(); details.push(`${label}: 통과`); return true; }
    catch (error) {
      requestSignal.throwIfAborted();
      details.push(`${label}: 실패 (${error instanceof Error ? error.message : String(error)})`); return false;
    }
  };
  result.vision = await probe('이미지 실전 검사 2회', async () => {
    for (let round = 0; round < 2; round++) {
      const a = randomInt(COLORS.length); let b = randomInt(COLORS.length - 1); if (b >= a) b++;
      const output = await client.complete({ signal: requestSignal,
        system: 'You are a visual inspection assistant. Inspect the actual attached image.',
        prompt: 'The image has two equally sized vertical panels. What is the dominant color on the left and on the right? Use the English labels from the schema.',
        images: [probeImage(COLORS[a][1], COLORS[b][1])],
        schema: { type: 'object', properties: { left: { type: 'string', enum: COLORS.map(c => c[0]) }, right: { type: 'string', enum: COLORS.map(c => c[0]) } }, required: ['left', 'right'], additionalProperties: false },
      }) as JsonObject;
      if (output.left !== COLORS[a][0] || output.right !== COLORS[b][0]) throw new Error('실제 이미지의 좌우 색상 식별이 맞지 않습니다.');
    }
  });
  result.structured = await probe('구조화 JSON', async () => {
    const nonce = randomUUID();
    const output = await client.complete({ signal: requestSignal, system: 'Return structured data exactly as requested.',
      prompt: `Copy nonce ${nonce} exactly and calculate 19 + 23 as answer.`,
      schema: { type: 'object', properties: { nonce: { type: 'string' }, answer: { type: 'integer' } }, required: ['nonce', 'answer'], additionalProperties: false },
    }) as JsonObject;
    if (output.nonce !== nonce || output.answer !== 42) throw new Error('구조화 응답의 값이 요청과 다릅니다.');
  });
  result.toolCall = await probe('도구 선택 JSON 제안', async () => {
    const output = await client.complete({ signal: requestSignal,
      system: 'Choose a tool by returning a JSON proposal. Do not execute it. Available: webgl.compile validates shader code; video.extract_frames decodes an existing video into frame images.',
      prompt: 'Select the tool to extract frames at seconds 0 and 1 from probe.mp4. Use exactly that video basename and those times.',
      schema: { type: 'object', properties: {
        tool: { type: 'string', enum: ['webgl.compile', 'video.extract_frames'] },
        args: { type: 'object', properties: { video: { type: 'string' }, times: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }, required: ['video', 'times'], additionalProperties: false },
      }, required: ['tool', 'args'], additionalProperties: false },
    }) as JsonObject;
    if (output.tool !== 'video.extract_frames' || output.args.video !== 'probe.mp4' || JSON.stringify(output.args.times) !== '[0,1]') throw new Error('도구 선택 또는 인자가 일치하지 않습니다.');
  });
  result.detail = `${details.join(' · ')}. toolCall은 하네스가 검증하는 구조화 도구 제안 방식이며 native function calling 검증이 아닙니다. 비전 검사는 연결 확인용으로, 실제 작업 정확도를 보장하지 않습니다.`;
  result.checkedAt = new Date().toISOString();
  return result;
}
