import * as THREE from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { parseExtendedXYZ } from "./xyzParser";
import { MoleculeRenderer } from "./moleculeRenderer";
import { VRObjectManipulator } from "./vrInteraction";
import { MeasurementTool } from "./measurement";
import { Playback } from "./playback";

const appEl = document.getElementById("app")!;
const statusEl = document.getElementById("status")!;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const urlInput = document.getElementById("urlInput") as HTMLInputElement;
const loadUrlBtn = document.getElementById("loadUrlBtn") as HTMLButtonElement;
const vrEntryEl = document.getElementById("vrEntry")!;
const playbackEl = document.getElementById("playback")!;
const frameSlider = document.getElementById("frameSlider") as HTMLInputElement;
const frameLabel = document.getElementById("frameLabel")!;
const playBtn = document.getElementById("playBtn") as HTMLButtonElement;
const stepBack = document.getElementById("stepBack") as HTMLButtonElement;
const stepFwd = document.getElementById("stepFwd") as HTMLButtonElement;
const fpsInput = document.getElementById("fpsInput") as HTMLInputElement;

// Surface otherwise-silent runtime errors in the UI status line, since most
// users testing this won't have DevTools open.
window.addEventListener("error", (e) => {
  statusEl.textContent = `Runtime error: ${e.message}`;
});
window.addEventListener("unhandledrejection", (e) => {
  statusEl.textContent = `Unhandled rejection: ${e.reason}`;
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111317);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
camera.position.set(0, 1.5, 4);
scene.add(camera);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
appEl.appendChild(renderer.domElement);

vrEntryEl.appendChild(VRButton.createButton(renderer));

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

async function loadTrajectoryFile(file: Blob) {
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
    measurementTool.clear();

    playback = new Playback(trajectory.numFrames, (frame) => {
      moleculeRenderer?.setFrame(frame);
      frameSlider.value = String(frame);
      frameLabel.textContent = `${frame} / ${trajectory.numFrames - 1}`;
    });

    frameSlider.min = "0";
    frameSlider.max = String(trajectory.numFrames - 1);
    frameSlider.value = "0";
    frameLabel.textContent = `0 / ${trajectory.numFrames - 1}`;
    playbackEl.style.display = "block";

    statusEl.textContent = `Loaded ${trajectory.numAtoms} atoms x ${trajectory.numFrames} frames`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${(err as Error).message}`;
  }
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadTrajectoryFile(file);
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
  if (file) loadTrajectoryFile(file);
});

loadUrlBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  statusEl.textContent = "Fetching...";
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    await loadTrajectoryFile(blob);
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Fetch error: ${(err as Error).message}`;
  }
});

frameSlider.addEventListener("input", () => {
  playback?.setFrame(parseInt(frameSlider.value, 10));
});

playBtn.addEventListener("click", () => {
  if (!playback) return;
  playback.playing = !playback.playing;
  playBtn.textContent = playback.playing ? "Pause" : "Play";
});

stepBack.addEventListener("click", () => {
  if (!playback) return;
  playback.setFrame(playback.frame - 1);
});

stepFwd.addEventListener("click", () => {
  if (!playback) return;
  playback.setFrame(playback.frame + 1);
});

fpsInput.addEventListener("change", () => {
  if (!playback) return;
  playback.fps = Math.max(1, parseInt(fpsInput.value, 10) || 15);
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
  orbitControls.update();
  renderer.render(scene, camera);
});
