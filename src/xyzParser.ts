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

/**
 * Parses an extended XYZ file via a streaming line reader so we never hold
 * the full file as one big JS string. Assumes atom count and ordering are
 * constant across frames (true for typical MD trajectories), which lets us
 * store all coordinates in one preallocated Float32Array instead of
 * per-atom/per-frame objects.
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

    const frameAtoms = parseInt(trimmed, 10);
    if (Number.isNaN(frameAtoms)) {
      throw new Error(`Expected atom count, got: "${countLine}"`);
    }
    if (numAtoms === -1) {
      numAtoms = frameAtoms;
    } else if (frameAtoms !== numAtoms) {
      throw new Error(
        `Frame ${numFrames} has ${frameAtoms} atoms, expected ${numAtoms}. Variable atom counts are not supported.`,
      );
    }

    const comment = (await nextLine()) ?? "";
    comments.push(comment);

    ensureCapacity(numFrames + 1);
    const base = numFrames * numAtoms * 3;

    for (let i = 0; i < numAtoms; i++) {
      const line = await nextLine();
      if (line === null) throw new Error("Unexpected end of file while reading atom data");
      const parts = line.trim().split(/\s+/);
      if (numFrames === 0) {
        symbols.push(parts[0]);
      }
      const off = base + i * 3;
      positions![off] = parseFloat(parts[1]);
      positions![off + 1] = parseFloat(parts[2]);
      positions![off + 2] = parseFloat(parts[3]);
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
