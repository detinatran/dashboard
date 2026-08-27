import type { MapContainer } from './MapContainer';
import {
  aoiReportToCsv,
  appendAoiEvents,
  createAoiShape,
  diffAoiSweep,
  downloadAoiFile,
  formatAoiAgo,
  formatAoiArea,
  formatAoiDistance,
  initialAoiDrawState,
  loadAoiShapes,
  measureAoi,
  queryAoiRing,
  reduceAoiDrawing,
  saveAoiShapes,
  selectAoiEntities,
  shapesToGeoJson,
  type AoiDrawAction,
  type AoiDrawMode,
  type AoiDrawState,
  type AoiEntityGroup,
  type AoiReport,
  type AoiShape,
  type AoiWatchBaseline,
  type AoiWatchEvent,
  type LngLat,
} from '@/services/aoi-tools';

export interface AoiWorkspaceOptions {
  map: MapContainer;
  getEntityGroups: () => AoiEntityGroup[];
}

const DRAW_MODES: Array<{ mode: AoiDrawMode; label: string; hint: string }> = [
  { mode: 'polygon', label: 'Polygon', hint: 'Click 3+ points; double-click to finish' },
  { mode: 'rectangle', label: 'Box', hint: 'Click two opposite corners' },
  { mode: 'circle', label: 'Radius', hint: 'Click a center, then the radius' },
  { mode: 'line', label: 'Measure', hint: 'Click 2+ points; double-click to finish' },
];

function button(label: string, className: string, title?: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  if (title) element.title = title;
  return element;
}

function textElement(tag: 'div' | 'span' | 'p' | 'strong', className: string, text: string): HTMLElement {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

export class AoiWorkspace {
  private readonly map: MapContainer;
  private readonly getEntityGroups: () => AoiEntityGroup[];
  private readonly toggleButton: HTMLButtonElement;
  private readonly workspace: HTMLElement;
  private shapes: AoiShape[] = loadAoiShapes();
  private selectedShapeId: string | null = this.shapes[0]?.id ?? null;
  private watchedShapeIds = new Set<string>();
  private baselines = new Map<string, AoiWatchBaseline>();
  private events: AoiWatchEvent[] = [];
  private drawState: AoiDrawState | null = null;
  private pointer: LngLat | null = null;
  private drawReadout: HTMLElement | null = null;
  private watchTimer: number | null = null;
  private open = false;
  private destroyed = false;

  constructor(options: AoiWorkspaceOptions) {
    this.map = options.map;
    this.getEntityGroups = options.getEntityGroups;
    const toggleButton = document.getElementById('aoiWorkspaceToggle');
    const workspace = document.getElementById('aoiWorkspace');
    if (!(toggleButton instanceof HTMLButtonElement) || !workspace) {
      throw new Error('AOI workspace mounts are unavailable.');
    }
    this.toggleButton = toggleButton;
    this.workspace = workspace;
    this.toggleButton.addEventListener('click', this.handleToggle);
    this.toggleButton.disabled = false;
    this.toggleButton.removeAttribute('aria-busy');
    this.workspace.addEventListener('keydown', this.handleKeyDown);
    this.watchTimer = window.setInterval(() => this.sweepWatches(this.open), 15_000);
    this.render();
    this.syncMapOverlay();
  }

  private readonly handleToggle = (): void => {
    this.setOpen(!this.open);
  };

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (this.drawState) this.applyDrawAction({ type: 'cancel' });
      else this.setOpen(false);
      return;
    }
    if (!this.drawState || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      this.applyDrawAction({ type: 'undo' });
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.applyDrawAction({ type: 'finish' });
    }
  };

  private setOpen(open: boolean): void {
    this.open = open;
    this.workspace.hidden = !open;
    this.workspace.setAttribute('aria-hidden', String(!open));
    this.toggleButton.classList.toggle('active', open);
    this.toggleButton.setAttribute('aria-expanded', String(open));
    if (!open && this.drawState) this.stopDrawing();
    if (open) this.render();
  }

  private async startDrawing(mode: AoiDrawMode): Promise<void> {
    if (this.map.isGlobeMode()) this.map.switchToFlat();
    try {
      await this.map.whenRendererReady();
    } catch {
      return;
    }
    if (this.destroyed) return;
    const enabled = this.map.setAoiInteraction(mode, {
      onClick: (at) => this.applyDrawAction({ type: 'click', at }),
      onDoubleClick: () => this.applyDrawAction({ type: 'double-click' }),
      onPointerMove: (at) => {
        this.pointer = at;
        this.syncMapOverlay();
        this.updateDrawReadout();
      },
    });
    if (!enabled) return;
    this.drawState = initialAoiDrawState(mode);
    this.pointer = null;
    this.render();
    this.syncMapOverlay();
  }

  private stopDrawing(): void {
    this.drawState = null;
    this.pointer = null;
    this.map.setAoiInteraction(null, null);
    this.syncMapOverlay();
    this.render();
  }

  private applyDrawAction(action: AoiDrawAction): void {
    if (!this.drawState) return;
    const transition = reduceAoiDrawing(this.drawState, action);
    this.drawState = transition.state;
    if (transition.result) {
      const shape = createAoiShape(transition.result, this.shapes, this.shapes.length);
      this.shapes = [...this.shapes, shape];
      this.selectedShapeId = shape.id;
      saveAoiShapes(this.shapes);
      this.stopDrawing();
      return;
    }
    if (transition.cancelled) {
      this.stopDrawing();
      return;
    }
    this.render();
    this.syncMapOverlay();
  }

  private syncMapOverlay(): void {
    this.map.setAoiOverlay({
      shapes: this.shapes,
      draft: this.drawState,
      pointer: this.pointer,
      selectedShapeId: this.selectedShapeId,
      watchedShapeIds: [...this.watchedShapeIds],
    });
  }

  private getReport(shape: AoiShape | undefined): AoiReport {
    const ring = shape ? queryAoiRing(shape) : null;
    return ring ? selectAoiEntities(ring, this.getEntityGroups()) : { total: 0, groups: [] };
  }

  private sweepWatches(renderAfter = true): void {
    if (this.watchedShapeIds.size === 0) {
      if (renderAfter) this.render();
      return;
    }
    let nextEvents = this.events;
    for (const shapeId of this.watchedShapeIds) {
      const shape = this.shapes.find((candidate) => candidate.id === shapeId);
      if (!shape) continue;
      const report = this.getReport(shape);
      const diff = diffAoiSweep(shapeId, report, this.baselines.get(shapeId) ?? null);
      this.baselines.set(shapeId, diff.baseline);
      nextEvents = appendAoiEvents(nextEvents, diff.events);
    }
    const changed = nextEvents !== this.events;
    this.events = nextEvents;
    if (renderAfter || changed) this.render();
  }

  private toggleWatch(shape: AoiShape): void {
    if (this.watchedShapeIds.has(shape.id)) {
      this.watchedShapeIds.delete(shape.id);
      this.baselines.delete(shape.id);
    } else if (queryAoiRing(shape)) {
      this.watchedShapeIds.add(shape.id);
      const report = this.getReport(shape);
      this.baselines.set(shape.id, diffAoiSweep(shape.id, report, null).baseline);
    }
    this.render();
    this.syncMapOverlay();
  }

  private deleteShape(shape: AoiShape): void {
    this.shapes = this.shapes.filter((candidate) => candidate.id !== shape.id);
    this.watchedShapeIds.delete(shape.id);
    this.baselines.delete(shape.id);
    this.events = this.events.filter((event) => event.aoiId !== shape.id);
    if (this.selectedShapeId === shape.id) this.selectedShapeId = this.shapes[0]?.id ?? null;
    saveAoiShapes(this.shapes);
    this.render();
    this.syncMapOverlay();
  }

  private renameShape(shape: AoiShape): void {
    const nextName = window.prompt('AOI name', shape.name)?.trim();
    if (!nextName || nextName === shape.name) return;
    this.shapes = this.shapes.map((candidate) => candidate.id === shape.id
      ? { ...candidate, name: nextName.slice(0, 80) }
      : candidate);
    saveAoiShapes(this.shapes);
    this.render();
    this.syncMapOverlay();
  }

  private exportShapes(): void {
    if (this.shapes.length === 0) return;
    downloadAoiFile(
      `worldmonitor-aoi-${new Date().toISOString().slice(0, 10)}.geojson`,
      JSON.stringify(shapesToGeoJson(this.shapes), null, 2),
      'application/geo+json',
    );
  }

  private exportReport(shape: AoiShape, report: AoiReport): void {
    const slug = shape.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'aoi';
    downloadAoiFile(`${slug}-contents.csv`, aoiReportToCsv(shape, report), 'text/csv;charset=utf-8');
  }

  private createHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'aoi-workspace-header';
    const titleWrap = document.createElement('div');
    titleWrap.append(
      textElement('strong', 'aoi-workspace-title', 'AOI workspace'),
      textElement('span', 'aoi-workspace-kicker', `${this.shapes.length} saved · ${this.watchedShapeIds.size} watched`),
    );
    const close = button('×', 'aoi-icon-btn', 'Close AOI workspace');
    close.setAttribute('aria-label', 'Close AOI workspace');
    close.addEventListener('click', () => this.setOpen(false));
    header.append(titleWrap, close);
    return header;
  }

  private createDrawTools(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'aoi-section aoi-draw-section';
    section.appendChild(textElement('div', 'aoi-section-label', 'Draw & measure'));
    const grid = document.createElement('div');
    grid.className = 'aoi-mode-grid';
    for (const item of DRAW_MODES) {
      const modeButton = button(item.label, 'aoi-mode-btn', item.hint);
      modeButton.dataset.mode = item.mode;
      const active = this.drawState?.mode === item.mode;
      modeButton.classList.toggle('active', active);
      modeButton.setAttribute('aria-pressed', String(active));
      modeButton.addEventListener('click', () => void this.startDrawing(item.mode));
      grid.appendChild(modeButton);
    }
    section.appendChild(grid);

    const readout = textElement('div', 'aoi-draw-readout', 'Choose a tool to draw on the 2D map.');
    this.drawReadout = readout;
    section.appendChild(readout);
    if (this.drawState) {
      const actions = document.createElement('div');
      actions.className = 'aoi-inline-actions';
      const undo = button('Undo', 'aoi-action-btn');
      undo.disabled = this.drawState.points.length === 0;
      undo.addEventListener('click', () => this.applyDrawAction({ type: 'undo' }));
      const finish = button('Finish', 'aoi-action-btn primary');
      finish.disabled = !measureAoi(this.drawState.mode, this.drawState.points).closable;
      finish.addEventListener('click', () => this.applyDrawAction({ type: 'finish' }));
      const cancel = button('Cancel', 'aoi-action-btn');
      cancel.addEventListener('click', () => this.applyDrawAction({ type: 'cancel' }));
      actions.append(undo, finish, cancel);
      section.appendChild(actions);
      this.updateDrawReadout();
    }
    return section;
  }

  private updateDrawReadout(): void {
    if (!this.drawReadout || !this.drawState) return;
    const previewPoints = this.pointer && this.drawState.points.length > 0
      ? [...this.drawState.points, this.pointer]
      : this.drawState.points;
    const progress = measureAoi(this.drawState.mode, previewPoints);
    const mode = DRAW_MODES.find((item) => item.mode === this.drawState?.mode);
    const measurement = this.drawState.mode === 'line'
      ? formatAoiDistance(progress.lengthKm)
      : `${formatAoiArea(progress.areaKm2)} · ${formatAoiDistance(progress.lengthKm)}`;
    this.drawReadout.textContent = `${mode?.hint ?? ''} · ${this.drawState.points.length} point(s) · ${measurement}`;
  }

  private createShapeList(): HTMLElement {
    const section = document.createElement('section');
    section.className = 'aoi-section';
    section.appendChild(textElement('div', 'aoi-section-label', 'Saved geometry'));
    if (this.shapes.length === 0) {
      section.appendChild(textElement('p', 'aoi-empty', 'No AOIs yet. Draw an area or a measurement path.'));
      return section;
    }
    const list = document.createElement('div');
    list.className = 'aoi-shape-list';
    for (const shape of this.shapes) {
      const card = document.createElement('article');
      card.className = 'aoi-shape-card';
      card.classList.toggle('selected', shape.id === this.selectedShapeId);
      card.style.setProperty('--aoi-color', shape.color);

      const select = button('', 'aoi-shape-select');
      select.setAttribute('aria-label', `Select ${shape.name}`);
      select.addEventListener('click', () => {
        this.selectedShapeId = shape.id;
        this.render();
        this.syncMapOverlay();
      });
      select.append(
        textElement('strong', 'aoi-shape-name', shape.name),
        textElement(
          'span',
          'aoi-shape-meta',
          shape.kind === 'line'
            ? formatAoiDistance(shape.perimeterKm)
            : `${formatAoiArea(shape.areaKm2)} · ${formatAoiDistance(shape.perimeterKm)}`,
        ),
      );

      const actions = document.createElement('div');
      actions.className = 'aoi-card-actions';
      if (queryAoiRing(shape)) {
        const watch = button(this.watchedShapeIds.has(shape.id) ? 'Watching' : 'Watch', 'aoi-mini-btn');
        const watching = this.watchedShapeIds.has(shape.id);
        watch.classList.toggle('active', watching);
        watch.setAttribute('aria-pressed', String(watching));
        watch.addEventListener('click', () => this.toggleWatch(shape));
        actions.appendChild(watch);
      }
      const rename = button('Rename', 'aoi-mini-btn');
      rename.addEventListener('click', () => this.renameShape(shape));
      const remove = button('Delete', 'aoi-mini-btn danger');
      remove.addEventListener('click', () => this.deleteShape(shape));
      actions.append(rename, remove);
      card.append(select, actions);
      list.appendChild(card);
    }
    section.appendChild(list);
    return section;
  }

  private createReport(): HTMLElement | null {
    const shape = this.shapes.find((candidate) => candidate.id === this.selectedShapeId);
    if (!shape || !queryAoiRing(shape)) return null;
    const report = this.getReport(shape);
    const section = document.createElement('section');
    section.className = 'aoi-section';
    const heading = document.createElement('div');
    heading.className = 'aoi-section-heading';
    heading.append(
      textElement('div', 'aoi-section-label', `Inside ${shape.name}`),
      textElement('strong', 'aoi-report-total', String(report.total)),
    );
    section.appendChild(heading);
    if (report.groups.length === 0) {
      section.appendChild(textElement('p', 'aoi-empty', 'No tracked entities are currently inside this AOI.'));
    } else {
      const groups = document.createElement('div');
      groups.className = 'aoi-report-groups';
      for (const group of report.groups) {
        const row = document.createElement('div');
        row.className = 'aoi-report-row';
        row.style.setProperty('--aoi-color', group.color);
        row.append(
          textElement('span', 'aoi-report-label', group.label),
          textElement('strong', 'aoi-report-count', String(group.count)),
        );
        groups.appendChild(row);
      }
      section.appendChild(groups);
      const exportButton = button('Export contents CSV', 'aoi-action-btn wide');
      exportButton.addEventListener('click', () => this.exportReport(shape, report));
      section.appendChild(exportButton);
    }
    return section;
  }

  private createWatchLog(): HTMLElement | null {
    if (this.watchedShapeIds.size === 0) return null;
    const section = document.createElement('section');
    section.className = 'aoi-section';
    section.appendChild(textElement('div', 'aoi-section-label', 'Tripwire activity'));
    if (this.events.length === 0) {
      section.appendChild(textElement('p', 'aoi-empty', 'Baselines captured. New entries and exits will appear here.'));
      return section;
    }
    const log = document.createElement('div');
    log.className = 'aoi-watch-log';
    for (const event of this.events.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = `aoi-watch-event ${event.kind}`;
      row.style.setProperty('--aoi-color', event.color);
      row.append(
        textElement('span', 'aoi-watch-kind', event.kind === 'enter' ? 'IN' : 'OUT'),
        textElement('span', 'aoi-watch-label', `${event.label} · ${event.layerLabel}`),
        textElement('span', 'aoi-watch-time', formatAoiAgo(event.at)),
      );
      log.appendChild(row);
    }
    section.appendChild(log);
    return section;
  }

  private render(): void {
    if (this.destroyed) return;
    this.workspace.classList.toggle('drawing', this.drawState !== null);
    this.workspace.replaceChildren();
    this.workspace.append(this.createHeader(), this.createDrawTools(), this.createShapeList());
    const report = this.createReport();
    const watchLog = this.createWatchLog();
    if (report) this.workspace.appendChild(report);
    if (watchLog) this.workspace.appendChild(watchLog);
    const footer = document.createElement('footer');
    footer.className = 'aoi-workspace-footer';
    const exportButton = button('Export all GeoJSON', 'aoi-action-btn wide');
    exportButton.disabled = this.shapes.length === 0;
    exportButton.addEventListener('click', () => this.exportShapes());
    footer.appendChild(exportButton);
    this.workspace.appendChild(footer);
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.toggleButton.removeEventListener('click', this.handleToggle);
    this.workspace.removeEventListener('keydown', this.handleKeyDown);
    if (this.watchTimer !== null) window.clearInterval(this.watchTimer);
    this.watchTimer = null;
    this.map.setAoiInteraction(null, null);
    this.map.setAoiOverlay({
      shapes: [],
      draft: null,
      pointer: null,
      selectedShapeId: null,
      watchedShapeIds: [],
    });
    this.workspace.replaceChildren();
  }
}
