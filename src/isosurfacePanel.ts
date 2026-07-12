import * as THREE from "three";
import { IsosurfaceRenderer, type SurfaceSpec } from "./isosurfaceRenderer";
import type { CubeVolume, Vec3Tuple } from "./cubeParser";

const MAX_SURFACES = 6;
// Colors handed out to seeded and added surfaces, in order.
const COLORS = [0x3b82f6, 0xef4444, 0x22c55e, 0xf59e0b, 0xa855f7, 0x06b6d4];

export interface IsosurfacePanelDeps {
  panelEl: HTMLElement;
  listEl: HTMLElement;
  addBtn: HTMLButtonElement;
  resetBtn: HTMLButtonElement;
  /** Group the isosurface meshes are added to (shares the molecule transform). */
  parent: THREE.Group;
  /** Called with progress text, and "" when idle. */
  onStatus: (text: string) => void;
}

function hexColor(value: number) {
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`;
}

function parseHexColor(value: string) {
  return parseInt(value.replace(/^#/, ""), 16) || 0;
}

/**
 * The bottom-left "Isosurface" panel: a list of surfaces (each with a color,
 * isovalue, opacity, and visibility) over a cube scalar field. Owns the
 * IsosurfaceRenderer lifecycle so main.ts just calls show()/hide().
 */
export class IsosurfacePanel {
  private renderer: IsosurfaceRenderer | null = null;
  private maxAbs = 1;
  private seedSigned = false;
  private count = 0;
  private colorCursor = 0;
  private debounce = new Map<number, number>();

  constructor(private deps: IsosurfacePanelDeps) {
    deps.addBtn.addEventListener("click", () => {
      const color = COLORS[this.colorCursor++ % COLORS.length];
      this.addSurface({ isovalue: this.maxAbs * 0.1, color, opacity: 0.55, visible: true });
    });
    deps.resetBtn.addEventListener("click", () => this.reset());
  }

  /** Renders the isosurfaces for a freshly loaded cube and shows the panel. */
  show(volume: CubeVolume, centroid: Vec3Tuple) {
    this.hide();
    this.maxAbs = Math.max(Math.abs(volume.min), Math.abs(volume.max)) || 1;
    this.seedSigned = volume.min < -1e-6 * this.maxAbs;

    this.renderer = new IsosurfaceRenderer(volume, centroid, {
      maxAbs: this.maxAbs,
      onStatus: this.deps.onStatus,
    });
    this.deps.parent.add(this.renderer.group);
    this.deps.panelEl.style.display = "block";
    this.seedDefaults();
  }

  /** Removes the isosurfaces and hides the panel (used on XYZ loads). */
  hide() {
    if (this.renderer) {
      this.deps.parent.remove(this.renderer.group);
      this.renderer.dispose();
      this.renderer = null;
    }
    this.clearRows();
    this.deps.panelEl.style.display = "none";
  }

  private reset() {
    if (!this.renderer) return;
    this.renderer.clearLayers();
    this.clearRows();
    this.seedDefaults();
  }

  private clearRows() {
    for (const handle of this.debounce.values()) window.clearTimeout(handle);
    this.debounce.clear();
    this.deps.listEl.replaceChildren();
    this.count = 0;
    this.colorCursor = 0;
    this.deps.addBtn.disabled = false;
  }

  // Defaults match the field: a positive lobe, plus a negative lobe when the
  // field has negative values.
  private seedDefaults() {
    this.addSurface({ isovalue: this.maxAbs * 0.3, color: COLORS[0], opacity: 0.55, visible: true });
    if (this.seedSigned) this.addSurface({ isovalue: -this.maxAbs * 0.3, color: COLORS[1], opacity: 0.55, visible: true });
    this.colorCursor = this.seedSigned ? 2 : 1;
  }

  private addSurface(spec: SurfaceSpec) {
    if (!this.renderer || this.count >= MAX_SURFACES) return;
    const id = this.renderer.addLayer(spec);
    this.count += 1;
    this.deps.listEl.appendChild(this.createRow(id, spec));
    this.deps.addBtn.disabled = this.count >= MAX_SURFACES;
  }

  private createRow(id: number, spec: SurfaceSpec): HTMLElement {
    const row = document.createElement("div");
    row.className = "isoRow";

    const color = document.createElement("input");
    color.type = "color";
    color.className = "isoColor";
    color.value = hexColor(spec.color);
    color.title = "Surface color";
    color.addEventListener("input", () => this.renderer?.setLayerColor(id, parseHexColor(color.value)));

    const valueWrap = document.createElement("div");
    valueWrap.className = "isoValueWrap";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "isoValue";
    slider.min = String(-this.maxAbs);
    slider.max = String(this.maxAbs);
    slider.step = String(this.maxAbs / 400);
    slider.value = String(spec.isovalue);
    slider.title = "Isovalue";
    // Editable number so exact isovalues can be typed in directly.
    const number = document.createElement("input");
    number.type = "number";
    number.className = "isoNumber";
    number.min = String(-this.maxAbs);
    number.max = String(this.maxAbs);
    number.step = String(this.maxAbs / 400);
    number.value = String(spec.isovalue);
    number.title = "Isovalue (type a value)";

    const applyIsovalue = (value: number) => {
      if (!Number.isFinite(value)) return;
      // Debounce so dragging or typing doesn't flood the worker with extractions.
      window.clearTimeout(this.debounce.get(id));
      this.debounce.set(id, window.setTimeout(() => this.renderer?.setLayerIsovalue(id, value), 60));
    };
    slider.addEventListener("input", () => {
      const value = parseFloat(slider.value);
      number.value = String(parseFloat(value.toPrecision(4)));
      applyIsovalue(value);
    });
    number.addEventListener("input", () => {
      const value = parseFloat(number.value);
      if (!Number.isFinite(value)) return;
      slider.value = String(value); // thumb tracks the typed value (clamped to range)
      applyIsovalue(value);
    });
    valueWrap.append(slider, number);

    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.className = "isoOpacity";
    opacity.min = "0.05";
    opacity.max = "1";
    opacity.step = "0.05";
    opacity.value = String(spec.opacity);
    opacity.title = "Opacity";
    opacity.addEventListener("input", () => this.renderer?.setLayerOpacity(id, parseFloat(opacity.value)));

    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.className = "isoVisibleBox";
    visible.checked = spec.visible;
    visible.title = "Visible";
    visible.addEventListener("change", () => this.renderer?.setLayerVisible(id, visible.checked));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "isoRemove";
    remove.textContent = "✕";
    remove.title = "Remove surface";
    remove.addEventListener("click", () => {
      this.renderer?.removeLayer(id);
      window.clearTimeout(this.debounce.get(id));
      this.debounce.delete(id);
      row.remove();
      this.count = Math.max(0, this.count - 1);
      this.deps.addBtn.disabled = this.count >= MAX_SURFACES;
    });

    row.append(color, valueWrap, opacity, visible, remove);
    return row;
  }
}
