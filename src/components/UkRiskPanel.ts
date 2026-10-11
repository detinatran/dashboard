import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { joinSafeHtml, safeHtml, type SafeHtml } from '@/utils/sanitize';
import { fetchUkSituation, getLastUkSituation } from '@/services/uk';
import { loadUkTwin, UK_NODE_TYPE_LABELS, type UkTwinGraph } from '@/services/uk/twin';
import { simulateCascade, summarizeCascade, type UkCascadeSummary } from '@/services/uk/cascade';
import {
  computeRegionalResilience,
  fetchHazardFeatures,
  scoreNodeRisk,
  type UkNodeRisk,
  type UkRegionResilience,
  type UkRiskLevel,
} from '@/services/uk/risk';

type Tab = 'outlook' | 'resilience';

const LEVEL_ORDER: UkRiskLevel[] = ['high', 'elevated', 'guarded', 'low'];
/** Assets below this probability are not seeded into the predicted cascade. */
const SEED_THRESHOLD = 0.15;
const MAX_ROWS = 10;

/**
 * Risk Outlook — "What will happen?" for CrisisTwin UK.
 * 72h: explainable hazard scores per twin asset from Open-Meteo/GloFAS
 * forecasts plus live EA warnings, with a one-click predicted cascade.
 * Resilience: a regional index from redundancy, exposure, concentration
 * and the current forecast.
 */
export class UkRiskPanel extends Panel {
  private tab: Tab = 'outlook';
  private twin: UkTwinGraph | null = null;
  private risks: UkNodeRisk[] = [];
  private regions: UkRegionResilience[] = [];
  private predicted: UkCascadeSummary | null = null;
  private updatedAt = 0;

  constructor() {
    super({
      id: 'uk-risk',
      title: t('panels.ukRisk'),
      showCount: true,
      defaultRowSpan: 2,
      infoTooltip: t('components.ukRisk.about'),
    });
    this.setupDelegatedListeners();
  }

  public async fetchData(): Promise<void> {
    if (!this.risks.length) this.showLoading();
    try {
      this.twin ??= await loadUkTwin();
      const [features, situation] = await Promise.all([
        fetchHazardFeatures(this.twin.nodes),
        // Warnings sharpen the score but are optional: reuse the monitor's round.
        fetchUkSituation().catch(() => getLastUkSituation()),
      ]);
      if (!this.element?.isConnected) return;
      const floods = situation?.floods ?? [];
      this.risks = this.twin.nodes
        .map(node => scoreNodeRisk(node, features.get(node.id) ?? { precip72: null, gustMax: null, riverRatio: null }, floods))
        .sort((a, b) => b.probability - a.probability);
      this.regions = computeRegionalResilience(
        this.twin.nodes,
        this.twin.edges,
        new Map(this.risks.map(r => [r.node.id, r.probability])),
        this.twin.regionLabels,
      );
      // A refresh invalidates the previous predicted cascade.
      if (this.predicted) this.runPredictedCascade();
      this.updatedAt = Date.now();
      this.setCount(this.risks.filter(r => r.level === 'high' || r.level === 'elevated').length);
      this.render();
    } catch (err) {
      if (this.isAbortError(err) || !this.element?.isConnected) return;
      console.error('[UkRiskPanel] fetch failed:', err);
      if (!this.risks.length) this.showError(t('components.ukRisk.loadError'), () => void this.fetchData());
    }
  }

  private runPredictedCascade(): void {
    if (!this.twin) return;
    const seeds = new Map(this.risks.filter(r => r.probability >= SEED_THRESHOLD).map(r => [r.node.id, r.probability]));
    const result = simulateCascade(this.twin.nodes, this.twin.edges, [], { seedLosses: seeds });
    this.predicted = summarizeCascade(this.twin.nodes, result);
    window.dispatchEvent(new CustomEvent('wm:uk-twin-impacts', { detail: { losses: Object.fromEntries(result.losses) } }));
  }

  private clearPredicted(): void {
    this.predicted = null;
    window.dispatchEvent(new CustomEvent('wm:uk-twin-impacts', { detail: { losses: {} } }));
  }

  private setupDelegatedListeners(): void {
    this.content.addEventListener('click', (e: Event) => {
      const target = e.target as HTMLElement;
      const tab = target.closest<HTMLElement>('[data-uk-risk-tab]');
      if (tab) {
        this.tab = tab.dataset.ukRiskTab as Tab;
        this.render();
        return;
      }
      if (target.closest('[data-uk-risk-simulate]')) {
        this.runPredictedCascade();
        this.render();
        return;
      }
      if (target.closest('[data-uk-risk-clear]')) {
        this.clearPredicted();
        this.render();
        return;
      }
      const focus = target.closest<HTMLElement>('[data-uk-risk-focus]');
      if (focus) {
        window.dispatchEvent(new CustomEvent('wm:uk-focus', {
          detail: { lat: Number(focus.dataset.lat), lon: Number(focus.dataset.lon) },
        }));
      }
    });
  }

  private render(): void {
    const tabs = safeHtml`<div class="panel-tabs uk-tabs">
      <button class="panel-tab ${this.tab === 'outlook' ? 'active' : ''}" data-uk-risk-tab="outlook">${t('components.ukRisk.tabOutlook')}</button>
      <button class="panel-tab ${this.tab === 'resilience' ? 'active' : ''}" data-uk-risk-tab="resilience">${t('components.ukRisk.tabResilience')}</button>
    </div>`;
    const body = this.tab === 'outlook' ? this.renderOutlook() : this.renderResilience();
    const minutes = Math.max(0, Math.round((Date.now() - this.updatedAt) / 60_000));
    this.setSafeContent(safeHtml`<div class="uk-risk">
      ${tabs}
      ${body}
      <div class="uk-updated">${t('components.ukRisk.sources', { minutes: String(minutes) })}</div>
    </div>`);
  }

  private renderOutlook(): SafeHtml {
    const counts = Object.fromEntries(LEVEL_ORDER.map(l => [l, this.risks.filter(r => r.level === l).length])) as Record<UkRiskLevel, number>;
    const chips = joinSafeHtml(LEVEL_ORDER.map(l =>
      safeHtml`<span class="uk-risk-chip uk-risk-${l}"><b>${counts[l]}</b> ${t(`components.ukRisk.level_${l}`)}</span>`));
    const top = this.risks.filter(r => r.level !== 'low').slice(0, MAX_ROWS);
    const rows = top.length
      ? joinSafeHtml(top.map(r => safeHtml`<div class="uk-risk-row uk-risk-${r.level}">
          <button class="uk-impact-name" data-uk-risk-focus data-lat="${r.node.lat}" data-lon="${r.node.lon}" title="${t('components.ukCrisisMonitor.showOnMap')}">${r.node.name}</button>
          <span class="uk-impact-type">${UK_NODE_TYPE_LABELS[r.node.type]}</span>
          <span class="uk-impact-bar"><span style="width:${Math.round(r.probability * 100)}%"></span></span>
          <span class="uk-impact-pct">${Math.round(r.probability * 100)}%</span>
          ${r.drivers.length ? safeHtml`<div class="uk-risk-drivers">${r.drivers.join(' · ')}</div>` : safeHtml``}
        </div>`))
      : safeHtml`<div class="uk-empty">${t('components.ukRisk.calm')}</div>`;

    const seeded = this.risks.filter(r => r.probability >= SEED_THRESHOLD).length;
    const p = this.predicted;
    const predicted = p
      ? safeHtml`<div class="uk-risk-predicted">
          <div>${t('components.ukRisk.predicted', {
            assets: String(p.impacts.filter(i => i.level !== 'minor').length),
            pct: String(Math.round(p.serviceDisruption * 100)),
          })}</div>
          <button class="uk-scenario-chip uk-scenario-reset" data-uk-risk-clear>${t('components.ukRisk.clear')}</button>
        </div>`
      : seeded
        ? safeHtml`<button class="uk-scenario-chip" data-uk-risk-simulate>${t('components.ukRisk.simulate', { count: String(seeded) })}</button>`
        : safeHtml``;

    return safeHtml`<div class="uk-risk-chips">${chips}</div>
      ${predicted}
      <div class="uk-risk-list">${rows}</div>`;
  }

  private renderResilience(): SafeHtml {
    const rows = joinSafeHtml(this.regions.map(r => {
      const band = r.score >= 80 ? 'good' : r.score >= 70 ? 'fair' : 'weak';
      const c = r.components;
      const pct = (x: number) => `${Math.round(x * 100)}%`;
      const detail = t('components.ukRisk.components', {
        redundancy: pct(c.redundancy), exposure: pct(c.exposure), concentration: pct(c.concentration), hazard: pct(c.hazard),
      });
      return safeHtml`<div class="uk-res-row" title="${detail}">
        <span class="uk-res-name">${r.label}</span>
        <span class="uk-impact-bar"><span class="uk-res-${band}" style="width:${r.score}%"></span></span>
        <span class="uk-res-score uk-res-${band}-text">${r.score}</span>
        <div class="uk-risk-drivers">${detail}</div>
      </div>`;
    }));
    return safeHtml`<div class="uk-res-note">${t('components.ukRisk.resilienceNote')}</div><div class="uk-res-list">${rows}</div>`;
  }
}
