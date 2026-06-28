import * as THREE from "three";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";

/**
 * One-handed grab translates/rotates the target group; squeezing with both
 * controllers simultaneously scales it based on the change in distance
 * between the two controllers (the standard "VR pinch-to-scale" pattern).
 */
export class VRObjectManipulator {
  private renderer: THREE.WebGLRenderer;
  private target: THREE.Group;
  private controllers: THREE.Group[] = [];
  private grabbing = new Set<number>();
  private grabOffset = new Map<number, THREE.Matrix4>();
  private twoHandStartDistance = 0;
  private twoHandStartScale = 1;
  private enabled = true;
  private updateMatrix = new THREE.Matrix4();
  private midpoint = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer, target: THREE.Group, scene: THREE.Scene) {
    this.renderer = renderer;
    this.target = target;

    const modelFactory = new XRControllerModelFactory();

    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      controller.userData.index = i;
      controller.addEventListener("selectstart", () => this.onSelectStart(i));
      controller.addEventListener("selectend", () => this.onSelectEnd(i));
      scene.add(controller);
      this.controllers.push(controller);

      const grip = renderer.xr.getControllerGrip(i);
      grip.add(modelFactory.createControllerModel(grip));
      scene.add(grip);

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]),
        new THREE.LineBasicMaterial({ color: 0x44ccff }),
      );
      line.scale.z = 2;
      controller.add(line);
    }
  }

  getControllers() {
    return this.controllers;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.grabbing.clear();
      this.grabOffset.clear();
    }
  }

  private onSelectStart(index: number) {
    if (!this.enabled) return;
    this.grabbing.add(index);
    const controller = this.controllers[index];
    const offset = new THREE.Matrix4().copy(controller.matrixWorld).invert().multiply(this.target.matrixWorld);
    this.grabOffset.set(index, offset);

    if (this.grabbing.size === 2) {
      this.twoHandStartDistance = this.controllers[0].position.distanceTo(this.controllers[1].position);
      this.twoHandStartScale = this.target.scale.x;
    }
  }

  private onSelectEnd(index: number) {
    this.grabbing.delete(index);
    this.grabOffset.delete(index);
    if (this.grabbing.size === 1) {
      const remaining = this.getSingleGrabIndex();
      const controller = this.controllers[remaining];
      const offset = new THREE.Matrix4().copy(controller.matrixWorld).invert().multiply(this.target.matrixWorld);
      this.grabOffset.set(remaining, offset);
    }
  }

  update() {
    if (!this.enabled) return;

    if (this.grabbing.size === 1) {
      const index = this.getSingleGrabIndex();
      const controller = this.controllers[index];
      const offset = this.grabOffset.get(index);
      if (offset) {
        this.updateMatrix.copy(controller.matrixWorld).multiply(offset);
        this.updateMatrix.decompose(this.target.position, this.target.quaternion, this.target.scale);
      }
    } else if (this.grabbing.size === 2) {
      const dist = this.controllers[0].position.distanceTo(this.controllers[1].position);
      const scale = this.twoHandStartScale * (dist / Math.max(this.twoHandStartDistance, 1e-4));
      this.target.scale.setScalar(THREE.MathUtils.clamp(scale, 0.01, 100));

      this.midpoint.addVectors(this.controllers[0].position, this.controllers[1].position).multiplyScalar(0.5);
      this.target.position.copy(this.midpoint);
    }
  }

  private getSingleGrabIndex() {
    for (const index of this.grabbing) return index;
    return 0;
  }
}
