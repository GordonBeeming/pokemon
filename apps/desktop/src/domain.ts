export type CaptureSource = 'camera' | 'file';

export interface PendingScan {
  id: string;
  createdAt: number;
  source: CaptureSource;
  mimeType: string;
  bytes: number;
}

export interface PendingScanImage {
  id: string;
  mimeType: string;
  data: string;
}

export interface AppConfig {
  cloudBaseUrl: string;
  imageLibraryPath: string;
  mcpPort: number;
  deviceLabel: string;
}

export interface McpStatus {
  endpoint: string;
  bearerToken: string;
  configSnippet: string;
  running: boolean;
  error: string | null;
}

export interface DesktopStatus {
  config: AppConfig;
  paired: boolean;
  pendingScans: PendingScan[];
  mcp: McpStatus;
}

export interface SyncReport {
  manifestEntries: number;
  sourceCards: number;
  downloaded: number;
  resumed: number;
  skipped: number;
  bytesWritten: number;
  uploaded: number;
  missingImages: number;
}

export interface CaptureInput {
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface EncodedFrame {
  mimeType: string;
  bytes: Uint8Array;
}

export type SaveCapture = (
  bytes: number[],
  mimeType: string,
  source: CaptureSource,
) => Promise<PendingScan>;

const allowedCaptureTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const maxCaptureBytes = 25 * 1024 * 1024;

export async function importCapture(input: CaptureInput, save: SaveCapture): Promise<PendingScan> {
  validateCapture(input.type, input.size);
  const bytes = new Uint8Array(await input.arrayBuffer());
  return save(Array.from(bytes), input.type, 'file');
}

export async function captureCameraFrame(
  encode: () => Promise<EncodedFrame>,
  save: SaveCapture,
): Promise<PendingScan> {
  const frame = await encode();
  validateCapture(frame.mimeType, frame.bytes.byteLength);
  return save(Array.from(frame.bytes), frame.mimeType, 'camera');
}

export function imageDataUrl(image: PendingScanImage): string {
  if (!allowedCaptureTypes.has(image.mimeType) || !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data)) {
    throw new Error('The pending capture contains invalid image data.');
  }
  return `data:${image.mimeType};base64,${image.data}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function pairingPageUrl(cloudBaseUrl: string): string {
  const url = new URL(cloudBaseUrl);
  url.pathname = '/';
  url.search = '';
  url.hash = 'devices';
  return url.toString();
}

function validateCapture(type: string, bytes: number): void {
  if (!allowedCaptureTypes.has(type)) {
    throw new Error('Choose a JPEG, PNG, WebP, or HEIC image.');
  }
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > maxCaptureBytes) {
    throw new Error('The capture must be between 1 byte and 25 MB.');
  }
}
