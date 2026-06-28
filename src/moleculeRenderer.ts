import * as THREE from "three";
import type { Trajectory } from "./xyzParser";
import { getElementInfo } from "./elements";
import { computeBonds, type Bond } from "./bonds";

const ATOM_SPHERE_SCALE = 0.35; // shrink covalent radius for a ball-and-stick look
const BOND_RADIUS = 0.08;

function getAtomSymbol(trajectory: Trajectory, frameIndex: number, atomIndex: number): string {
  return trajectory.frameSymbols[frameIndex * trajectory.numAtoms + atomIndex] ?? trajectory.symbols[atomIndex] ?? "X";
}

function writeFrameSymbols(trajectory: Trajectory, frameIndex: number, symbols: string[]) {
  for (let i = 0; i < trajectory.numAtoms; i++) {
    symbols[i] = getAtomSymbol(trajectory, frameIndex, i);
  }
}

function getMaxAtomCountsBySymbol(trajectory: Trajectory): Map<string, number> {
  const maxCounts = new Map<string, number>();
  const frameCounts = new Map<string, number>();

  for (let frame = 0; frame < trajectory.numFrames; frame++) {
    frameCounts.clear();
    for (let atomIndex = 0; atomIndex < trajectory.numAtoms; atomIndex++) {
      const symbol = getAtomSymbol(trajectory, frame, atomIndex);
      frameCounts.set(symbol, (frameCounts.get(symbol) ?? 0) + 1);
    }
    for (const [symbol, count] of frameCounts) {
      maxCounts.set(symbol, Math.max(maxCounts.get(symbol) ?? 0, count));
    }
  }

  return maxCounts;
}

/**
 * Renders a trajectory frame using one InstancedMesh per element seen in the
 * trajectory plus one InstancedMesh for bonds. Updating a frame rewrites
 * instance matrices and the current atom-to-element mesh mapping.
 */
export class MoleculeRenderer {
  readonly group = new THREE.Group();

  private trajectory: Trajectory;
  private atomMeshes = new Map<string, THREE.InstancedMesh>();
  private atomMaterials = new Set<THREE.Material>();
  private atomGeometries = new Set<THREE.BufferGeometry>();
  private bondMesh: THREE.InstancedMesh;
  private bondCapacity: number;
  private currentFrame = -1;
  private bondCylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
  private atomTransform = new THREE.Object3D();
  private bondTransform = new THREE.Object3D();
  private atomCountsBySymbol = new Map<string, number>();
  private frameSymbolsScratch: string[];
  private bondStart = new THREE.Vector3();
  private bondEnd = new THREE.Vector3();
  private bondMidpoint = new THREE.Vector3();
  private bondDirection = new THREE.Vector3();
  private bondUp = new THREE.Vector3(0, 1, 0);
  private bondQuaternion = new THREE.Quaternion();
  private bondsCacheFrame = -1;
  private bondsCache: Bond[] = [];
  private computeBondsEnabled = true;

  constructor(trajectory: Trajectory) {
    this.trajectory = trajectory;
    this.frameSymbolsScratch = new Array<string>(trajectory.numAtoms);

    for (const [symbol, maxCount] of getMaxAtomCountsBySymbol(trajectory)) {
      const info = getElementInfo(symbol);
      const geom = new THREE.SphereGeometry(info.radius * ATOM_SPHERE_SCALE, 16, 12);
      const mat = new THREE.MeshStandardMaterial({ color: info.color, roughness: 0.4, metalness: 0.05 });
      const mesh = new THREE.InstancedMesh(geom, mat, maxCount);
      this.atomGeometries.add(geom);
      this.atomMaterials.add(mat);
      mesh.count = 0;
      mesh.userData.symbol = symbol;
      mesh.userData.atomIndices = [];
      // InstancedMesh frustum culling tests the original (origin-centered)
      // geometry bounds, not the spread of instance positions, so the whole
      // mesh can vanish once the centroid leaves the frustum. Disable it.
      mesh.frustumCulled = false;
      this.atomMeshes.set(symbol, mesh);
      this.atomCountsBySymbol.set(symbol, 0);
      this.group.add(mesh);
    }

    // Bond mesh capacity: heuristic upper bound, grown lazily if exceeded.
    this.bondCapacity = Math.max(trajectory.numAtoms * 2, 64);
    const bondMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6 });
    this.bondMesh = new THREE.InstancedMesh(this.bondCylinderGeom, bondMat, this.bondCapacity);
    this.bondMesh.count = 0;
    this.bondMesh.frustumCulled = false;
    this.group.add(this.bondMesh);

    this.setFrame(0);
    this.centerOnFirstFrame();
  }

  dispose() {
    for (const mesh of this.atomMeshes.values()) {
      this.group.remove(mesh);
    }
    this.atomMeshes.clear();
    for (const geom of this.atomGeometries) {
      geom.dispose();
    }
    this.atomGeometries.clear();
    for (const mat of this.atomMaterials) {
      mat.dispose();
    }
    this.atomMaterials.clear();

    this.group.remove(this.bondMesh);
    this.bondMesh.geometry.dispose();
    if (Array.isArray(this.bondMesh.material)) {
      for (const mat of this.bondMesh.material) mat.dispose();
    } else {
      this.bondMesh.material.dispose();
    }
  }

  setBondsEnabled(enabled: boolean) {
    this.computeBondsEnabled = enabled;
    if (!enabled) {
      this.bondMesh.count = 0;
      this.bondMesh.instanceMatrix.needsUpdate = true;
    } else {
      this.bondsCacheFrame = -1;
      this.setFrame(this.currentFrame, true);
    }
  }

  private centerOnFirstFrame() {
    const { positions, numAtoms } = this.trajectory;
    const center = new THREE.Vector3();
    for (let i = 0; i < numAtoms; i++) {
      center.x += positions[i * 3];
      center.y += positions[i * 3 + 1];
      center.z += positions[i * 3 + 2];
    }
    center.divideScalar(numAtoms);
    this.group.position.set(-center.x, -center.y, -center.z);
  }

  setFrame(frameIndex: number, force = false) {
    if (!force && frameIndex === this.currentFrame) return;
    this.currentFrame = frameIndex;
    const { positions, numAtoms } = this.trajectory;
    const base = frameIndex * numAtoms * 3;

    for (const [symbol, mesh] of this.atomMeshes) {
      mesh.count = 0;
      this.atomCountsBySymbol.set(symbol, 0);
      (mesh.userData.atomIndices as number[]).length = 0;
    }

    for (let atomIndex = 0; atomIndex < numAtoms; atomIndex++) {
      const symbol = getAtomSymbol(this.trajectory, frameIndex, atomIndex);
      const mesh = this.atomMeshes.get(symbol);
      if (!mesh) continue;

      const instanceIndex = this.atomCountsBySymbol.get(symbol) ?? 0;
      const indices = mesh.userData.atomIndices as number[];

      const off = base + atomIndex * 3;
      this.atomTransform.position.set(positions[off], positions[off + 1], positions[off + 2]);
      this.atomTransform.updateMatrix();
      mesh.setMatrixAt(instanceIndex, this.atomTransform.matrix);
      this.atomCountsBySymbol.set(symbol, instanceIndex + 1);
      indices.push(atomIndex);
    }

    for (const [symbol, mesh] of this.atomMeshes) {
      mesh.count = this.atomCountsBySymbol.get(symbol) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }

    if (this.computeBondsEnabled) {
      this.updateBonds(frameIndex);
    }
  }

  private updateBonds(frameIndex: number) {
    if (this.bondsCacheFrame !== frameIndex) {
      writeFrameSymbols(this.trajectory, frameIndex, this.frameSymbolsScratch);
      this.bondsCache = computeBonds(
        this.trajectory.positions,
        frameIndex,
        this.trajectory.numAtoms,
        this.frameSymbolsScratch,
      );
      this.bondsCacheFrame = frameIndex;
    }
    const bonds = this.bondsCache;

    if (bonds.length > this.bondCapacity) {
      this.growBondCapacity(bonds.length);
    }

    const { positions, numAtoms } = this.trajectory;
    const base = frameIndex * numAtoms * 3;

    for (let i = 0; i < bonds.length; i++) {
      const bond = bonds[i];
      this.bondStart.set(
        positions[base + bond.a * 3],
        positions[base + bond.a * 3 + 1],
        positions[base + bond.a * 3 + 2],
      );
      this.bondEnd.set(
        positions[base + bond.b * 3],
        positions[base + bond.b * 3 + 1],
        positions[base + bond.b * 3 + 2],
      );
      this.bondMidpoint.copy(this.bondStart).add(this.bondEnd).multiplyScalar(0.5);
      this.bondDirection.copy(this.bondEnd).sub(this.bondStart);
      const len = this.bondDirection.length();
      this.bondDirection.normalize();
      this.bondQuaternion.setFromUnitVectors(this.bondUp, this.bondDirection);

      this.bondTransform.position.copy(this.bondMidpoint);
      this.bondTransform.quaternion.copy(this.bondQuaternion);
      this.bondTransform.scale.set(BOND_RADIUS, len, BOND_RADIUS);
      this.bondTransform.updateMatrix();
      this.bondMesh.setMatrixAt(i, this.bondTransform.matrix);
    }
    this.bondMesh.count = bonds.length;
    this.bondMesh.instanceMatrix.needsUpdate = true;
  }

  private growBondCapacity(minCapacity: number) {
    const newCapacity = Math.max(minCapacity, this.bondCapacity * 2);
    const oldMesh = this.bondMesh;
    this.group.remove(oldMesh);
    this.bondMesh = new THREE.InstancedMesh(this.bondCylinderGeom, oldMesh.material, newCapacity);
    this.bondMesh.count = 0;
    this.bondMesh.frustumCulled = false;
    this.bondCapacity = newCapacity;
    this.group.add(this.bondMesh);
  }

  /** Returns {symbol, atomIndex} for a hit on an atom InstancedMesh, given a raycaster intersection. */
  resolveAtomHit(mesh: THREE.Object3D, instanceId: number): { symbol: string; atomIndex: number } | null {
    if (!(mesh instanceof THREE.InstancedMesh)) return null;
    const indices: number[] | undefined = mesh.userData.atomIndices;
    if (!indices) return null;
    const atomIndex = indices[instanceId];
    if (atomIndex === undefined) return null;
    return { symbol: mesh.userData.symbol, atomIndex };
  }

  getAtomMeshes(): THREE.InstancedMesh[] {
    return Array.from(this.atomMeshes.values());
  }

  getAtomWorldPosition(atomIndex: number, target: THREE.Vector3): THREE.Vector3 {
    const { positions } = this.trajectory;
    const base = this.currentFrame * this.trajectory.numAtoms * 3;
    const off = base + atomIndex * 3;
    target.set(positions[off], positions[off + 1], positions[off + 2]);
    return this.group.localToWorld(target);
  }

  getNumFrames() {
    return this.trajectory.numFrames;
  }
}
