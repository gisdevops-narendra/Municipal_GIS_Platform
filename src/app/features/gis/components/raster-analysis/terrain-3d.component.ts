import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, ViewChild, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface TerrainMesh {
  width: number;
  height: number;
  cellX: number;
  cellY: number;
  bbox: [number, number, number, number];
  z: (number | null)[];
  min: number;
  max: number;
}

/** Hypsometric tint, low → high (same as the backend "elevation" ramp). */
const RAMP: [number, number, number][] = [
  [11, 110, 79], [79, 157, 74], [167, 201, 87], [242, 232, 160], [212, 163, 115], [156, 102, 68], [127, 85, 57], [236, 231, 226]
];
export const TERRAIN_RAMP_CSS = `linear-gradient(90deg, ${RAMP.map((c) => `rgb(${c.join(',')})`).join(', ')})`;

const VERTEX_SHADER = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUv;
in float aWall;
uniform mat4 uMvp;
out vec3 vNormal;
out vec2 vUv;
out float vWall;
out float vZ;
void main() {
  vNormal = aNormal;
  vUv = aUv;
  vWall = aWall;
  vZ = aPos.z;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
in float vWall;
in float vZ;
uniform sampler2D uRamp;
uniform sampler2D uDrape;
uniform float uDrapeOn;
uniform vec3 uSun;
uniform float uBaseZ;
uniform float uTopZ;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  float diffuse = max(dot(n, uSun), 0.0);
  if (vWall > 0.5) {
    // Earth cross-section on the sides of the block.
    float t = clamp((vZ - uBaseZ) / max(uTopZ - uBaseZ, 1e-6), 0.0, 1.0);
    vec3 soil = mix(vec3(0.30, 0.22, 0.16), vec3(0.55, 0.43, 0.31), t);
    outColor = vec4(soil * (0.55 + 0.45 * abs(dot(n, uSun))), 1.0);
    return;
  }
  vec3 base = texture(uRamp, vUv).rgb;
  vec4 drape = texture(uDrape, vUv);
  vec3 color = mix(base, drape.rgb, drape.a * uDrapeOn);
  // Hillshade-style light: ambient sky + directional sun.
  float sky = 0.5 + 0.5 * n.z;
  float light = 0.28 + 0.22 * sky + 0.72 * diffuse;
  outColor = vec4(min(color * light, vec3(1.0)), 1.0);
}`;

/**
 * 3D Terrain View — a DEM rendered with WebGL as a smooth, lit block model:
 * per-pixel hillshade lighting, an elevation tint, an optional draped layer
 * (full-resolution WMS image as a texture) and earth-coloured side walls.
 * Drag to orbit, Shift/right-drag to pan, wheel to zoom.
 */
@Component({
  selector: 'app-terrain-3d',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="t3d" role="dialog" aria-label="3D terrain view">
      <header class="t3d__head">
        <span class="t3d__title" [title]="title">{{ title }}</span>
        <label class="t3d__ctl">
          <span>Exaggeration × {{ exaggeration }}</span>
          <input type="range" min="1" max="10" step="0.5" [(ngModel)]="exaggeration" (input)="rebuild()" />
        </label>
        <label class="t3d__ctl">
          <span>Sun</span>
          <input type="range" min="0" max="360" step="5" [(ngModel)]="sunAzimuth" (input)="requestDraw()" title="Light direction" />
        </label>
        @if (drapeUrl) {
          <label class="t3d__ctl t3d__check">
            <input type="checkbox" [(ngModel)]="showDrape" (change)="requestDraw()" />
            <span>Drape</span>
          </label>
        }
        <button type="button" class="t3d__btn" (click)="reset()" title="Reset view"><i class="pi pi-refresh"></i></button>
        <button type="button" class="t3d__btn" (click)="savePng()" title="Save as PNG"><i class="pi pi-image"></i></button>
        <button type="button" class="t3d__btn" (click)="closed.emit()" title="Close"><i class="pi pi-times"></i></button>
      </header>
      <div class="t3d__stage">
        <canvas
          #canvas
          class="t3d__canvas"
          (pointerdown)="onDown($event)"
          (pointermove)="onMove($event)"
          (pointerup)="onUp($event)"
          (pointercancel)="onUp($event)"
          (wheel)="onWheel($event)"
          (contextmenu)="$event.preventDefault()"
        ></canvas>
        @if (error()) {
          <p class="t3d__error">{{ error() }}</p>
        }
        <div class="t3d__compass" title="North" [style.transform]="'rotate(' + azimuth() + 'deg)'">
          <span class="t3d__north">N</span>
          <span class="t3d__needle"></span>
        </div>
        @if (mesh) {
          <div class="t3d__legend">
            <span class="t3d__legend-title">Elevation (m)</span>
            <span class="t3d__legend-bar" [style.background]="rampCss"></span>
            <span class="t3d__legend-range"><span>{{ mesh.min.toFixed(0) }}</span><span>{{ mesh.max.toFixed(0) }}</span></span>
          </div>
        }
      </div>
      <p class="t3d__hint">
        Drag to rotate · Shift + drag or right-drag to pan · scroll to zoom
        @if (mesh) {
          · {{ mesh.width }} × {{ mesh.height }} cells · {{ (spanKm()).toFixed(1) }} km across
        }
      </p>
    </div>
  `,
  styles: [
    `
      .t3d { position: fixed; inset: 5vh 5vw; z-index: 2000; display: flex; flex-direction: column;
        border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface);
        box-shadow: 0 20px 60px rgb(0 0 0 / 45%); overflow: hidden; }
      .t3d__head { display: flex; align-items: center; gap: 14px; padding: 8px 12px; border-bottom: 1px solid var(--color-line);
        background: var(--color-surface-alt); flex-wrap: wrap; }
      .t3d__title { flex: 1; min-width: 120px; font-weight: 600; font-size: 13px; color: var(--color-ink-900);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .t3d__ctl { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--color-ink-500); white-space: nowrap; }
      .t3d__ctl input[type='range'] { width: 110px; }
      .t3d__check { cursor: pointer; }
      .t3d__btn { width: 30px; height: 30px; border: none; border-radius: var(--radius-sm); background: transparent;
        color: var(--color-ink-500); cursor: pointer; }
      .t3d__btn:hover { background: var(--color-surface); color: var(--color-ink-900); }
      .t3d__stage { position: relative; flex: 1; min-height: 0; }
      .t3d__canvas { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none;
        background: radial-gradient(ellipse at 50% 0%, #e8f1fa 0%, #c3d8ec 55%, #9fb9d3 100%); }
      .t3d__canvas:active { cursor: grabbing; }
      .t3d__error { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; padding: 24px;
        text-align: center; color: var(--color-ink-700); }
      .t3d__compass { position: absolute; top: 14px; left: 14px; width: 44px; height: 44px; border-radius: 50%;
        background: rgb(255 255 255 / 85%); box-shadow: 0 2px 8px rgb(0 0 0 / 20%); pointer-events: none; }
      .t3d__north { position: absolute; top: 2px; left: 0; right: 0; text-align: center; font: 700 11px/1 system-ui, sans-serif; color: #b91c1c; }
      .t3d__needle { position: absolute; left: 50%; top: 15px; width: 0; height: 0; transform: translateX(-50%);
        border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 18px solid #b91c1c; }
      .t3d__needle::after { content: ''; position: absolute; left: -6px; top: 18px; border-left: 6px solid transparent;
        border-right: 6px solid transparent; border-top: 10px solid #475569; }
      .t3d__legend { position: absolute; left: 14px; bottom: 14px; display: grid; gap: 4px; width: 190px; padding: 8px 10px;
        border-radius: 6px; background: rgb(255 255 255 / 88%); box-shadow: 0 2px 8px rgb(0 0 0 / 18%);
        font: 11px/1.2 system-ui, sans-serif; color: #1f2937; pointer-events: none; }
      .t3d__legend-title { font-weight: 600; }
      .t3d__legend-bar { height: 10px; border-radius: 3px; }
      .t3d__legend-range { display: flex; justify-content: space-between; }
      .t3d__hint { margin: 0; padding: 6px 12px; font-size: 11px; color: var(--color-ink-500); }
    `
  ]
})
export class Terrain3dComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() mesh: TerrainMesh | null = null;
  /** CORS-readable image covering `mesh.bbox` (EPSG:4326) to drape. */
  @Input() drapeUrl: string | null = null;
  @Input() title = '3D terrain';
  @Output() closed = new EventEmitter<void>();

  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly rampCss = TERRAIN_RAMP_CSS;
  readonly error = signal<string | null>(null);
  readonly azimuth = signal(-30);
  readonly spanKm = signal(0);
  exaggeration = 2;
  sunAzimuth = 315;
  showDrape = true;

  private pitch = 38;
  private zoom = 1;
  private target: [number, number, number] = [0, 0, 0];
  private drag: { x: number; y: number; pan: boolean } | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buffers: WebGLBuffer[] = [];
  private indexCount = 0;
  private rampTexture: WebGLTexture | null = null;
  private drapeTexture: WebGLTexture | null = null;
  private hasDrape = false;
  private zRange: [number, number] = [0, 1];
  private frame = 0;
  private readonly resize = new ResizeObserver(() => this.requestDraw());

  ngAfterViewInit(): void {
    this.initGl();
    this.resize.observe(this.canvasRef.nativeElement);
    this.load();
  }

  ngOnChanges(): void {
    if (this.gl) this.load();
  }

  ngOnDestroy(): void {
    this.resize.disconnect();
    cancelAnimationFrame(this.frame);
    const gl = this.gl;
    if (!gl) return;
    this.buffers.forEach((b) => gl.deleteBuffer(b));
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.rampTexture) gl.deleteTexture(this.rampTexture);
    if (this.drapeTexture) gl.deleteTexture(this.drapeTexture);
    if (this.program) gl.deleteProgram(this.program);
  }

  reset(): void {
    this.azimuth.set(-30);
    this.pitch = 38;
    this.zoom = 1;
    this.target = [0, 0, 0];
    this.requestDraw();
  }

  savePng(): void {
    this.draw();
    const a = document.createElement('a');
    a.href = this.canvasRef.nativeElement.toDataURL('image/png');
    a.download = `${this.title.replace(/[^\w-]+/g, '_')}_3d.png`;
    a.click();
  }

  onDown(e: PointerEvent): void {
    this.drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 };
    this.canvasRef.nativeElement.setPointerCapture(e.pointerId);
  }

  onMove(e: PointerEvent): void {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    if (this.drag.pan) {
      // Move the look-at point along the ground, in screen directions.
      const az = (this.azimuth() * Math.PI) / 180;
      const k = 1.4 / this.zoom / Math.max(this.canvasRef.nativeElement.clientHeight, 1);
      const right: [number, number] = [Math.cos(az), Math.sin(az)];
      const forward: [number, number] = [-Math.sin(az), Math.cos(az)];
      this.target[0] -= (dx * right[0] - dy * forward[0]) * k;
      this.target[1] -= (dx * right[1] - dy * forward[1]) * k;
    } else {
      this.azimuth.update((a) => a + dx * 0.4);
      this.pitch = Math.min(89, Math.max(5, this.pitch + dy * 0.3));
    }
    this.requestDraw();
  }

  onUp(e: PointerEvent): void {
    this.drag = null;
    this.canvasRef.nativeElement.releasePointerCapture?.(e.pointerId);
  }

  onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.zoom = Math.min(12, Math.max(0.4, this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    this.requestDraw();
  }

  /** Geometry depends on the exaggeration (normals too): rebuild it. */
  rebuild(): void {
    this.buildGeometry();
    this.requestDraw();
  }

  requestDraw(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }

  // ----- setup -----

  private initGl(): void {
    const gl = this.canvasRef.nativeElement.getContext('webgl2', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) {
      this.error.set('3D view needs WebGL 2, which this browser or device does not provide.');
      return;
    }
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
      return shader;
    };
    try {
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
      this.program = program;
      this.gl = gl;
    } catch (e) {
      this.error.set(`3D view could not start: ${(e as Error).message}`);
    }
  }

  private load(): void {
    const m = this.mesh;
    if (!m || !this.gl) return;
    const sizeX = (m.width - 1) * m.cellX;
    const sizeY = (m.height - 1) * m.cellY;
    this.spanKm.set(Math.max(sizeX, sizeY) / 1000);
    this.buildRampTexture();
    this.buildGeometry();
    this.loadDrape();
    this.requestDraw();
  }

  /** Elevation tint as a texture at mesh resolution — filtered smoothly. */
  private buildRampTexture(): void {
    const gl = this.gl!;
    const m = this.mesh!;
    const data = new Uint8Array(m.width * m.height * 4);
    const range = m.max - m.min || 1;
    m.z.forEach((z, i) => {
      const t = Math.min(Math.max(((z ?? m.min) - m.min) / range, 0), 1) * (RAMP.length - 1);
      const k = Math.min(Math.floor(t), RAMP.length - 2);
      const f = t - k;
      for (let ch = 0; ch < 3; ch++) data[i * 4 + ch] = Math.round(RAMP[k][ch] + (RAMP[k + 1][ch] - RAMP[k][ch]) * f);
      data[i * 4 + 3] = 255;
    });
    if (this.rampTexture) gl.deleteTexture(this.rampTexture);
    this.rampTexture = this.texture(m.width, m.height, data);
  }

  private loadDrape(): void {
    const gl = this.gl!;
    this.hasDrape = false;
    if (this.drapeTexture) gl.deleteTexture(this.drapeTexture);
    this.drapeTexture = this.texture(1, 1, new Uint8Array([0, 0, 0, 0]));
    if (!this.drapeUrl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!this.gl) return;
      try {
        gl.bindTexture(gl.TEXTURE_2D, this.drapeTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        this.hasDrape = true;
        this.requestDraw();
      } catch {
        // Not CORS-readable: keep the elevation tint.
      }
    };
    img.src = this.drapeUrl;
  }

  private texture(width: number, height: number, data: Uint8Array): WebGLTexture {
    const gl = this.gl!;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Surface + side walls, in units where the longer side spans 1. */
  private buildGeometry(): void {
    const gl = this.gl;
    const m = this.mesh;
    if (!gl || !m || !this.program) return;
    const { width: nx, height: ny, cellX, cellY } = m;
    const sizeX = (nx - 1) * cellX;
    const sizeY = (ny - 1) * cellY;
    const span = Math.max(sizeX, sizeY) || 1;
    const mid = (m.min + m.max) / 2;
    const zScale = this.exaggeration / span;
    const valid = (r: number, c: number) => r >= 0 && c >= 0 && r < ny && c < nx && m.z[r * nx + c] !== null;
    const zAt = (r: number, c: number) => ((m.z[r * nx + c] ?? m.min) - mid) * zScale;
    const xAt = (c: number) => (c * cellX - sizeX / 2) / span;
    const yAt = (r: number) => (sizeY / 2 - r * cellY) / span;
    const baseZ = (m.min - mid) * zScale - Math.max((m.max - m.min) * zScale * 0.15, 0.02);
    this.zRange = [baseZ, (m.max - mid) * zScale];

    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const wall: number[] = [];
    const idx: number[] = [];

    // Surface vertices: smooth normals from central differences.
    for (let r = 0; r < ny; r++) {
      for (let c = 0; c < nx; c++) {
        const z = zAt(r, c);
        const zl = valid(r, c - 1) ? zAt(r, c - 1) : z;
        const zr = valid(r, c + 1) ? zAt(r, c + 1) : z;
        const zu = valid(r - 1, c) ? zAt(r - 1, c) : z;
        const zd = valid(r + 1, c) ? zAt(r + 1, c) : z;
        const dx = (zr - zl) / ((valid(r, c - 1) && valid(r, c + 1) ? 2 : 1) * (cellX / span));
        const dy = (zu - zd) / ((valid(r - 1, c) && valid(r + 1, c) ? 2 : 1) * (cellY / span));
        const len = Math.hypot(dx, dy, 1);
        pos.push(xAt(c), yAt(r), z);
        nor.push(-dx / len, -dy / len, 1 / len);
        uv.push(c / (nx - 1), r / (ny - 1));
        wall.push(0);
      }
    }
    const quadOk = (r: number, c: number) =>
      r >= 0 && c >= 0 && r < ny - 1 && c < nx - 1 && valid(r, c) && valid(r, c + 1) && valid(r + 1, c) && valid(r + 1, c + 1);
    for (let r = 0; r < ny - 1; r++) {
      for (let c = 0; c < nx - 1; c++) {
        if (!quadOk(r, c)) continue;
        const i = r * nx + c;
        idx.push(i, i + nx, i + 1, i + 1, i + nx, i + nx + 1);
      }
    }

    // Side walls wherever a surface quad has no neighbour (grid edge or
    // the clipped boundary) — the terrain reads as a solid block.
    const addWall = (r0: number, c0: number, r1: number, c1: number, nX: number, nY: number) => {
      const start = pos.length / 3;
      for (const [r, c, bottom] of [[r0, c0, false], [r1, c1, false], [r0, c0, true], [r1, c1, true]] as [number, number, boolean][]) {
        pos.push(xAt(c), yAt(r), bottom ? baseZ : zAt(r, c));
        nor.push(nX, nY, 0);
        uv.push(c / (nx - 1), r / (ny - 1));
        wall.push(1);
      }
      idx.push(start, start + 2, start + 1, start + 1, start + 2, start + 3);
    };
    for (let r = 0; r < ny - 1; r++) {
      for (let c = 0; c < nx - 1; c++) {
        if (!quadOk(r, c)) continue;
        if (!quadOk(r - 1, c)) addWall(r, c + 1, r, c, 0, 1); // north
        if (!quadOk(r + 1, c)) addWall(r + 1, c, r + 1, c + 1, 0, -1); // south
        if (!quadOk(r, c - 1)) addWall(r, c, r + 1, c, -1, 0); // west
        if (!quadOk(r, c + 1)) addWall(r + 1, c + 1, r, c + 1, 1, 0); // east
      }
    }

    this.buffers.forEach((b) => gl.deleteBuffer(b));
    this.buffers = [];
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const attribute = (name: string, data: number[], size: number) => {
      const buffer = gl.createBuffer()!;
      this.buffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.program!, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    attribute('aPos', pos, 3);
    attribute('aNormal', nor, 3);
    attribute('aUv', uv, 2);
    attribute('aWall', wall, 1);
    const indexBuffer = gl.createBuffer()!;
    this.buffers.push(indexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(idx), gl.STATIC_DRAW);
    this.indexCount = idx.length;
    gl.bindVertexArray(null);
  }

  // ----- render -----

  private draw(): void {
    const gl = this.gl;
    const canvas = this.canvasRef?.nativeElement;
    if (!gl || !canvas || !this.program || !this.vao || !this.mesh) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const H = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // Orbit camera around the target, z up.
    const az = (this.azimuth() * Math.PI) / 180;
    const el = (this.pitch * Math.PI) / 180;
    const dist = 1.9 / this.zoom;
    const [tx, ty, tz] = this.target;
    const eye: [number, number, number] = [
      tx + dist * Math.cos(el) * Math.sin(az),
      ty - dist * Math.cos(el) * Math.cos(az),
      tz + dist * Math.sin(el)
    ];
    const view = lookAt(eye, this.target, [0, 0, 1]);
    const proj = perspective((35 * Math.PI) / 180, W / H, 0.01, 50);
    const mvp = multiply(proj, view);

    const sunAz = (this.sunAzimuth * Math.PI) / 180;
    const sunEl = (45 * Math.PI) / 180;
    const sun = [Math.sin(sunAz) * Math.cos(sunEl), Math.cos(sunAz) * Math.cos(sunEl), Math.sin(sunEl)];

    gl.useProgram(this.program);
    const u = (name: string) => gl.getUniformLocation(this.program!, name);
    gl.uniformMatrix4fv(u('uMvp'), false, mvp);
    gl.uniform3fv(u('uSun'), sun);
    gl.uniform1f(u('uBaseZ'), this.zRange[0]);
    gl.uniform1f(u('uTopZ'), this.zRange[1]);
    gl.uniform1f(u('uDrapeOn'), this.hasDrape && this.showDrape ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    gl.uniform1i(u('uRamp'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.drapeTexture);
    gl.uniform1i(u('uDrape'), 1);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }
}

// ----- column-major 4×4 matrices -----

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

function lookAt(eye: number[], center: number[], up: number[]): Float32Array {
  const z = normalize([eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]]);
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1
  ]);
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (v: number[]) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
