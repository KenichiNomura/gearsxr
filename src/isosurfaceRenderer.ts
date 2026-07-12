import * as THREE from "three";
import IsoWorker from "./isosurfaceWorker?worker&inline";
import { marchingCubes, type IsoGeometry } from "./marchingCubes";
import type { CubeGrid, CubeVolume, Vec3Tuple } from "./cubeParser";

interface WorkerResult {
  type: "result";
  token: number;
  geometry: IsoGeometry;
}

export interface SurfaceSpec {
  isovalue: number;
  color: number; // 0xRRGGBB
  opacity: number; // 0..1
  visible: boolean;
}

interface Layer {
  id: number;
  isovalue: number;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  requestToken: number;
}

export interface IsosurfaceInit {
  /** Largest |field value|, used to scale draw order of nested shells. */
  maxAbs: number;
  onStatus?: (text: string) => void;
}

/**
 * Renders any number of independent isosurfaces of one cube scalar field, each
 * with its own isovalue, color, and opacity. Marching-cubes extraction runs in
 * a Web Worker (one level per request, matched back by token) so editing a
 * surface never stalls the render loop; a main-thread path is used if the
 * worker can't be created.
 */
export class IsosurfaceRenderer {
  readonly group = new THREE.Group();

  private worker: Worker | null = null;
  private fallbackValues: Float32Array | null = null;
  private grid: CubeGrid;
  private maxAbs: number;
  private onStatus?: (text: string) => void;

  private layers = new Map<number, Layer>();
  private tokenToLayer = new Map<number, number>();
  private nextId = 1;
  private nextToken = 1;
  private pending = 0;

  constructor(volume: CubeVolume, centroid: Vec3Tuple, init: IsosurfaceInit) {
    this.grid = volume.grid;
    this.maxAbs = init.maxAbs || 1;
    this.onStatus = init.onStatus;

    // Share the molecule's recentring so the field lines up with the atoms.
    this.group.position.set(-centroid[0], -centroid[1], -centroid[2]);

    try {
      this.worker = new IsoWorker();
      this.worker.onmessage = (event: MessageEvent<WorkerResult>) => this.onResult(event.data);
      // Transfer the grid into the worker; extraction happens there from now on.
      this.worker.postMessage({ type: "init", values: volume.values.buffer, grid: volume.grid }, [
        volume.values.buffer,
      ]);
    } catch {
      this.worker = null;
      this.fallbackValues = volume.values;
    }
  }

  addLayer(spec: SurfaceSpec): number {
    const id = this.nextId++;
    const material = new THREE.MeshStandardMaterial({
      color: spec.color,
      transparent: true,
      opacity: spec.opacity,
      side: THREE.DoubleSide,
      roughness: 0.35,
      metalness: 0.0,
      // Nested translucent shells sort by renderOrder, not the depth buffer.
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.frustumCulled = false;
    mesh.visible = spec.visible;
    mesh.renderOrder = this.renderOrderFor(spec.isovalue);

    const layer: Layer = { id, isovalue: spec.isovalue, mesh, material, requestToken: 0 };
    this.layers.set(id, layer);
    this.group.add(mesh);
    this.requestExtraction(layer);
    return id;
  }

  setLayerIsovalue(id: number, value: number) {
    const layer = this.layers.get(id);
    if (!layer || value === layer.isovalue) return;
    layer.isovalue = value;
    layer.mesh.renderOrder = this.renderOrderFor(value);
    this.requestExtraction(layer);
  }

  setLayerColor(id: number, color: number) {
    this.layers.get(id)?.material.color.setHex(color);
  }

  setLayerOpacity(id: number, opacity: number) {
    const layer = this.layers.get(id);
    if (layer) layer.material.opacity = opacity;
  }

  setLayerVisible(id: number, visible: boolean) {
    const layer = this.layers.get(id);
    if (layer) layer.mesh.visible = visible;
  }

  removeLayer(id: number) {
    const layer = this.layers.get(id);
    if (!layer) return;
    this.group.remove(layer.mesh);
    layer.mesh.geometry.dispose();
    layer.material.dispose();
    this.layers.delete(id);
  }

  setVisible(visible: boolean) {
    this.group.visible = visible;
  }

  clearLayers() {
    for (const layer of this.layers.values()) {
      this.group.remove(layer.mesh);
      layer.mesh.geometry.dispose();
      layer.material.dispose();
    }
    this.layers.clear();
    this.tokenToLayer.clear();
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.fallbackValues = null;
    this.clearLayers();
  }

  private renderOrderFor(isovalue: number) {
    return Math.round((Math.abs(isovalue) / this.maxAbs) * 1000);
  }

  private requestExtraction(layer: Layer) {
    const token = this.nextToken++;
    layer.requestToken = token;
    this.tokenToLayer.set(token, layer.id);
    this.pending++;
    this.onStatus?.("Building isosurface...");

    if (this.worker) {
      this.worker.postMessage({ type: "extract", token, level: layer.isovalue });
      return;
    }
    // Main-thread fallback.
    if (!this.fallbackValues) {
      this.settlePending();
      return;
    }
    const geometry = marchingCubes({ values: this.fallbackValues, grid: this.grid, isolevel: layer.isovalue });
    this.onResult({ type: "result", token, geometry });
  }

  private onResult(result: WorkerResult) {
    const layerId = this.tokenToLayer.get(result.token);
    this.tokenToLayer.delete(result.token);
    this.settlePending();
    if (layerId === undefined) return;
    const layer = this.layers.get(layerId);
    if (!layer || layer.requestToken !== result.token) return; // superseded or removed
    this.applyGeometry(layer.mesh, result.geometry);
  }

  private settlePending() {
    this.pending = Math.max(0, this.pending - 1);
    if (this.pending === 0) this.onStatus?.("");
  }

  private applyGeometry(mesh: THREE.Mesh, geom: IsoGeometry | undefined) {
    mesh.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    if (geom && geom.positions.length > 0) {
      geometry.setAttribute("position", new THREE.BufferAttribute(geom.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(geom.normals, 3));
    }
    mesh.geometry = geometry;
  }
}
