import type { WebcamEntry } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import { fetchWebcamImage, getBundledCctvCamera } from '@/services/webcams';
import { isPinned, pinWebcam } from '@/services/webcams/pinned-store';

interface ActiveViewer {
  root: HTMLElement;
  cleanup: () => void;
}

const activeViewers = new WeakMap<HTMLElement, ActiveViewer>();

export function clearMapCctvNotice(container: HTMLElement): void {
  container.querySelector('.map-cctv-notice')?.remove();
}

export function showMapCctvUnavailable(
  container: HTMLElement,
  location: { lat: number; lon: number },
  radiusKm: number,
): void {
  clearMapCctvNotice(container);
  const notice = document.createElement('section');
  notice.className = 'map-cctv-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-label', 'CCTV search result');

  const copy = document.createElement('div');
  const heading = document.createElement('strong');
  heading.textContent = 'NO CCTV SOURCE';
  const detail = document.createElement('span');
  detail.textContent = `No public camera found within ${radiusKm} km of ${location.lat.toFixed(2)}, ${location.lon.toFixed(2)}.`;
  const hint = document.createElement('span');
  hint.className = 'map-cctv-notice-hint';
  hint.textContent = 'Select another marker, or keep CCTV enabled to browse camera icons.';
  copy.append(heading, detail, hint);

  const close = makeButton('×', 'map-cctv-notice-close', 'Dismiss CCTV search result');
  close.addEventListener('click', () => notice.remove());
  notice.append(copy, close);
  container.appendChild(notice);
}

function safeHttpUrl(value: string | undefined): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch {
    return '';
  }
}

function cacheBustedUrl(value: string, generation: number): string {
  const url = new URL(value);
  url.searchParams.set('_wm', `${Date.now()}-${generation}`);
  return url.href;
}

function makeButton(label: string, className: string, title: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  return button;
}

function formatCameraId(camera: WebcamEntry): string {
  const lat = Math.abs(Math.round(camera.lat * 10_000)).toString().padStart(4, '0').slice(-4);
  const lng = Math.abs(Math.round(camera.lng * 10_000)).toString().padStart(4, '0').slice(-4);
  return `CAM-${lat}-${lng}`;
}

export function closeMapWebcamViewer(container: HTMLElement): void {
  const active = activeViewers.get(container);
  if (!active) return;
  active.cleanup();
  activeViewers.delete(container);
}

export function openMapWebcamViewer(container: HTMLElement, camera: WebcamEntry): void {
  closeMapWebcamViewer(container);
  clearMapCctvNotice(container);

  const osirisCamera = getBundledCctvCamera(camera.webcamId);
  const root = document.createElement('section');
  root.className = 'map-webcam-viewer';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'false');
  root.setAttribute('aria-label', `Camera feed: ${camera.title || camera.webcamId}`);

  const header = document.createElement('header');
  header.className = 'map-webcam-viewer-header';

  const telemetry = document.createElement('div');
  telemetry.className = 'map-webcam-viewer-telemetry';
  const telemetryLeft = document.createElement('span');
  telemetryLeft.textContent = `${formatCameraId(camera)}  ${camera.lat.toFixed(4)}, ${camera.lng.toFixed(4)}`;
  const telemetryRight = document.createElement('span');
  const clock = document.createElement('time');
  const syncClock = () => {
    clock.textContent = `${new Date().toISOString().slice(11, 19)}Z`;
  };
  syncClock();
  telemetryRight.append(clock, '  LIVE UPLINK');
  telemetry.append(telemetryLeft, telemetryRight);

  const headingRow = document.createElement('div');
  headingRow.className = 'map-webcam-viewer-heading';
  const cameraGlyph = document.createElement('span');
  cameraGlyph.className = 'map-webcam-viewer-glyph';
  cameraGlyph.setAttribute('aria-hidden', 'true');
  const headingCopy = document.createElement('div');
  headingCopy.className = 'map-webcam-viewer-heading-copy';
  const title = document.createElement('h3');
  title.textContent = camera.title || camera.webcamId;
  const subtitle = document.createElement('p');
  subtitle.textContent = [
    osirisCamera?.city,
    camera.country,
    `SOURCE: ${osirisCamera?.source || 'WINDY'}`,
  ].filter(Boolean).join(' · ');
  headingCopy.append(title, subtitle);

  const controls = document.createElement('div');
  controls.className = 'map-webcam-viewer-controls';
  const minimizeButton = makeButton('▾', 'map-webcam-viewer-icon-btn', 'Minimize camera viewer');
  const refreshButton = makeButton('↻', 'map-webcam-viewer-icon-btn', 'Refresh camera feed');
  const expandButton = makeButton('⛶', 'map-webcam-viewer-icon-btn', 'Toggle fullscreen camera');
  const closeButton = makeButton('×', 'map-webcam-viewer-icon-btn danger', 'Close camera viewer');
  minimizeButton.setAttribute('aria-expanded', 'true');
  expandButton.setAttribute('aria-pressed', 'false');
  controls.append(minimizeButton, refreshButton, expandButton, closeButton);
  headingRow.append(cameraGlyph, headingCopy, controls);
  header.append(telemetry, headingRow);

  const media = document.createElement('div');
  media.className = 'map-webcam-viewer-media';
  const mediaStatus = document.createElement('div');
  mediaStatus.className = 'map-webcam-viewer-media-status';
  mediaStatus.textContent = 'ACQUIRING CAMERA FEED…';
  media.appendChild(mediaStatus);

  const liveBadge = document.createElement('div');
  liveBadge.className = 'map-webcam-viewer-live-badge';
  liveBadge.textContent = osirisCamera?.streamType === 'iframe' ? '● LIVE SOURCE' : '● LIVE CAMERA';
  media.appendChild(liveBadge);

  const footer = document.createElement('footer');
  footer.className = 'map-webcam-viewer-footer';
  const feedMeta = document.createElement('div');
  feedMeta.className = 'map-webcam-viewer-feed-meta';
  const feedType = document.createElement('span');
  feedType.textContent = `FEED  ${(osirisCamera?.streamType || 'preview').toUpperCase()}`;
  const feedState = document.createElement('span');
  feedState.className = 'map-webcam-viewer-feed-state';
  feedState.textContent = 'CONNECTING';
  feedMeta.append(feedType, feedState);

  const actions = document.createElement('div');
  actions.className = 'map-webcam-viewer-actions';
  const pinButton = makeButton('📌 PIN', 'map-webcam-viewer-action', 'Pin this camera');
  const rawLink = document.createElement('a');
  rawLink.className = 'map-webcam-viewer-action';
  rawLink.textContent = '↗ RAW FEED';
  rawLink.target = '_blank';
  rawLink.rel = 'noopener noreferrer';
  rawLink.hidden = true;
  const mapLink = document.createElement('a');
  mapLink.className = 'map-webcam-viewer-action accent';
  mapLink.textContent = '⌖ MAP TARGET';
  mapLink.href = `https://www.google.com/maps/@${camera.lat},${camera.lng},17z`;
  mapLink.target = '_blank';
  mapLink.rel = 'noopener noreferrer';
  actions.append(pinButton, rawLink, mapLink);
  footer.append(feedMeta, actions);

  root.append(header, media, footer);
  // Mount above renderer-specific transformed wrappers. This keeps the mobile
  // fixed bottom sheet anchored to the viewport and survives SVG/WebGL redraws.
  const mount = container.closest<HTMLElement>('.map-section') ?? container;
  mount.appendChild(root);

  let destroyed = false;
  let refreshGeneration = 0;
  let jpgRefreshTimer: number | null = null;
  const clockTimer = window.setInterval(syncClock, 1_000);

  const setPinnedState = () => {
    const pinned = isPinned(camera.webcamId);
    pinButton.classList.toggle('active', pinned);
    pinButton.textContent = pinned ? '📌 PINNED' : '📌 PIN';
    pinButton.disabled = pinned;
  };
  setPinnedState();

  const cleanup = () => {
    if (destroyed) return;
    destroyed = true;
    window.clearInterval(clockTimer);
    if (jpgRefreshTimer !== null) window.clearInterval(jpgRefreshTimer);
    document.removeEventListener('keydown', handleKeyDown);
    root.remove();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeMapWebcamViewer(container);
  };
  document.addEventListener('keydown', handleKeyDown);
  activeViewers.set(container, { root, cleanup });

  closeButton.addEventListener('click', () => closeMapWebcamViewer(container));
  minimizeButton.addEventListener('click', () => {
    const minimized = root.classList.toggle('minimized');
    if (minimized) {
      root.classList.remove('expanded');
      expandButton.classList.remove('active');
      expandButton.setAttribute('aria-pressed', 'false');
    }
    minimizeButton.textContent = minimized ? '▴' : '▾';
    minimizeButton.title = minimized ? 'Restore camera viewer' : 'Minimize camera viewer';
    minimizeButton.setAttribute('aria-label', minimizeButton.title);
    minimizeButton.setAttribute('aria-expanded', String(!minimized));
  });
  expandButton.addEventListener('click', () => {
    root.classList.remove('minimized');
    minimizeButton.textContent = '▾';
    minimizeButton.title = 'Minimize camera viewer';
    minimizeButton.setAttribute('aria-label', minimizeButton.title);
    minimizeButton.setAttribute('aria-expanded', 'true');
    const expanded = root.classList.toggle('expanded');
    expandButton.classList.toggle('active', expanded);
    expandButton.setAttribute('aria-pressed', String(expanded));
  });

  let resolvedPlayerUrl = '';
  pinButton.addEventListener('click', () => {
    pinWebcam({
      webcamId: camera.webcamId,
      title: camera.title,
      lat: camera.lat,
      lng: camera.lng,
      category: camera.category || 'other',
      country: camera.country || '',
      playerUrl: resolvedPlayerUrl,
    });
    setPinnedState();
  });

  const renderImage = (thumbnailUrl: string, playerUrl: string) => {
    const currentGeneration = ++refreshGeneration;
    const image = document.createElement('img');
    image.className = 'map-webcam-viewer-image';
    image.alt = camera.title || 'Camera preview';
    image.referrerPolicy = 'no-referrer';
    image.src = cacheBustedUrl(thumbnailUrl, currentGeneration);
    image.addEventListener('load', () => {
      if (destroyed) return;
      root.classList.remove('loading', 'feed-error');
      root.classList.add('feed-ready');
      feedState.textContent = 'ACTIVE / REFRESHING';
      mediaStatus.hidden = true;
    });
    image.addEventListener('error', () => {
      if (destroyed) return;
      root.classList.remove('loading', 'feed-ready');
      root.classList.add('feed-error');
      mediaStatus.hidden = false;
      mediaStatus.textContent = 'CAMERA PREVIEW UNAVAILABLE';
      feedState.textContent = 'SOURCE UNREACHABLE';
    });
    media.querySelectorAll('.map-webcam-viewer-image, .map-webcam-viewer-iframe, .map-webcam-viewer-play')
      .forEach((element) => element.remove());
    media.insertBefore(image, liveBadge);

    if (playerUrl) {
      const playButton = makeButton('▶ START LIVE STREAM', 'map-webcam-viewer-play centered', 'Play live camera feed');
      playButton.addEventListener('click', () => {
        if (jpgRefreshTimer !== null) {
          window.clearInterval(jpgRefreshTimer);
          jpgRefreshTimer = null;
        }
        const iframe = document.createElement('iframe');
        iframe.className = 'map-webcam-viewer-iframe';
        iframe.src = playerUrl;
        iframe.title = `${camera.title || camera.webcamId} live feed`;
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
        iframe.allow = 'autoplay; encrypted-media; fullscreen';
        iframe.allowFullscreen = true;
        image.replaceWith(iframe);
        playButton.remove();
        root.classList.add('streaming');
        feedType.textContent = 'FEED  LIVE PLAYER';
        feedState.textContent = 'ACTIVE / STREAMING';
      });
      media.insertBefore(playButton, liveBadge);
    }
  };

  const loadFeed = async () => {
    root.classList.remove('feed-ready', 'feed-error', 'streaming');
    root.classList.add('loading');
    mediaStatus.hidden = false;
    mediaStatus.textContent = 'ACQUIRING CAMERA FEED…';
    feedState.textContent = 'CONNECTING';
    const imageData = await fetchWebcamImage(camera.webcamId);
    if (destroyed || activeViewers.get(container)?.root !== root) return;

    const thumbnailUrl = safeHttpUrl(osirisCamera?.feedUrl || imageData.thumbnailUrl);
    resolvedPlayerUrl = safeHttpUrl(osirisCamera?.streamUrl || imageData.playerUrl);
    const rawUrl = safeHttpUrl(
      osirisCamera?.externalUrl
      || osirisCamera?.feedUrl
      || osirisCamera?.streamUrl
      || imageData.windyUrl,
    );
    if (rawUrl) {
      rawLink.href = rawUrl;
      rawLink.hidden = false;
    }

    if (thumbnailUrl) {
      renderImage(thumbnailUrl, resolvedPlayerUrl);
      if (osirisCamera?.streamType === 'jpg' && jpgRefreshTimer === null) {
        jpgRefreshTimer = window.setInterval(() => renderImage(thumbnailUrl, ''), 5_000);
      }
      return;
    }

    if (resolvedPlayerUrl) {
      const playButton = makeButton('▶ START LIVE STREAM', 'map-webcam-viewer-play centered', 'Play live camera feed');
      playButton.addEventListener('click', () => {
        const iframe = document.createElement('iframe');
        iframe.className = 'map-webcam-viewer-iframe';
        iframe.src = resolvedPlayerUrl;
        iframe.title = `${camera.title || camera.webcamId} live feed`;
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');
        iframe.allow = 'autoplay; encrypted-media; fullscreen';
        iframe.allowFullscreen = true;
        media.insertBefore(iframe, liveBadge);
        playButton.remove();
        root.classList.remove('loading');
        root.classList.add('streaming');
        mediaStatus.hidden = true;
        feedState.textContent = 'ACTIVE / STREAMING';
      });
      media.insertBefore(playButton, liveBadge);
      mediaStatus.textContent = 'LIVE PLAYER READY';
      feedState.textContent = 'READY';
      return;
    }

    mediaStatus.textContent = 'CAMERA FEED UNAVAILABLE';
    feedState.textContent = 'OFFLINE';
    root.classList.remove('loading');
    root.classList.add('feed-error');
  };

  refreshButton.addEventListener('click', () => {
    if (jpgRefreshTimer !== null) {
      window.clearInterval(jpgRefreshTimer);
      jpgRefreshTimer = null;
    }
    void loadFeed();
  });

  void loadFeed();
}
