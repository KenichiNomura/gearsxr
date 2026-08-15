export type Vec3Tuple = [number, number, number];
export type QuatTuple = [number, number, number, number];

export interface TransformState {
  position: Vec3Tuple;
  quaternion: QuatTuple;
  scale: Vec3Tuple;
}

export interface ViewState {
  cameraPosition: Vec3Tuple;
  orbitTarget: Vec3Tuple;
}

/** One isosurface of the current cube: level, color (0xRRGGBB), opacity, visibility. */
export interface SurfaceState {
  isovalue: number;
  color: number;
  opacity: number;
  visible: boolean;
}

export interface PresenterState {
  trajectoryUrl: string | null;
  frameIndex: number;
  playing: boolean;
  fps: number;
  backgroundId: string;
  transform: TransformState;
  view: ViewState;
  surfaces: SurfaceState[];
  presenterId: string | null;
  updatedAt: number;
}

export interface RoomUser {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
}

export type ConnectionStatus = "offline" | "connecting" | "connected" | "error";

export type ServerMessage =
  | { type: "snapshot"; roomId: string; selfId: string; state: PresenterState; users: RoomUser[] }
  | { type: "presence"; users: RoomUser[]; presenterId: string | null }
  | { type: "presenter-state"; senderId: string; state: PresenterState }
  | { type: "take-presenter"; presenterId: string }
  | { type: "upload-ticket"; token: string }
  | { type: "error"; message: string };

interface CollaborationCallbacks {
  onSnapshot?: (message: Extract<ServerMessage, { type: "snapshot" }>) => void;
  onPresence?: (message: Extract<ServerMessage, { type: "presence" }>) => void;
  onPresenterState?: (message: Extract<ServerMessage, { type: "presenter-state" }>) => void;
  onPresenterChanged?: (presenterId: string | null) => void;
  onConnectionStatus?: (status: ConnectionStatus) => void;
  onError?: (message: string) => void;
}

const COLORS = ["#44ccff", "#ffcc44", "#ff6b8a", "#69db7c", "#b197fc", "#ffa94d"];
const SERVER_PARAM = "server";
const JOIN_TIMEOUT_MS = 8000;

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

export function normalizeWebSocketBase(value: string) {
  return value.trim().replace(/\/+$/, "");
}

/** ws(s):// room-server base -> http(s):// base for its plain HTTP routes (e.g. /proxy). */
export function httpBaseFromWebSocketBase(base: string) {
  return base.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "";
}

export function defaultWebSocketBase() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get(SERVER_PARAM)?.trim();
  if (fromUrl) return normalizeWebSocketBase(fromUrl);

  const configured = import.meta.env.VITE_COLLAB_WS_BASE?.trim();
  if (configured) return normalizeWebSocketBase(configured);

  if (isLoopbackHost(location.hostname) || location.protocol === "file:") return "ws://127.0.0.1:8787";
  if (location.hostname) return `ws://${location.hostname}:8787`;
  return "";
}

export function sanitizeRoomId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

export function makeRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function isBlockedMixedWebSocket(base: string) {
  if (location.protocol !== "https:" || !base.startsWith("ws://")) return false;
  try {
    const url = new URL(base);
    return !isLoopbackHost(url.hostname);
  } catch {
    return true;
  }
}

export class CollaborationClient {
  private ws: WebSocket | null = null;
  private callbacks: CollaborationCallbacks;
  private status: ConnectionStatus = "offline";
  private intentionallyClosing = false;
  private joinTimeoutId: number | null = null;
  private pendingTicket: { resolve: (token: string) => void; reject: (error: Error) => void; timeoutId: number } | null = null;
  private user: RoomUser = {
    id: randomId(),
    name: "Guest",
    color: randomColor(),
    joinedAt: Date.now(),
  };

  users: RoomUser[] = [];
  presenterId: string | null = null;

  constructor(callbacks: CollaborationCallbacks = {}) {
    this.callbacks = callbacks;
  }

  get selfId() {
    return this.user.id;
  }

  get connectionStatus() {
    return this.status;
  }

  isConnected() {
    return this.status === "connected" && this.ws?.readyState === WebSocket.OPEN;
  }

  isPresenter() {
    return this.isConnected() && this.presenterId === this.selfId;
  }

  connect(roomId: string, userName: string, serverBase = "") {
    const normalizedRoomId = sanitizeRoomId(roomId);
    if (!normalizedRoomId || normalizedRoomId.length < 3) {
      this.callbacks.onError?.("Room code must be at least 3 letters or numbers.");
      return;
    }

    const base = normalizeWebSocketBase(serverBase) || defaultWebSocketBase();
    if (!base) {
      this.callbacks.onError?.("Set VITE_COLLAB_WS_BASE to the deployed Worker wss:// URL.");
      return;
    }
    if (isBlockedMixedWebSocket(base)) {
      this.callbacks.onError?.(
        `HTTPS pages cannot reliably connect to ${base}. Use the HTTP dev page for desktop testing, or use a deployed wss:// Worker for WebXR.`,
      );
      this.setStatus("error");
      return;
    }

    this.disconnect();
    this.intentionallyClosing = false;
    this.user = {
      ...this.user,
      name: userName.trim().slice(0, 40) || "Guest",
      joinedAt: Date.now(),
    };

    this.setStatus("connecting");
    const ws = new WebSocket(`${base}/room/${encodeURIComponent(normalizedRoomId)}`);
    this.ws = ws;
    this.joinTimeoutId = window.setTimeout(() => {
      if (this.ws !== ws) return;
      this.clearJoinTimeout();
      this.resetRoomState();
      this.setStatus("error");
      this.callbacks.onError?.(`Room connection timed out: ${base}`);
      ws.close(4000, "Join timed out");
    }, JOIN_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.send({ type: "join", user: this.user });
    });
    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      this.onMessage(event);
    });
    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.clearJoinTimeout();
      const wasIntentional = this.intentionallyClosing;
      this.intentionallyClosing = false;
      this.resetRoomState();
      if (!wasIntentional && event.code !== 1000) {
        this.setStatus("error");
        const reason = event.reason ? `: ${event.reason}` : ` (code ${event.code})`;
        this.callbacks.onError?.(`Room disconnected${reason}`);
        return;
      }
      this.setStatus("offline");
    });
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return;
      this.clearJoinTimeout();
      this.callbacks.onError?.(`Room connection failed: ${base}`);
      this.setStatus("error");
    });
  }

  disconnect() {
    this.clearJoinTimeout();
    this.intentionallyClosing = Boolean(this.ws);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: "leave" });
    }
    this.ws?.close();
    this.resetRoomState();
    this.setStatus("offline");
  }

  sendPresenterState(state: PresenterState) {
    if (!this.isPresenter()) return;
    this.send({ type: "presenter-state", state });
  }

  takePresenter() {
    if (!this.isConnected()) return;
    this.send({ type: "take-presenter" });
  }

  /**
   * Asks the room server for a short-lived ticket authorizing the presenter to
   * upload a local trajectory (up to `size` bytes) to the /share endpoint.
   * Resolves with the token, or rejects on error/timeout.
   */
  requestUploadTicket(size: number, name: string): Promise<string> {
    if (!this.isPresenter()) return Promise.reject(new Error("Only the presenter can share a file."));
    if (this.pendingTicket) return Promise.reject(new Error("An upload ticket request is already in progress."));
    return new Promise<string>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pendingTicket = null;
        reject(new Error("Timed out waiting for an upload ticket."));
      }, JOIN_TIMEOUT_MS);
      this.pendingTicket = { resolve, reject, timeoutId };
      this.send({ type: "request-upload", size, name });
    });
  }

  private settleTicket(token: string | null, error?: Error) {
    if (!this.pendingTicket) return;
    window.clearTimeout(this.pendingTicket.timeoutId);
    if (token !== null) this.pendingTicket.resolve(token);
    else this.pendingTicket.reject(error ?? new Error("Upload ticket request failed."));
    this.pendingTicket = null;
  }

  private onMessage(event: MessageEvent) {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(event.data)) as ServerMessage;
    } catch {
      this.callbacks.onError?.("Received invalid room message.");
      return;
    }

    if (message.type === "snapshot") {
      this.clearJoinTimeout();
      this.users = message.users;
      this.presenterId = message.state.presenterId;
      this.setStatus("connected");
      this.callbacks.onSnapshot?.(message);
      this.callbacks.onPresenterChanged?.(this.presenterId);
      return;
    }

    if (message.type === "presence") {
      this.users = message.users;
      this.presenterId = message.presenterId;
      this.callbacks.onPresence?.(message);
      this.callbacks.onPresenterChanged?.(this.presenterId);
      return;
    }

    if (message.type === "presenter-state") {
      this.presenterId = message.state.presenterId;
      this.callbacks.onPresenterState?.(message);
      return;
    }

    if (message.type === "take-presenter") {
      this.presenterId = message.presenterId;
      this.callbacks.onPresenterChanged?.(this.presenterId);
      return;
    }

    if (message.type === "upload-ticket") {
      this.settleTicket(message.token);
      return;
    }

    if (message.type === "error") {
      // A share request in flight fails without tearing down the connection.
      if (this.pendingTicket) {
        this.settleTicket(null, new Error(message.message));
        return;
      }
      this.clearJoinTimeout();
      this.setStatus("error");
      this.callbacks.onError?.(message.message);
    }
  }

  private send(data: unknown) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(data));
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    this.callbacks.onConnectionStatus?.(status);
  }

  private clearJoinTimeout() {
    if (this.joinTimeoutId === null) return;
    window.clearTimeout(this.joinTimeoutId);
    this.joinTimeoutId = null;
  }

  /** Clears connection/room fields and notifies listeners that the room is empty. */
  private resetRoomState() {
    this.settleTicket(null, new Error("Left the room before the upload ticket arrived."));
    this.ws = null;
    this.users = [];
    this.presenterId = null;
    this.callbacks.onPresence?.({ type: "presence", users: [], presenterId: null });
  }
}
