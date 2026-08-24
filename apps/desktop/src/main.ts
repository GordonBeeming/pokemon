import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  captureCameraFrame,
  formatBytes,
  imageDataUrl,
  importCapture,
  pairingPageUrl,
  type AppConfig,
  type DesktopStatus,
  type EncodedFrame,
  type PendingScan,
  type PendingScanImage,
  type SaveCapture,
  type SyncReport,
} from './domain';
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
      <div class="status-line" aria-label="Connection status">
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
          <label class="file-action" for="file-capture">Choose image</label>
          <input id="file-capture" type="file" accept="image/jpeg,image/png,image/webp,image/heic,.heic" />
        </div>

        <div class="inbox" aria-labelledby="inbox-heading">
          <div class="inbox-heading">
            <h3 id="inbox-heading">Pending inbox</h3>
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
            <span class="sync-state" id="sync-state">Ready</span>
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
            </div>
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
const syncState = requireElement('#sync-state', HTMLSpanElement);
const mcpEndpoint = requireElement('#mcp-endpoint', HTMLSpanElement);
const mcpConfig = requireElement('#mcp-config', HTMLPreElement);
const copyMcp = requireElement('#copy-mcp', HTMLButtonElement);
const notice = requireElement('#notice', HTMLDivElement);

let status: DesktopStatus | null = null;
let cameraStream: MediaStream | null = null;

const saveLocalCapture: SaveCapture = async (bytes, mimeType, source) =>
  invoke<PendingScan>('save_capture', { bytes, mimeType, source });

async function refresh(): Promise<void> {
  status = await invoke<DesktopStatus>('desktop_status');
  renderStatus(status);
  await renderPending(status.pendingScans);
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

async function renderPending(scans: PendingScan[]): Promise<void> {
  pendingCount.textContent = `${scans.length} pending`;
  pendingList.replaceChildren();
  if (scans.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No captures are waiting. The next image will appear here.';
    pendingList.append(empty);
    return;
  }
  for (const scan of scans) {
    const article = document.createElement('article');
    article.className = 'pending-item';
    const preview = document.createElement('div');
    preview.className = 'pending-preview';
    const image = document.createElement('img');
    image.alt = `Pending ${scan.source} capture`;
    const pendingImage = await invoke<PendingScanImage>('pending_scan_image', { scanId: scan.id });
    image.src = imageDataUrl(pendingImage);
    preview.append(image);

    const detail = document.createElement('div');
    detail.className = 'pending-detail';
    const title = document.createElement('strong');
    title.textContent = scan.source === 'camera' ? 'Camera capture' : 'Imported image';
    const metadata = document.createElement('span');
    metadata.textContent = `${formatBytes(scan.bytes)} · ${new Date(scan.createdAt * 1000).toLocaleString()}`;
    detail.append(title, metadata);

    const remove = document.createElement('button');
    remove.className = 'text-action danger';
    remove.type = 'button';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete pending capture ${scan.id}`);
    remove.addEventListener('click', () => {
      void runAction(async () => {
        await invoke('delete_pending_scan', { scanId: scan.id });
        await refresh();
        showNotice('Local capture deleted.');
      });
    });
    article.append(preview, detail, remove);
    pendingList.append(article);
  }
}

cameraToggle.addEventListener('click', () => {
  void runAction(async () => {
    if (cameraStream) {
      stopCamera();
      return;
    }
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
      audio: false,
    });
    camera.srcObject = cameraStream;
    await camera.play();
    camera.hidden = false;
    cameraPlaceholder.hidden = true;
    cameraCapture.disabled = false;
    cameraToggle.textContent = 'Stop camera';
  });
});

cameraCapture.addEventListener('click', () => {
  void runAction(async () => {
    await captureCameraFrame(encodeCameraFrame, saveLocalCapture);
    await refresh();
    showNotice('Camera capture added to the pending inbox.');
  });
});

fileCapture.addEventListener('change', () => {
  void runAction(async () => {
    const file = fileCapture.files?.item(0);
    if (!file) return;
    await importCapture(file, saveLocalCapture);
    fileCapture.value = '';
    await refresh();
    showNotice('Image added to the pending inbox.');
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
    showNotice(`Paired with ${scopes.length} scoped permissions.`);
  });
});

disconnect.addEventListener('click', () => {
  void runAction(async () => {
    await invoke('disconnect_cloud');
    await refresh();
    showNotice('Cloud token removed from Keychain.');
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
    showNotice('Settings saved.');
  });
});

syncArt.addEventListener('click', () => {
  void runAction(async () => {
    syncArt.disabled = true;
    syncState.textContent = 'Syncing';
    try {
      const report = await invoke<SyncReport>('synchronize_art');
      syncState.textContent = 'Up to date';
      showNotice(
        `Art sync checked ${report.sourceCards} catalogue cards: ${report.downloaded} downloaded, ${report.uploaded} uploaded, ${report.skipped} unchanged, ${report.missingImages} without source art.`,
      );
    } finally {
      syncArt.disabled = false;
    }
  });
});

copyMcp.addEventListener('click', () => {
  void runAction(async () => {
    await navigator.clipboard.writeText(requireStatus().mcp.configSnippet);
    showNotice('Codex MCP config copied.');
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
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error('The camera frame could not be encoded.')),
      'image/jpeg',
      0.92,
    );
  });
  return { mimeType: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) };
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

async function runAction(action: () => Promise<void>): Promise<void> {
  notice.dataset.state = 'working';
  notice.textContent = 'Working…';
  try {
    await action();
    if (notice.dataset.state === 'working') notice.textContent = '';
  } catch (error) {
    notice.dataset.state = 'error';
    notice.textContent = error instanceof Error ? error.message : String(error);
  }
}

function showNotice(message: string): void {
  notice.dataset.state = 'ok';
  notice.textContent = message;
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
