import { validateShaderSource } from './shader.js';

const HEADER = 'uniform float2 u_resolution;\nuniform float u_time;\n';
const FOOTER = '\nhalf4 main(float2 p) {\n  vec4 c = effect(vec2(p.x, u_resolution.y - p.y));\n  return half4(c.rgb * c.a, c.a);\n}\n';

/** Source coordinates are bottom-left; RuntimeShader coordinates are top-left.
 * AGSL accepts vec types. Premultiply only at the host entry point.
 * Android RuntimeShader compilation still must be performed on a device/emulator.
 */
export function convertToAgsl(code: string): { code: string; androidVerified: false } {
  validateShaderSource(code);
  return { code: HEADER + code.trim() + FOOTER, androidVerified: false };
}

export function validateAgslSource(code: string): void {
  if (!code.startsWith(HEADER) || !code.endsWith(FOOTER)) throw new Error('AGSL must use the supported converter uniforms, coordinate mapping and premultiplied output wrapper.');
  validateShaderSource(code.slice(HEADER.length, -FOOTER.length));
}
