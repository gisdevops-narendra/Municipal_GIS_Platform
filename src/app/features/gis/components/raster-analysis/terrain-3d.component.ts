import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, ViewChild } from '@angular/core';
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

/** Elevation colours, low → high (used when no drape layer is chosen). */
const RAMP: [number, number, number][] = [
  [26, 152, 80], [145, 207, 96], [217, 239, 139], [254, 224, 139], [252, 141, 89], [215, 48, 39], [245, 245, 245]
];

/**
 * 3D Terrain View — a DEM rendered as a lit, rotatable surface on a 2D
 * canvas (painter's algorithm; no WebGL / 3D library needed). Optionally
 * draped with another layer's colours via a CORS WMS GetMap image.
 * Drag to rotate / tilt, wheel to zoom.
 */
@Component({
  selector: 'app-terrain-3d',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="t3d" role="dialog" aria-label="3D terrain view">
      <header class="t3d__head">
        <span class="t3d__title">{{ title }}</span>
        <label class="t3d__ctl">
          Vertical exaggeration × {{ exaggeration }}
          <input type="range" min="1" max="10" step="0.5" [(ngModel)]="exaggeration" (input)="draw()" />
        </label>
        <button type="button" class="t3d__btn" (click)="reset()" title="Reset view"><i class="pi pi-refresh"></i></button>
        <button type="button" class="t3d__btn" (click)="savePng()" title="Save as PNG"><i class="pi pi-image"></i></button>
        <button type="button" class="t3d__btn" (click)="closed.emit()" title="Close"><i class="pi pi-times"></i></button>
      </header>
      <canvas
        #canvas
        class="t3d__canvas"
        (pointerdown)="onDown($event)"
        (pointermove)="onMove($event)"
        (pointerup)="dragging = false"
        (pointerleave)="dragging = false"
        (wheel)="onWheel($event)"
      ></canvas>
      <p class="t3d__hint">Drag to rotate and tilt · scroll to zoom · {{ mesh?.min?.toFixed(0) }} – {{ mesh?.max?.toFixed(0) }} m</p>
    </div>
  `,
  styles: [
    `
      .t3d { position: fixed; inset: 6vh 6vw; z-index: 2000; display: flex; flex-direction: column;
        border: 1px solid var(--color-line); border-radius: var(--radius-md); background: var(--color-surface);
        box-shadow: 0 20px 60px rgb(0 0 0 / 45%); overflow: hidden; }
      .t3d__head { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid var(--color-line);
        background: var(--color-surface-alt); }
      .t3d__title { flex: 1; font-weight: 600; font-size: 13px; color: var(--color-ink-900); }
      .t3d__ctl { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--color-ink-500); }
      .t3d__btn { width: 30px; height: 30px; border: none; border-radius: var(--radius-sm); background: transparent;
        color: var(--color-ink-500); cursor: pointer; }
      .t3d__btn:hover { background: var(--color-surface); color: var(--color-ink-900); }
      .t3d__canvas { flex: 1; width: 100%; min-height: 0; cursor: grab; background: linear-gradient(#cfe3f5, #f4f7fb); }
      .t3d__canvas:active { cursor: grabbing; }
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

  exaggeration = 2;
  dragging = false;
  private azimuth = -35;
  private tilt = 55;
  private zoom = 1;
  private last = [0, 0];
  private colors: [number, number, number][] = [];
  private resize = new ResizeObserver(() => this.draw());

  ngAfterViewInit(): void {
    this.resize.observe(this.canvasRef.nativeElement);
    this.prepare();
  }

  ngOnChanges(): void {
    if (this.canvasRef) this.prepare();
  }

  ngOnDestroy(): void {
    this.resize.disconnect();
  }

  reset(): void {
    this.azimuth = -35;
    this.tilt = 55;
    this.zoom = 1;
    this.draw();
  }

  savePng(): void {
    const a = document.createElement('a');
    a.href = this.canvasRef.nativeElement.toDataURL('image/png');
    a.download = `${this.title.replace(/[^\w-]+/g, '_')}_3d.png`;
    a.click();
  }

  onDown(e: PointerEvent): void {
    this.dragging = true;
    this.last = [e.clientX, e.clientY];
  }

  onMove(e: PointerEvent): void {
    if (!this.dragging) return;
    this.azimuth += (e.clientX - this.last[0]) * 0.4;
    this.tilt = Math.min(85, Math.max(10, this.tilt - (e.clientY - this.last[1]) * 0.3));
    this.last = [e.clientX, e.clientY];
    this.draw();
  }

  onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.zoom = Math.min(5, Math.max(0.3, this.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    this.draw();
  }

  /** Vertex colours: from the drape image if any, else an elevation ramp. */
  private prepare(): void {
    const m = this.mesh;
    if (!m) return;
    const ramp = (z: number | null): [number, number, number] => {
      if (z === null) return [200, 200, 200];
      const t = Math.min(Math.max((z - m.min) / (m.max - m.min || 1), 0), 1) * (RAMP.length - 1);
      const i = Math.min(Math.floor(t), RAMP.length - 2);
      const f = t - i;
      return [0, 1, 2].map((k) => Math.round(RAMP[i][k] + (RAMP[i + 1][k] - RAMP[i][k]) * f)) as [number, number, number];
    };
    this.colors = m.z.map(ramp);
    this.draw();
    if (!this.drapeUrl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = m.width;
      c.height = m.height;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, m.width, m.height);
      try {
        const data = ctx.getImageData(0, 0, m.width, m.height).data;
        this.colors = this.colors.map((fallback, i) =>
          data[i * 4 + 3] > 10 ? [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]] : fallback
        );
        this.draw();
      } catch {
        // Not CORS-readable: keep the elevation colours.
      }
    };
    img.src = this.drapeUrl;
  }

  draw(): void {
    const m = this.mesh;
    const canvas = this.canvasRef?.nativeElement;
    if (!m || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const { width: nx, height: ny, cellX, cellY } = m;
    const sizeX = (nx - 1) * cellX;
    const sizeY = (ny - 1) * cellY;
    const span = Math.max(sizeX, sizeY) || 1;
    const mid = (m.min + m.max) / 2;
    const az = (this.azimuth * Math.PI) / 180;
    const tl = (this.tilt * Math.PI) / 180;
    const [ca, sa, ct, st] = [Math.cos(az), Math.sin(az), Math.cos(tl), Math.sin(tl)];
    const scale = (Math.min(W, H) / span) * 0.85 * this.zoom;

    // Project every vertex once: rotate about the vertical axis, then tilt.
    const px = new Float32Array(nx * ny);
    const py = new Float32Array(nx * ny);
    const depth = new Float32Array(nx * ny);
    const zs = new Float32Array(nx * ny);
    for (let r = 0; r < ny; r++) {
      for (let c = 0; c < nx; c++) {
        const i = r * nx + c;
        const z = m.z[i] ?? m.min;
        zs[i] = (z - mid) * this.exaggeration;
        const x = c * cellX - sizeX / 2;
        const y = sizeY / 2 - r * cellY;
        const xr = x * ca - y * sa;
        const yr = x * sa + y * ca;
        px[i] = W / 2 + xr * scale;
        py[i] = H / 2 - (yr * ct + zs[i] * st) * scale * 0.9;
        depth[i] = yr * st - zs[i] * ct;
      }
    }

    // Quads, far → near; shaded by a fixed sun (north-west, 45° up).
    const quads: { i: number; d: number }[] = [];
    for (let r = 0; r < ny - 1; r++) {
      for (let c = 0; c < nx - 1; c++) {
        const i = r * nx + c;
        if (m.z[i] === null || m.z[i + 1] === null || m.z[i + nx] === null || m.z[i + nx + 1] === null) continue;
        quads.push({ i, d: depth[i] + depth[i + 1] + depth[i + nx] + depth[i + nx + 1] });
      }
    }
    quads.sort((a, b) => b.d - a.d);
    const sun = [-0.5, 0.5, 0.707];
    for (const { i } of quads) {
      const dzx = (zs[i + 1] - zs[i]) / cellX;
      const dzy = (zs[i] - zs[i + nx]) / cellY;
      const len = Math.hypot(dzx, dzy, 1);
      const shade = Math.max(0.35, Math.min(1.15, ((-dzx * sun[0] - dzy * sun[1] + sun[2]) / len) * 1.1));
      const col = this.colors[i] ?? [180, 180, 180];
      ctx.fillStyle = `rgb(${Math.min(255, col[0] * shade) | 0},${Math.min(255, col[1] * shade) | 0},${Math.min(255, col[2] * shade) | 0})`;
      ctx.beginPath();
      ctx.moveTo(px[i], py[i]);
      ctx.lineTo(px[i + 1], py[i + 1]);
      ctx.lineTo(px[i + nx + 1], py[i + nx + 1]);
      ctx.lineTo(px[i + nx], py[i + nx]);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
  }
}
