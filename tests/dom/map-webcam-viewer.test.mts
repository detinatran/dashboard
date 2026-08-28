import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearMapCctvNotice,
  closeMapWebcamViewer,
  openMapWebcamViewer,
  showMapCctvUnavailable,
} from '../../src/components/MapWebcamViewer';

describe('MapWebcamViewer', () => {
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('opens the OSIRIS camera workflow and cleans it up', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    openMapWebcamViewer(container, {
      webcamId: 'osiris-bg-sofia-tsarigradsko-uab',
      title: 'Tsarigradsko Shose (UAB)',
      lat: 42.662,
      lng: 23.376,
      category: 'traffic',
      country: 'Bulgaria',
    });

    const viewer = container.querySelector<HTMLElement>('.map-webcam-viewer');
    expect(viewer).not.toBeNull();
    expect(viewer?.getAttribute('aria-label')).toContain('Tsarigradsko Shose');
    await vi.waitFor(() => {
      expect(viewer?.querySelector<HTMLImageElement>('.map-webcam-viewer-image')?.src)
        .toContain('cdn.uab.org/images/cctv');
    });

    const rawFeed = viewer?.querySelector<HTMLAnchorElement>('.map-webcam-viewer-action[href*="cdn.uab.org"]');
    expect(rawFeed?.target).toBe('_blank');
    const minimize = viewer?.querySelector<HTMLButtonElement>('[aria-label="Minimize camera viewer"]');
    minimize?.click();
    expect(viewer?.classList.contains('minimized')).toBe(true);
    expect(minimize?.getAttribute('aria-expanded')).toBe('false');
    minimize?.click();
    expect(viewer?.classList.contains('minimized')).toBe(false);
    viewer?.querySelector<HTMLButtonElement>('[aria-label="Toggle fullscreen camera"]')?.click();
    expect(viewer?.classList.contains('expanded')).toBe(true);

    closeMapWebcamViewer(container);
    expect(container.querySelector('.map-webcam-viewer')).toBeNull();
  });

  it('keeps an unavailable result visible until dismissed or cleared', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    showMapCctvUnavailable(container, { lat: 0, lon: 0 }, 150);
    expect(container.querySelector('.map-cctv-notice')?.textContent).toContain('NO CCTV SOURCE');
    expect(container.querySelector('.map-cctv-notice')?.textContent).toContain('150 km');
    clearMapCctvNotice(container);
    expect(container.querySelector('.map-cctv-notice')).toBeNull();
  });
});
