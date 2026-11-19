// CrisisTwin UK guide tour: a lightweight spotlight walkthrough of the four
// questions the edition answers (monitor → map → risk → twin → what-if). No
// library — a fixed spotlight box (dimming via its huge box-shadow), a card
// positioned near the target, and keyboard/resize handling. Auto-runs once per
// browser (localStorage) on desktop; replayable from the header ✦ Tour button.

import { t } from '@/services/i18n';

const SEEN_KEY = 'wm-uk-tour-v1';
const SPOT_PADDING = 8;

interface TourStep {
  /** First selector that matches wins; a step with no match is skipped. */
  target: string;
  titleKey: string;
  bodyKey: string;
}

const STEPS: TourStep[] = [
  { target: '[data-panel="uk-crisis-monitor"]', titleKey: 'components.ukTour.monitorTitle', bodyKey: 'components.ukTour.monitorBody' },
  { target: '#mapSection', titleKey: 'components.ukTour.mapTitle', bodyKey: 'components.ukTour.mapBody' },
  { target: '[data-panel="uk-risk"]', titleKey: 'components.ukTour.riskTitle', bodyKey: 'components.ukTour.riskBody' },
  { target: '[data-panel="uk-twin"]', titleKey: 'components.ukTour.twinTitle', bodyKey: 'components.ukTour.twinBody' },
  { target: '[data-uk-twin-tab="whatif"]', titleKey: 'components.ukTour.whatifTitle', bodyKey: 'components.ukTour.whatifBody' },
  { target: '#ukTourBtn', titleKey: 'components.ukTour.doneTitle', bodyKey: 'components.ukTour.doneBody' },
];

class UkGuideTour {
  private backdrop: HTMLElement | null = null;
  private spot: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private index = 0;
  private active: TourStep[] = [];
  private repositionFrame: number | null = null;
  private readonly reposition = () => {
    if (this.repositionFrame !== null) return;
    this.repositionFrame = requestAnimationFrame(() => {
      this.repositionFrame = null;
      this.place();
    });
  };
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.finish();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') this.next();
    else if (e.key === 'ArrowLeft') this.back();
  };

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  start(): void {
    if (this.isOpen()) return;
    this.active = STEPS.filter(s => document.querySelector(s.target));
    if (!this.active.length) return;
    this.index = 0;

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'uk-tour-backdrop';
    this.spot = document.createElement('div');
    this.spot.className = 'uk-tour-spot';
    this.card = document.createElement('div');
    this.card.className = 'uk-tour-card';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-tour]')?.dataset.tour;
      if (action === 'next') this.next();
      else if (action === 'back') this.back();
      else if (action === 'skip') this.finish();
    });
    document.body.append(this.backdrop, this.spot, this.card);
    document.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.reposition);
    window.addEventListener('scroll', this.reposition, true);
    this.show();
  }

  private step(): TourStep {
    return this.active[this.index]!;
  }

  private targetEl(): HTMLElement | null {
    return document.querySelector<HTMLElement>(this.step().target);
  }

  private show(): void {
    const el = this.targetEl();
    if (!el) {
      this.next();
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.renderCard();
    // Let the smooth scroll settle before measuring.
    window.setTimeout(() => this.place(), 320);
    this.place();
  }

  private renderCard(): void {
    const card = this.card;
    if (!card) return;
    const total = this.active.length;
    const dots = this.active
      .map((_, i) => `<span class="uk-tour-dot${i === this.index ? ' active' : ''}"></span>`)
      .join('');
    const last = this.index === total - 1;
    card.innerHTML = `
      <div class="uk-tour-step">${t('components.ukTour.step', { current: String(this.index + 1), total: String(total) })}</div>
      <div class="uk-tour-title"></div>
      <div class="uk-tour-body"></div>
      <div class="uk-tour-actions">
        <span class="uk-tour-dots">${dots}</span>
        <button class="uk-tour-ghost" data-tour="skip">${t('components.ukTour.skip')}</button>
        ${this.index > 0 ? `<button class="uk-tour-ghost" data-tour="back">${t('components.ukTour.back')}</button>` : ''}
        <button class="uk-tour-next" data-tour="next">${last ? t('components.ukTour.done') : t('components.ukTour.next')}</button>
      </div>`;
    // Step copy goes through textContent: no markup, no injection surface.
    card.querySelector('.uk-tour-title')!.textContent = t(this.step().titleKey);
    card.querySelector('.uk-tour-body')!.textContent = t(this.step().bodyKey);
    card.querySelector<HTMLButtonElement>('.uk-tour-next')?.focus();
  }

  private place(): void {
    const el = this.targetEl();
    const spot = this.spot;
    const card = this.card;
    if (!el || !spot || !card) return;
    const r = el.getBoundingClientRect();
    const pad = SPOT_PADDING;
    spot.style.top = `${r.top - pad}px`;
    spot.style.left = `${r.left - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;

    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const margin = 12;
    // Prefer beside the target (right, then left), else below, else above.
    let top: number;
    let left: number;
    if (r.right + margin + cw <= window.innerWidth - 8) {
      left = r.right + margin;
      top = r.top;
    } else if (r.left - margin - cw >= 8) {
      left = r.left - margin - cw;
      top = r.top;
    } else if (r.bottom + margin + ch <= window.innerHeight - 8) {
      left = r.left;
      top = r.bottom + margin;
    } else {
      left = r.left;
      top = Math.max(8, r.top - margin - ch);
    }
    card.style.top = `${Math.min(Math.max(8, top), window.innerHeight - ch - 8)}px`;
    card.style.left = `${Math.min(Math.max(8, left), window.innerWidth - cw - 8)}px`;
  }

  private next(): void {
    if (this.index >= this.active.length - 1) {
      this.finish();
      return;
    }
    this.index += 1;
    this.show();
  }

  private back(): void {
    if (this.index === 0) return;
    this.index -= 1;
    this.show();
  }

  private finish(): void {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
    document.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.reposition);
    window.removeEventListener('scroll', this.reposition, true);
    if (this.repositionFrame !== null) cancelAnimationFrame(this.repositionFrame);
    this.repositionFrame = null;
    this.backdrop?.remove();
    this.spot?.remove();
    this.card?.remove();
    this.backdrop = this.spot = this.card = null;
  }
}

let tour: UkGuideTour | null = null;

/** Binds the header ✦ Tour button and auto-runs once per browser on desktop. */
export function initUkGuideTour(): void {
  tour ??= new UkGuideTour();
  document.getElementById('ukTourBtn')?.addEventListener('click', () => tour?.start());
  let seen = false;
  try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch { seen = true; }
  if (!seen && window.innerWidth > 900) {
    window.setTimeout(() => {
      if (!tour?.isOpen()) tour?.start();
    }, 2500);
  }
}
