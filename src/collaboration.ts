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

export interface PresenterState {
  trajectoryUrl: string | null;
  frameIndex: number;
  playing: boolean;
  fps: number;
  transform: TransformState;
  view: ViewState;
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

export function defaultWebSocketBase() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get(SERVER_PARAM)?.trim();
  if (fromUrl) return normalizeWebSocketBase(fromUrl);

  const configured = import.meta.env.VITE_COLLAB_WS_BASE?.trim();
  if (configured) return normalizeWebSocketBase(configured);

  const localHost = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "";
  if (localHost || location.protocol === "file:") return "ws://127.0.0.1:8787";
  if (location.hostname) return `ws://${location.hostname}:8787`;
  return "";
}

export function sanitizeRoomId(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

export function makeRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

export function makeShareUrl(roomId: string, serverBase = "") {
  const url = new URL(location.href);
  url.searchParams.set("room", roomId);
  if (serverBase.trim()) {
    url.searchParams.set(SERVER_PARAM, normalizeWebSocketBase(serverBase));
  } else {
    url.searchParams.delete(SERVER_PARAM);
  }
  return url.toString();
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "";
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
  private roomId: string | null = null;
  private serverBase = "";
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

  get currentRoomId() {
    return this.roomId;
  }

  get connectionStatus() {
    return this.status;
  }

  get currentServerBase() {
    return this.serverBase;
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
    this.roomId = normalizedRoomId;
    this.serverBase = base;
    this.user = {
      ...this.user,
      name: userName.trim().slice(0, 40) || "Guest",
      joinedAt: Date.now(),
    };

    this.setStatus("connecting");
    const ws = new WebSocket(`${base}/room/${encodeURIComponent(normalizedRoomId)}`);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.setStatus("connected");
      this.send({ type: "join", user: this.user });
    });
    ws.addEventListener("message", (event) => this.onMessage(event));
    ws.addEventListener("close", () => {
      this.users = [];
      this.presenterId = null;
      this.setStatus("offline");
      this.callbacks.onPresence?.({ type: "presence", users: [], presenterId: null });
    });
    ws.addEventListener("error", () => {
      this.callbacks.onError?.(`Room connection failed: ${base}`);
      this.setStatus("error");
    });
  }

  disconnect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: "leave" });
    }
    this.ws?.close();
    this.ws = null;
    this.roomId = null;
    this.serverBase = "";
    this.users = [];
    this.presenterId = null;
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

  private onMessage(event: MessageEvent) {
    let message: ServerMessage;
    try {
      message = JSON.parse(String(event.data)) as ServerMessage;
    } catch {
      this.callbacks.onError?.("Received invalid room message.");
      return;
    }

    if (message.type === "snapshot") {
      this.users = message.users;
      this.presenterId = message.state.presenterId;
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

    if (message.type === "error") {
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
}
