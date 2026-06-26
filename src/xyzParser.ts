// Streaming extended XYZ parser.
// Extended XYZ frame format:
//   line 1: natoms
//   line 2: comment/properties (may contain Lattice=".." Properties=species:S:1:pos:R:3 ..." etc.)
//   next natoms lines: "<symbol> x y z [extra columns]"

export interface Trajectory {
  numFrames: number;
  numAtoms: number;
  /** Element symbol per atom (assumed constant across frames). */
  symbols: string[];
  /** Flattened positions: frame i, atom j -> positions[i * numAtoms * 3 + j*3 + {0,1,2}] */
  positions: Float32Array;
  /** Per-frame comment line, kept for reference (e.g. lattice, energy). */
  comments: string[];
}

export interface ParseProgress {
  framesParsed: number;
  bytesRead: number;
  totalBytes: number;
}

interface PropertyField {
  name: string;
  type: string;
  count: number;
  start: number;
}

interface FrameLayout {
  symbolIndex: number;
  positionIndices: [number, number, number];
  idIndex: number | null;
}

interface ParsedAtom {
  symbol: string;
  id: number | null;
  x: number;
  y: number;
  z: number;
}

const SYMBOL_PROPERTY_NAMES = new Set(["species", "symbol", "element", "atom", "atomspecies"]);
const POSITION_PROPERTY_NAMES = new Set(["pos", "position", "positions", "coord", "coords", "coordinate", "coordinates"]);
const ID_PROPERTY_NAMES = new Set([
  "id",
  "atomid",
  "atomidentifier",
  "identifier",
  "particleid",
  "particleidentifier",
  "uid",
]);

function normalizePropertyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractPropertiesSpec(comment: string): string | null {
  const match = comment.match(/\bProperties=(?:"([^"]*)"|'([^']*)'|(\S+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function parseProperties(comment: string): PropertyField[] | null {
  const spec = extractPropertiesSpec(comment);
  if (!spec) return null;

  const tokens = spec.split(":");
  if (tokens.length % 3 !== 0) return null;

  const fields: PropertyField[] = [];
  let start = 0;
  for (let i = 0; i < tokens.length; i += 3) {
    const count = parseInt(tokens[i + 2], 10);
    if (!tokens[i] || !tokens[i + 1] || !Number.isFinite(count) || count < 1) return null;
    fields.push({ name: tokens[i], type: tokens[i + 1], count, start });
    start += count;
  }
  return fields;
}

function findField(fields: PropertyField[], names: Set<string>, minCount = 1): PropertyField | undefined {
  return fields.find((field) => field.count >= minCount && names.has(normalizePropertyName(field.name)));
}

function getFrameLayout(comment: string): FrameLayout {
  const fields = parseProperties(comment);
  if (!fields) {
    return { symbolIndex: 0, positionIndices: [1, 2, 3], idIndex: null };
  }

  const symbolField = findField(fields, SYMBOL_PROPERTY_NAMES);
  const positionField = findField(fields, POSITION_PROPERTY_NAMES, 3);
  const idField = findField(fields, ID_PROPERTY_NAMES);
  const xField = fields.find((field) => field.count === 1 && normalizePropertyName(field.name) === "x");
  const yField = fields.find((field) => field.count === 1 && normalizePropertyName(field.name) === "y");
  const zField = fields.find((field) => field.count === 1 && normalizePropertyName(field.name) === "z");

  return {
    symbolIndex: symbolField?.start ?? 0,
    positionIndices: positionField
      ? [positionField.start, positionField.start + 1, positionField.start + 2]
      : xField && yField && zField
        ? [xField.start, yField.start, zField.start]
        : [1, 2, 3],
    idIndex: idField?.start ?? null,
  };
}

function parseAtomLine(line: string, layout: FrameLayout, frameIndex: number, atomIndex: number): ParsedAtom {
  const parts = line.trim().split(/\s+/);
  const symbol = parts[layout.symbolIndex] ?? parts[0] ?? "X";
  const x = parseFloat(parts[layout.positionIndices[0]]);
  const y = parseFloat(parts[layout.positionIndices[1]]);
  const z = parseFloat(parts[layout.positionIndices[2]]);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error(`Frame ${frameIndex}, atom ${atomIndex}: could not parse finite xyz coordinates from "${line}"`);
  }

  let id: number | null = null;
  if (layout.idIndex !== null) {
    const parsedId = Number(parts[layout.idIndex]);
    if (Number.isInteger(parsedId)) {
      id = parsedId;
    }
  }

  return { symbol, id, x, y, z };
}

function makeAtomIdMap(atoms: ParsedAtom[]): Map<number, number> | null {
  const idToIndex = new Map<number, number>();
  for (let i = 0; i < atoms.length; i++) {
    const id = atoms[i].id;
    if (id === null || idToIndex.has(id)) return null;
    idToIndex.set(id, i);
  }
  return idToIndex;
}

/**
 * Parses an extended XYZ file via a streaming line reader so we never hold
 * the full file as one big JS string. When an extended XYZ Properties field
 * includes atom IDs, every frame is reordered to the first frame's ID order
 * so trajectories exported with changing line order still animate smoothly.
 */
export async function parseExtendedXYZ(
  file: Blob,
  onProgress?: (p: ParseProgress) => void,
): Promise<Trajectory> {
  const totalBytes = file.size;
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let done = false;
  let bytesRead = 0;

  async function nextLine(): Promise<string | null> {
    while (true) {
      const nlIndex = buffer.indexOf("\n");
      if (nlIndex !== -1) {
        const line = buffer.slice(0, nlIndex).replace(/\r$/, "");
        buffer = buffer.slice(nlIndex + 1);
        return line;
      }
      if (done) {
        if (buffer.length > 0) {
          const line = buffer;
          buffer = "";
          return line;
        }
        return null;
      }
      const { value, done: streamDone } = await reader.read();
      if (streamDone) {
        done = true;
        continue;
      }
      bytesRead += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
    }
  }

  let numAtoms = -1;
  let symbols: string[] = [];
  const comments: string[] = [];
  let positions: Float32Array | null = null;
  let frameCapacity = 0;
  let numFrames = 0;
  let idToAtomIndex: Map<number, number> | null = null;

  function ensureCapacity(minFrames: number) {
    if (!positions || frameCapacity < minFrames) {
      const newCapacity = Math.max(minFrames, frameCapacity === 0 ? 64 : frameCapacity * 2);
      const newArr = new Float32Array(newCapacity * numAtoms * 3);
      if (positions) newArr.set(positions);
      positions = newArr;
      frameCapacity = newCapacity;
    }
  }

  while (true) {
    const countLine = await nextLine();
    if (countLine === null) break;
    const trimmed = countLine.trim();
    if (trimmed.length === 0) continue;

    const frameAtomCount = parseInt(trimmed, 10);
    if (Number.isNaN(frameAtomCount)) {
      throw new Error(`Expected atom count, got: "${countLine}"`);
    }
    if (numAtoms === -1) {
      numAtoms = frameAtomCount;
    } else if (frameAtomCount !== numAtoms) {
      throw new Error(
        `Frame ${numFrames} has ${frameAtomCount} atoms, expected ${numAtoms}. Variable atom counts are not supported.`,
      );
    }

    const comment = (await nextLine()) ?? "";
    comments.push(comment);
    const layout = getFrameLayout(comment);

    ensureCapacity(numFrames + 1);
    const base = numFrames * numAtoms * 3;
    const frameAtoms: ParsedAtom[] = [];

    for (let i = 0; i < numAtoms; i++) {
      const line = await nextLine();
      if (line === null) throw new Error("Unexpected end of file while reading atom data");
      frameAtoms.push(parseAtomLine(line, layout, numFrames, i));
    }

    if (numFrames === 0) {
      idToAtomIndex = makeAtomIdMap(frameAtoms);
    }

    if (idToAtomIndex) {
      const seenAtomIndices = new Set<number>();
      for (let i = 0; i < numAtoms; i++) {
        const atom = frameAtoms[i];
        if (atom.id === null || !idToAtomIndex.has(atom.id)) {
          throw new Error(`Frame ${numFrames} atom IDs do not match the first frame.`);
        }
        const atomIndex = idToAtomIndex.get(atom.id)!;
        if (seenAtomIndices.has(atomIndex)) {
          throw new Error(`Frame ${numFrames} contains duplicate atom ID ${atom.id}.`);
        }
        seenAtomIndices.add(atomIndex);
        if (numFrames === 0) {
          symbols[atomIndex] = atom.symbol;
        }
        const off = base + atomIndex * 3;
        positions![off] = atom.x;
        positions![off + 1] = atom.y;
        positions![off + 2] = atom.z;
      }
    } else {
      for (let i = 0; i < numAtoms; i++) {
        const atom = frameAtoms[i];
        if (numFrames === 0) {
          symbols.push(atom.symbol);
        }
        const off = base + i * 3;
        positions![off] = atom.x;
        positions![off + 1] = atom.y;
        positions![off + 2] = atom.z;
      }
    }

    numFrames++;
    onProgress?.({ framesParsed: numFrames, bytesRead, totalBytes });
  }

  if (numAtoms === -1 || !positions) {
    throw new Error("File contained no frames");
  }

  return {
    numFrames,
    numAtoms,
    symbols,
    positions: (positions as Float32Array).subarray(0, numFrames * numAtoms * 3),
    comments,
  };
}
