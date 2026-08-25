import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  captureCameraFrame,
  formatBytes,
  importCapture,
  pairingPageUrl,
  type AppConfig,
  type DesktopStatus,
  type EncodedFrame,
  type PendingScan,
  type SaveCapture,
  type SyncReport,
} from './domain';
import { BoundedAsyncQueue, ExclusiveAction, LatestGeneration } from './ui-controller';
import './styles.css';

const app = document.querySelector('#app');
if (!(app instanceof HTMLDivElement)) throw new Error('Application root is missing.');

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <h1>Pokédex Scanner</h1>
        <p>Capture one card, confirm the match, then move on.</p>
      </div>
      <div class="status-line" aria-label="Connection status" role="status" aria-live="polite">
        <span class="status-chip" id="cloud-status">Cloud unknown</span>
        <span class="status-chip" id="mcp-status">MCP unknown</span>
      </div>
    </header>

    <div class="workspace">
      <section class="capture-column" aria-labelledby="capture-heading">
        <div class="section-heading">
          <div>
            <h2 id="capture-heading">Card capture</h2>
            <p>The image stays on this Mac until a match is confirmed.</p>
          </div>
          <span class="count" id="pending-count">0 pending</span>
        </div>

        <div class="capture-stage">
          <video id="camera" playsinline muted aria-label="Camera preview"></video>
          <div class="camera-placeholder" id="camera-placeholder">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 6.5 8.2 4h7.6L17 6.5h2A2.5 2.5 0 0 1 21.5 9v8A2.5 2.5 0 0 1 19 19.5H5A2.5 2.5 0 0 1 2.5 17V9A2.5 2.5 0 0 1 5 6.5h2Z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
            <strong>Camera is off</strong>
            <span>Start it when the card is ready.</span>
          </div>
          <div class="scan-frame" aria-hidden="true"></div>
        </div>

        <div class="capture-actions">
          <button class="primary" id="camera-toggle" type="button">Start camera</button>
          <button id="camera-capture" type="button" disabled>Capture card</button>
          <label class="file-action">Choose image
            <input id="file-capture" type="file" accept="image/jpeg,image/png,image/webp,image/heic,.heic" />
          </label>
        </div>

        <div class="inbox" aria-labelledby="inbox-heading">
          <div class="inbox-heading">
            <h3 id="inbox-heading" tabindex="-1">Pending inbox</h3>
            <p>Codex can inspect these through the local MCP bridge.</p>
          </div>
          <div id="pending-list" class="pending-list"></div>
        </div>
      </section>

      <aside class="control-column" aria-label="Scanner controls">
        <section class="control-section" aria-labelledby="pairing-heading">
          <div class="control-title">
            <h2 id="pairing-heading">Cloud pairing</h2>
            <span class="state-dot" id="pairing-dot" aria-hidden="true"></span>
          </div>
          <p>Generate a one-time code in the web app, then redeem it here. The desktop token is stored in Keychain.</p>
          <button class="quiet" id="open-pairing" type="button">Open pairing page</button>
          <form id="pair-form">
            <label for="pair-code">One-time code</label>
            <div class="inline-form">
              <input id="pair-code" name="pair-code" autocomplete="one-time-code" minlength="8" maxlength="64" required />
              <button type="submit">Pair</button>
            </div>
          </form>
          <button class="text-action danger" id="disconnect" type="button">Remove cloud token</button>
        </section>

        <section class="control-section" aria-labelledby="library-heading">
          <div class="control-title">
            <h2 id="library-heading">Art library</h2>
            <span class="sync-state" id="sync-state" role="status" aria-live="polite" aria-atomic="true">Ready</span>
          </div>
          <form id="settings-form">
            <label for="library-path">Image library path</label>
            <input id="library-path" name="library-path" spellcheck="false" required />
            <label for="cloud-url">Cloud origin</label>
            <input id="cloud-url" name="cloud-url" type="url" spellcheck="false" required />
            <label for="device-label">Device label</label>
            <input id="device-label" name="device-label" maxlength="80" required />
            <div class="form-actions">
              <button type="submit">Save settings</button>
              <button class="primary" id="sync-art" type="button">Sync high + low art</button>
              <button id="cancel-sync" type="button" hidden>Cancel sync</button>
            </div>
            <progress id="sync-progress" hidden aria-label="Art synchronization in progress"></progress>
          </form>
        </section>

        <section class="control-section" aria-labelledby="mcp-heading">
          <div class="control-title">
            <h2 id="mcp-heading">Codex MCP</h2>
            <span class="sync-state" id="mcp-endpoint"></span>
          </div>
          <p>Authenticated Streamable HTTP is bound to this Mac only.</p>
          <pre id="mcp-config" tabindex="0"></pre>
          <button class="quiet" id="copy-mcp" type="button">Copy Codex config</button>
        </section>
      </aside>
    </div>
    <div id="notice" class="notice" role="status" aria-live="polite"></div>
  </main>
`;

const camera = requireElement('#camera', HTMLVideoElement);
const cameraPlaceholder = requireElement('#camera-placeholder', HTMLDivElement);
const cameraToggle = requireElement('#camera-toggle', HTMLButtonElement);
const cameraCapture = requireElement('#camera-capture', HTMLButtonElement);
const fileCapture = requireElement('#file-capture', HTMLInputElement);
const pendingList = requireElement('#pending-list', HTMLDivElement);
const pendingCount = requireElement('#pending-count', HTMLSpanElement);
const cloudStatus = requireElement('#cloud-status', HTMLSpanElement);
const mcpStatus = requireElement('#mcp-status', HTMLSpanElement);
const pairingDot = requireElement('#pairing-dot', HTMLSpanElement);
const pairForm = requireElement('#pair-form', HTMLFormElement);
const pairCode = requireElement('#pair-code', HTMLInputElement);
const openPairing = requireElement('#open-pairing', HTMLButtonElement);
const disconnect = requireElement('#disconnect', HTMLButtonElement);
const settingsForm = requireElement('#settings-form', HTMLFormElement);
const libraryPath = requireElement('#library-path', HTMLInputElement);
const cloudUrl = requireElement('#cloud-url', HTMLInputElement);
const deviceLabel = requireElement('#device-label', HTMLInputElement);
const syncArt = requireElement('#sync-art', HTMLButtonElement);
const cancelSync = requireElement('#cancel-sync', HTMLButtonElement);
const syncState = requireElement('#sync-state', HTMLSpanElement);
const syncProgress = requireElement('#sync-progress', HTMLProgressElement);
const mcpEndpoint = requireElement('#mcp-endpoint', HTMLSpanElement);
const mcpConfig = requireElement('#mcp-config', HTMLPreElement);
const copyMcp = requireElement('#copy-mcp', HTMLButtonElement);
const notice = requireElement('#notice', HTMLDivElement);

let status: DesktopStatus | null = null;
let cameraStream: MediaStream | null = null;
const refreshGenerations = new LatestGeneration();
const noticeGenerations = new LatestGeneration();
const cameraAction = new ExclusiveAction();
const previewQueue = new BoundedAsyncQueue(2);
const previewScans = new WeakMap<HTMLImageElement, PendingScan>();
const pendingActionStates = new Map<string, { state: 'working' | 'error'; message: string }>();
let pendingFocusIntent: {
  ownerScanId: string;
  candidates: string[];
  phase: 'in-flight' | 'completion';
} | null = null;
const previewObserver =
  typeof IntersectionObserver === 'undefined'
    ? null
    : new IntersectionObserver(
        (entries) => {
          entries
            .filter((entry) => entry.isIntersecting && entry.target instanceof HTMLImageElement)
            .forEach((entry) => {
              const image = entry.target as HTMLImageElement;
              previewObserver?.unobserve(image);
              const scan = previewScans.get(image);
              if (scan) void loadPendingPreview(image, scan);
            });
        },
        { rootMargin: '160px' },
      );

const saveLocalCapture: SaveCapture = async (bytes, mimeType, source, previewBytes) =>
  invoke<PendingScan>('save_capture', { bytes, mimeType, source, previewBytes });

async function refresh(): Promise<void> {
  const generation = refreshGenerations.next();
  const next = await invoke<DesktopStatus>('desktop_status');
  const pending = pendingFragment(next.pendingScans);
  if (!refreshGenerations.isCurrent(generation)) return;
  status = next;
  renderStatus(next);
  pendingCount.textContent = `${next.pendingScans.length} pending`;
  const focusCandidates = acceptedPendingFocusCandidates();
  pendingList.querySelectorAll('img').forEach((image) => previewObserver?.unobserve(image));
  pendingList.replaceChildren(pending);
  if (focusCandidates) restorePendingFocus(focusCandidates);
}

function renderStatus(next: DesktopStatus): void {
  cloudStatus.textContent = next.paired ? 'Cloud paired' : 'Cloud not paired';
  cloudStatus.dataset.state = next.paired ? 'ok' : 'idle';
  pairingDot.dataset.state = next.paired ? 'ok' : 'idle';
  disconnect.hidden = !next.paired;
  mcpStatus.textContent = next.mcp.running ? 'MCP running' : 'MCP unavailable';
  mcpStatus.dataset.state = next.mcp.running ? 'ok' : 'error';
  mcpEndpoint.textContent = next.mcp.running ? next.mcp.endpoint : 'Unavailable';
  mcpConfig.textContent = next.mcp.configSnippet;
  libraryPath.value = next.config.imageLibraryPath;
  cloudUrl.value = next.config.cloudBaseUrl;
  deviceLabel.value = next.config.deviceLabel;
}

function pendingFragment(scans: PendingScan[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (scans.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.tabIndex = -1;
    empty.textContent = 'No captures are waiting. The next image will appear here.';
    fragment.append(empty);
    return fragment;
  }
  fragment.append(...scans.map(pendingArticle));
  return fragment;
}

function pendingArticle(scan: PendingScan): HTMLElement {
  const article = document.createElement('article');
  article.className = 'pending-item';
  article.dataset.scanId = scan.id;
  article.tabIndex = -1;
  const preview = document.createElement('div');
  preview.className = 'pending-preview';
  const image = document.createElement('img');
  image.alt = `Pending ${scan.source} capture`;
  image.loading = 'lazy';
  image.dataset.state = 'loading';
  image.addEventListener('error', () => {
    diagnosePendingPreviewFailure(
      scan.id,
      'asset-load',
      new Error('Asset preview failed to load.'),
    );
    showPendingPreviewFailure(image);
  });
  const previewStatus = document.createElement('span');
  previewStatus.className = 'pending-preview-status';
  previewStatus.textContent = 'Loading preview…';
  previewStatus.setAttribute('aria-hidden', 'true');
  previewScans.set(image, scan);
  if (previewObserver) previewObserver.observe(image);
  else void loadPendingPreview(image, scan);
  preview.append(image, previewStatus);

  const detail = document.createElement('div');
  detail.className = 'pending-detail';
  const title = document.createElement('strong');
  title.id = `pending-title-${scan.id}`;
  title.textContent = scan.source === 'camera' ? 'Camera capture' : 'Imported image';
  const metadata = document.createElement('span');
  metadata.id = `pending-metadata-${scan.id}`;
  metadata.textContent = `${formatBytes(scan.bytes)} · ${new Date(scan.createdAt * 1000).toLocaleString()}`;
  const guidance = document.createElement('span');
  guidance.className = 'pending-state-guidance';
  guidance.id = `pending-guidance-${scan.id}`;
  const actionStatus = document.createElement('span');
  actionStatus.className = 'pending-action-status';
  actionStatus.id = `pending-action-${scan.id}`;
  actionStatus.setAttribute('role', 'status');
  actionStatus.setAttribute('aria-live', 'polite');
  actionStatus.setAttribute('aria-atomic', 'true');
  actionStatus.hidden = true;
  article.setAttribute('aria-labelledby', title.id);
  article.setAttribute('aria-describedby', `${metadata.id} ${guidance.id} ${actionStatus.id}`);
  const currentAction = pendingActionStates.get(scan.id);
  if (currentAction) {
    actionStatus.hidden = false;
    actionStatus.dataset.state = currentAction.state;
    actionStatus.textContent = currentAction.message;
    if (currentAction.state === 'working') article.setAttribute('aria-busy', 'true');
  }
  detail.append(title, metadata, guidance, actionStatus);

  const remove = document.createElement('button');
  remove.className = 'text-action danger';
  remove.type = 'button';
  remove.setAttribute('aria-describedby', actionStatus.id);
  if (scan.state === 'pending') {
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete pending capture ${scan.id}`);
    remove.addEventListener('click', () => {
      seedPendingFocusOwnership(scan.id);
      void deletePendingCapture(scan, article, remove, actionStatus);
    });
    renderPendingActionState(scan, article, remove, actionStatus, true);
  } else {
    remove.disabled = true;
    remove.textContent = scan.state === 'claimed' ? 'Confirmation pending' : 'Confirmed';
    guidance.textContent =
      scan.state === 'claimed'
        ? 'The cloud update may still be running. If it has stopped, retry the same confirmation from Codex; its saved mutation ID will be reused.'
        : 'The collection update completed. Retry the same confirmation from Codex if local cleanup remains.';
    remove.setAttribute('aria-describedby', `${guidance.id} ${actionStatus.id}`);
    remove.setAttribute(
      'aria-label',
      scan.state === 'claimed'
        ? `Capture ${scan.id} confirmation is pending and cannot be deleted`
        : `Capture ${scan.id} is confirmed and cannot be deleted`,
    );
  }
  article.append(preview, detail, remove);
  return article;
}

function renderPendingActionState(
  scan: PendingScan,
  article: HTMLElement,
  remove: HTMLButtonElement,
  actionStatus: HTMLSpanElement,
  allowRetry: boolean,
): void {
  const action = pendingActionStates.get(scan.id);
  if (action?.state === 'working') article.setAttribute('aria-busy', 'true');
  else article.removeAttribute('aria-busy');
  actionStatus.hidden = !action;
  actionStatus.dataset.state = action?.state ?? '';
  actionStatus.textContent = action?.message ?? '';
  if (action?.state === 'working') {
    remove.disabled = true;
    remove.textContent = 'Deleting…';
    remove.setAttribute('aria-label', `Deleting pending capture ${scan.id}`);
    return;
  }
  remove.disabled = !allowRetry;
  remove.textContent = 'Delete';
  remove.setAttribute('aria-label', `Delete pending capture ${scan.id}`);
}

async function deletePendingCapture(
  scan: PendingScan,
  article: HTMLElement,
  remove: HTMLButtonElement,
  actionStatus: HTMLSpanElement,
): Promise<void> {
  const focusCandidates = pendingFocusCandidates(scan.id);
  const noticeGeneration = beginNotice();
  pendingActionStates.set(scan.id, {
    state: 'working',
    message: 'Deleting this capture…',
  });
  renderPendingActionState(scan, article, remove, actionStatus, false);
  try {
    await invoke('delete_pending_scan', { scanId: scan.id });
    pendingActionStates.delete(scan.id);
    replacePendingFocusIntent(scan.id, focusCandidates);
    const refreshError = await refreshAfterDelete();
    if (!refreshError) {
      finishNotice(noticeGeneration, 'ok', 'Local capture deleted.');
      return;
    }
    const message = `Capture deleted, but inbox refresh failed. ${refreshError}`;
    pendingActionStates.set(scan.id, { state: 'error', message });
    if (article.isConnected) {
      renderPendingActionState(scan, article, remove, actionStatus, false);
    }
    finishNotice(noticeGeneration, 'error', message);
  } catch (error) {
    const message = `Couldn’t delete this capture. ${actionErrorMessage(error)}`;
    pendingActionStates.set(scan.id, { state: 'error', message });
    renderPendingActionState(scan, article, remove, actionStatus, false);
    try {
      replacePendingFocusIntent(scan.id, [scan.id, ...focusCandidates]);
      await refresh();
      if (!status?.pendingScans.some((pending) => pending.id === scan.id)) {
        pendingActionStates.delete(scan.id);
      }
    } catch (refreshError) {
      const refreshMessage = `${message} The current inbox state could not be refreshed: ${actionErrorMessage(refreshError)}`;
      pendingActionStates.set(scan.id, { state: 'error', message: refreshMessage });
      if (article.isConnected) {
        renderPendingActionState(scan, article, remove, actionStatus, false);
      }
    }
    finishNotice(noticeGeneration, 'error', message);
  }
}

async function refreshAfterDelete(): Promise<string | null> {
  try {
    await refresh();
    return null;
  } catch {
    try {
      await refresh();
      return null;
    } catch (error) {
      return actionErrorMessage(error);
    }
  }
}

function pendingRow(scanId: string): HTMLElement | null {
  return pendingList.querySelector<HTMLElement>(`.pending-item[data-scan-id="${scanId}"]`);
}

function seedPendingFocusOwnership(ownerScanId: string): void {
  const owner = pendingRow(ownerScanId);
  if (owner?.contains(document.activeElement)) {
    pendingFocusIntent = { ownerScanId, candidates: [ownerScanId], phase: 'in-flight' };
  }
}

function replacePendingFocusIntent(ownerScanId: string, candidates: string[]): void {
  if (pendingFocusIntent?.ownerScanId !== ownerScanId) return;
  const owner = pendingRow(ownerScanId);
  if (!owner?.contains(document.activeElement)) {
    pendingFocusIntent = null;
    return;
  }
  pendingFocusIntent = { ownerScanId, candidates, phase: 'completion' };
}

function acceptedPendingFocusCandidates(): string[] | undefined {
  const intent = pendingFocusIntent;
  if (!intent) return undefined;
  const owner = pendingRow(intent.ownerScanId);
  const active = document.activeElement;
  if (active && active !== document.body && !owner?.contains(active)) {
    pendingFocusIntent = null;
    return undefined;
  }
  if (intent.phase === 'completion') pendingFocusIntent = null;
  return intent.candidates;
}

pendingList.addEventListener('focusout', (event) => {
  const intent = pendingFocusIntent;
  if (!intent || !(event.relatedTarget instanceof Element)) return;
  if (
    event.relatedTarget !== document.body &&
    !pendingRow(intent.ownerScanId)?.contains(event.relatedTarget)
  ) {
    pendingFocusIntent = null;
  }
});

function pendingFocusCandidates(scanId: string): string[] {
  const rows = Array.from(pendingList.querySelectorAll<HTMLElement>('.pending-item'));
  const index = rows.findIndex((row) => row.dataset.scanId === scanId);
  if (index < 0) return [];
  return [rows[index + 1]?.dataset.scanId, rows[index - 1]?.dataset.scanId].filter(
    (value): value is string => Boolean(value),
  );
}

function restorePendingFocus(candidates: string[]): void {
  for (const scanId of candidates) {
    const row = pendingList.querySelector<HTMLElement>(`.pending-item[data-scan-id="${scanId}"]`);
    if (!row) continue;
    const action = row.querySelector<HTMLButtonElement>('button:not(:disabled)');
    (action ?? row).focus();
    return;
  }
  const empty = pendingList.querySelector<HTMLElement>('.empty-state');
  if (empty) {
    empty.focus();
    return;
  }
  requireElement('#inbox-heading', HTMLHeadingElement).focus();
}

async function loadPendingPreview(image: HTMLImageElement, scan: PendingScan): Promise<void> {
  try {
    await previewQueue.run(async () => {
      const path = await invoke<string>('pending_scan_preview_path', { scanId: scan.id });
      if (!image.isConnected) return;
      const previewStatus = image.nextElementSibling;
      if (previewStatus instanceof HTMLSpanElement) previewStatus.hidden = true;
      delete image.dataset.state;
      image.src = convertFileSrc(path);
    });
  } catch (error) {
    diagnosePendingPreviewFailure(scan.id, 'native-command', error);
    showPendingPreviewFailure(image);
  }
}

function diagnosePendingPreviewFailure(scanId: string, phase: string, error: unknown): void {
  console.warn('Pending preview unavailable.', {
    event: 'pending_preview_failed',
    scanId,
    phase,
    errorClass: error instanceof Error ? error.name : typeof error,
  });
}

function showPendingPreviewFailure(image: HTMLImageElement): void {
  if (!image.isConnected) return;
  const previewStatus = image.nextElementSibling;
  if (!(previewStatus instanceof HTMLSpanElement) || previewStatus.dataset.state === 'error')
    return;
  image.dataset.state = 'error';
  image.removeAttribute('src');
  previewStatus.hidden = false;
  previewStatus.dataset.state = 'error';
  previewStatus.removeAttribute('aria-hidden');
  previewStatus.setAttribute('role', 'status');
  previewStatus.textContent = 'No preview';
}

cameraToggle.addEventListener('click', () => {
  void runAction(async () => {
    await cameraAction.run(async () => {
      cameraToggle.disabled = true;
      try {
        if (cameraStream) {
          stopCamera();
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
          audio: false,
        });
        cameraStream = stream;
        camera.srcObject = stream;
        await camera.play();
        camera.hidden = false;
        cameraPlaceholder.hidden = true;
        cameraCapture.disabled = false;
        cameraToggle.textContent = 'Stop camera';
      } finally {
        cameraToggle.disabled = false;
      }
    });
  });
});

cameraCapture.addEventListener('click', () => {
  void runAction(async () => {
    await captureCameraFrame(encodeCameraFrame, saveLocalCapture);
    await refresh();
    return 'Camera capture added to the pending inbox.';
  });
});

fileCapture.addEventListener('change', () => {
  void runAction(async () => {
    const file = fileCapture.files?.item(0);
    if (!file) return;
    const preview = await encodeFilePreview(file);
    await importCapture(file, preview, saveLocalCapture);
    fileCapture.value = '';
    await refresh();
    return 'Image added to the pending inbox.';
  });
});

openPairing.addEventListener('click', () => {
  void runAction(async () => {
    const current = requireStatus();
    await openUrl(pairingPageUrl(current.config.cloudBaseUrl));
  });
});

pairForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void runAction(async () => {
    const scopes = await invoke<string[]>('redeem_pairing_code', { code: pairCode.value });
    pairCode.value = '';
    await refresh();
    return `Paired with ${scopes.length} scoped permissions.`;
  });
});

disconnect.addEventListener('click', () => {
  void runAction(async () => {
    await invoke('disconnect_cloud');
    await refresh();
    return 'Cloud token removed from Keychain.';
  });
});

settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void runAction(async () => {
    const current = requireStatus();
    const config: AppConfig = {
      ...current.config,
      imageLibraryPath: libraryPath.value,
      cloudBaseUrl: cloudUrl.value,
      deviceLabel: deviceLabel.value,
    };
    await invoke<AppConfig>('save_settings', { config });
    await refresh();
    return 'Settings saved.';
  });
});

syncArt.addEventListener('click', () => {
  void runAction(async () => {
    syncArt.disabled = true;
    syncProgress.hidden = false;
    settingsForm.setAttribute('aria-busy', 'true');
    cancelSync.hidden = false;
    syncState.textContent = 'Syncing';
    try {
      const report = await invoke<SyncReport>('synchronize_art');
      syncState.textContent = 'Up to date';
      return `Art sync checked ${report.sourceCards} catalogue cards: ${report.downloaded} downloaded, ${report.uploaded} uploaded, ${report.skipped} unchanged, ${report.missingImages} without source art.`;
    } catch (error) {
      syncState.textContent = String(error).toLowerCase().includes('cancel')
        ? 'Cancelled'
        : 'Sync failed';
      throw error;
    } finally {
      syncArt.disabled = false;
      syncProgress.hidden = true;
      cancelSync.hidden = true;
      settingsForm.removeAttribute('aria-busy');
    }
  });
});

cancelSync.addEventListener('click', () => {
  cancelSync.disabled = true;
  syncState.textContent = 'Cancelling';
  void invoke('cancel_art_sync').finally(() => {
    cancelSync.disabled = false;
  });
});

copyMcp.addEventListener('click', () => {
  void runAction(async () => {
    await navigator.clipboard.writeText(requireStatus().mcp.configSnippet);
    return 'Codex MCP config copied.';
  });
});

window.addEventListener('beforeunload', stopCamera);

async function encodeCameraFrame(): Promise<EncodedFrame> {
  if (camera.videoWidth < 1 || camera.videoHeight < 1) {
    throw new Error('The camera has not produced a frame yet.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = camera.videoWidth;
  canvas.height = camera.videoHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The camera frame could not be prepared.');
  context.drawImage(camera, 0, 0, canvas.width, canvas.height);
  const previewBytes = await encodeThumbnail(canvas, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error('The camera frame could not be encoded.')),
      'image/jpeg',
      0.92,
    );
  });
  return {
    mimeType: blob.type,
    bytes: new Uint8Array(await blob.arrayBuffer()),
    previewBytes,
  };
}

async function encodeFilePreview(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  try {
    return await encodeThumbnail(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function encodeThumbnail(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Uint8Array> {
  const maximum = 240;
  const scale = Math.min(1, maximum / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The capture preview could not be prepared.');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error('The capture preview could not be encoded.')),
      'image/jpeg',
      0.72,
    );
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function stopCamera(): void {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  camera.srcObject = null;
  camera.hidden = true;
  cameraPlaceholder.hidden = false;
  cameraCapture.disabled = true;
  cameraToggle.textContent = 'Start camera';
}

async function runAction(action: () => Promise<string | void>): Promise<void> {
  const generation = beginNotice();
  try {
    const message = await action();
    finishNotice(generation, message ? 'ok' : 'idle', message ?? '');
  } catch (error) {
    finishNotice(generation, 'error', actionErrorMessage(error));
  }
}

function beginNotice(): number {
  const generation = noticeGenerations.next();
  notice.dataset.state = 'working';
  notice.textContent = 'Working…';
  return generation;
}

function finishNotice(generation: number, state: 'idle' | 'ok' | 'error', message: string): void {
  if (!noticeGenerations.isCurrent(generation)) return;
  notice.dataset.state = state;
  notice.textContent = message;
}

function actionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireStatus(): DesktopStatus {
  if (!status) throw new Error('Desktop status is not ready.');
  return status;
}

function requireElement<T extends Element>(selector: string, constructor: new () => T): T {
  const element = document.querySelector(selector);
  if (!(element instanceof constructor))
    throw new Error(`Required control is missing: ${selector}`);
  return element;
}

void runAction(refresh);
