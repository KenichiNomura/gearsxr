import * as THREE from "three";
import type { Trajectory } from "./xyzParser";
import { getElementInfo, uniqueSymbols } from "./elements";
import { computeBonds, type Bond } from "./bonds";

const ATOM_SPHERE_SCALE = 0.35; // shrink covalent radius for a ball-and-stick look
const BOND_RADIUS = 0.08;

/**
 * Renders a trajectory frame using one InstancedMesh per element (so each
 * mesh shares geometry/material/color) plus one InstancedMesh for bonds.
 * Updating a frame just rewrites instance matrices, not geometry, which is
 * what keeps this fast enough for VR framerates.
 */
export class MoleculeRenderer {
  readonly group = new THREE.Group();

  private trajectory: Trajectory;
  private atomMeshes = new Map<string, THREE.InstancedMesh>();
  private atomIndicesBySymbol = new Map<string, number[]>();
  private bondMesh: THREE.InstancedMesh;
  private bondCapacity: number;
  private currentFrame = -1;
  private bondCylinderGeom = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
  private atomTransform = new THREE.Object3D();
  private bondTransform = new THREE.Object3D();
  private bondsCacheFrame = -1;
  private bondsCache: Bond[] = [];
  private computeBondsEnabled = true;

  constructor(trajectory: Trajectory) {
    this.trajectory = trajectory;

    for (const symbol of uniqueSymbols(trajectory.symbols)) {
      const indices: number[] = [];
      for (let i = 0; i < trajectory.symbols.length; i++) {
        if (trajectory.symbols[i] === symbol) indices.push(i);
      }
      this.atomIndicesBySymbol.set(symbol, indices);

      const info = getElementInfo(symbol);
      const geom = new THREE.SphereGeometry(info.radius * ATOM_SPHERE_SCALE, 16, 12);
      const mat = new THREE.MeshStandardMaterial({ color: info.color, roughness: 0.4, metalness: 0.05 });
      const mesh = new THREE.InstancedMesh(geom, mat, indices.length);
      mesh.userData.symbol = symbol;
      mesh.userData.atomIndices = indices;
      // InstancedMesh frustum culling tests the original (origin-centered)
      // geometry bounds, not the spread of instance positions, so the whole
      // mesh can vanish once the centroid leaves the frustum. Disable it.
      mesh.frustumCulled = false;
      this.atomMeshes.set(symbol, mesh);
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

  setBondsEnabled(enabled: boolean) {
    this.computeBondsEnabled = enabled;
    if (!enabled) {
      this.bondMesh.count = 0;
      this.bondMesh.instanceMatrix.needsUpdate = true;
    } else {
      this.bondsCacheFrame = -1;
      this.setFrame(this.currentFrame);
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

  setFrame(frameIndex: number) {
    if (frameIndex === this.currentFrame) return;
    this.currentFrame = frameIndex;
    const { positions, numAtoms } = this.trajectory;
    const base = frameIndex * numAtoms * 3;

    for (const [, mesh] of this.atomMeshes) {
      const indices: number[] = mesh.userData.atomIndices;
      for (let k = 0; k < indices.length; k++) {
        const atomIdx = indices[k];
        const off = base + atomIdx * 3;
        this.atomTransform.position.set(positions[off], positions[off + 1], positions[off + 2]);
        this.atomTransform.updateMatrix();
        mesh.setMatrixAt(k, this.atomTransform.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }

    if (this.computeBondsEnabled) {
      this.updateBonds(frameIndex);
    }
  }

  private updateBonds(frameIndex: number) {
    if (this.bondsCacheFrame !== frameIndex) {
      this.bondsCache = computeBonds(
        this.trajectory.positions,
        frameIndex,
        this.trajectory.numAtoms,
        this.trajectory.symbols,
      );
      this.bondsCacheFrame = frameIndex;
    }
    const bonds = this.bondsCache;

    if (bonds.length > this.bondCapacity) {
      this.growBondCapacity(bonds.length);
    }

    const { positions, numAtoms } = this.trajectory;
    const base = frameIndex * numAtoms * 3;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion();

    for (let i = 0; i < bonds.length; i++) {
      const bond = bonds[i];
      a.set(
        positions[base + bond.a * 3],
        positions[base + bond.a * 3 + 1],
        positions[base + bond.a * 3 + 2],
      );
      b.set(
        positions[base + bond.b * 3],
        positions[base + bond.b * 3 + 1],
        positions[base + bond.b * 3 + 2],
      );
      mid.copy(a).add(b).multiplyScalar(0.5);
      dir.copy(b).sub(a);
      const len = dir.length();
      dir.normalize();
      quat.setFromUnitVectors(up, dir);

      this.bondTransform.position.copy(mid);
      this.bondTransform.quaternion.copy(quat);
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
