/** Original MIT-licensed teaching shader. No images, textures or remote assets. */
export const DEFAULT_GLSL = `float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float cloud(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float rain(vec2 uv, float scale, float speed) {
  vec2 p = vec2(uv.x + uv.y * 0.10, uv.y) * vec2(scale, 5.0);
  p.y += u_time * speed;
  vec2 cell = floor(p);
  vec2 f = fract(p);
  float seed = hash21(cell);
  float line = 1.0 - smoothstep(0.015, 0.055, abs(f.x - 0.5));
  float tail = smoothstep(0.0, 0.65, f.y) * (1.0 - smoothstep(0.80, 1.0, f.y));
  return line * tail * step(0.35, seed);
}

vec4 effect(vec2 fragCoord) {
  vec2 uv = fragCoord / u_resolution;
  float aspect = u_resolution.x / u_resolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec3 sky = mix(vec3(0.18, 0.28, 0.37), vec3(0.045, 0.08, 0.15), uv.y);
  float mist = cloud(p * 3.0 + vec2(u_time * 0.025, 0.0));
  mist = 0.6 * mist + 0.4 * cloud(p * 7.0 + vec2(u_time * 0.04, 1.0));
  sky += vec3(0.12, 0.14, 0.17) * mist * smoothstep(0.30, 0.90, uv.y);
  float horizon = 0.12 + 0.04 * sin(uv.x * 16.0) + 0.02 * sin(uv.x * 37.0);
  sky = mix(vec3(0.025, 0.05, 0.075), sky, smoothstep(horizon, horizon + 0.03, uv.y));
  float streaks = rain(p, 70.0, 5.0) * 0.28 + rain(p + vec2(0.32, 0.6), 38.0, 3.0) * 0.22;
  sky += vec3(0.62, 0.77, 0.90) * streaks;
  float vignette = 1.0 - 0.25 * length((uv - 0.5) * vec2(1.0, 0.65));
  return vec4(clamp(sky * vignette, 0.0, 1.0), 1.0);
}`;

export const SIMPLE_GLSL = `vec4 effect(vec2 fragCoord) {
  vec2 uv = fragCoord / u_resolution;
  vec3 sky = mix(vec3(0.28, 0.55, 0.76), vec3(0.08, 0.20, 0.38), uv.y);
  float glow = 1.0 - smoothstep(0.02, 0.20, length(uv - vec2(0.75, 0.75)));
  sky += vec3(0.7, 0.52, 0.23) * glow;
  return vec4(clamp(sky, 0.0, 1.0), 1.0);
}`;

const TYPES = new Set(['float', 'vec2', 'vec3', 'vec4', 'bool']);
const BUILTINS = new Set([
  'abs', 'acos', 'asin', 'atan', 'ceil', 'clamp', 'cos', 'cross', 'degrees',
  'distance', 'dot', 'exp', 'exp2', 'floor', 'fract', 'inversesqrt', 'length',
  'log', 'log2', 'max', 'min', 'mix', 'mod', 'normalize', 'pow', 'radians',
  'reflect', 'refract', 'sign', 'sin', 'smoothstep', 'sqrt', 'step', 'tan',
]);
const FORBIDDEN = /\b(?:for|while|do|discard|main|uniform|varying|attribute|precision|highp|mediump|lowp|struct|switch|case|break|continue|inout|out|in|void|int|uint|mat[234]|sampler\w*|texture\w*|dFdx|dFdy|fwidth)\b/g;

function tokensOf(code: string): string[] {
  // Scan comments left-to-right. Sequential global replacements can mistakenly
  // hide executable code when a line comment contains a block-comment opener.
  const clean = code.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  if (clean.includes('/*') || clean.includes('*/')) throw new Error('Unclosed or invalid comment.');
  // Name every rejected construct: the generate agent repairs from this text, and a generic message leaves it guessing.
  const forbidden = [...new Set(clean.match(FORBIDDEN) ?? [])];
  if (forbidden.length) {
    throw new Error(`Unsupported GLSL keywords: ${forbidden.join(', ')}. Loops, int, uniforms, precision qualifiers and a custom entry point are not allowed. ` +
      'Do not write main(); define vec4 effect(vec2 fragCoord) and return the color. The host declares u_resolution and u_time.');
  }
  const builtins = [...new Set(clean.match(/\b(?:gl_|sk_)\w*/g) ?? [])];
  if (builtins.length) throw new Error(`Built-in identifiers are not allowed: ${builtins.join(', ')}. Return the color from vec4 effect(vec2 fragCoord) instead of writing gl_FragColor.`);
  const tokens: string[] = [];
  const lexer = /\s+|[A-Za-z_]\w*|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?|==|!=|<=|>=|&&|\|\||\+=|-=|\*=|\/=|[{}(),;.+\-*\/<>=!?:]/y;
  let at = 0;
  while (at < clean.length) {
    lexer.lastIndex = at;
    const token = lexer.exec(clean);
    if (!token) throw new Error(`Unsupported GLSL token at character ${at}; arrays, directives and bitwise operators are not supported.`);
    if (!/^\s+$/.test(token[0])) tokens.push(token[0]);
    at = lexer.lastIndex;
  }
  if (tokens.length > 6000) throw new Error('Shader token budget exceeded.');
  return tokens;
}

/** A conservative portable subset, not a general GLSL parser or arbitrary GLSL-to-AGSL compiler. */
export function validateShaderSource(code: string): void {
  if (typeof code !== 'string' || code.length < 10 || code.length > 20000) throw new Error('Shader must contain 10–20,000 characters.');
  const tokens = tokensOf(code);
  const functions = new Map<string, { type: string; args: string[]; body: string[] }>();
  let i = 0;
  while (i < tokens.length) {
    const type = tokens[i++];
    const name = tokens[i++];
    if (!TYPES.has(type) || !/^[A-Za-z_]\w*$/.test(name ?? '') || TYPES.has(name) || BUILTINS.has(name) || name.startsWith('u_')) throw new Error('Only float/vec/bool function definitions are supported at file scope.');
    if (functions.has(name)) throw new Error('Function overloading and duplicate definitions are not supported.');
    if (tokens[i++] !== '(') throw new Error('Global variables are not supported.');
    const args: string[] = [];
    while (tokens[i] !== ')') {
      const argType = tokens[i++];
      const argName = tokens[i++];
      if (!TYPES.has(argType) || !/^[A-Za-z_]\w*$/.test(argName ?? '')) throw new Error('Unsupported function parameter.');
      args.push(argType);
      if (tokens[i] !== ',') break;
      i++;
    }
    if (tokens[i++] !== ')' || tokens[i++] !== '{') throw new Error('Malformed function definition.');
    let depth = 1;
    const body: string[] = [];
    while (i < tokens.length && depth > 0) {
      const token = tokens[i++];
      if (token === '{') depth++;
      if (token === '}') depth--;
      if (depth > 0) body.push(token);
    }
    if (depth) throw new Error('Unbalanced function braces.');
    if (!body.includes('return')) throw new Error('Every helper must return a value.');
    functions.set(name, { type, args, body });
    if (functions.size > 16) throw new Error('At most 16 functions are supported.');
  }
  const effect = functions.get('effect');
  if (!effect || effect.type !== 'vec4' || effect.args.join(',') !== 'vec2') throw new Error('Required entry point: vec4 effect(vec2 fragCoord).');
  const graph = new Map<string, string[]>();
  for (const [name, fn] of functions) {
    const calls: string[] = [];
    for (let n = 0; n < fn.body.length; n++) {
      const token = fn.body[n];
      if ((token === 'u_time' || token === 'u_resolution') && /^(?:=|\+=|-=|\*=|\/=)$/.test(fn.body[n + 1] ?? '')) throw new Error('Host uniforms are read-only.');
      if (fn.body[n + 1] === '(' && /^[A-Za-z_]/.test(token)) {
        if (functions.has(token)) calls.push(token);
        else if (!TYPES.has(token) && !BUILTINS.has(token) && token !== 'if') throw new Error(`Unsupported function: ${token}`);
      }
    }
    graph.set(name, calls);
  }
  // Recursion plus branching can consume unbounded GPU work even without loops.
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(name: string): void {
    if (visiting.has(name)) throw new Error('Recursive shader functions are not supported.');
    if (done.has(name)) return;
    visiting.add(name);
    for (const child of graph.get(name) ?? []) visit(child);
    visiting.delete(name);
    done.add(name);
  }
  for (const name of functions.keys()) visit(name);
  const costs = new Map<string, number>();
  function cost(name: string): number {
    if (costs.has(name)) return costs.get(name)!;
    const value = functions.get(name)!.body.length + (graph.get(name) ?? []).reduce((sum, child) => sum + cost(child), 0);
    if (value > 12000) throw new Error('Expanded shader expression budget exceeded.');
    costs.set(name, value);
    return value;
  }
  for (const name of functions.keys()) cost(name);
}

const HOST_HEADER = 'precision highp float;\nuniform vec2 u_resolution;\nuniform float u_time;\n';
const HOST_HEADER_LINES = HOST_HEADER.split('\n').length - 1;

export function buildFragmentShader(code: string): string {
  validateShaderSource(code);
  return `${HOST_HEADER}${code}\nvoid main() { gl_FragColor = effect(gl_FragCoord.xy); }`;
}

/** Shift compiler line numbers so they refer to the agent's source, not the host-wrapped program. */
export function relocateCompileLog(log: string): string {
  return log.replace(/\b0:(\d+):/g, (match, line: string) => {
    const relocated = Number(line) - HOST_HEADER_LINES;
    return relocated >= 1 ? `0:${relocated}:` : match;
  });
}
