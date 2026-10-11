/**
 * Observed history + forecast, on one canvas.
 *
 * Follows the house TransitChart pattern (src/utils/transit-chart.ts): a canvas
 * class that owns its DOM children, reads colours from CSS custom properties so
 * it tracks the theme, and redraws on resize. No chart library is added — the
 * repo deliberately has none.
 *
 * Two rules this chart must not break:
 *   - Observed and forecast are drawn differently (solid vs dashed, with a NOW
 *     divider) so a prediction can never be mistaken for a measurement.
 *   - Gaps are NOT bridged. A missing hour is a break in the line, because a
 *     straight segment across it would invent readings that were never taken.
 */

import { getCSSColor } from '@/utils';

export interface ChartObservation { timestamp: number; waterLevel: number }
export interface ChartForecastPoint {
  timestamp: number;
  waterLevel: number;
  lowerBound?: number | null;
  upperBound?: number | null;
}

const PAD = { top: 16, right: 46, bottom: 26, left: 8 };
const GRID_LINES = 4;
/** Samples more than this far apart are a gap, not a segment. */
const MAX_GAP_MS = 45 * 60_000;

export class CoastalForecastChart {
  private container: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private themeHandler: (() => void) | null = null;
  private observations: ChartObservation[] = [];
  private forecast: ChartForecastPoint[] = [];
  private nowMs = Date.now();

  mount(container: HTMLElement): void {
    this.container = container;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'coastal-chart-canvas';
    this.canvas.setAttribute('role', 'img');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.themeHandler = () => this.draw();
    window.addEventListener('theme-changed', this.themeHandler);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(container);
    }
  }

  setData(observations: ChartObservation[], forecast: ChartForecastPoint[], nowMs = Date.now()): void {
    this.observations = [...observations].sort((a, b) => a.timestamp - b.timestamp);
    this.forecast = [...forecast].sort((a, b) => a.timestamp - b.timestamp);
    this.nowMs = nowMs;
    this.draw();
  }

  destroy(): void {
    if (this.themeHandler) window.removeEventListener('theme-changed', this.themeHandler);
    this.themeHandler = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.container = null;
  }

  private draw(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    const container = this.container;
    if (!canvas || !ctx || !container) return;

    const cssW = container.clientWidth || 320;
    const cssH = container.clientHeight || 180;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const all = [
      ...this.observations.map((o) => ({ t: o.timestamp, v: o.waterLevel })),
      ...this.forecast.flatMap((f) => [
        { t: f.timestamp, v: f.waterLevel },
        ...(Number.isFinite(f.lowerBound as number) ? [{ t: f.timestamp, v: f.lowerBound as number }] : []),
        ...(Number.isFinite(f.upperBound as number) ? [{ t: f.timestamp, v: f.upperBound as number }] : []),
      ]),
    ];
    if (all.length < 2) return;

    const tMin = Math.min(...all.map((p) => p.t));
    const tMax = Math.max(...all.map((p) => p.t));
    const vMinRaw = Math.min(...all.map((p) => p.v));
    const vMaxRaw = Math.max(...all.map((p) => p.v));
    const padV = Math.max(0.15, (vMaxRaw - vMinRaw) * 0.1);
    const vMin = vMinRaw - padV;
    const vMax = vMaxRaw + padV;

    const plotW = cssW - PAD.left - PAD.right;
    const plotH = cssH - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - tMin) / Math.max(1, tMax - tMin)) * plotW;
    const y = (v: number) => PAD.top + (1 - (v - vMin) / Math.max(1e-6, vMax - vMin)) * plotH;

    const border = getCSSColor('--border') || '#16211a';
    const textDim = getCSSColor('--text-muted') || '#7f9689';
    const accent = getCSSColor('--accent') || '#7df9c0';
    const amber = getCSSColor('--semantic-elevated') || '#ffb000';

    // Gridlines + right-axis labels.
    ctx.strokeStyle = border;
    ctx.fillStyle = textDim;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= GRID_LINES; i++) {
      const v = vMin + ((vMax - vMin) * i) / GRID_LINES;
      const yy = Math.round(y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, yy);
      ctx.lineTo(PAD.left + plotW, yy);
      ctx.stroke();
      ctx.fillText(`${v.toFixed(1)}m`, PAD.left + plotW + 6, yy);
    }

    // Uncertainty band, drawn first so the lines sit on top.
    const banded = this.forecast.filter(
      (f) => Number.isFinite(f.lowerBound as number) && Number.isFinite(f.upperBound as number),
    );
    if (banded.length >= 2) {
      ctx.fillStyle = getCSSColor('--overlay-light') || 'rgba(125,249,192,0.05)';
      ctx.beginPath();
      banded.forEach((f, i) => {
        const px = x(f.timestamp);
        const py = y(f.upperBound as number);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      for (let i = banded.length - 1; i >= 0; i--) {
        const b = banded[i];
        if (!b) continue;
        ctx.lineTo(x(b.timestamp), y(b.lowerBound as number));
      }
      ctx.closePath();
      ctx.fill();
    }

    // Observed: solid, broken across gaps.
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    let penDown = false;
    for (let i = 0; i < this.observations.length; i++) {
      const o = this.observations[i];
      if (!o) continue;
      const prev = i > 0 ? this.observations[i - 1] : undefined;
      const gap = prev ? o.timestamp - prev.timestamp > MAX_GAP_MS : false;
      if (!penDown || gap) {
        ctx.moveTo(x(o.timestamp), y(o.waterLevel));
        penDown = true;
      } else {
        ctx.lineTo(x(o.timestamp), y(o.waterLevel));
      }
    }
    ctx.stroke();

    // Forecast: dashed, and visually joined to the last observation so the
    // handover point is explicit rather than a floating segment.
    if (this.forecast.length) {
      const last = this.observations.length ? this.observations[this.observations.length - 1] : undefined;
      ctx.strokeStyle = amber;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      if (last) ctx.moveTo(x(last.timestamp), y(last.waterLevel));
      this.forecast.forEach((f, i) => {
        const px = x(f.timestamp);
        const py = y(f.waterLevel);
        if (!last && i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = amber;
      for (const f of this.forecast) {
        ctx.beginPath();
        ctx.arc(x(f.timestamp), y(f.waterLevel), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // NOW divider.
    if (this.nowMs >= tMin && this.nowMs <= tMax) {
      const nx = Math.round(x(this.nowMs)) + 0.5;
      ctx.strokeStyle = textDim;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(nx, PAD.top);
      ctx.lineTo(nx, PAD.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = textDim;
      ctx.textAlign = 'center';
      ctx.fillText('NOW', nx, cssH - 8);
    }
  }
}
