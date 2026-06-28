import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDurableObject>;
  ALLOWED_ORIGINS?: string;
  MAX_ROOM_USERS?: string;
  MAX_MESSAGE_BYTES?: string;
  MAX_MESSAGES_PER_10_SECONDS?: string;
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
  const trajectoryUrl = typeof patch.trajectoryUrl === "string" || patch.trajectoryUrl === null
    ? patch.trajectoryUrl
    : current.trajectoryUrl;

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

  constructor(durableState: DurableObjectState, env: Env) {
    super(durableState, env);
  }

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
