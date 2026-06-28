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
  makeShareUrl,
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
const joinRoomBtn = document.getElementById("joinRoomBtn") as HTMLButtonElement;
const leaveRoomBtn = document.getElementById("leaveRoomBtn") as HTMLButtonElement;
const roomLink = document.getElementById("roomLink") as HTMLInputElement;
const copyRoomLinkBtn = document.getElementById("copyRoomLinkBtn") as HTMLButtonElement;
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

setControlsCollapsed(readStoredValue(CONTROLS_COLLAPSED_KEY, LEGACY_CONTROLS_COLLAPSED_KEY) === "1");

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

function transformSignature(transform: TransformState) {
  return [
    ...transform.position,
    ...transform.quaternion,
    ...transform.scale,
  ].map((value) => value.toFixed(5)).join(",");
}

function viewSignature(view: ViewState) {
  return [
    ...view.cameraPosition,
    ...view.orbitTarget,
  ].map((value) => value.toFixed(5)).join(",");
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
  lastObservedTransform = transformSignature(getMoleculeTransform());
}

function applyViewState(view: ViewState) {
  if (renderer.xr.isPresenting) return;

  camera.position.fromArray(view.cameraPosition);
  orbitControls.target.fromArray(view.orbitTarget);
  camera.updateMatrixWorld(true);
  orbitControls.update();
  lastObservedView = viewSignature(getViewState());
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

function updateRoomLink() {
  const roomId = sanitizeRoomId(roomInput.value);
  roomLink.value = roomId.length >= 3 ? makeShareUrl(roomId, serverInput.value) : "";
  copyRoomLinkBtn.disabled = !roomLink.value;
}

function updateCollaborationUi() {
  updateRoomLink();
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

// Desktop click-to-select (so the measurement tool is usable without a headset).
renderer.domElement.addEventListener("dblclick", (event: MouseEvent) => {
  if (!moleculeRenderer) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  measurementTool.raycastSelect(raycaster, moleculeRenderer);
});

renderer.domElement.addEventListener("keydown", () => {});
window.addEventListener("keydown", (e) => {
  if (e.key === "c" || e.key === "C") measurementTool.clear();
});

async function loadTrajectoryFile(file: Blob, sourceUrl: string | null = null, broadcastState = true) {
  statusEl.textContent = "Parsing...";
  try {
    const trajectory = await parseExtendedXYZ(file, (p) => {
      const pct = ((p.bytesRead / p.totalBytes) * 100).toFixed(0);
      statusEl.textContent = `Parsing... ${pct}% (${p.framesParsed} frames)`;
    });

    if (moleculeRenderer) {
      moleculeRoot.remove(moleculeRenderer.group);
    }
    moleculeRenderer = new MoleculeRenderer(trajectory);
    moleculeRoot.add(moleculeRenderer.group);
    moleculeRoot.position.set(0, 0, 0);
    moleculeRoot.quaternion.identity();
    moleculeRoot.scale.set(1, 1, 1);
    lastObservedTransform = transformSignature(getMoleculeTransform());
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

    statusEl.textContent = `Loaded ${trajectory.numAtoms} atoms x ${trajectory.numFrames} frames`;
    if (broadcastState && collaboration.isPresenter() && !sourceUrl) {
      statusEl.textContent += "\nRoom note: local files cannot sync to other users. Use Load URL for multiuser rooms.";
    }
    if (broadcastState) markPresenterStateDirty(true);
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${(err as Error).message}`;
  }
}

async function loadTrajectoryFromUrl(url: string, broadcastState = true) {
  if (pendingTrajectoryUrl === url) return;
  pendingTrajectoryUrl = url;
  statusEl.textContent = "Fetching...";
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    await loadTrajectoryFile(blob, url, broadcastState);
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Fetch error: ${(err as Error).message}`;
  } finally {
    pendingTrajectoryUrl = null;
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

roomInput.addEventListener("input", updateRoomLink);
serverInput.addEventListener("input", updateRoomLink);

joinRoomBtn.addEventListener("click", () => {
  const roomId = sanitizeRoomId(roomInput.value) || makeRoomId();
  const serverBase = normalizeWebSocketBase(serverInput.value);
  roomInput.value = roomId;
  serverInput.value = serverBase;
  localStorage.setItem(USER_NAME_KEY, userNameInput.value.trim());
  localStorage.setItem(SERVER_BASE_KEY, serverBase);
  collaboration.connect(roomId, userNameInput.value, serverBase);
  updateRoomLink();
});

leaveRoomBtn.addEventListener("click", () => {
  collaboration.disconnect();
  updateCollaborationUi();
});

takePresenterBtn.addEventListener("click", () => {
  collaboration.takePresenter();
});

copyRoomLinkBtn.addEventListener("click", async () => {
  updateRoomLink();
  if (!roomLink.value) return;
  try {
    await navigator.clipboard.writeText(roomLink.value);
    collabStatusEl.textContent = `${collabStatusEl.textContent}\nLink copied`;
  } catch {
    roomLink.select();
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
  const transform = getMoleculeTransform();
  const signature = transformSignature(transform);
  if (signature !== lastObservedTransform) {
    lastObservedTransform = signature;
    markPresenterStateDirty();
  }
  if (!renderer.xr.isPresenting) {
    const view = getViewState();
    const currentViewSignature = viewSignature(view);
    if (currentViewSignature !== lastObservedView) {
      lastObservedView = currentViewSignature;
      markPresenterStateDirty();
    }
  }
  orbitControls.update();
  flushPresenterState();
  renderer.render(scene, camera);
});
