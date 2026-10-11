import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { joinSafeHtml, safeHtml, safeUrlAttr, type SafeHtml } from '@/utils/sanitize';
import {
  fetchUkSituation,
  getLastUkSituation,
  SEVERITY_RANK,
  type UkAlert,
  type UkAlertCategory,
  type UkAlertSeverity,
  type UkSituation,
} from '@/services/uk';

type CategoryFilter = 'all' | UkAlertCategory;

const CATEGORY_ICON: Record<UkAlertCategory, string> = {
  flood: '🌊',
  weather: '🌧️',
  grid: '⚡',
  transport: '🚇',
  seismic: '📈',
};

const SOURCE_LABEL: Record<UkAlert['source'], string> = {
  'ea-floods': 'Environment Agency',
  'met-office': 'Met Office',
  'neso-grid': 'NESO',
  tfl: 'TfL',
  bgs: 'BGS',
};

const MIX_COLORS: Record<string, string> = {
  wind: '#4fc3f7',
  solar: '#ffd54f',
  hydro: '#4db6ac',
  biomass: '#8bc34a',
  nuclear: '#ba68c8',
  gas: '#ff8a65',
  coal: '#795548',
  imports: '#90a4ae',
  other: '#616161',
};

/** Max alerts rendered; the long tail is TfL planned works and small quakes. */
const MAX_ROWS = 60;

function timeAgo(epochMs: number): string {
  if (!epochMs) return '';
  const minutes = Math.floor((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function worstSeverity(alerts: UkAlert[]): UkAlertSeverity | null {
  let worst: UkAlertSeverity | null = null;
  for (const a of alerts) {
    if (!worst || SEVERITY_RANK[a.severity] > SEVERITY_RANK[worst]) worst = a.severity;
  }
  return worst;
}

export class UkCrisisMonitorPanel extends Panel {
  private filter: CategoryFilter = 'all';
  private situation: UkSituation | null = getLastUkSituation();

  constructor() {
    super({
      id: 'uk-crisis-monitor',
      title: t('panels.ukCrisisMonitor'),
      showCount: true,
      trackActivity: true,
      infoTooltip: t('components.ukCrisisMonitor.infoTooltip'),
    });
    this.setupDelegatedListeners();
    if (this.situation) this.render();
  }

  public async fetchData(): Promise<void> {
    if (!this.situation) this.showLoading();
    try {
      const situation = await fetchUkSituation();
      if (!this.element?.isConnected) return;
      if (situation.failed.length >= Object.keys(SOURCE_LABEL).length) throw new Error('all UK sources failed');
      this.situation = situation;
      this.render();
    } catch (err) {
      if (this.isAbortError(err) || !this.element?.isConnected) return;
      if (!this.situation) this.showError(t('components.ukCrisisMonitor.loadError'), () => void this.fetchData());
    }
  }

  private setupDelegatedListeners(): void {
    this.content.addEventListener('click', (e: Event) => {
      const target = e.target as HTMLElement;
      const tab = target.closest<HTMLElement>('[data-uk-filter]');
      if (tab) {
        this.filter = tab.dataset.ukFilter as CategoryFilter;
        this.render();
        return;
      }
      const locate = target.closest<HTMLElement>('[data-uk-lat]');
      if (locate) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('wm:uk-focus', {
          detail: { lat: Number(locate.dataset.ukLat), lon: Number(locate.dataset.ukLon) },
        }));
      }
    });
  }

  private render(): void {
    const s = this.situation;
    if (!s) return;
    const active = s.alerts;
    this.setCount(active.filter(a => a.severity !== 'low').length);

    const byCategory = (c: UkAlertCategory) => active.filter(a => a.category === c);
    const kpi = (category: UkAlertCategory, label: string): SafeHtml => {
      const list = byCategory(category);
      const worst = worstSeverity(list) ?? 'none';
      return safeHtml`<button class="uk-kpi uk-sev-${worst} ${this.filter === category ? 'active' : ''}" data-uk-filter="${category}">
        <span class="uk-kpi-icon">${CATEGORY_ICON[category]}</span>
        <span class="uk-kpi-value">${list.length}</span>
        <span class="uk-kpi-label">${label}</span>
      </button>`;
    };

    const kpis = joinSafeHtml([
      kpi('flood', t('components.ukCrisisMonitor.floods')),
      kpi('weather', t('components.ukCrisisMonitor.weather')),
      kpi('grid', t('components.ukCrisisMonitor.gridWarnings')),
      kpi('transport', t('components.ukCrisisMonitor.transport')),
      kpi('seismic', t('components.ukCrisisMonitor.quakes')),
    ]);

    const visible = (this.filter === 'all' ? active : byCategory(this.filter)).slice(0, MAX_ROWS);
    const rows = visible.length
      ? joinSafeHtml(visible.map(a => this.renderAlert(a)))
      : safeHtml`<div class="uk-empty">${t('components.ukCrisisMonitor.allClear')}</div>`;

    const degraded = s.failed.length
      ? safeHtml`<div class="uk-degraded">${t('components.ukCrisisMonitor.degraded', { sources: s.failed.map(f => SOURCE_LABEL[f]).join(', ') })}</div>`
      : safeHtml``;

    this.setSafeContent(safeHtml`<div class="uk-monitor">
      <div class="uk-kpis">${kpis}</div>
      ${this.renderGrid()}
      <div class="panel-tabs uk-tabs">
        <button class="panel-tab ${this.filter === 'all' ? 'active' : ''}" data-uk-filter="all">${t('components.ukCrisisMonitor.filterAll')} (${active.length})</button>
      </div>
      ${degraded}
      <div class="uk-alert-list">${rows}</div>
      <div class="uk-updated">${t('components.ukCrisisMonitor.updated', { time: timeAgo(s.fetchedAt) })}</div>
    </div>`);
  }

  private renderGrid(): SafeHtml {
    const grid = this.situation?.grid;
    if (!grid) return safeHtml``;
    const total = grid.mix.reduce((sum, m) => sum + m.perc, 0) || 1;
    const segments = joinSafeHtml(
      grid.mix
        .filter(m => m.perc > 0.4)
        .map(m => safeHtml`<span class="uk-mix-seg" title="${m.fuel} ${m.perc.toFixed(1)}%" style="width:${((m.perc / total) * 100).toFixed(2)}%;background:${MIX_COLORS[m.fuel] ?? '#9e9e9e'}"></span>`),
    );
    const demand = grid.demandMw != null ? `${(grid.demandMw / 1000).toFixed(1)} GW` : '—';
    return safeHtml`<div class="uk-grid">
      <div class="uk-grid-stats">
        <span>⚡ ${t('components.ukCrisisMonitor.grid')}</span>
        <span>${t('components.ukCrisisMonitor.carbon')}: <b>${grid.intensity ?? '—'}</b> g/kWh <em class="uk-index-${grid.index.replace(/\s+/g, '-')}">${grid.index}</em></span>
        <span>${t('components.ukCrisisMonitor.renewables')}: <b>${grid.renewablePct}%</b></span>
        <span>${t('components.ukCrisisMonitor.demand')}: <b>${demand}</b></span>
      </div>
      <div class="uk-mix-bar">${segments}</div>
    </div>`;
  }

  private renderAlert(a: UkAlert): SafeHtml {
    const url = a.url ? safeUrlAttr(a.url) : null;
    const title = url && url.toString()
      ? safeHtml`<a href="${url}" target="_blank" rel="noopener noreferrer">${a.title}</a>`
      : safeHtml`${a.title}`;
    const locate = a.lat != null && a.lon != null && a.category !== 'transport'
      ? safeHtml`<button class="uk-locate" data-uk-lat="${a.lat}" data-uk-lon="${a.lon}" title="${t('components.ukCrisisMonitor.showOnMap')}">◎</button>`
      : safeHtml``;
    return safeHtml`<div class="uk-alert uk-sev-${a.severity}">
      <span class="uk-alert-icon">${CATEGORY_ICON[a.category]}</span>
      <div class="uk-alert-body">
        <div class="uk-alert-title">${title}</div>
        ${a.detail ? safeHtml`<div class="uk-alert-detail">${a.detail}</div>` : safeHtml``}
        <div class="uk-alert-meta">${SOURCE_LABEL[a.source]} · ${timeAgo(a.time)}</div>
      </div>
      ${locate}
    </div>`;
  }
}
