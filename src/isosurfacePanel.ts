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
  /** Called after any surface change so the presenter can broadcast the list. */
  onChange: () => void;
}

interface Row {
  spec: SurfaceSpec;
  el: HTMLElement;
  color: HTMLInputElement;
  slider: HTMLInputElement;
  number: HTMLInputElement;
  opacity: HTMLInputElement;
  visible: HTMLInputElement;
  remove: HTMLButtonElement;
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
 * IsosurfaceRenderer lifecycle, and can serialize its list (getSurfaces) or
 * mirror a presenter's list (applySurfaces) for room sync.
 */
export class IsosurfacePanel {
  private renderer: IsosurfaceRenderer | null = null;
  private maxAbs = 1;
  private seedSigned = false;
  private colorCursor = 0;
  private interactive = true;
  private debounce = new Map<number, number>();
  private rows = new Map<number, Row>(); // insertion order == display order

  constructor(private deps: IsosurfacePanelDeps) {
    deps.addBtn.addEventListener("click", () => {
      const color = COLORS[this.colorCursor++ % COLORS.length];
      this.addSurface({ isovalue: this.maxAbs * 0.1, color, opacity: 0.55, visible: true });
      this.deps.onChange();
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

  /** Current surface list, in display order (empty when no cube is loaded). */
  getSurfaces(): SurfaceSpec[] {
    return [...this.rows.values()].map((row) => ({ ...row.spec }));
  }

  /**
   * Follower path: make the local list match `specs` by position, updating rows
   * in place so only surfaces whose isovalue actually changed are re-extracted.
   */
  applySurfaces(specs: SurfaceSpec[]) {
    if (!this.renderer) return;
    const ids = [...this.rows.keys()];
    for (let i = specs.length; i < ids.length; i++) this.removeSurface(ids[i]);
    specs.forEach((spec, i) => {
      if (i < ids.length) this.updateRow(ids[i], spec);
      else this.addSurface(spec);
    });
  }

  /** Enables/disables all controls (followers can't edit the shared list). */
  setInteractive(enabled: boolean) {
    this.interactive = enabled;
    this.deps.resetBtn.disabled = !enabled;
    for (const row of this.rows.values()) this.setRowEnabled(row, enabled);
    this.refreshAddDisabled();
  }

  private reset() {
    if (!this.renderer) return;
    this.renderer.clearLayers();
    this.clearRows();
    this.seedDefaults();
    this.deps.onChange();
  }

  private clearRows() {
    for (const handle of this.debounce.values()) window.clearTimeout(handle);
    this.debounce.clear();
    this.rows.clear();
    this.deps.listEl.replaceChildren();
    this.colorCursor = 0;
    this.refreshAddDisabled();
  }

  // Defaults match the field: a positive lobe, plus a negative lobe when the
  // field has negative values.
  private seedDefaults() {
    this.addSurface({ isovalue: this.maxAbs * 0.3, color: COLORS[0], opacity: 0.55, visible: true });
    if (this.seedSigned) this.addSurface({ isovalue: -this.maxAbs * 0.3, color: COLORS[1], opacity: 0.55, visible: true });
    this.colorCursor = this.seedSigned ? 2 : 1;
  }

  private refreshAddDisabled() {
    this.deps.addBtn.disabled = !this.interactive || this.rows.size >= MAX_SURFACES;
  }

  private addSurface(spec: SurfaceSpec) {
    if (!this.renderer || this.rows.size >= MAX_SURFACES) return;
    const id = this.renderer.addLayer(spec);
    const row = this.createRow(id, spec);
    this.rows.set(id, row);
    this.deps.listEl.appendChild(row.el);
    this.setRowEnabled(row, this.interactive);
    this.refreshAddDisabled();
  }

  private removeSurface(id: number) {
    this.renderer?.removeLayer(id);
    window.clearTimeout(this.debounce.get(id));
    this.debounce.delete(id);
    this.rows.get(id)?.el.remove();
    this.rows.delete(id);
    this.refreshAddDisabled();
  }

  private updateRow(id: number, spec: SurfaceSpec) {
    const row = this.rows.get(id);
    if (!row) return;
    if (row.spec.color !== spec.color) {
      row.color.value = hexColor(spec.color);
      this.renderer?.setLayerColor(id, spec.color);
    }
    if (row.spec.opacity !== spec.opacity) {
      row.opacity.value = String(spec.opacity);
      this.renderer?.setLayerOpacity(id, spec.opacity);
    }
    if (row.spec.visible !== spec.visible) {
      row.visible.checked = spec.visible;
      this.renderer?.setLayerVisible(id, spec.visible);
    }
    if (row.spec.isovalue !== spec.isovalue) {
      row.slider.value = String(spec.isovalue);
      row.number.value = String(parseFloat(spec.isovalue.toPrecision(4)));
      this.renderer?.setLayerIsovalue(id, spec.isovalue); // re-extract only when the level changed
    }
    Object.assign(row.spec, spec);
  }

  private setRowEnabled(row: Row, enabled: boolean) {
    for (const el of [row.color, row.slider, row.number, row.opacity, row.visible, row.remove]) {
      el.disabled = !enabled;
    }
  }

  private scheduleIsovalue(id: number, value: number) {
    // Debounce so dragging or typing doesn't flood the worker with extractions.
    window.clearTimeout(this.debounce.get(id));
    this.debounce.set(id, window.setTimeout(() => this.renderer?.setLayerIsovalue(id, value), 60));
  }

  private createRow(id: number, spec: SurfaceSpec): Row {
    const el = document.createElement("div");
    el.className = "isoRow";

    const color = document.createElement("input");
    color.type = "color";
    color.className = "isoColor";
    color.value = hexColor(spec.color);
    color.title = "Surface color";

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
    valueWrap.append(slider, number);

    const opacity = document.createElement("input");
    opacity.type = "range";
    opacity.className = "isoOpacity";
    opacity.min = "0.05";
    opacity.max = "1";
    opacity.step = "0.05";
    opacity.value = String(spec.opacity);
    opacity.title = "Opacity";

    const visible = document.createElement("input");
    visible.type = "checkbox";
    visible.className = "isoVisibleBox";
    visible.checked = spec.visible;
    visible.title = "Visible";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "isoRemove";
    remove.textContent = "✕";
    remove.title = "Remove surface";

    const row: Row = { spec: { ...spec }, el, color, slider, number, opacity, visible, remove };

    color.addEventListener("input", () => {
      row.spec.color = parseHexColor(color.value);
      this.renderer?.setLayerColor(id, row.spec.color);
      this.deps.onChange();
    });
    slider.addEventListener("input", () => {
      row.spec.isovalue = parseFloat(slider.value);
      number.value = String(parseFloat(row.spec.isovalue.toPrecision(4)));
      this.scheduleIsovalue(id, row.spec.isovalue);
      this.deps.onChange();
    });
    number.addEventListener("input", () => {
      const value = parseFloat(number.value);
      if (!Number.isFinite(value)) return;
      row.spec.isovalue = value;
      slider.value = String(value); // thumb tracks the typed value (clamped to range)
      this.scheduleIsovalue(id, value);
      this.deps.onChange();
    });
    opacity.addEventListener("input", () => {
      row.spec.opacity = parseFloat(opacity.value);
      this.renderer?.setLayerOpacity(id, row.spec.opacity);
      this.deps.onChange();
    });
    visible.addEventListener("change", () => {
      row.spec.visible = visible.checked;
      this.renderer?.setLayerVisible(id, visible.checked);
      this.deps.onChange();
    });
    remove.addEventListener("click", () => {
      this.removeSurface(id);
      this.deps.onChange();
    });

    el.append(color, valueWrap, opacity, visible, remove);
    return row;
  }
}
