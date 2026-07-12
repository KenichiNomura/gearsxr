import * as THREE from "three";
import IsoWorker from "./isosurfaceWorker?worker&inline";
import { marchingCubes, type IsoGeometry } from "./marchingCubes";
import type { CubeGrid, CubeVolume, Vec3Tuple } from "./cubeParser";

const POSITIVE_COLOR = 0x3b82f6; // blue lobe / density
const NEGATIVE_COLOR = 0xef4444; // red lobe

interface WorkerResult {
  type: "result";
  id: number;
  positive?: IsoGeometry;
  negative?: IsoGeometry;
}

export interface IsosurfaceOptions {
  isovalue: number;
  signed: boolean;
  opacity?: number;
  onStatus?: (text: string) => void;
}

/**
 * Renders a positive (blue) and optional negative (red) isosurface of a cube
 * scalar field. Marching-cubes extraction runs in a Web Worker so changing the
 * isovalue never stalls the render loop; a main-thread path is used if the
 * worker can't be created.
 */
export class IsosurfaceRenderer {
  readonly group = new THREE.Group();

  private positiveMesh: THREE.Mesh;
  private negativeMesh: THREE.Mesh;
  private worker: Worker | null = null;
  private fallbackValues: Float32Array | null = null;
  private grid: CubeGrid;
  private isovalue: number;
  private signed: boolean;
  private requestId = 0;
  private onStatus?: (text: string) => void;

  constructor(volume: CubeVolume, centroid: Vec3Tuple, options: IsosurfaceOptions) {
    this.grid = volume.grid;
    this.isovalue = options.isovalue;
    this.signed = options.signed;
    this.onStatus = options.onStatus;

    // Share the molecule's recentring so the field lines up with the atoms.
    this.group.position.set(-centroid[0], -centroid[1], -centroid[2]);

    const opacity = options.opacity ?? 0.55;
    this.positiveMesh = this.makeMesh(POSITIVE_COLOR, opacity);
    this.negativeMesh = this.makeMesh(NEGATIVE_COLOR, opacity);
    this.group.add(this.positiveMesh, this.negativeMesh);

    try {
      this.worker = new IsoWorker();
      this.worker.onmessage = (event: MessageEvent<WorkerResult>) => this.onWorkerResult(event.data);
      // Transfer the grid into the worker; extraction happens there from now on.
      this.worker.postMessage({ type: "init", values: volume.values.buffer, grid: volume.grid }, [
        volume.values.buffer,
      ]);
    } catch {
      this.worker = null;
      this.fallbackValues = volume.values;
    }

    this.requestExtraction();
  }

  private makeMesh(color: number, opacity: number): THREE.Mesh {
    const material = new THREE.MeshStandardMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      roughness: 0.35,
      metalness: 0.0,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.frustumCulled = false;
    return mesh;
  }

  private levels(): { positiveLevel: number | null; negativeLevel: number | null } {
    return {
      positiveLevel: this.isovalue,
      negativeLevel: this.signed ? -this.isovalue : null,
    };
  }

  private requestExtraction() {
    const id = ++this.requestId;
    const { positiveLevel, negativeLevel } = this.levels();
    this.onStatus?.("Building isosurface...");

    if (this.worker) {
      this.worker.postMessage({ type: "extract", id, positiveLevel, negativeLevel });
      return;
    }
    // Main-thread fallback.
    if (!this.fallbackValues) return;
    const positive = positiveLevel !== null
      ? marchingCubes({ values: this.fallbackValues, grid: this.grid, isolevel: positiveLevel })
      : undefined;
    const negative = negativeLevel !== null
      ? marchingCubes({ values: this.fallbackValues, grid: this.grid, isolevel: negativeLevel })
      : undefined;
    this.onWorkerResult({ type: "result", id, positive, negative });
  }

  private onWorkerResult(result: WorkerResult) {
    if (result.id !== this.requestId) return; // a newer isovalue superseded this
    this.applyGeometry(this.positiveMesh, result.positive);
    this.applyGeometry(this.negativeMesh, result.negative);
    this.onStatus?.("");
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

  setIsovalue(value: number) {
    if (value === this.isovalue) return;
    this.isovalue = value;
    this.requestExtraction();
  }

  setSignedMode(signed: boolean) {
    if (signed === this.signed) return;
    this.signed = signed;
    this.negativeMesh.visible = signed;
    this.requestExtraction();
  }

  setOpacity(opacity: number) {
    for (const mesh of [this.positiveMesh, this.negativeMesh]) {
      (mesh.material as THREE.MeshStandardMaterial).opacity = opacity;
    }
  }

  setVisible(visible: boolean) {
    this.group.visible = visible;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.fallbackValues = null;
    for (const mesh of [this.positiveMesh, this.negativeMesh]) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }
}
