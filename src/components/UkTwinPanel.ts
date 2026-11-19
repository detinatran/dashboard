import * as d3 from 'd3';
import { Panel } from './Panel';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { t } from '@/services/i18n';
import { joinSafeHtml, safeHtml, type SafeHtml } from '@/utils/sanitize';
import {
  loadUkTwin,
  UK_NODE_TYPE_COLORS,
  UK_NODE_TYPE_LABELS,
  UK_SECTORS,
  type UkTwinGraph,
  type UkTwinNode,
} from '@/services/uk/twin';
import {
  summarizeCascade,
  UK_SCENARIOS,
  type UkCascadeSummary,
  type UkImpactLevel,
} from '@/services/uk/cascade';
import {
  DEFAULT_TIMELINE_HOURS,
  simulateCascadeTimeline,
  type UkTimelineResult,
} from '@/services/uk/timeline';
import {
  rankCriticalNodes,
  rankCriticalPairs,
  type UkCriticalEntry,
  type UkCriticalPair,
} from '@/services/uk/critical';
import {
  evaluatePlan,
  normalBaseline,
  recommendPlan,
  type UkPlan,
  type UkPlanResult,
} from '@/services/uk/whatif';

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  ref: UkTwinNode;
}
interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  dependency: number;
}

const LEVEL_COLORS: Record<UkImpactLevel, string> = {
  down: '#f03e3e',
  severe: '#ff7043',
  degraded: '#ffb000',
  minor: '#b0a36b',
};

const GRAPH_HEIGHT = 300;

type TwinTab = 'graph' | 'critical' | 'whatif';

const PLAYBACK_MS = 220;

/** Plans are carried in <select> values: none | close:<id> | reroute:<id>:<target>. */
function encodePlan(plan: UkPlan): string {
  if (plan.kind === 'close') return `close:${plan.node}`;
  if (plan.kind === 'reroute') return `reroute:${plan.node}:${plan.target}`;
  return 'none';
}

function decodePlan(value: string): UkPlan {
  const [kind, node, target] = value.split(':');
  if (kind === 'close' && node) return { kind: 'close', node };
  if (kind === 'reroute' && node && target) return { kind: 'reroute', node, target };
  return { kind: 'none' };
}

/**
 * Knowledge graph + cascading-impact simulator over the UK digital twin.
 * Click an asset (or pick a scenario) to fail it; the engine propagates
 * capacity loss along dependency edges and the map layer mirrors the result.
 */
export class UkTwinPanel extends Panel {
  private twin: UkTwinGraph | null = null;
  private failed = new Set<string>();
  private summary: UkCascadeSummary | null = null;
  private losses = new Map<string, number>();
  private simulation: d3.Simulation<SimNode, SimLink> | null = null;
  private simNodes: SimNode[] = [];
  private simLinks: SimLink[] = [];
  private canvas: HTMLCanvasElement | null = null;
  private hovered: SimNode | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private tab: TwinTab = 'graph';
  private timeline: UkTimelineResult | null = null;
  private hour = DEFAULT_TIMELINE_HOURS;
  private playTimer: number | null = null;
  private criticalEntries: UkCriticalEntry[] | null = null;
  private criticalPairs: UkCriticalPair[] | null = null;
  private whatIfHazard = 'humber-surge';
  private planA: UkPlan = { kind: 'close', node: 'albion-factory-hull' };
  private planB: UkPlan = { kind: 'reroute', node: 'albion-factory-hull', target: 'albion-factory-burton' };

  constructor() {
    super({
      id: 'uk-twin',
      title: t('panels.ukTwin'),
      showCount: true,
      defaultRowSpan: 2,
      infoTooltip: t('components.ukTwin.about'),
    });
    this.setupDelegatedListeners();
    void this.init();
  }

  private async init(): Promise<void> {
    this.showLoading();
    try {
      this.twin = await loadUkTwin();
      if (!this.element?.isConnected) return;
      this.setCount(this.twin.nodes.length);
      this.render();
    } catch (error) {
      console.error('[UkTwinPanel] init failed:', error);
      this.showError(t('components.ukTwin.loadError'), () => void this.init());
    }
  }

  public destroy(): void {
    this.stopPlayback();
    this.simulation?.stop();
    this.simulation = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    super.destroy();
  }

  // -------------------------------------------------------------------------
  // Simulation state
  // -------------------------------------------------------------------------

  private runCascade(): void {
    if (!this.twin) return;
    this.stopPlayback();
    if (this.failed.size === 0) {
      this.timeline = null;
      this.hour = 0;
    } else {
      // Hour-stepped cascade: buffers (generators, storage, inventory) delay
      // the hit; the last frame approximates the static fixed point.
      this.timeline = simulateCascadeTimeline(this.twin.nodes, this.twin.edges, this.failed);
      this.hour = this.timeline.hours;
    }
    this.applyHour();
  }

  /** Losses, summary, map sync and redraw for the currently selected hour. */
  private applyHour(): void {
    if (!this.twin) return;
    const frame = this.timeline?.frames[Math.min(this.hour, this.timeline.hours)] ?? null;
    this.losses = frame ? new Map(frame.losses) : new Map();
    this.summary = frame && this.failed.size > 0
      ? summarizeCascade(this.twin.nodes, { losses: this.losses, failed: this.failed, passes: 0 })
      : null;
    // The deck layer mirrors the cascade so the map tells the same story.
    window.dispatchEvent(new CustomEvent('wm:uk-twin-impacts', {
      detail: { losses: Object.fromEntries(this.losses) },
    }));
    this.renderSidebar();
    this.drawGraph();
    this.updateTimelineUi();
  }

  private stopPlayback(): void {
    if (this.playTimer !== null) {
      window.clearInterval(this.playTimer);
      this.playTimer = null;
    }
  }

  private togglePlayback(): void {
    if (!this.timeline) return;
    if (this.playTimer !== null) {
      this.stopPlayback();
      this.updateTimelineUi();
      return;
    }
    if (this.hour >= this.timeline.hours) this.hour = 0;
    this.playTimer = window.setInterval(() => {
      if (!this.timeline || !this.element?.isConnected) {
        this.stopPlayback();
        return;
      }
      this.hour += 1;
      if (this.hour >= this.timeline.hours) {
        this.hour = this.timeline.hours;
        this.stopPlayback();
      }
      this.applyHour();
    }, PLAYBACK_MS);
    this.applyHour();
  }

  private timelineLabel(): string {
    const frame = this.timeline?.frames[Math.min(this.hour, this.timeline.hours)];
    if (!this.timeline || !frame) return '';
    return t('components.ukTwin.timelineLabel', {
      hour: String(frame.hour),
      service: (Math.max(0, 1 - frame.serviceDisruption) * 100).toFixed(0),
      peak: String(this.timeline.peakHour),
    });
  }

  /** Rebuilds or refreshes the timeline strip without re-rendering the tab. */
  private updateTimelineUi(): void {
    const mount = this.content.querySelector<HTMLElement>('.uk-timeline-mount');
    if (!mount) return;
    if (!this.timeline) {
      mount.replaceChildren();
      return;
    }
    let range = mount.querySelector<HTMLInputElement>('input[data-uk-hour]');
    if (!range) {
      const strip = safeHtml`<div class="uk-timeline">
        <button class="uk-timeline-play" data-uk-play></button>
        <input class="uk-timeline-range" type="range" min="0" max="${String(this.timeline.hours)}" step="1" data-uk-hour aria-label="${t('components.ukTwin.timelineAria')}">
        <span class="uk-timeline-label" data-uk-timeline-label></span>
      </div>`;
      setTrustedHtml(mount, trustedHtml(strip.toString(), 'Timeline strip built with safeHtml; every interpolated value is escaped'));
      range = mount.querySelector<HTMLInputElement>('input[data-uk-hour]');
    }
    if (range) {
      range.max = String(this.timeline.hours);
      range.value = String(this.hour);
    }
    const play = mount.querySelector<HTMLButtonElement>('[data-uk-play]');
    if (play) {
      const playing = this.playTimer !== null;
      play.textContent = playing ? '⏸' : '▶';
      play.title = playing ? t('components.ukTwin.timelinePause') : t('components.ukTwin.timelinePlay');
    }
    const label = mount.querySelector<HTMLElement>('[data-uk-timeline-label]');
    if (label) label.textContent = this.timelineLabel();
  }

  private toggleFailed(id: string): void {
    if (this.failed.has(id)) this.failed.delete(id);
    else this.failed.add(id);
    this.runCascade();
  }

  private applyScenario(id: string): void {
    if (!this.twin) return;
    const scenario = UK_SCENARIOS.find(s => s.id === id);
    if (!scenario) return;
    this.failed = new Set(scenario.select(this.twin.nodes));
    this.runCascade();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private setupDelegatedListeners(): void {
    this.content.addEventListener('input', (e: Event) => {
      const range = (e.target as HTMLElement).closest<HTMLInputElement>('input[data-uk-hour]');
      if (!range || !this.timeline) return;
      this.stopPlayback();
      this.hour = Math.max(0, Math.min(this.timeline.hours, Number(range.value) || 0));
      this.applyHour();
    });
    this.content.addEventListener('change', (e: Event) => {
      const select = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-uk-whatif]');
      if (!select) return;
      if (select.dataset.ukWhatif === 'hazard') this.whatIfHazard = select.value;
      if (select.dataset.ukWhatif === 'a') this.planA = decodePlan(select.value);
      if (select.dataset.ukWhatif === 'b') this.planB = decodePlan(select.value);
      this.render();
    });
    this.content.addEventListener('click', (e: Event) => {
      const target = e.target as HTMLElement;
      const tab = target.closest<HTMLElement>('[data-uk-twin-tab]');
      if (tab) {
        this.tab = tab.dataset.ukTwinTab as TwinTab;
        this.render();
        return;
      }
      const scenario = target.closest<HTMLElement>('[data-uk-scenario]');
      if (scenario) {
        this.applyScenario(scenario.dataset.ukScenario!);
        return;
      }
      if (target.closest('[data-uk-play]')) {
        this.togglePlayback();
        return;
      }
      const crit = target.closest<HTMLElement>('[data-uk-crit]');
      if (crit) {
        // Simulate the ranked failure on the graph tab.
        this.failed = new Set(crit.dataset.ukCrit!.split('|'));
        this.tab = 'graph';
        this.render();
        this.runCascade();
        return;
      }
      if (target.closest('[data-uk-reset]')) {
        this.failed.clear();
        this.runCascade();
        return;
      }
      const row = target.closest<HTMLElement>('[data-uk-impact-focus]');
      if (row) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('wm:uk-focus', {
          detail: { lat: Number(row.dataset.lat), lon: Number(row.dataset.lon) },
        }));
      }
    });
  }

  private render(): void {
    if (!this.twin) return;
    const tabs = safeHtml`<div class="panel-tabs uk-tabs">
      <button class="panel-tab ${this.tab === 'graph' ? 'active' : ''}" data-uk-twin-tab="graph">${t('components.ukTwin.tabGraph')}</button>
      <button class="panel-tab ${this.tab === 'critical' ? 'active' : ''}" data-uk-twin-tab="critical">${t('components.ukTwin.tabCritical')}</button>
      <button class="panel-tab ${this.tab === 'whatif' ? 'active' : ''}" data-uk-twin-tab="whatif">${t('components.ukTwin.tabWhatIf')}</button>
    </div>`;
    if (this.tab === 'whatif' || this.tab === 'critical') {
      // Leaving the graph: the canvas is detached, so ticks must not draw.
      this.canvas = null;
      const body = this.tab === 'whatif' ? this.renderWhatIf() : this.renderCritical();
      this.setSafeContent(safeHtml`<div class="uk-twin">${tabs}${body}</div>`);
      return;
    }
    const chips = joinSafeHtml(UK_SCENARIOS.map(s =>
      safeHtml`<button class="uk-scenario-chip" data-uk-scenario="${s.id}" title="${s.description}">${s.name}</button>`));
    this.setSafeContent(safeHtml`<div class="uk-twin">
      ${tabs}
      <div class="uk-scenarios">
        ${chips}
        <button class="uk-scenario-chip uk-scenario-reset" data-uk-reset>${t('components.ukTwin.reset')}</button>
      </div>
      <div class="uk-twin-canvas-wrap"><canvas class="uk-twin-canvas" height="${GRAPH_HEIGHT}"></canvas></div>
      <div class="uk-timeline-mount"></div>
      <div class="uk-twin-legend">
        ${joinSafeHtml(UK_SECTORS.map(s =>
          safeHtml`<span class="uk-legend-item"><span class="uk-legend-dot" style="background:${s.color}"></span>${s.label}</span>`))}
        <span class="uk-legend-item uk-legend-failed"><span class="uk-legend-dot"></span>${t('components.ukTwin.legendFailed')}</span>
      </div>
      <div class="uk-twin-hint">${t('components.ukTwin.hint')}</div>
      <div class="uk-twin-sidebar"></div>
    </div>`, () => {
      // Panel commits content on a debounce: the canvas only exists here.
      this.canvas = this.content.querySelector('canvas');
      this.bindCanvas();
      this.renderSidebar();
      this.updateTimelineUi();
      if (!this.simulation) this.startSimulation();
      else {
        // Back from another tab: a fresh canvas element needs observing.
        this.resizeObserver?.disconnect();
        if (this.canvas) this.resizeObserver?.observe(this.canvas.parentElement ?? this.canvas);
        this.drawGraph();
      }
    });
  }

  // -------------------------------------------------------------------------
  // What-if lab
  // -------------------------------------------------------------------------

  private planLabel(plan: UkPlan): string {
    const name = (id: string) => this.twin?.nodes.find(n => n.id === id)?.name.replace(/^Albion Provisions\s*/, '') ?? id;
    if (plan.kind === 'close') return t('components.ukTwin.planClose', { site: name(plan.node) });
    if (plan.kind === 'reroute') return t('components.ukTwin.planReroute', { site: name(plan.node), target: name(plan.target) });
    return t('components.ukTwin.planNone');
  }

  private planOptions(selected: UkPlan): SafeHtml {
    const twin = this.twin!;
    const sites = twin.nodes.filter(n => n.owner === 'sample' && (n.type === 'factory' || n.type === 'distribution_centre'));
    const plans: UkPlan[] = [{ kind: 'none' }];
    for (const s of sites) plans.push({ kind: 'close', node: s.id });
    for (const s of sites) {
      for (const other of sites) {
        if (other.id !== s.id && other.type === s.type) plans.push({ kind: 'reroute', node: s.id, target: other.id });
      }
    }
    const current = encodePlan(selected);
    return joinSafeHtml(plans.map(p => {
      const value = encodePlan(p);
      return value === current
        ? safeHtml`<option value="${value}" selected>${this.planLabel(p)}</option>`
        : safeHtml`<option value="${value}">${this.planLabel(p)}</option>`;
    }));
  }

  private renderWhatIf(): SafeHtml {
    const twin = this.twin!;
    const scenario = UK_SCENARIOS.find(s => s.id === this.whatIfHazard) ?? UK_SCENARIOS[0]!;
    const hazard = scenario.select(twin.nodes);
    const normal = normalBaseline(twin.nodes, twin.edges);
    const none = evaluatePlan(twin.nodes, twin.edges, hazard, { kind: 'none' });
    const a = evaluatePlan(twin.nodes, twin.edges, hazard, this.planA);
    const b = evaluatePlan(twin.nodes, twin.edges, hazard, this.planB);
    const best = recommendPlan([none, a, b]);

    const hazardOptions = joinSafeHtml(UK_SCENARIOS.map(sc => sc.id === scenario.id
      ? safeHtml`<option value="${sc.id}" selected>${sc.name}</option>`
      : safeHtml`<option value="${sc.id}">${sc.name}</option>`));

    const columns: Array<[string, UkPlanResult, boolean]> = [
      [t('components.ukTwin.colNormal'), normal, false],
      [t('components.ukTwin.planNone'), none, best === none],
      ['A', a, best === a],
      ['B', b, best === b],
    ];
    const head = joinSafeHtml(columns.map(([label, , win]) => safeHtml`<th class="${win ? 'uk-whatif-best' : ''}">${label}</th>`));
    const row = (label: string, value: (r: UkPlanResult) => string): SafeHtml => safeHtml`<tr>
      <th scope="row">${label}</th>
      ${joinSafeHtml(columns.map(([, r, win]) => safeHtml`<td class="${win ? 'uk-whatif-best' : ''}">${value(r)}</td>`))}
    </tr>`;

    return safeHtml`<div class="uk-whatif">
      <label class="uk-whatif-field"><span>${t('components.ukTwin.hazard')}</span>
        <select data-uk-whatif="hazard">${hazardOptions}</select></label>
      <label class="uk-whatif-field"><span>A</span>
        <select data-uk-whatif="a">${this.planOptions(this.planA)}</select></label>
      <label class="uk-whatif-field"><span>B</span>
        <select data-uk-whatif="b">${this.planOptions(this.planB)}</select></label>
      <table class="uk-whatif-table">
        <thead><tr><th></th>${head}</tr></thead>
        <tbody>
          ${row(t('components.ukTwin.metricService'), r => `${(r.serviceLevel * 100).toFixed(1)}%`)}
          ${row(t('components.ukTwin.metricDelivery'), r => `${r.deliveryHours.toFixed(1)} h`)}
          ${row(t('components.ukTwin.metricCost'), r => r.costIndex.toFixed(0))}
        </tbody>
      </table>
      ${best ? safeHtml`<div class="uk-whatif-recommend">${t('components.ukTwin.recommend', { plan: this.planLabel(best.plan) })}</div>` : safeHtml``}
      <div class="uk-twin-hint">${t('components.ukTwin.assumptions')}</div>
    </div>`;
  }

  // -------------------------------------------------------------------------
  // Critical nodes (N-1 / N-2)
  // -------------------------------------------------------------------------

  private renderCritical(): SafeHtml {
    if (!this.twin) return safeHtml``;
    if (!this.criticalEntries || !this.criticalPairs) {
      // ~112 N-1 cascades + pairs over the top candidates; cheap enough to
      // compute synchronously once and cache for the panel's lifetime.
      this.criticalEntries = rankCriticalNodes(this.twin.nodes, this.twin.edges, 12);
      this.criticalPairs = rankCriticalPairs(this.twin.nodes, this.twin.edges, { candidates: 10, top: 6 });
    }
    const maxSingle = this.criticalEntries[0]?.score || 1;
    const rows = joinSafeHtml(this.criticalEntries.map((entry, i) => safeHtml`<div class="uk-impact-row uk-crit-row">
      <span class="uk-crit-rank">${String(i + 1)}</span>
      <button class="uk-impact-name" data-uk-crit="${entry.node.id}" title="${t('components.ukTwin.critSimulate')}">${entry.node.name}</button>
      <span class="uk-impact-type">${UK_NODE_TYPE_LABELS[entry.node.type]}</span>
      <span class="uk-impact-bar"><span style="width:${((entry.score / maxSingle) * 100).toFixed(1)}%;background:${LEVEL_COLORS.severe}"></span></span>
      <span class="uk-impact-pct">${(entry.score * 100).toFixed(1)}%</span>
    </div>`));
    const maxPair = this.criticalPairs[0]?.score || 1;
    const pairs = joinSafeHtml(this.criticalPairs.map(pair => safeHtml`<div class="uk-impact-row uk-crit-row">
      <button class="uk-impact-name uk-crit-pair" data-uk-crit="${pair.a.id}|${pair.b.id}" title="${t('components.ukTwin.critSimulate')}">${pair.a.name} + ${pair.b.name}</button>
      <span class="uk-impact-bar"><span style="width:${((pair.score / maxPair) * 100).toFixed(1)}%;background:${LEVEL_COLORS.down}"></span></span>
      <span class="uk-impact-pct">${(pair.score * 100).toFixed(1)}%</span>
      <span class="uk-crit-synergy" title="${t('components.ukTwin.pairSynergy')}">+${(pair.synergy * 100).toFixed(1)}</span>
    </div>`));
    return safeHtml`<div class="uk-critical">
      <div class="uk-crit-hint">${t('components.ukTwin.critHint')}</div>
      <div class="uk-crit-heading">${t('components.ukTwin.critN1Heading')}</div>
      <div class="uk-impact-list">${rows}</div>
      <div class="uk-crit-heading">${t('components.ukTwin.critN2Heading')}</div>
      <div class="uk-impact-list">${pairs}</div>
    </div>`;
  }

  private renderSidebar(): void {
    const sidebar = this.content.querySelector('.uk-twin-sidebar');
    if (!sidebar) return;
    const summary = this.summary;
    if (!summary) {
      sidebar.innerHTML = '';
      const idle = document.createElement('div');
      idle.className = 'uk-twin-idle';
      idle.textContent = t('components.ukTwin.idle');
      sidebar.appendChild(idle);
      return;
    }
    const pct = Math.round(summary.serviceDisruption * 100);
    const bar = (level: UkImpactLevel, label: string): SafeHtml =>
      safeHtml`<span class="uk-level uk-level-${level}">${summary.counts[level]} ${label}</span>`;
    const rows = joinSafeHtml(summary.impacts.slice(0, 12).map(i =>
      safeHtml`<div class="uk-impact-row">
        <span class="uk-impact-dot" style="background:${LEVEL_COLORS[i.level]}"></span>
        <button class="uk-impact-name" data-uk-impact-focus data-lat="${i.node.lat}" data-lon="${i.node.lon}" title="${t('components.ukCrisisMonitor.showOnMap')}">${i.node.name}</button>
        <span class="uk-impact-type">${UK_NODE_TYPE_LABELS[i.node.type]}${i.direct ? ' · ' + t('components.ukTwin.direct') : ''}</span>
        <span class="uk-impact-bar"><span style="width:${Math.round(i.loss * 100)}%;background:${LEVEL_COLORS[i.level]}"></span></span>
        <span class="uk-impact-pct">${Math.round(i.loss * 100)}%</span>
      </div>`));
    const html = safeHtml`
      <div class="uk-twin-counts">
        ${bar('down', t('components.ukTwin.down'))}
        ${bar('severe', t('components.ukTwin.severe'))}
        ${bar('degraded', t('components.ukTwin.degraded'))}
        ${bar('minor', t('components.ukTwin.minor'))}
        <span class="uk-service">${t('components.ukTwin.serviceDisruption', { pct: String(pct) })}</span>
      </div>
      <div class="uk-impact-list">${rows}</div>`;
    // Same escaped-template discipline as setSafeContent, scoped to the subtree.
    setTrustedHtml(sidebar as HTMLElement, trustedHtml(html.toString(), 'Cascade summary built with safeHtml; every interpolated value is escaped'));
  }

  // -------------------------------------------------------------------------
  // Force graph on canvas
  // -------------------------------------------------------------------------

  private startSimulation(): void {
    if (!this.twin || !this.canvas) return;
    const byId = new Map<string, SimNode>();
    this.simNodes = this.twin.nodes.map(n => {
      const sim: SimNode = { id: n.id, ref: n };
      byId.set(n.id, sim);
      return sim;
    });
    this.simLinks = this.twin.edges
      .filter(e => byId.has(e.from) && byId.has(e.to))
      .map(e => ({ source: e.from, target: e.to, dependency: e.dependency }));

    const width = this.canvasWidth();
    this.simulation = d3.forceSimulation<SimNode>(this.simNodes)
      .force('link', d3.forceLink<SimNode, SimLink>(this.simLinks).id(d => d.id).distance(34).strength(l => 0.2 + l.dependency * 0.5))
      .force('charge', d3.forceManyBody().strength(-38))
      .force('center', d3.forceCenter(width / 2, GRAPH_HEIGHT / 2))
      .force('collide', d3.forceCollide(7))
      .on('tick', () => this.drawGraph());

    this.resizeObserver = new ResizeObserver(() => {
      const w = this.canvasWidth();
      this.simulation?.force('center', d3.forceCenter(w / 2, GRAPH_HEIGHT / 2));
      this.simulation?.alpha(0.3).restart();
    });
    this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
  }

  private canvasWidth(): number {
    const wrap = this.canvas?.parentElement;
    const width = Math.max(260, Math.floor(wrap?.clientWidth ?? 420));
    if (this.canvas && this.canvas.width !== width) this.canvas.width = width;
    return width;
  }

  private nodeAt(x: number, y: number): SimNode | null {
    let best: SimNode | null = null;
    let bestDist = 144; // 12px pick radius, squared
    for (const n of this.simNodes) {
      const dx = (n.x ?? 0) - x;
      const dy = (n.y ?? 0) - y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { best = n; bestDist = d; }
    }
    return best;
  }

  private bindCanvas(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const toLocal = (e: MouseEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    canvas.addEventListener('mousemove', (e) => {
      const next = this.nodeAt(...toLocal(e));
      if (next !== this.hovered) {
        this.hovered = next;
        canvas.style.cursor = next ? 'pointer' : 'default';
        canvas.title = next
          ? `${next.ref.name} — ${UK_NODE_TYPE_LABELS[next.ref.type]} (${t('components.ukTwin.clickToToggle')})`
          : '';
        this.drawGraph();
      }
    });
    canvas.addEventListener('mouseleave', () => { this.hovered = null; this.drawGraph(); });
    canvas.addEventListener('click', (e) => {
      const hit = this.nodeAt(...toLocal(e));
      if (hit) this.toggleFailed(hit.id);
    });
  }

  private drawGraph(): void {
    const canvas = this.canvas;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const width = this.canvasWidth();
    ctx.clearRect(0, 0, width, GRAPH_HEIGHT);

    ctx.lineWidth = 0.6;
    for (const link of this.simLinks) {
      const s = link.source as SimNode;
      const d = link.target as SimNode;
      if (s.x == null || d.x == null) continue;
      const sourceLoss = this.losses.get(s.id) ?? 0;
      ctx.strokeStyle = sourceLoss >= 0.3
        ? `rgba(240, 62, 62, ${0.15 + sourceLoss * 0.45})`
        : 'rgba(128, 150, 140, 0.18)';
      ctx.beginPath();
      ctx.moveTo(s.x!, s.y!);
      ctx.lineTo(d.x!, d.y!);
      ctx.stroke();
    }

    for (const n of this.simNodes) {
      if (n.x == null || n.y == null) continue;
      const loss = this.losses.get(n.id) ?? 0;
      const [r, g, b] = UK_NODE_TYPE_COLORS[n.ref.type];
      const radius = 2.5 + n.ref.criticality * 0.9 + (n === this.hovered ? 2 : 0);
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
      // Blend the type colour toward alarm red as capacity loss grows.
      const mix = Math.min(1, loss * 1.1);
      ctx.fillStyle = `rgb(${Math.round(r + (255 - r) * mix)}, ${Math.round(g * (1 - mix * 0.7))}, ${Math.round(b * (1 - mix * 0.75))})`;
      ctx.fill();
      if (this.failed.has(n.id) || n === this.hovered) {
        if (this.failed.has(n.id)) {
          ctx.strokeStyle = '#f03e3e';
          ctx.lineWidth = 2;
        } else {
          // Hover ring in the theme's ink so it is visible on light and dark.
          ctx.strokeStyle = getComputedStyle(canvas).color || 'rgba(230, 240, 235, 0.9)';
          ctx.lineWidth = 1.2;
        }
        ctx.stroke();
      }
    }
  }
}
