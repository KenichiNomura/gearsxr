import * as THREE from "three";
import type { MoleculeRenderer } from "./moleculeRenderer";

export interface SelectedAtom {
  symbol: string;
  atomIndex: number;
  worldPosition: THREE.Vector3;
}

/**
 * Tracks up to 3 atom selections (raycast hits) to report distance
 * (2 atoms) or angle (3 atoms), and draws small marker spheres + a
 * connecting line/label so it's visible both on desktop and in VR.
 */
export class MeasurementTool {
  readonly group = new THREE.Group();
  private selections: SelectedAtom[] = [];
  private markers: THREE.Mesh[] = [];
  private line: THREE.Line | null = null;
  private markerGeom = new THREE.SphereGeometry(0.12, 12, 8);
  private markerMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
  private lineMat = new THREE.LineBasicMaterial({ color: 0xffff00 });
  private onChange: (text: string) => void;

  constructor(onChange: (text: string) => void) {
    this.onChange = onChange;
  }

  raycastSelect(raycaster: THREE.Raycaster, renderer: MoleculeRenderer) {
    const meshes = renderer.getAtomMeshes();
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return;
    const hit = hits[0];
    if (hit.instanceId === undefined) return;
    const resolved = renderer.resolveAtomHit(hit.object, hit.instanceId);
    if (!resolved) return;

    const worldPos = renderer.getAtomWorldPosition(resolved.atomIndex, new THREE.Vector3());
    this.addSelection({ ...resolved, worldPosition: worldPos });
  }

  private addSelection(sel: SelectedAtom) {
    if (this.selections.length >= 3) this.clear();
    this.selections.push(sel);

    const marker = new THREE.Mesh(this.markerGeom, this.markerMat);
    marker.position.copy(sel.worldPosition);
    this.group.add(marker);
    this.markers.push(marker);

    this.updateLine();
    this.report();
  }

  private updateLine() {
    if (this.line) {
      this.group.remove(this.line);
      this.line.geometry.dispose();
      this.line = null;
    }
    if (this.selections.length < 2) return;
    const points = this.selections.map((s) => s.worldPosition);
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    this.line = new THREE.Line(geom, this.lineMat);
    this.group.add(this.line);
  }

  private report() {
    if (this.selections.length === 1) {
      const s = this.selections[0];
      this.onChange(`Selected: ${s.symbol}#${s.atomIndex}`);
    } else if (this.selections.length === 2) {
      const [a, b] = this.selections;
      const dist = a.worldPosition.distanceTo(b.worldPosition);
      this.onChange(`${a.symbol}#${a.atomIndex} - ${b.symbol}#${b.atomIndex}\nDistance: ${dist.toFixed(3)} Å`);
    } else if (this.selections.length === 3) {
      const [a, b, c] = this.selections;
      const ba = new THREE.Vector3().subVectors(a.worldPosition, b.worldPosition);
      const bc = new THREE.Vector3().subVectors(c.worldPosition, b.worldPosition);
      const angleRad = ba.angleTo(bc);
      const angleDeg = THREE.MathUtils.radToDeg(angleRad);
      this.onChange(
        `${a.symbol}#${a.atomIndex} - ${b.symbol}#${b.atomIndex} - ${c.symbol}#${c.atomIndex}\nAngle: ${angleDeg.toFixed(2)}°`,
      );
    }
  }

  clear() {
    for (const m of this.markers) this.group.remove(m);
    this.markers = [];
    if (this.line) {
      this.group.remove(this.line);
      this.line.geometry.dispose();
      this.line = null;
    }
    this.selections = [];
    this.onChange("");
  }
}
