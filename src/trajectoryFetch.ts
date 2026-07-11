// Fetches a trajectory URL with strict validation: scheme/filename checks,
// share-link rewriting, a direct fetch with the room-server proxy as CORS
// fallback, and an allowlist-based content check that rejects anything that
// does not positively look like an XYZ file before the full download.

import { getFrameLayout } from "./xyzParser";
import { resolveTrajectoryUrl, validateTrajectoryUrl } from "./shareLinks";

export const MAX_TRAJECTORY_BYTES = 200 * 1024 * 1024;
const SNIFF_BYTES = 8192;
const MAX_SNIFF_ATOM_LINES = 20;
const MAX_ATOM_COUNT = 10_000_000;
const ALLOWED_CONTENT_TYPES = new Set([
  "text/plain",
  "application/octet-stream",
  "binary/octet-stream",
  "chemical/x-xyz",
]);

export interface FetchTrajectoryOptions {
  /** http(s) base of the room server hosting the /proxy fallback route. */
  proxyBase?: string | null;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}

function isAbortError(err: unknown) {
  return err instanceof DOMException && err.name === "AbortError";
}

function checkContentType(response: Response) {
  const raw = response.headers.get("content-type");
  if (!raw) return;
  const type = raw.split(";")[0].trim().toLowerCase();
  if (!type || ALLOWED_CONTENT_TYPES.has(type)) return;
  if (type === "text/html") {
    throw new Error(
      'This URL returned a web page, not an XYZ file. Make sure the share link is public ("Anyone with the link").',
    );
  }
  throw new Error(`Unexpected content type "${type}" — expected a plain-text XYZ file.`);
}

/**
 * Validates that the first bytes of the download match the XYZ grammar:
 * clean text, an atom-count first line, and well-formed atom lines. Throws
 * with the failing check; when `isComplete` is false the final (possibly
 * partial) line is ignored.
 */
function sniffXyzText(rawText: string, isComplete: boolean) {
  const text = rawText.replace(/^\uFEFF/, "");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new Error("This URL did not return a plain text file.");
  }

  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  if (!isComplete) lines.pop();

  let index = 0;
  while (index < lines.length && lines[index].trim().length === 0) index++;
  const countLine = lines[index]?.trim();
  if (countLine === undefined) {
    throw new Error("The file does not start with an XYZ atom count line.");
  }
  if (!/^\d+$/.test(countLine)) {
    throw new Error(`The file does not look like XYZ: expected an atom count on line 1, got "${countLine.slice(0, 60)}".`);
  }
  const numAtoms = parseInt(countLine, 10);
  if (numAtoms < 1 || numAtoms > MAX_ATOM_COUNT) {
    throw new Error(`Atom count ${numAtoms} is out of the supported range (1 to ${MAX_ATOM_COUNT}).`);
  }

  const comment = lines[index + 1];
  if (comment === undefined) {
    if (isComplete) throw new Error("The file ends before the XYZ comment line.");
    return;
  }
  const layout = getFrameLayout(comment);

  const atomLines = lines.slice(index + 2);
  const checkCount = Math.min(numAtoms, MAX_SNIFF_ATOM_LINES, atomLines.length);
  if (isComplete && atomLines.length < Math.min(numAtoms, MAX_SNIFF_ATOM_LINES)) {
    throw new Error(`The file declares ${numAtoms} atoms but ends after ${atomLines.length} atom lines.`);
  }
  for (let i = 0; i < checkCount; i++) {
    const lineNumber = index + 3 + i;
    const parts = atomLines[i].trim().split(/\s+/);
    const symbol = parts[layout.symbolIndex];
    if (!symbol || !/^[A-Za-z][A-Za-z0-9_]{0,7}$/.test(symbol)) {
      throw new Error(`Line ${lineNumber} does not look like an XYZ atom line (bad species "${(symbol ?? "").slice(0, 20)}").`);
    }
    for (const positionIndex of layout.positionIndices) {
      if (!Number.isFinite(parseFloat(parts[positionIndex]))) {
        throw new Error(`Line ${lineNumber} does not look like an XYZ atom line (missing numeric coordinates).`);
      }
    }
  }
}

function concatBytes(chunks: Uint8Array[], maxBytes: number) {
  const total = Math.min(maxBytes, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= total) break;
    out.set(chunk.subarray(0, Math.min(chunk.byteLength, total - offset)), offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchAndValidate(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { credentials: "omit", signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  checkContentType(response);

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TRAJECTORY_BYTES) {
    throw new Error(`File is too large (${Math.round(declaredLength / 1_000_000)} MB; the limit is ${Math.round(MAX_TRAJECTORY_BYTES / 1_000_000)} MB).`);
  }

  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > MAX_TRAJECTORY_BYTES) throw new Error("File is too large.");
    sniffXyzText(await blob.slice(0, SNIFF_BYTES).text(), blob.size <= SNIFF_BYTES);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let received = 0;
  let sniffed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (received > MAX_TRAJECTORY_BYTES) {
        throw new Error(`Download exceeded the ${Math.round(MAX_TRAJECTORY_BYTES / 1_000_000)} MB limit.`);
      }
      if (!sniffed && received >= SNIFF_BYTES) {
        sniffed = true;
        sniffXyzText(decoder.decode(concatBytes(chunks, SNIFF_BYTES)), false);
      }
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  }
  if (!sniffed) {
    sniffXyzText(decoder.decode(concatBytes(chunks, SNIFF_BYTES)), received <= SNIFF_BYTES);
  }
  return new Blob(chunks as BlobPart[]);
}

/**
 * Fetches and validates a trajectory URL. Share links are rewritten to their
 * direct-download form; when the direct fetch fails (usually CORS) and the
 * URL is a known cloud-storage link, the room server's /proxy route is tried.
 */
export async function fetchTrajectoryBlob(originalUrl: string, options: FetchTrajectoryOptions = {}): Promise<Blob> {
  const { proxyBase, signal, onStatus } = options;

  const validationError = validateTrajectoryUrl(originalUrl);
  if (validationError) throw new Error(validationError);

  const { directUrl, isCloudShare } = resolveTrajectoryUrl(originalUrl);
  try {
    return await fetchAndValidate(directUrl, signal);
  } catch (err) {
    if (isAbortError(err) || !isCloudShare || !proxyBase) throw err;
    onStatus?.("Direct fetch failed; retrying through the room-server proxy...");
    try {
      return await fetchAndValidate(`${proxyBase}/proxy?url=${encodeURIComponent(directUrl)}`, signal);
    } catch (proxyErr) {
      if (isAbortError(proxyErr)) throw proxyErr;
      throw new Error(`Could not load the share link directly (${(err as Error).message}) or via the proxy (${(proxyErr as Error).message}).`);
    }
  }
}
