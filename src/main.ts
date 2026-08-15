import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { parseExtendedXYZ, type Trajectory } from "./xyzParser";
import { parseCubeVolume, type CubeVolume } from "./cubeParser";
import { symbolForAtomicNumber } from "./elements";
import { MoleculeRenderer } from "./moleculeRenderer";
import { IsosurfacePanel } from "./isosurfacePanel";
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
  httpBaseFromWebSocketBase,
  makeRoomId,
  normalizeWebSocketBase,
  sanitizeRoomId,
  type PresenterState,
  type TransformState,
  type ViewState,
} from "./collaboration";
import { fetchTrajectoryBlob } from "./trajectoryFetch";
import { uploadTrajectory } from "./shareDrop";
import {
  fetchMaterialsProjectXyz,
  materialsProjectId,
  optimadeIdFromUrl,
  optimadeUrlForId,
} from "./materialsProject";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const appEl = $("app");
const uiEl = $("ui");
const statusEl = $("status");
const toggleControlsBtn = $<HTMLButtonElement>("toggleControlsBtn");
const collaborationEl = $("collaboration");
const toggleRoomBtn = $<HTMLButtonElement>("toggleRoomBtn");
const fileInput = $<HTMLInputElement>("fileInput");
const urlInput = $<HTMLInputElement>("urlInput");
const loadUrlBtn = $<HTMLButtonElement>("loadUrlBtn");
const backgroundSelect = $<HTMLSelectElement>("backgroundSelect");
const vrEntryEl = $("vrEntry");
const isosurfaceEl = $("isosurface");
const isoListEl = $("isoList");
const isoAddBtn = $<HTMLButtonElement>("isoAddBtn");
const isoResetBtn = $<HTMLButtonElement>("isoResetBtn");
const playbackEl = $("playback");
const frameSlider = $<HTMLInputElement>("frameSlider");
const frameLabel = $("frameLabel");
const playBtn = $<HTMLButtonElement>("playBtn");
const stepBack = $<HTMLButtonElement>("stepBack");
const stepFwd = $<HTMLButtonElement>("stepFwd");
const fpsInput = $<HTMLInputElement>("fpsInput");
const roomInput = $<HTMLInputElement>("roomInput");
const userNameInput = $<HTMLInputElement>("userNameInput");
const serverInput = $<HTMLInputElement>("serverInput");
const copyRoomCodeBtn = $<HTMLButtonElement>("copyRoomCodeBtn");
const joinRoomBtn = $<HTMLButtonElement>("joinRoomBtn");
const leaveRoomBtn = $<HTMLButtonElement>("leaveRoomBtn");
const takePresenterBtn = $<HTMLButtonElement>("takePresenterBtn");
const collabStatusEl = $("collabStatus");

// Controls only the presenter (or a solo user) may operate.
const presenterControls = [
  fileInput, urlInput, loadUrlBtn, frameSlider, playBtn, stepBack, stepFwd, fpsInput, backgroundSelect,
];

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
let cubeStatusSummary = "";
let playback: Playback | null = null;
let currentTrajectoryUrl: string | null = null;
let pendingTrajectoryUrl: string | null = null;
// The most recent locally-loaded (non-URL) trajectory, kept so a presenter can
// upload it to the room's /share storage on demand. Cleared on URL loads.
let lastLocalBlob: Blob | null = null;
let lastLocalName = "";
let sharingInFlight = false;
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

// Isosurface controls (shown only for cube files). Idle status restores the
// cube's "Loaded …" summary once extraction finishes.
const isoPanel = new IsosurfacePanel({
  panelEl: isosurfaceEl,
  listEl: isoListEl,
  addBtn: isoAddBtn,
  resetBtn: isoResetBtn,
  parent: moleculeRoot,
  onStatus: (text) => {
    statusEl.textContent = text || cubeStatusSummary;
  },
  onChange: () => markPresenterStateDirty(),
});

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

const urlParams = new URLSearchParams(location.search);
const backgroundFromUrl = urlParams.get("background");
let currentBackgroundId = normalizeBackgroundId(
  backgroundFromUrl ?? localStorage.getItem(BACKGROUND_KEY) ?? DEFAULT_BACKGROUND_ID,
);
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

setControlsCollapsed(localStorage.getItem(CONTROLS_COLLAPSED_KEY) === "1");
setRoomCollapsed(localStorage.getItem(ROOM_COLLAPSED_KEY) !== "0");

const roomFromUrl = sanitizeRoomId(urlParams.get("room") ?? "");
roomInput.value = roomFromUrl.length >= 3 ? roomFromUrl : makeRoomId();
userNameInput.value = localStorage.getItem(USER_NAME_KEY) ?? `User ${Math.floor(1000 + Math.random() * 9000)}`;
serverInput.value = normalizeWebSocketBase(
  urlParams.get("server") ?? localStorage.getItem(SERVER_BASE_KEY) ?? defaultWebSocketBase()
);

const collaboration = new CollaborationClient({
  onSnapshot: (message) => {
    updateCollaborationUi();
    if (collaboration.isPresenter()) {
      markPresenterStateDirty(true);
      void ensureLocalTrajectoryShared();
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
      void ensureLocalTrajectoryShared();
    }
  },
  onConnectionStatus: () => updateCollaborationUi(),
  onError: (message) => {
    collabStatusEl.textContent = `Room error: ${message}`;
  },
});

function signature(...values: number[]) {
  return values.map((value) => value.toFixed(5)).join(",");
}

function objectTransformSignature(object: THREE.Object3D) {
  const { position: p, quaternion: q, scale: s } = object;
  return signature(p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z);
}

function currentViewSignature() {
  const { position: p } = camera;
  const { target: t } = orbitControls;
  return signature(p.x, p.y, p.z, t.x, t.y, t.z);
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

function syncPlayButton() {
  playBtn.textContent = playback?.playing ? "Pause" : "Play";
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
    surfaces: isoPanel.getSurfaces(),
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
  isoPanel.setInteractive(canControlSharedState);
  for (const control of presenterControls) {
    control.disabled = !canControlSharedState;
  }

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
      statusEl.textContent = "Waiting for the presenter to load a trajectory…";
    }

    if (state.trajectoryUrl && state.trajectoryUrl !== currentTrajectoryUrl) {
      await loadTrajectoryFromUrl(state.trajectoryUrl, false);
      if (applyVersion !== remoteApplyVersion) return;
    }

    // Mirror the presenter's isosurface list (no-op unless a cube is loaded).
    // Guarded so an older room server that omits `surfaces` doesn't wipe the
    // follower's own seeded surfaces.
    if (Array.isArray(state.surfaces)) isoPanel.applySurfaces(state.surfaces);

    applyMoleculeTransform(state.transform);
    if (state.view) {
      applyViewState(state.view);
    }
    if (playback) {
      playback.fps = state.fps;
      fpsInput.value = String(state.fps);
      playback.playing = state.playing;
      syncPlayButton();
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

window.addEventListener("keydown", (e) => {
  if (e.key === "c" || e.key === "C") measurementTool.clear();
});

type TrajectoryFormat = "xyz" | "cube";

function looksLikeCubeHead(head: string): boolean {
  const lines = head.split(/\r?\n/);
  if (/^\s*\d+\s*$/.test(lines[0] ?? "")) return false; // XYZ atom-count first line
  const gridLine = (lines[2] ?? "").trim().split(/\s+/);
  return (
    gridLine.length >= 4 &&
    /^-?\d+$/.test(gridLine[0]) &&
    gridLine.slice(1, 4).every((p) => Number.isFinite(parseFloat(p)))
  );
}

async function detectTrajectoryFormat(file: Blob, sourceUrl: string | null): Promise<TrajectoryFormat> {
  const name = (sourceUrl ?? (file as File).name ?? "").toLowerCase();
  if (name.endsWith(".cube") || name.endsWith(".cub")) return "cube";
  if (name.endsWith(".xyz") || name.endsWith(".extxyz")) return "xyz";
  // Extension-less (e.g. Drive download URLs): peek at the first bytes.
  return looksLikeCubeHead(await file.slice(0, 1024).text()) ? "cube" : "xyz";
}

function cubeToTrajectory(volume: CubeVolume): Trajectory {
  const numAtoms = volume.atoms.length;
  const symbols = volume.atoms.map((atom) => symbolForAtomicNumber(atom.atomicNumber));
  const positions = new Float32Array(numAtoms * 3);
  volume.atoms.forEach((atom, i) => {
    positions[i * 3] = atom.position[0];
    positions[i * 3 + 1] = atom.position[1];
    positions[i * 3 + 2] = atom.position[2];
  });
  return { numFrames: 1, numAtoms, symbols, frameSymbols: symbols.slice(), positions, comments: [""] };
}

function atomsCentroid(volume: CubeVolume): [number, number, number] {
  const centroid: [number, number, number] = [0, 0, 0];
  for (const atom of volume.atoms) {
    centroid[0] += atom.position[0];
    centroid[1] += atom.position[1];
    centroid[2] += atom.position[2];
  }
  const n = Math.max(1, volume.atoms.length);
  return [centroid[0] / n, centroid[1] / n, centroid[2] / n];
}

function mountMolecule(trajectory: Trajectory, sourceUrl: string | null) {
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
}

/**
 * When the presenter has a local file loaded (no URL to broadcast), upload it
 * once to the room's /share storage and adopt the returned URL so every member
 * loads it like any other trajectory. No-op unless presenter + local file +
 * not already shared. Runs on local loads and when joining / taking presenter.
 */
async function ensureLocalTrajectoryShared() {
  if (sharingInFlight) return;
  if (!collaboration.isPresenter() || currentTrajectoryUrl || !lastLocalBlob) return;

  const blob = lastLocalBlob;
  const name = lastLocalName || "trajectory.xyz";
  sharingInFlight = true;
  try {
    statusEl.textContent = "Sharing file with the room…";
    const token = await collaboration.requestUploadTicket(blob.size, name);
    if (lastLocalBlob !== blob) return; // a newer file was loaded while waiting
    const httpBase = httpBaseFromWebSocketBase(normalizeWebSocketBase(serverInput.value) || defaultWebSocketBase());
    const shareUrl = await uploadTrajectory(httpBase, blob, name, token);
    if (lastLocalBlob !== blob) return;
    currentTrajectoryUrl = shareUrl;
    statusEl.textContent = "Shared with the room — others can now load this file.";
    markPresenterStateDirty(true);
  } catch (err) {
    statusEl.textContent = `Could not share this file with the room: ${(err as Error).message}`;
  } finally {
    sharingInFlight = false;
  }
}


async function loadCubeVolume(
  file: Blob,
  sourceUrl: string | null,
  broadcastState: boolean,
  loadVersion: number,
) {
  statusEl.textContent = "Parsing cube...";
  const volume = await parseCubeVolume(file, (p) => {
    if (loadVersion !== trajectoryLoadVersion) return;
    const pct = ((p.pointsRead / p.totalPoints) * 100).toFixed(0);
    statusEl.textContent = `Parsing cube... ${pct}% (${p.totalPoints.toLocaleString()} points)`;
  });
  if (loadVersion !== trajectoryLoadVersion) return;

  mountMolecule(cubeToTrajectory(volume), sourceUrl);

  // A cube is a single structure — no trajectory frames.
  playback = null;
  playbackEl.style.display = "none";
  document.body.classList.remove("has-playback");

  cubeStatusSummary = `Loaded ${volume.atoms.length} atoms, ${volume.grid.nx}x${volume.grid.ny}x${volume.grid.nz} grid`;
  isoPanel.show(volume, atomsCentroid(volume));

  statusEl.textContent = cubeStatusSummary;
  if (broadcastState) markPresenterStateDirty(true);
  if (broadcastState && !sourceUrl) void ensureLocalTrajectoryShared();
}

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
    // A locally-loaded file: remember it so a presenter can share it, and drop
    // any previous share URL so ensureLocalTrajectoryShared re-uploads.
    lastLocalBlob = file;
    lastLocalName = (file as File).name || "trajectory.xyz";
  } else {
    lastLocalBlob = null;
    lastLocalName = "";
  }

  let format: TrajectoryFormat;
  try {
    format = await detectTrajectoryFormat(file, sourceUrl);
  } catch (err) {
    if (loadVersion !== trajectoryLoadVersion) return;
    statusEl.textContent = `Error: ${(err as Error).message}`;
    return;
  }
  if (loadVersion !== trajectoryLoadVersion) return;

  if (format === "cube") {
    try {
      await loadCubeVolume(file, sourceUrl, broadcastState, loadVersion);
    } catch (err) {
      if (loadVersion !== trajectoryLoadVersion) return;
      console.error(err);
      statusEl.textContent = `Error: ${(err as Error).message}`;
    }
    return;
  }

  statusEl.textContent = "Parsing...";
  try {
    // Loading an XYZ trajectory clears any cube isosurface from a prior load.
    isoPanel.hide();
    const trajectory = await parseExtendedXYZ(file, (p) => {
      if (loadVersion !== trajectoryLoadVersion) return;
      const pct = ((p.bytesRead / p.totalBytes) * 100).toFixed(0);
      statusEl.textContent = `Parsing... ${pct}% (${p.framesParsed} frames)`;
    });
    if (loadVersion !== trajectoryLoadVersion) return;

    mountMolecule(trajectory, sourceUrl);

    playback = new Playback(trajectory.numFrames, (frame) => {
      moleculeRenderer?.setFrame(frame);
      frameSlider.value = String(frame);
      frameLabel.textContent = `${frame} / ${trajectory.numFrames - 1}`;
      markPresenterStateDirty();
    });
    playback.fps = readFpsInput();
    fpsInput.value = String(playback.fps);
    syncPlayButton();

    frameSlider.min = "0";
    frameSlider.max = String(trajectory.numFrames - 1);
    frameSlider.value = "0";
    frameLabel.textContent = `0 / ${trajectory.numFrames - 1}`;
    playbackEl.style.display = "block";
    document.body.classList.add("has-playback");

    statusEl.textContent = `Loaded ${trajectory.numAtoms} atoms x ${trajectory.numFrames} frames`;
    if (broadcastState) markPresenterStateDirty(true);
    if (broadcastState && !sourceUrl) void ensureLocalTrajectoryShared();
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
    const proxyBase = httpBaseFromWebSocketBase(
      normalizeWebSocketBase(serverInput.value) || defaultWebSocketBase(),
    );
    const onStatus = (message: string) => {
      if (loadVersion === trajectoryLoadVersion) statusEl.textContent = message;
    };

    // A Materials Project structure (canonical OPTIMADE URL) is fetched as JSON
    // and converted to XYZ; followers receive the same URL and take this path.
    const mpId = optimadeIdFromUrl(url);
    let blob: Blob;
    if (mpId) {
      onStatus(`Fetching Materials Project ${mpId}...`);
      const xyz = await fetchMaterialsProjectXyz(mpId, { proxyBase, signal: fetchController.signal, onStatus });
      blob = new Blob([xyz], { type: "text/plain" });
    } else {
      blob = await fetchTrajectoryBlob(url, { proxyBase, signal: fetchController.signal, onStatus });
    }
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
uiEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  uiEl.style.outline = "2px dashed #44ccff";
});
uiEl.addEventListener("dragleave", () => {
  uiEl.style.outline = "none";
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  uiEl.style.outline = "none";
  const file = e.dataTransfer?.files?.[0];
  if (file) loadTrajectoryFile(file, null, true);
});

loadUrlBtn.addEventListener("click", async () => {
  const raw = urlInput.value.trim();
  if (!raw) return;
  // A Materials Project id or page URL normalizes to the OPTIMADE URL.
  const mpId = materialsProjectId(raw);
  await loadTrajectoryFromUrl(mpId ? optimadeUrlForId(mpId) : raw, true);
});

frameSlider.addEventListener("input", () => {
  playback?.setFrame(parseInt(frameSlider.value, 10));
});

playBtn.addEventListener("click", () => {
  if (!playback) return;
  playback.playing = !playback.playing;
  syncPlayButton();
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
  const transformSig = objectTransformSignature(moleculeRoot);
  if (transformSig !== lastObservedTransform) {
    lastObservedTransform = transformSig;
    markPresenterStateDirty();
  }
  if (!renderer.xr.isPresenting) {
    const viewSig = currentViewSignature();
    if (viewSig !== lastObservedView) {
      lastObservedView = viewSig;
      markPresenterStateDirty();
    }
  }
  orbitControls.update();
  flushPresenterState();
  renderer.render(scene, camera);
});
