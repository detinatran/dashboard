/**
 * Coastal station detail — opened when a Water Level Prediction marker is clicked.
 *
 * Built with imperative DOM (no innerHTML) so it satisfies enforce-safe-html
 * without needing a trustedHtml audit reason.
 *
 * The contract this panel exists to honour: a forecast is rendered ONLY when
 * `waterLevelForecast.status === 'ready'`. Every other status renders an
 * explanation instead. Observed level, trend and history stay visible either
 * way, because they are real measurements and remain useful when the model is
 * absent.
 */

import { CoastalForecastChart } from '@/components/CoastalForecastChart';
import {
  fetchCoastalForecast, fetchCoastalHistory, riskIcon,
  type GetForecastResponse,
} from '@/services/coastal';
import { t } from '@/services/i18n';

const HORIZON_LABELS: Record<string, string> = { '1h': '+1H', '3h': '+3H', '6h': '+6H' };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusLabel(status: string): string {
  switch (status) {
    case 'live': return t('components.coastal.statusLive');
    case 'delayed': return t('components.coastal.statusDelayed');
    case 'stale': return t('components.coastal.statusStale');
    default: return '—';
  }
}

function riskLabel(level: string): string {
  switch (level) {
    case 'normal': return t('components.coastal.riskNormal');
    case 'advisory': return t('components.coastal.riskAdvisory');
    case 'watch': return t('components.coastal.riskWatch');
    case 'high': return t('components.coastal.riskHigh');
    default: return t('components.coastal.riskUnknown');
  }
}

function trendLabel(trend: string): string {
  switch (trend) {
    case 'rising': return `↑ ${t('components.coastal.trendRising')}`;
    case 'falling': return `↓ ${t('components.coastal.trendFalling')}`;
    case 'stable': return `→ ${t('components.coastal.trendStable')}`;
    default: return t('components.coastal.trendUnknown');
  }
}

/** Why a forecast is absent, in the user's words rather than a status code. */
function forecastUnavailableMessage(status: string): string {
  switch (status) {
    case 'model_not_configured': return t('components.coastal.modelNotConfigured');
    case 'model_incompatible': return t('components.coastal.modelIncompatible');
    case 'insufficient_history':
    case 'no_history': return t('components.coastal.insufficientHistory');
    default: return t('components.coastal.forecastUnavailable');
  }
}

export class CoastalStationPanel {
  private root: HTMLElement;
  private chart: CoastalForecastChart | null = null;
  private destroyed = false;

  constructor(container: HTMLElement) {
    this.root = el('div', 'coastal-panel');
    this.root.setAttribute('role', 'complementary');
    this.root.setAttribute('aria-label', t('components.coastal.panelTitle'));
    container.appendChild(this.root);
  }

  async show(stationId: string): Promise<void> {
    this.root.replaceChildren();
    this.root.appendChild(el('div', 'coastal-panel-loading', '…'));

    const res = await fetchCoastalForecast(stationId);
    if (this.destroyed) return;
    this.root.replaceChildren();
    if (!res || !res.dataAvailable) {
      this.root.appendChild(el('div', 'coastal-panel-empty', t('components.coastal.noStations')));
      return;
    }
    this.renderHeader(res);
    this.renderCurrent(res);
    this.renderForecast(res);
    this.renderChart(res, stationId);
    this.renderWarning(res);
    this.renderConditions(res);
    this.renderTechnical(res);
  }

  private renderHeader(res: GetForecastResponse): void {
    const station = res.station;
    const data = res.data;
    const dataStatus = data?.status ?? 'unknown';
    const head = el('div', 'coastal-panel-header');
    head.appendChild(el('h3', 'coastal-panel-title',
      station?.displayName || station?.name || ''));

    const status = el('div', `coastal-status coastal-status-${dataStatus}`);
    // Icon + text, never colour alone.
    status.appendChild(el('span', 'coastal-status-dot', '●'));
    status.appendChild(el('span', 'coastal-status-text', statusLabel(dataStatus)));
    if (Number.isFinite(data?.ageMinutes)) {
      status.appendChild(el('span', 'coastal-status-age',
        t('components.coastal.updatedAgo', { minutes: String(data?.ageMinutes ?? 0) })));
    }
    head.appendChild(status);
    this.root.appendChild(head);

    const riskLevel = res.risk?.level ?? 'unknown';
    const risk = el('div', `coastal-risk coastal-risk-${riskLevel}`);
    risk.appendChild(el('span', 'coastal-risk-icon', riskIcon(riskLevel)));
    risk.appendChild(el('span', 'coastal-risk-label', riskLabel(riskLevel)));
    if (res.risk?.reason) risk.appendChild(el('span', 'coastal-risk-reason', res.risk.reason));
    // Never present model output as an official warning.
    risk.appendChild(el('div', 'coastal-risk-caption', t('components.coastal.riskCaption')));
    this.root.appendChild(risk);
  }

  private renderCurrent(res: GetForecastResponse): void {
    const current = res.current;
    if (!res.hasCurrent || !current) return;
    const sec = el('section', 'coastal-section coastal-current');
    sec.appendChild(el('div', 'coastal-label', t('components.coastal.currentLevel')));
    sec.appendChild(el('div', 'coastal-value-lg', `${current.waterLevel.toFixed(2)} m`));
    sec.appendChild(el('div', 'coastal-trend', trendLabel(current.trend)));

    // Tide/residual only when a real tide source exists — otherwise omitted
    // entirely rather than shown as zero.
    if (current.hasTide) {
      const tide = el('div', 'coastal-subrow');
      tide.appendChild(el('span', 'coastal-label', t('components.coastal.astronomicalTide')));
      tide.appendChild(el('span', 'coastal-value', `${current.predictedTide.toFixed(2)} m`));
      sec.appendChild(tide);
      const resid = el('div', 'coastal-subrow');
      resid.appendChild(el('span', 'coastal-label', t('components.coastal.residual')));
      resid.appendChild(el('span', 'coastal-value',
        `${current.residual >= 0 ? '+' : ''}${current.residual.toFixed(2)} m`));
      sec.appendChild(resid);
    }
    this.root.appendChild(sec);
  }

  private renderForecast(res: GetForecastResponse): void {
    const sec = el('section', 'coastal-section coastal-forecast');
    sec.appendChild(el('div', 'coastal-label', t('components.coastal.forecast')));

    const f = res.waterLevelForecast;
    if (!f || f.status !== 'ready' || !f.horizons?.length) {
      sec.appendChild(el('p', 'coastal-unavailable', forecastUnavailableMessage(f?.status ?? 'unavailable')));
      this.root.appendChild(sec);
      return;
    }

    const grid = el('div', 'coastal-horizon-grid');
    for (const h of f.horizons) {
      const cell = el('div', 'coastal-horizon');
      cell.appendChild(el('div', 'coastal-horizon-label', HORIZON_LABELS[h.horizon] ?? h.horizon));
      cell.appendChild(el('div', 'coastal-horizon-value', `${h.waterLevel.toFixed(2)} m`));
      if (h.hasBounds) {
        cell.appendChild(el('div', 'coastal-horizon-range',
          `${t('components.coastal.expectedRange')}: ${h.lowerBound.toFixed(2)}–${h.upperBound.toFixed(2)} m`));
      }
      grid.appendChild(cell);
    }
    sec.appendChild(grid);
    this.root.appendChild(sec);
  }

  private renderChart(res: GetForecastResponse, stationId: string): void {
    const sec = el('section', 'coastal-section coastal-chart-section');
    const holder = el('div', 'coastal-chart');
    sec.appendChild(holder);
    this.root.appendChild(sec);

    this.chart = new CoastalForecastChart();
    this.chart.mount(holder);

    // History is fetched lazily: the map must not wait on it.
    void fetchCoastalHistory(stationId, 24).then((hist) => {
      if (this.destroyed || !this.chart) return;
      const observations = (hist?.observations ?? []).map((o) => ({
        timestamp: o.timestamp, waterLevel: o.waterLevel,
      }));
      const forecast = res.waterLevelForecast?.status === 'ready'
        ? (res.waterLevelForecast.horizons ?? []).map((h) => ({
            timestamp: h.timestamp,
            waterLevel: h.waterLevel,
            lowerBound: h.hasBounds ? h.lowerBound : null,
            upperBound: h.hasBounds ? h.upperBound : null,
          }))
        : [];
      this.chart.setData(observations, forecast, res.baseTimestamp || Date.now());
    });
  }

  private renderWarning(res: GetForecastResponse): void {
    const sec = el('section', 'coastal-section coastal-warning');
    sec.appendChild(el('div', 'coastal-label', t('components.coastal.warningOutlook')));
    const w = res.warningForecast;
    if (!w || w.status !== 'ready' || !w.horizons?.length) {
      sec.appendChild(el('p', 'coastal-unavailable', t('components.coastal.warningNotConfigured')));
      this.root.appendChild(sec);
      return;
    }
    const grid = el('div', 'coastal-horizon-grid');
    for (const h of w.horizons) {
      const cell = el('div', 'coastal-horizon');
      cell.appendChild(el('div', 'coastal-horizon-label', HORIZON_LABELS[h.horizon] ?? h.horizon));
      cell.appendChild(el('div', 'coastal-horizon-value', `${Math.round(h.probability * 100)}%`));
      grid.appendChild(cell);
    }
    sec.appendChild(grid);
    this.root.appendChild(sec);
  }

  private renderConditions(res: GetForecastResponse): void {
    const wx = res.weather;
    if (!wx?.present) return;
    const sec = el('section', 'coastal-section coastal-conditions');
    sec.appendChild(el('div', 'coastal-label', t('components.coastal.conditions')));
    const grid = el('div', 'coastal-conditions-grid');
    const rows: [string, string][] = [
      ['Pressure', `${wx.pressure.toFixed(0)} hPa`],
      ['Wind', `${wx.windSpeed.toFixed(1)} m/s`],
      ['Gust', `${wx.windGust.toFixed(1)} m/s`],
      ['Rain', `${wx.precipitation.toFixed(1)} mm`],
    ];
    for (const [label, value] of rows) {
      const row = el('div', 'coastal-condition');
      row.appendChild(el('span', 'coastal-label', label));
      row.appendChild(el('span', 'coastal-value', value));
      grid.appendChild(row);
    }
    sec.appendChild(grid);
    this.root.appendChild(sec);
  }

  private renderTechnical(res: GetForecastResponse): void {
    const details = el('details', 'coastal-technical');
    details.appendChild(el('summary', 'coastal-technical-summary',
      t('components.coastal.technicalDetails')));
    const rows: [string, string][] = [
      [t('components.coastal.dataSource'), res.data?.waterLevelProvider || '—'],
      [t('components.coastal.latestObservation'),
        res.data?.latestUpdate ? new Date(res.data.latestUpdate).toISOString() : '—'],
      [t('components.coastal.forecastGenerated'),
        res.generatedAt ? new Date(res.generatedAt).toISOString() : '—'],
      [t('components.coastal.regressionModel'), res.model?.regressionVersion || '—'],
      [t('components.coastal.warningModel'), res.model?.warningVersion || '—'],
      [t('components.coastal.stationId'), res.station?.id || '—'],
    ];
    for (const [label, value] of rows) {
      const row = el('div', 'coastal-tech-row');
      row.appendChild(el('span', 'coastal-label', label));
      row.appendChild(el('span', 'coastal-value', value));
      details.appendChild(row);
    }
    this.root.appendChild(details);
  }

  destroy(): void {
    this.destroyed = true;
    this.chart?.destroy();
    this.chart = null;
    this.root.remove();
  }
}
