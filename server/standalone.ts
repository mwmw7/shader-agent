import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './api.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = await startServer({ dataDir: process.env.HARNESS_DATA_DIR ?? path.join(root, '.harness-data'), port: Number(process.env.HARNESS_PORT ?? 4317), uiDir: path.join(root, 'dist-ui/browser') });
console.log(`Shader Harness: ${server.url}\n종료: Ctrl+C. API 키는 이 브라우저 실행 모드에서 메모리에만 보관됩니다.`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void server.close().finally(() => process.exit(0)); });
