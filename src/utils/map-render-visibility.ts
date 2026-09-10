/** Combines independent pause owners; becoming visible must not dismiss a modal pause. */
export class MapRenderVisibility {
  private manual = false;
  private offscreen = false;
  private hidden = false;
  private observer: IntersectionObserver | null = null;
  private document: Document | null = null;
  private readonly onVisibility = () => {
    this.hidden = this.document?.hidden ?? false;
    this.apply();
  };

  constructor(private readonly notify: (paused: boolean) => void) {}

  observe(element: HTMLElement): void {
    this.document = element.ownerDocument;
    this.document.addEventListener('visibilitychange', this.onVisibility);
    this.onVisibility();
    if (typeof IntersectionObserver === 'function') {
      this.observer = new IntersectionObserver((entries) => {
        if (!this.document) return;
        // A batch may include several transitions; the last one owns the state.
        for (const entry of entries) {
          if (entry.target === element) this.offscreen = !entry.isIntersecting;
        }
        this.apply();
      }, { rootMargin: '150px' });
      this.observer.observe(element);
    }
  }

  setManual(paused: boolean): void { this.manual = paused; this.apply(); }
  setOffscreen(paused: boolean): void { this.offscreen = paused; this.apply(); }
  apply(): void { this.notify(this.manual || this.offscreen || this.hidden); }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.document?.removeEventListener('visibilitychange', this.onVisibility);
    this.document = null;
  }
}
