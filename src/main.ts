import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { parseExtendedXYZ } from "./xyzParser";
import { MoleculeRenderer } from "./moleculeRenderer";
import { VRObjectManipulator } from "./vrInteraction";
import { MeasurementTool } from "./measurement";
import { Playback } from "./playback";
import {
  BACKGROUND_PRESETS,
  DEFAULT_BACKGROUND_ID,
  getBackgroundPreset,
  normalizeBackgroundId,
} from "./backgrounds";
import {
  CollaborationClient,
  defaultWebSocketBase,
  makeRoomId,
  normalizeWebSocketBase,
  sanitizeRoomId,
  type PresenterState,
  type TransformState,
  type ViewState,
} from "./collaboration";

const appEl = document.getElementById("app")!;
const uiEl = document.getElementById("ui")!;
const statusEl = document.getElementById("status")!;
const toggleControlsBtn = document.getElementById("toggleControlsBtn") as HTMLButtonElement;
const collaborationEl = document.getElementById("collaboration")!;
const toggleRoomBtn = document.getElementById("toggleRoomBtn") as HTMLButtonElement;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const urlInput = document.getElementById("urlInput") as HTMLInputElement;
const loadUrlBtn = document.getElementById("loadUrlBtn") as HTMLButtonElement;
const backgroundSelect = document.getElementById("backgroundSelect") as HTMLSelectElement;
const vrEntryEl = document.getElementById("vrEntry")!;
const playbackEl = document.getElementById("playback")!;
const frameSlider = document.getElementById("frameSlider") as HTMLInputElement;
const frameLabel = document.getElementById("frameLabel")!;
const playBtn = document.getElementById("playBtn") as HTMLButtonElement;
const stepBack = document.getElementById("stepBack") as HTMLButtonElement;
const stepFwd = document.getElementById("stepFwd") as HTMLButtonElement;
const fpsInput = document.getElementById("fpsInput") as HTMLInputElement;
const roomInput = document.getElementById("roomInput") as HTMLInputElement;
const userNameInput = document.getElementById("userNameInput") as HTMLInputElement;
const serverInput = document.getElementById("serverInput") as HTMLInputElement;
const copyRoomCodeBtn = document.getElementById("copyRoomCodeBtn") as HTMLButtonElement;
const joinRoomBtn = document.getElementById("joinRoomBtn") as HTMLButtonElement;
const leaveRoomBtn = document.getElementById("leaveRoomBtn") as HTMLButtonElement;
const takePresenterBtn = document.getElementById("takePresenterBtn") as HTMLButtonElement;
const collabStatusEl = document.getElementById("collabStatus")!;

// Surface otherwise-silent runtime errors in the UI status line, since most
// users testing this won't have DevTools open.
window.addEventListener("error", (e) => {
  statusEl.textContent = `Runtime error: ${e.message}`;
});
window.addEventListener("unhandledrejection", (e) => {
  statusEl.textContent = `Unhandled rejection: ${e.reason}`;
});

const defaultSceneBackground = new THREE.Color(0x111317);
const scene = new THREE.Scene();
scene.background = defaultSceneBackground;

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 1.5, 4);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
appEl.appendChild(renderer.domElement);

const vrButton = VRButton.createButton(renderer);
Object.assign(vrButton.style, {
  position: "static",
  top: "auto",
  right: "auto",
  bottom: "auto",
  left: "auto",
  margin: "0",
});
vrEntryEl.appendChild(vrButton);

const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.target.set(0, 1, 0);
orbitControls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.55));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.35);
dirLight.position.set(0, 0, 0);
dirLight.target.position.set(0, 0, -1);
camera.add(dirLight);
camera.add(dirLight.target);

const grid = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
grid.position.y = 0;
scene.add(grid);

let moleculeRenderer: MoleculeRenderer | null = null;
let playback: Playback | null = null;
let currentTrajectoryUrl: string | null = null;
let pendingTrajectoryUrl: string | null = null;
let activeTrajectoryFetch: AbortController | null = null;
let trajectoryLoadVersion = 0;
let applyingRemoteState = false;
let pendingPresenterSync = false;
let lastPresenterSyncAt = 0;
let lastObservedTransform = "";
let lastObservedView = "";
let remoteApplyVersion = 0;
const MIN_FPS = 1;
const MAX_FPS = 60;

// Persistent group that VR grab/scale acts on; molecule contents are swapped
// in/out of it per file load so the manipulator/controllers only need to be
// set up once instead of accumulating duplicate listeners on every reload.
const moleculeRoot = new THREE.Group();
scene.add(moleculeRoot);

const manipulator = new VRObjectManipulator(renderer, moleculeRoot, scene);

const measurementTool = new MeasurementTool((text) => {
  statusEl.textContent = text;
});
scene.add(measurementTool.group);

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();
const pointerNdc = new THREE.Vector2();
const CLICK_SELECT_MAX_DRIFT_PX = 5;
let pointerSelectStart: { pointerId: number; x: number; y: number } | null = null;

function setupSelectionRaycast(controller: THREE.Group) {
  controller.addEventListener("select" as keyof THREE.Object3DEventMap, () => {
    if (!moleculeRenderer) return;
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
    measurementTool.raycastSelect(raycaster, moleculeRenderer);
  });
}

for (const controller of manipulator.getControllers()) {
  setupSelectionRaycast(controller);
}

const USER_NAME_KEY = "gearsxr-user-name";
const SERVER_BASE_KEY = "gearsxr-server-base";
const BACKGROUND_KEY = "gearsxr-background";
const CONTROLS_COLLAPSED_KEY = "gearsxr-controls-collapsed";
const ROOM_COLLAPSED_KEY = "gearsxr-room-collapsed";
const LEGACY_USER_NAME_KEY = "vr-md-viewer-user-name";
const LEGACY_SERVER_BASE_KEY = "vr-md-viewer-server-base";
const LEGACY_BACKGROUND_KEY = "vr-md-viewer-background";
const LEGACY_CONTROLS_COLLAPSED_KEY = "vr-md-viewer-controls-collapsed";

function readStoredValue(key: string, legacyKey: string): string | null {
  const value = localStorage.getItem(key);
  if (value !== null) return value;

  const legacyValue = localStorage.getItem(legacyKey);
  if (legacyValue !== null) {
    localStorage.setItem(key, legacyValue);
  }
  return legacyValue;
}

const urlParams = new URLSearchParams(location.search);
const backgroundFromUrl = urlParams.get("background");
let currentBackgroundId = backgroundFromUrl
  ? normalizeBackgroundId(backgroundFromUrl)
  : normalizeBackgroundId(readStoredValue(BACKGROUND_KEY, LEGACY_BACKGROUND_KEY) ?? DEFAULT_BACKGROUND_ID);
let appliedBackgroundId = "";
let backgroundLoadVersion = 0;
const backgroundLoader = new THREE.TextureLoader();
const backgroundTextures = new Map<string, THREE.Texture>();

for (const preset of BACKGROUND_PRESETS) {
  const option = document.createElement("option");
  option.value = preset.id;
  option.textContent = preset.label;
  backgroundSelect.appendChild(option);
}
backgroundSelect.value = currentBackgroundId;

function setControlsCollapsed(collapsed: boolean) {
  uiEl.classList.toggle("collapsed", collapsed);
  toggleControlsBtn.textContent = collapsed ? "Show" : "Hide";
  toggleControlsBtn.setAttribute("aria-expanded", String(!collapsed));
  localStorage.setItem(CONTROLS_COLLAPSED_KEY, collapsed ? "1" : "0");
}

function setRoomCollapsed(collapsed: boolean) {
  collaborationEl.classList.toggle("collapsed", collapsed);
  toggleRoomBtn.textContent = collapsed ? "Show" : "Hide";
  toggleRoomBtn.setAttribute("aria-expanded", String(!collapsed));
  localStorage.setItem(ROOM_COLLAPSED_KEY, collapsed ? "1" : "0");
}

setControlsCollapsed(readStoredValue(CONTROLS_COLLAPSED_KEY, LEGACY_CONTROLS_COLLAPSED_KEY) === "1");
setRoomCollapsed(localStorage.getItem(ROOM_COLLAPSED_KEY) !== "0");

const roomFromUrl = sanitizeRoomId(urlParams.get("room") ?? "");
roomInput.value = roomFromUrl.length >= 3 ? roomFromUrl : makeRoomId();
userNameInput.value = readStoredValue(USER_NAME_KEY, LEGACY_USER_NAME_KEY) ?? `User ${Math.floor(1000 + Math.random() * 9000)}`;
serverInput.value = normalizeWebSocketBase(
  urlParams.get("server") ?? readStoredValue(SERVER_BASE_KEY, LEGACY_SERVER_BASE_KEY) ?? defaultWebSocketBase()
);

const collaboration = new CollaborationClient({
  onSnapshot: (message) => {
    updateCollaborationUi();
    if (collaboration.isPresenter()) {
      markPresenterStateDirty(true);
    } else {
      void applyRemotePresenterState(message.state);
    }
  },
  onPresence: () => updateCollaborationUi(),
  onPresenterState: (message) => {
    if (message.senderId !== collaboration.selfId) {
      void applyRemotePresenterState(message.state);
    }
  },
  onPresenterChanged: () => {
    updateCollaborationUi();
    if (collaboration.isPresenter()) {
      markPresenterStateDirty(true);
    }
  },
  onConnectionStatus: () => updateCollaborationUi(),
  onError: (message) => {
    collabStatusEl.textContent = `Room error: ${message}`;
  },
});

function objectTransformSignature(object: THREE.Object3D) {
  const { position, quaternion, scale } = object;
  return `${position.x.toFixed(5)},${position.y.toFixed(5)},${position.z.toFixed(5)},` +
    `${quaternion.x.toFixed(5)},${quaternion.y.toFixed(5)},${quaternion.z.toFixed(5)},${quaternion.w.toFixed(5)},` +
    `${scale.x.toFixed(5)},${scale.y.toFixed(5)},${scale.z.toFixed(5)}`;
}

function currentViewSignature() {
  const { position } = camera;
  const { target } = orbitControls;
  return `${position.x.toFixed(5)},${position.y.toFixed(5)},${position.z.toFixed(5)},` +
    `${target.x.toFixed(5)},${target.y.toFixed(5)},${target.z.toFixed(5)}`;
}

function getMoleculeTransform(): TransformState {
  return {
    position: moleculeRoot.position.toArray() as [number, number, number],
    quaternion: moleculeRoot.quaternion.toArray() as [number, number, number, number],
    scale: moleculeRoot.scale.toArray() as [number, number, number],
  };
}

function getViewState(): ViewState {
  return {
    cameraPosition: camera.position.toArray() as [number, number, number],
    orbitTarget: orbitControls.target.toArray() as [number, number, number],
  };
}

function clampFps(value: number) {
  return Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(value)));
}

function readFpsInput() {
  const value = Number.parseFloat(fpsInput.value);
  return Number.isFinite(value) ? clampFps(value) : 15;
}

function applyFpsInput(commit = false) {
  if (!playback) return;
  const parsed = Number.parseFloat(fpsInput.value);
  if (!Number.isFinite(parsed)) {
    if (commit) fpsInput.value = String(playback.fps);
    return;
  }
  playback.fps = clampFps(parsed);
  if (commit) fpsInput.value = String(playback.fps);
  markPresenterStateDirty(true);
}

async function setSceneBackground(
  backgroundId: string,
  options: { broadcastState?: boolean; persist?: boolean } = {},
) {
  const { broadcastState = true, persist = true } = options;
  const nextBackgroundId = normalizeBackgroundId(backgroundId);

  if (persist) {
    localStorage.setItem(BACKGROUND_KEY, nextBackgroundId);
  }
  if (currentBackgroundId === nextBackgroundId && appliedBackgroundId === nextBackgroundId) {
    if (broadcastState) markPresenterStateDirty(true);
    return;
  }

  currentBackgroundId = nextBackgroundId;
  backgroundSelect.value = nextBackgroundId;
  const loadVersion = ++backgroundLoadVersion;
  const preset = getBackgroundPreset(nextBackgroundId);

  if (!preset.url) {
    scene.background = defaultSceneBackground;
    appliedBackgroundId = nextBackgroundId;
    if (broadcastState) markPresenterStateDirty(true);
    return;
  }

  try {
    let texture = backgroundTextures.get(nextBackgroundId);
    if (!texture) {
      texture = await backgroundLoader.loadAsync(new URL(preset.url, location.href).toString());
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.mapping = THREE.EquirectangularReflectionMapping;
      backgroundTextures.set(nextBackgroundId, texture);
    }
    if (loadVersion !== backgroundLoadVersion || currentBackgroundId !== nextBackgroundId) return;
    scene.background = texture;
    appliedBackgroundId = nextBackgroundId;
    if (broadcastState) markPresenterStateDirty(true);
  } catch (err) {
    console.error(err);
    if (loadVersion === backgroundLoadVersion) {
      statusEl.textContent = `Background error: ${(err as Error).message}`;
    }
  }
}

function applyMoleculeTransform(transform: TransformState) {
  moleculeRoot.position.fromArray(transform.position);
  moleculeRoot.quaternion.fromArray(transform.quaternion);
  moleculeRoot.scale.fromArray(transform.scale);
  moleculeRoot.updateMatrixWorld(true);
  lastObservedTransform = objectTransformSignature(moleculeRoot);
}

function applyViewState(view: ViewState) {
  if (renderer.xr.isPresenting) return;

  camera.position.fromArray(view.cameraPosition);
  orbitControls.target.fromArray(view.orbitTarget);
  camera.updateMatrixWorld(true);
  orbitControls.update();
  lastObservedView = currentViewSignature();
}

function getPresenterState(): PresenterState {
  return {
    trajectoryUrl: currentTrajectoryUrl,
    frameIndex: playback?.frame ?? 0,
    playing: playback?.playing ?? false,
    fps: playback?.fps ?? readFpsInput(),
    backgroundId: currentBackgroundId,
    transform: getMoleculeTransform(),
    view: getViewState(),
    presenterId: collaboration.presenterId,
    updatedAt: Date.now(),
  };
}

function markPresenterStateDirty(force = false) {
  if (applyingRemoteState || !collaboration.isPresenter()) return;
  pendingPresenterSync = true;
  if (force) flushPresenterState(true);
}

function flushPresenterState(force = false) {
  if (!pendingPresenterSync || !collaboration.isPresenter()) return;
  const now = performance.now();
  if (!force && now - lastPresenterSyncAt < 100) return;
  collaboration.sendPresenterState(getPresenterState());
  pendingPresenterSync = false;
  lastPresenterSyncAt = now;
}

function updateRoomCodeUi() {
  const roomId = sanitizeRoomId(roomInput.value);
  copyRoomCodeBtn.disabled = roomId.length < 3;
}

function updateCollaborationUi() {
  updateRoomCodeUi();
  const connected = collaboration.isConnected();
  const connecting = collaboration.connectionStatus === "connecting";
  const presenter = collaboration.users.find((user) => user.id === collaboration.presenterId);
  const role = connected ? (collaboration.isPresenter() ? "Presenter" : "Follower") : collaboration.connectionStatus;
  const users = collaboration.users.length;

  joinRoomBtn.disabled = connected || connecting;
  leaveRoomBtn.disabled = !connected && !connecting;
  takePresenterBtn.disabled = !connected || collaboration.isPresenter();
  serverInput.disabled = connected || connecting;
  const canControlSharedState = !connected || collaboration.isPresenter();
  manipulator.setEnabled(canControlSharedState);
  orbitControls.enabled = canControlSharedState;
  fileInput.disabled = !canControlSharedState;
  urlInput.disabled = !canControlSharedState;
  loadUrlBtn.disabled = !canControlSharedState;
  frameSlider.disabled = !canControlSharedState;
  playBtn.disabled = !canControlSharedState;
  stepBack.disabled = !canControlSharedState;
  stepFwd.disabled = !canControlSharedState;
  fpsInput.disabled = !canControlSharedState;
  backgroundSelect.disabled = !canControlSharedState;

  const statusLines = connected
    ? [
        `${role} | ${users} user${users === 1 ? "" : "s"}`,
        presenter ? `Presenter: ${presenter.name}` : "Presenter: none",
        collaboration.isPresenter() ? "You control frame and view" : "Following presenter view",
        `Server: ${serverInput.value}`,
      ]
    : [role.charAt(0).toUpperCase() + role.slice(1)];
  collabStatusEl.textContent = statusLines.join("\n");
}

async function applyRemotePresenterState(state: PresenterState) {
  const applyVersion = ++remoteApplyVersion;
  applyingRemoteState = true;
  try {
    await setSceneBackground(state.backgroundId, { broadcastState: false, persist: false });
    if (applyVersion !== remoteApplyVersion) return;

    if (!state.trajectoryUrl && !moleculeRenderer) {
      statusEl.textContent = "Waiting for presenter to load a trajectory URL. Local files are not shared through the room.";
    }

    if (state.trajectoryUrl && state.trajectoryUrl !== currentTrajectoryUrl) {
      await loadTrajectoryFromUrl(state.trajectoryUrl, false);
      if (applyVersion !== remoteApplyVersion) return;
    }

    applyMoleculeTransform(state.transform);
    if (state.view) {
      applyViewState(state.view);
    }
    if (playback) {
      playback.fps = state.fps;
      fpsInput.value = String(state.fps);
      playback.playing = state.playing;
      playBtn.textContent = playback.playing ? "Pause" : "Play";
      playback.setFrame(state.frameIndex);
    }
  } finally {
    applyingRemoteState = false;
    updateCollaborationUi();
  }
}

updateCollaborationUi();
void setSceneBackground(currentBackgroundId, { broadcastState: false, persist: false });

toggleControlsBtn.addEventListener("click", () => {
  setControlsCollapsed(!uiEl.classList.contains("collapsed"));
});

toggleRoomBtn.addEventListener("click", () => {
  setRoomCollapsed(!collaborationEl.classList.contains("collapsed"));
});

// Desktop click-to-select; a small drift guard lets normal orbit-dragging pass through.
renderer.domElement.addEventListener("pointerdown", (event: PointerEvent) => {
  if (event.button !== 0 || renderer.xr.isPresenting) {
    pointerSelectStart = null;
    return;
  }
  pointerSelectStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
});

renderer.domElement.addEventListener("pointerup", (event: PointerEvent) => {
  const start = pointerSelectStart;
  pointerSelectStart = null;
  if (!moleculeRenderer || !start || start.pointerId !== event.pointerId) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  if (dx * dx + dy * dy > CLICK_SELECT_MAX_DRIFT_PX * CLICK_SELECT_MAX_DRIFT_PX) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNdc, camera);
  measurementTool.raycastSelect(raycaster, moleculeRenderer);
});

renderer.domElement.addEventListener("pointercancel", () => {
  pointerSelectStart = null;
});

renderer.domElement.addEventListener("keydown", () => {});
window.addEventListener("keydown", (e) => {
  if (e.key === "c" || e.key === "C") measurementTool.clear();
});

async function loadTrajectoryFile(
  file: Blob,
  sourceUrl: string | null = null,
  broadcastState = true,
  loadVersion = ++trajectoryLoadVersion,
) {
  if (!sourceUrl) {
    activeTrajectoryFetch?.abort();
    activeTrajectoryFetch = null;
    pendingTrajectoryUrl = null;
  }
  statusEl.textContent = "Parsing...";
  try {
    const trajectory = await parseExtendedXYZ(file, (p) => {
      if (loadVersion !== trajectoryLoadVersion) return;
      const pct = ((p.bytesRead / p.totalBytes) * 100).toFixed(0);
      statusEl.textContent = `Parsing... ${pct}% (${p.framesParsed} frames)`;
    });
    if (loadVersion !== trajectoryLoadVersion) return;

    if (moleculeRenderer) {
      moleculeRoot.remove(moleculeRenderer.group);
      moleculeRenderer.dispose();
    }
    moleculeRenderer = new MoleculeRenderer(trajectory);
    moleculeRoot.add(moleculeRenderer.group);
    moleculeRoot.position.set(0, 0, 0);
    moleculeRoot.quaternion.identity();
    moleculeRoot.scale.set(1, 1, 1);
    lastObservedTransform = objectTransformSignature(moleculeRoot);
    measurementTool.clear();
    currentTrajectoryUrl = sourceUrl;

    playback = new Playback(trajectory.numFrames, (frame) => {
      moleculeRenderer?.setFrame(frame);
      frameSlider.value = String(frame);
      frameLabel.textContent = `${frame} / ${trajectory.numFrames - 1}`;
      markPresenterStateDirty();
    });
    playback.fps = readFpsInput();
    fpsInput.value = String(playback.fps);

    frameSlider.min = "0";
    frameSlider.max = String(trajectory.numFrames - 1);
    frameSlider.value = "0";
    frameLabel.textContent = `0 / ${trajectory.numFrames - 1}`;
    playbackEl.style.display = "block";
    document.body.classList.add("has-playback");

    statusEl.textContent = `Loaded ${trajectory.numAtoms} atoms x ${trajectory.numFrames} frames`;
    if (broadcastState && collaboration.isPresenter() && !sourceUrl) {
      statusEl.textContent += "\nRoom note: local files cannot sync to other users. Use Load URL for multiuser rooms.";
    }
    if (broadcastState) markPresenterStateDirty(true);
  } catch (err) {
    if (loadVersion !== trajectoryLoadVersion) return;
    console.error(err);
    statusEl.textContent = `Error: ${(err as Error).message}`;
  }
}

async function loadTrajectoryFromUrl(url: string, broadcastState = true) {
  if (pendingTrajectoryUrl === url) return;
  const loadVersion = ++trajectoryLoadVersion;
  activeTrajectoryFetch?.abort();
  const fetchController = new AbortController();
  activeTrajectoryFetch = fetchController;
  pendingTrajectoryUrl = url;
  statusEl.textContent = "Fetching...";
  try {
    const response = await fetch(url, { signal: fetchController.signal });
    if (loadVersion !== trajectoryLoadVersion) return;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    if (loadVersion !== trajectoryLoadVersion) return;
    await loadTrajectoryFile(blob, url, broadcastState, loadVersion);
  } catch (err) {
    if (loadVersion !== trajectoryLoadVersion) return;
    if (err instanceof DOMException && err.name === "AbortError") return;
    console.error(err);
    statusEl.textContent = `Fetch error: ${(err as Error).message}`;
  } finally {
    if (activeTrajectoryFetch === fetchController) {
      activeTrajectoryFetch = null;
    }
    if (pendingTrajectoryUrl === url) {
      pendingTrajectoryUrl = null;
    }
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadTrajectoryFile(file, null, true);
});

// Drag-and-drop fallback: doesn't depend on the native file-picker dialog,
// which can fail to appear on some browser/OS/permission combinations.
const dropZone = document.getElementById("ui")!;
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.style.outline = "2px dashed #44ccff";
});
dropZone.addEventListener("dragleave", () => {
  dropZone.style.outline = "none";
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.style.outline = "none";
  const file = e.dataTransfer?.files?.[0];
  if (file) loadTrajectoryFile(file, null, true);
});

loadUrlBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  await loadTrajectoryFromUrl(url, true);
});

frameSlider.addEventListener("input", () => {
  playback?.setFrame(parseInt(frameSlider.value, 10));
});

playBtn.addEventListener("click", () => {
  if (!playback) return;
  playback.playing = !playback.playing;
  playBtn.textContent = playback.playing ? "Pause" : "Play";
  markPresenterStateDirty(true);
});

stepBack.addEventListener("click", () => {
  if (!playback) return;
  playback.setFrame(playback.frame - 1);
});

stepFwd.addEventListener("click", () => {
  if (!playback) return;
  playback.setFrame(playback.frame + 1);
});

fpsInput.addEventListener("input", () => applyFpsInput(false));
fpsInput.addEventListener("change", () => applyFpsInput(true));

backgroundSelect.addEventListener("change", () => {
  void setSceneBackground(backgroundSelect.value, { broadcastState: true, persist: true });
});

roomInput.addEventListener("input", updateRoomCodeUi);
serverInput.addEventListener("input", updateRoomCodeUi);

joinRoomBtn.addEventListener("click", () => {
  const roomId = sanitizeRoomId(roomInput.value) || makeRoomId();
  const serverBase = normalizeWebSocketBase(serverInput.value);
  roomInput.value = roomId;
  serverInput.value = serverBase;
  localStorage.setItem(USER_NAME_KEY, userNameInput.value.trim());
  localStorage.setItem(SERVER_BASE_KEY, serverBase);
  collaboration.connect(roomId, userNameInput.value, serverBase);
  updateRoomCodeUi();
});

leaveRoomBtn.addEventListener("click", () => {
  collaboration.disconnect();
  updateCollaborationUi();
});

takePresenterBtn.addEventListener("click", () => {
  collaboration.takePresenter();
});

copyRoomCodeBtn.addEventListener("click", async () => {
  const roomId = sanitizeRoomId(roomInput.value);
  if (roomId.length < 3) return;
  roomInput.value = roomId;
  updateRoomCodeUi();
  try {
    await navigator.clipboard.writeText(roomId);
    collabStatusEl.textContent = `${collabStatusEl.textContent}\nRoom code copied`;
  } catch {
    roomInput.select();
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  playback?.step(delta);
  manipulator?.update();
  const signature = objectTransformSignature(moleculeRoot);
  if (signature !== lastObservedTransform) {
    lastObservedTransform = signature;
    markPresenterStateDirty();
  }
  if (!renderer.xr.isPresenting) {
    const signature = currentViewSignature();
    if (signature !== lastObservedView) {
      lastObservedView = signature;
      markPresenterStateDirty();
    }
  }
  orbitControls.update();
  flushPresenterState();
  renderer.render(scene, camera);
});
