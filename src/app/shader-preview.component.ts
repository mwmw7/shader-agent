import { AfterViewInit, Component, ElementRef, Input, NgZone, OnChanges, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { buildFragmentShader } from '../../server/shader';

@Component({
  selector: 'app-shader-preview',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="preview-wrap">
      <canvas #canvas width="640" height="360" aria-label="현재 GLSL 코드의 실시간 WebGL 미리보기"></canvas>
      <div *ngIf="error" class="shader-error" role="alert">{{ error }}</div>
      <div class="preview-controls">
        <span>{{ error ? '컴파일 오류' : '실시간 WebGL' }} · {{ seconds.toFixed(1) }}s</span>
        <button type="button" (click)="toggle()" [disabled]="!!error" [attr.aria-label]="paused ? '미리보기 재생' : '미리보기 일시 정지'">{{ paused ? '▶ 재생' : 'Ⅱ 일시 정지' }}</button>
        <button type="button" (click)="reset()" aria-label="미리보기 시간을 0초로 초기화">↺</button>
      </div>
    </div>`,
  styles: [`
    :host { display: block; }
    .preview-wrap { position: relative; overflow: hidden; background: #101b30; border-radius: 14px; }
    canvas { display: block; width: 100%; height: auto; aspect-ratio: 16/9; }
    .preview-controls { display: flex; gap: 9px; align-items: center; padding: 10px 12px; color: #d8e7ff; background: #15243a; font-size: 11px; }
    .preview-controls span { margin-right: auto; font-variant-numeric: tabular-nums; }
    button { border: 1px solid #45556d; background: transparent; border-radius: 6px; padding: 4px 8px; color: #ecf3ff; cursor: pointer; }
    button:focus-visible { outline: 2px solid #84b7ff; outline-offset: 2px; }
    button:disabled { opacity: .4; }
    .shader-error { position: absolute; inset: 0 0 43px; padding: 15px; color: #ffe4dc; background: #241c2fe8; font: 12px/1.6 monospace; overflow: auto; white-space: pre-wrap; }
  `],
})
export class ShaderPreviewComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() code = '';
  @ViewChild('canvas', { static: true }) canvas!: ElementRef<HTMLCanvasElement>;
  error = '';
  paused = false;
  seconds = 0;
  private gl: WebGLRenderingContext | null = null;
  private program?: WebGLProgram;
  private buffer?: WebGLBuffer;
  private frame = 0;
  private previous = 0;
  private lastLabel = 0;
  private elapsed = 0;
  private timeLocation: WebGLUniformLocation | null = null;
  private resolutionLocation: WebGLUniformLocation | null = null;

  constructor(private zone: NgZone) {}

  ngAfterViewInit() {
    this.gl = this.canvas.nativeElement.getContext('webgl', { alpha: false, preserveDrawingBuffer: true });
    if (!this.gl) { this.error = 'WebGL을 사용할 수 없습니다. GPU 또는 브라우저 설정을 확인하세요.'; return; }
    this.compile();
    this.zone.runOutsideAngular(() => { this.frame = requestAnimationFrame(this.draw); });
  }
  ngOnChanges() { if (this.gl) this.compile(); }
  ngOnDestroy() {
    cancelAnimationFrame(this.frame);
    if (this.program) this.gl?.deleteProgram(this.program);
    if (this.buffer) this.gl?.deleteBuffer(this.buffer);
  }
  toggle() { this.paused = !this.paused; }
  reset() { this.elapsed = 0; this.seconds = 0; }
  private compile() {
    const gl = this.gl!;
    this.error = '';
    if (!this.code) return;
    const shaders: WebGLShader[] = [];
    let program: WebGLProgram | null = null;
    try {
      // Use the same conservative subset gate as the backend before any GPU compilation.
      const fragmentSource = buildFragmentShader(this.code);
      const make = (type: number, source: string) => {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('셰이더를 만들 수 없습니다.');
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || '셰이더 컴파일 실패');
        return shader;
      };
      const vertex = make(gl.VERTEX_SHADER, 'attribute vec2 position; void main(){ gl_Position=vec4(position,0.0,1.0); }');
      const fragment = make(gl.FRAGMENT_SHADER, fragmentSource);
      program = gl.createProgram();
      if (!program) throw new Error('WebGL 프로그램을 만들 수 없습니다.');
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || '셰이더 연결 실패');
      if (this.program) gl.deleteProgram(this.program);
      this.program = program;
      gl.useProgram(program);
      if (!this.buffer) this.buffer = gl.createBuffer() || undefined;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer!);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const attribute = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
      this.timeLocation = gl.getUniformLocation(program, 'u_time');
      this.resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
      this.reset();
    } catch (error) {
      if (program && program !== this.program) gl.deleteProgram(program);
      this.error = error instanceof Error ? error.message : String(error);
    } finally { shaders.forEach(shader => gl.deleteShader(shader)); }
  }
  private draw = (now: number) => {
    if (!this.paused && this.previous) this.elapsed += Math.min((now - this.previous) / 1000, .1);
    this.previous = now;
    const gl = this.gl;
    if (gl && this.program && !this.error) {
      gl.viewport(0, 0, 640, 360); gl.useProgram(this.program);
      gl.uniform2f(this.resolutionLocation, 640, 360); gl.uniform1f(this.timeLocation, this.elapsed);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    if (now - this.lastLabel > 200) {
      this.zone.run(() => { this.seconds = this.elapsed; });
      this.lastLabel = now;
    }
    this.frame = requestAnimationFrame(this.draw);
  };
}
