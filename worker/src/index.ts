import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDurableObject>;
  ALLOWED_ORIGINS?: string;
  MAX_ROOM_USERS?: string;
  MAX_MESSAGE_BYTES?: string;
  MAX_MESSAGES_PER_10_SECONDS?: string;
  MAX_PROXY_BYTES?: string;
  PROXY_ALLOWED_HOSTS?: string;
}

type Vec3Tuple = [number, number, number];
type QuatTuple = [number, number, number, number];

interface TransformState {
  position: Vec3Tuple;
  quaternion: QuatTuple;
  scale: Vec3Tuple;
}

interface ViewState {
  cameraPosition: Vec3Tuple;
  orbitTarget: Vec3Tuple;
}

interface PresenterState {
  trajectoryUrl: string | null;
  frameIndex: number;
  playing: boolean;
  fps: number;
  backgroundId: string;
  transform: TransformState;
  view: ViewState;
  presenterId: string | null;
  updatedAt: number;
}

interface RoomUser {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
}

type ClientMessage =
  | { type: "join"; user?: Partial<RoomUser> }
  | { type: "presenter-state"; state?: Partial<PresenterState> }
  | { type: "take-presenter" }
  | { type: "leave" };

const DEFAULT_ALLOWED_ORIGINS = new Set([
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "https://localhost:5173",
  "https://127.0.0.1:5173",
  "https://kenichinomura.github.io",
  "https://gearsxr.space",
  "https://www.gearsxr.space",
]);
const DEFAULT_MAX_ROOM_USERS = 6;
const DEFAULT_MAX_MESSAGE_BYTES = 8192;
const DEFAULT_MAX_MESSAGES_PER_10_SECONDS = 240;
const RATE_WINDOW_MS = 10_000;
const DEFAULT_MAX_PROXY_BYTES = 52_428_800; // 50 MB
const MAX_PROXY_REDIRECTS = 5;
const PROXY_TIMEOUT_MS = 30_000;
const MAX_TRAJECTORY_URL_LENGTH = 2048;
// Entries starting with "." are suffix matches; everything else is exact.
const DEFAULT_PROXY_ALLOWED_HOSTS = [
  "drive.google.com",
  "drive.usercontent.google.com",
  ".dropboxusercontent.com",
  "api.onedrive.com",
  "onedrive.live.com",
  "1drv.ms",
  ".1drv.com",
  "raw.githubusercontent.com",
];
const DEFAULT_BACKGROUND_ID = "dark-cyberspace";
const VALID_BACKGROUND_IDS = new Set([
  DEFAULT_BACKGROUND_ID,
  "none",
  "neon-lab",
  "orbital-deck",
  "hologram-atrium",
]);

const DEFAULT_TRANSFORM: TransformState = {
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

const DEFAULT_VIEW: ViewState = {
  cameraPosition: [0, 1.5, 4],
  orbitTarget: [0, 1, 0],
};

function makeDefaultState(): PresenterState {
  return {
    trajectoryUrl: null,
    frameIndex: 0,
    playing: false,
    fps: 15,
    backgroundId: DEFAULT_BACKGROUND_ID,
    transform: DEFAULT_TRANSFORM,
    view: DEFAULT_VIEW,
    presenterId: null,
    updatedAt: Date.now(),
  };
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function forbidden(message: string) {
  return json({ error: message }, { status: 403 });
}

function html(body: string, init: ResponseInit = {}) {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...init.headers,
    },
  });
}

function sanitizeRoomId(roomId: string | null) {
  const value = (roomId ?? "").trim().toLowerCase();
  return /^[a-z0-9-]{3,40}$/.test(value) ? value : "";
}

function numberFromEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function allowedOrigins(env: Env) {
  const configured = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured.length > 0 ? new Set(configured) : DEFAULT_ALLOWED_ORIGINS;
}

function originAllowed(request: Request, env: Env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return allowedOrigins(env).has(origin);
}

function messageByteLength(data: unknown) {
  if (typeof data === "string") return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return String(data).length;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteTuple(values: unknown, length: 3): Vec3Tuple | null;
function finiteTuple(values: unknown, length: 4): QuatTuple | null;
function finiteTuple(values: unknown, length: 3 | 4): Vec3Tuple | QuatTuple | null {
  if (!Array.isArray(values) || values.length !== length) return null;
  if (!values.every(isFiniteNumber)) return null;
  return values as Vec3Tuple | QuatTuple;
}

function normalizeTransform(input: unknown, fallback: TransformState): TransformState {
  const value = input && typeof input === "object" ? (input as Partial<TransformState>) : {};
  return {
    position: finiteTuple(value.position, 3) ?? fallback.position,
    quaternion: finiteTuple(value.quaternion, 4) ?? fallback.quaternion,
    scale: finiteTuple(value.scale, 3) ?? fallback.scale,
  };
}

function normalizeView(input: unknown, fallback: ViewState): ViewState {
  const value = input && typeof input === "object" ? (input as Partial<ViewState>) : {};
  return {
    cameraPosition: finiteTuple(value.cameraPosition, 3) ?? fallback.cameraPosition,
    orbitTarget: finiteTuple(value.orbitTarget, 3) ?? fallback.orbitTarget,
  };
}

function normalizeBackgroundId(value: unknown, fallback: string) {
  return typeof value === "string" && VALID_BACKGROUND_IDS.has(value) ? value : fallback;
}

function mergePresenterState(current: PresenterState, patch: Partial<PresenterState>): PresenterState {
  const frameIndex = isFiniteNumber(patch.frameIndex) ? Math.max(0, Math.floor(patch.frameIndex)) : current.frameIndex;
  const fps = isFiniteNumber(patch.fps) ? Math.min(60, Math.max(1, Math.round(patch.fps))) : current.fps;
  const trajectoryUrl = sanitizeTrajectoryUrl(patch.trajectoryUrl, current.trajectoryUrl);

  return {
    trajectoryUrl,
    frameIndex,
    playing: typeof patch.playing === "boolean" ? patch.playing : current.playing,
    fps,
    backgroundId: normalizeBackgroundId(patch.backgroundId, current.backgroundId),
    transform: normalizeTransform(patch.transform, current.transform),
    view: normalizeView(patch.view, current.view ?? DEFAULT_VIEW),
    presenterId: current.presenterId,
    updatedAt: Date.now(),
  };
}

function normalizeUser(user: Partial<RoomUser> | undefined): RoomUser | null {
  if (!user || typeof user.id !== "string") return null;
  const id = user.id.trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) return null;
  const name = typeof user.name === "string" && user.name.trim() ? user.name.trim().slice(0, 40) : "Guest";
  const color = typeof user.color === "string" && /^#[0-9a-fA-F]{6}$/.test(user.color) ? user.color : "#44ccff";
  return { id, name, color, joinedAt: Date.now() };
}

function isPrivateHostname(hostname: string) {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

// Room state may only carry https URLs (or plain http to loopback/LAN hosts
// for local development); anything else keeps the previous value so a hostile
// presenter cannot relay javascript:/data:/etc. URLs to followers.
function sanitizeTrajectoryUrl(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MAX_TRAJECTORY_URL_LENGTH) return fallback;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || (url.protocol === "http:" && isPrivateHostname(url.hostname))) {
      return value;
    }
  } catch {
    // fall through
  }
  return fallback;
}

function proxyAllowedHosts(env: Env) {
  const configured = (env.PROXY_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_PROXY_ALLOWED_HOSTS;
}

function proxyHostAllowed(hostname: string, allowed: string[]) {
  const host = hostname.toLowerCase();
  return allowed.some((entry) =>
    entry.startsWith(".") ? host.endsWith(entry) || host === entry.slice(1) : host === entry,
  );
}

/** Returns the parsed URL when the proxy may fetch it, or a rejection reason. */
function validateProxyTarget(raw: string | null, env: Env): URL | string {
  if (!raw) return "Missing url parameter.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Invalid url parameter.";
  }
  if (url.protocol !== "https:") return "Only https:// URLs can be proxied.";
  if (url.username || url.password) return "URLs with embedded credentials are not allowed.";
  if (url.port) return "URLs with explicit ports are not allowed.";
  if (!proxyHostAllowed(url.hostname, proxyAllowedHosts(env))) {
    return `Host "${url.hostname}" is not in the proxy allowlist.`;
  }
  return url;
}

/**
 * Fetches the target following redirects manually so every hop is
 * re-validated against the https + host-allowlist rules. Only the target URL
 * is sent upstream — no client cookies or headers are forwarded.
 */
async function fetchProxyTarget(target: URL, env: Env, signal: AbortSignal): Promise<Response | string> {
  let current = target;
  for (let hop = 0; hop <= MAX_PROXY_REDIRECTS; hop++) {
    const response = await fetch(current.toString(), { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get("Location");
    void response.body?.cancel();
    if (!location) return "Upstream sent a redirect without a Location header.";
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return "Upstream redirected to an invalid URL.";
    }
    const validated = validateProxyTarget(next, env);
    if (typeof validated === "string") return `Upstream redirected to a disallowed URL: ${validated}`;
    current = validated;
  }
  return "Too many upstream redirects.";
}

/**
 * Google Drive answers with an HTML "can't scan for viruses" confirmation
 * page for larger files. Re-submit its form (action + hidden inputs) once,
 * still subject to the proxy target rules.
 */
async function resolveDriveConfirmPage(page: Response, env: Env, signal: AbortSignal): Promise<Response | string> {
  const html = await page.text();
  const action = html.match(/<form[^>]+action="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  if (!action) {
    return "Google Drive returned a web page instead of the file. Make sure the link is shared publicly.";
  }
  let actionUrl: URL;
  try {
    actionUrl = new URL(action);
  } catch {
    return "Google Drive returned an unexpected confirmation page.";
  }
  for (const input of html.matchAll(/<input[^>]*>/g)) {
    const name = input[0].match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    const value = (input[0].match(/value="([^"]*)"/)?.[1] ?? "").replace(/&amp;/g, "&");
    actionUrl.searchParams.set(name, value);
  }
  const validated = validateProxyTarget(actionUrl.toString(), env);
  if (typeof validated === "string") return `Google Drive confirmation blocked: ${validated}`;
  return fetchProxyTarget(validated, env, signal);
}

function proxyCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  const headers: Record<string, string> = { vary: "Origin", "cache-control": "no-store" };
  if (origin) headers["access-control-allow-origin"] = origin;
  return headers;
}

async function handleProxy(request: Request, env: Env): Promise<Response> {
  const cors = proxyCorsHeaders(request);
  if (request.method !== "GET") {
    return json({ error: "Method not allowed." }, { status: 405, headers: cors });
  }
  if (!originAllowed(request, env)) {
    return json({ error: "Origin is not allowed." }, { status: 403, headers: cors });
  }

  const target = validateProxyTarget(new URL(request.url).searchParams.get("url"), env);
  if (typeof target === "string") {
    return json({ error: target }, { status: 400, headers: cors });
  }

  const maxBytes = numberFromEnv(env.MAX_PROXY_BYTES, DEFAULT_MAX_PROXY_BYTES);
  const signal = AbortSignal.timeout(PROXY_TIMEOUT_MS);

  let upstream: Response | string;
  try {
    upstream = await fetchProxyTarget(target, env, signal);
    if (typeof upstream !== "string") {
      const finalHost = (() => {
        try {
          return new URL(upstream.url).hostname.toLowerCase();
        } catch {
          return target.hostname;
        }
      })();
      const isDriveHtml =
        (finalHost === "drive.google.com" || finalHost === "drive.usercontent.google.com") &&
        (upstream.headers.get("content-type") ?? "").includes("text/html");
      if (isDriveHtml) {
        upstream = await resolveDriveConfirmPage(upstream, env, signal);
      }
    }
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "Upstream fetch timed out." : "Upstream fetch failed.";
    return json({ error: reason }, { status: 502, headers: cors });
  }
  if (typeof upstream === "string") {
    return json({ error: upstream }, { status: 502, headers: cors });
  }
  if (!upstream.ok) {
    void upstream.body?.cancel();
    return json({ error: `Upstream returned HTTP ${upstream.status}.` }, { status: 502, headers: cors });
  }

  const declaredLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void upstream.body?.cancel();
    return json({ error: `File exceeds the proxy size limit (${maxBytes} bytes).` }, { status: 413, headers: cors });
  }

  let sentBytes = 0;
  const sizeLimiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sentBytes += chunk.byteLength;
      if (sentBytes > maxBytes) {
        controller.error(new Error("Proxy size limit exceeded."));
      } else {
        controller.enqueue(chunk);
      }
    },
  });

  // Pinned response headers: proxied bytes are always inert plain text on
  // this origin, never a renderable page, whatever upstream claimed.
  return new Response(upstream.body ? upstream.body.pipeThrough(sizeLimiter) : null, {
    status: 200,
    headers: {
      ...cors,
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "content-disposition": "attachment",
    },
  });
}

function send(socket: WebSocket, data: unknown) {
  try {
    socket.send(JSON.stringify(data));
  } catch {
    // The close event will clean the socket up.
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>GEARS XR Room Server</title>
    <style>
      body { margin: 2rem; font-family: system-ui, sans-serif; line-height: 1.5; color: #1f2937; }
      code { background: #f3f4f6; border-radius: 4px; padding: 0.1rem 0.25rem; }
    </style>
  </head>
  <body>
    <h1>GEARS XR Room Server</h1>
    <p>Status: running</p>
    <p>Health check: <a href="/health"><code>/health</code></a></p>
    <p>WebSocket rooms connect at <code>/room/{roomId}</code>.</p>
  </body>
</html>`);
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/proxy") {
      return handleProxy(request, env);
    }

    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    const roomId = sanitizeRoomId(match?.[1] ?? null);
    if (!roomId) {
      return json({ error: "Expected /room/{roomId} with 3-40 lowercase letters, numbers, or dashes." }, { status: 404 });
    }
    if (!originAllowed(request, env)) {
      return forbidden("Origin is not allowed.");
    }

    const id = env.ROOMS.idFromName(roomId);
    return env.ROOMS.get(id).fetch(request);
  },
};

export class RoomDurableObject extends DurableObject<Env> {
  private roomId = "";
  private sockets = new Map<WebSocket, RoomUser>();
  private rateLimits = new Map<WebSocket, { windowStartedAt: number; count: number }>();
  private state: PresenterState = makeDefaultState();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = sanitizeRoomId(url.pathname.match(/^\/room\/([^/]+)$/)?.[1] ?? null);
    if (!roomId) {
      return json({ error: "Invalid room id." }, { status: 404 });
    }
    this.roomId = roomId;

    if (!originAllowed(request, this.env)) {
      return forbidden("Origin is not allowed.");
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ roomId, users: this.users(), state: this.state });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();

    server.addEventListener("message", (event) => this.onMessage(server, event));
    server.addEventListener("close", () => this.removeSocket(server));
    server.addEventListener("error", () => this.removeSocket(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  private onMessage(socket: WebSocket, event: MessageEvent) {
    let message: ClientMessage;
    if (messageByteLength(event.data) > numberFromEnv(this.env.MAX_MESSAGE_BYTES, DEFAULT_MAX_MESSAGE_BYTES)) {
      send(socket, { type: "error", message: "Message is too large." });
      socket.close(1009, "Message too large");
      return;
    }

    if (!this.allowMessage(socket)) {
      send(socket, { type: "error", message: "Message rate limit exceeded." });
      socket.close(1008, "Message rate limit exceeded");
      return;
    }

    try {
      message = JSON.parse(String(event.data)) as ClientMessage;
    } catch {
      send(socket, { type: "error", message: "Invalid JSON message." });
      return;
    }

    if (message.type === "join") {
      const user = normalizeUser(message.user);
      if (!user) {
        send(socket, { type: "error", message: "Invalid join message." });
        socket.close(1008, "Invalid join message");
        return;
      }
      if (!this.sockets.has(socket) && this.sockets.size >= numberFromEnv(this.env.MAX_ROOM_USERS, DEFAULT_MAX_ROOM_USERS)) {
        send(socket, { type: "error", message: "Room is full." });
        socket.close(1008, "Room is full");
        return;
      }

      this.sockets.set(socket, user);
      if (!this.state.presenterId || !this.hasUser(this.state.presenterId)) {
        this.state = { ...this.state, presenterId: user.id, updatedAt: Date.now() };
      }

      send(socket, {
        type: "snapshot",
        roomId: this.roomId,
        selfId: user.id,
        state: this.state,
        users: this.users(),
      });
      this.broadcastPresence();
      return;
    }

    const user = this.sockets.get(socket);
    if (!user) {
      send(socket, { type: "error", message: "Join before sending room messages." });
      return;
    }

    if (message.type === "presenter-state") {
      if (this.state.presenterId !== user.id) {
        send(socket, { type: "error", message: "Only the presenter can update shared state." });
        return;
      }

      this.state = mergePresenterState(this.state, message.state ?? {});
      this.broadcast({ type: "presenter-state", senderId: user.id, state: this.state }, socket);
      return;
    }

    if (message.type === "take-presenter") {
      this.state = { ...this.state, presenterId: user.id, updatedAt: Date.now() };
      this.broadcastPresence();
      this.broadcast({ type: "take-presenter", presenterId: user.id });
      return;
    }

    if (message.type === "leave") {
      socket.close(1000, "Leaving room");
    }
  }

  private removeSocket(socket: WebSocket) {
    const user = this.sockets.get(socket);
    if (!user) return;

    this.sockets.delete(socket);
    this.rateLimits.delete(socket);
    if (this.state.presenterId === user.id) {
      const nextPresenter = this.users()[0]?.id ?? null;
      this.state = { ...this.state, presenterId: nextPresenter, playing: nextPresenter ? this.state.playing : false, updatedAt: Date.now() };
    }
    this.broadcastPresence();
  }

  private hasUser(userId: string) {
    return this.users().some((user) => user.id === userId);
  }

  private users() {
    return [...this.sockets.values()];
  }

  private broadcastPresence() {
    this.broadcast({ type: "presence", users: this.users(), presenterId: this.state.presenterId });
  }

  private allowMessage(socket: WebSocket) {
    const now = Date.now();
    const limit = numberFromEnv(this.env.MAX_MESSAGES_PER_10_SECONDS, DEFAULT_MAX_MESSAGES_PER_10_SECONDS);
    const current = this.rateLimits.get(socket);
    if (!current || now - current.windowStartedAt > RATE_WINDOW_MS) {
      this.rateLimits.set(socket, { windowStartedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  }

  private broadcast(data: unknown, except?: WebSocket) {
    for (const socket of this.sockets.keys()) {
      if (socket !== except) send(socket, data);
    }
  }
}
