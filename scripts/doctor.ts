import { access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
let failed = false;
function report(name: string, ok: boolean, message: string) { console.log(`${ok ? '✓' : '✗'} ${name}: ${message}`); failed ||= !ok; }
const major = Number(process.versions.node.split('.')[0]);
report('Node.js', major >= 22, process.version);
const ffmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10_000 });
report('FFmpeg', ffmpeg.status === 0, ffmpeg.status === 0 ? ffmpeg.stdout.split('\n')[0] : '설치 후 PATH 또는 FFMPEG_PATH를 지정하세요. macOS: brew install ffmpeg');
const executable = process.env.CHROMIUM_PATH || chromium.executablePath();
try { await access(executable); report('Chromium 파일', true, executable); }
catch { report('Chromium 파일', false, 'npm run setup:renderer 로 설치하세요.'); }
try {
  const browser = await chromium.launch({ executablePath: executable, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], timeout: 20_000 });
  try {
    const page = await browser.newPage();
    const webgl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl'));
    report('실제 WebGL 컨텍스트', webgl, webgl ? '사용 가능' : 'GPU/소프트웨어 렌더러를 확인하세요.');
  } finally { await browser.close(); }
} catch (error: any) { report('Chromium 실행', false, error.message.split('\n')[0]); }
console.log('로컬 모델은 앱 설정에서 목록 조회 → 비전·JSON·도구 선택 검증을 실행하세요.');
process.exitCode = failed ? 1 : 0;
