// Streaming Gaussian Cube parser.
//
// Cube format (whitespace-delimited after two free-text comment lines):
//   line 1, 2 : comments
//   line 3    : natoms  Ox Oy Oz            (origin)
//   line 4-6  : Ni  vix viy viz             (voxel count + axis step vector)
//   next |natoms| lines : Z charge x y z    (one atom each)
//   [if natoms < 0] one record: NVAL id1 .. idNVAL   (orbital cube: NVAL fields/point)
//   then Nx*Ny*Nz*NVAL scalars, z-fastest (ix outer, iz inner)
//
// Unit convention: a positive voxel count means Bohr, negative means Angstrom.
// Everything (origin, axes, atom coords) is converted to Angstrom to match the
// rest of the app.

export type Vec3Tuple = [number, number, number];

const BOHR_TO_ANGSTROM = 0.529177210903;
// Guard against pathological grids exhausting memory (~64 MB of Float32).
const MAX_GRID_POINTS = 16_000_000;

export interface CubeAtom {
  atomicNumber: number;
  position: Vec3Tuple;
}

export interface CubeGrid {
  nx: number;
  ny: number;
  nz: number;
  origin: Vec3Tuple;
  /** Step vectors along the i, j, k grid axes (Angstrom). */
  axes: [Vec3Tuple, Vec3Tuple, Vec3Tuple];
}

export interface CubeVolume {
  atoms: CubeAtom[];
  grid: CubeGrid;
  /** Scalar field, indexed value[ix*ny*nz + iy*nz + iz]. */
  values: Float32Array;
  min: number;
  max: number;
}

export interface CubeParseProgress {
  bytesRead: number;
  totalBytes: number;
  pointsRead: number;
  totalPoints: number;
}

function isWhitespace(code: number) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;
}

/** Reads a byte stream as either whole lines or whitespace-delimited tokens. */
class StreamTokenizer {
  private buffer = "";
  private pos = 0;
  private done = false;

  constructor(
    private reader: ReadableStreamDefaultReader<Uint8Array>,
    private decoder: TextDecoder,
    private onBytes: (n: number) => void,
  ) {}

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const { value, done } = await this.reader.read();
    if (done) {
      this.done = true;
      return false;
    }
    this.onBytes(value.byteLength);
    this.buffer += this.decoder.decode(value, { stream: true });
    return true;
  }

  async readLine(): Promise<string | null> {
    if (this.pos > 0) {
      this.buffer = this.buffer.slice(this.pos);
      this.pos = 0;
    }
    while (true) {
      const nl = this.buffer.indexOf("\n");
      if (nl !== -1) {
        const line = this.buffer.slice(0, nl).replace(/\r$/, "");
        this.pos = nl + 1;
        return line;
      }
      if (!(await this.fill())) {
        if (this.buffer.length > 0) {
          const line = this.buffer.replace(/\r$/, "");
          this.buffer = "";
          return line;
        }
        return null;
      }
    }
  }

  async readToken(): Promise<string | null> {
    // Skip leading whitespace, discarding fully-consumed buffer.
    while (true) {
      while (this.pos < this.buffer.length && isWhitespace(this.buffer.charCodeAt(this.pos))) this.pos++;
      if (this.pos < this.buffer.length) break;
      this.buffer = "";
      this.pos = 0;
      if (!(await this.fill())) return null;
    }
    // Token now starts at pos; drop the consumed prefix so the buffer stays small.
    this.buffer = this.buffer.slice(this.pos);
    this.pos = 0;
    while (true) {
      while (this.pos < this.buffer.length && !isWhitespace(this.buffer.charCodeAt(this.pos))) this.pos++;
      if (this.pos < this.buffer.length) return this.buffer.slice(0, this.pos);
      if (!(await this.fill())) return this.pos > 0 ? this.buffer.slice(0, this.pos) : null;
    }
  }
}

export async function parseCubeVolume(
  file: Blob,
  onProgress?: (p: CubeParseProgress) => void,
): Promise<CubeVolume> {
  const totalBytes = file.size;
  let bytesRead = 0;
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  const tok = new StreamTokenizer(reader, decoder, (n) => {
    bytesRead += n;
  });

  async function readNumber(what: string): Promise<number> {
    const token = await tok.readToken();
    if (token === null) throw new Error(`Unexpected end of cube file while reading ${what}.`);
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error(`Cube file has a non-numeric ${what}: "${token.slice(0, 40)}".`);
    return value;
  }

  async function readInt(what: string): Promise<number> {
    return Math.trunc(await readNumber(what));
  }

  // Two free-text comment lines.
  if ((await tok.readLine()) === null || (await tok.readLine()) === null) {
    throw new Error("Cube file ended before the header.");
  }

  const natomsRaw = await readInt("atom count");
  const isOrbitalCube = natomsRaw < 0;
  const numAtoms = Math.abs(natomsRaw);
  if (numAtoms < 1) throw new Error("Cube file declares no atoms.");
  const originRaw: Vec3Tuple = [await readNumber("origin x"), await readNumber("origin y"), await readNumber("origin z")];

  async function readAxis(label: string): Promise<{ count: number; vector: Vec3Tuple }> {
    const count = await readInt(`${label} voxel count`);
    const vector: Vec3Tuple = [
      await readNumber(`${label} vector x`),
      await readNumber(`${label} vector y`),
      await readNumber(`${label} vector z`),
    ];
    return { count, vector };
  }

  const axisX = await readAxis("first");
  const axisY = await readAxis("second");
  const axisZ = await readAxis("third");

  // A negative voxel count flags Angstrom units; positive means Bohr.
  const unit = axisX.count < 0 ? 1 : BOHR_TO_ANGSTROM;
  const nx = Math.abs(axisX.count);
  const ny = Math.abs(axisY.count);
  const nz = Math.abs(axisZ.count);
  if (nx < 2 || ny < 2 || nz < 2) {
    throw new Error(`Cube grid is too small to render (${nx} x ${ny} x ${nz}).`);
  }
  const totalPoints = nx * ny * nz;
  if (totalPoints > MAX_GRID_POINTS) {
    throw new Error(
      `Cube grid ${nx} x ${ny} x ${nz} has ${totalPoints.toLocaleString()} points, over the ${MAX_GRID_POINTS.toLocaleString()} limit.`,
    );
  }

  const scale = (v: Vec3Tuple): Vec3Tuple => [v[0] * unit, v[1] * unit, v[2] * unit];
  const grid: CubeGrid = {
    nx,
    ny,
    nz,
    origin: scale(originRaw),
    axes: [scale(axisX.vector), scale(axisY.vector), scale(axisZ.vector)],
  };

  const atoms: CubeAtom[] = [];
  for (let i = 0; i < numAtoms; i++) {
    const atomicNumber = await readInt("atomic number");
    await readNumber("nuclear charge"); // unused
    const position: Vec3Tuple = [
      await readNumber("atom x"),
      await readNumber("atom y"),
      await readNumber("atom z"),
    ];
    atoms.push({ atomicNumber, position: scale(position) });
  }

  // Orbital cubes list the fields per grid point on their own record; we keep
  // the first field only.
  let fieldsPerPoint = 1;
  if (isOrbitalCube) {
    fieldsPerPoint = await readInt("orbital field count");
    if (fieldsPerPoint < 1) fieldsPerPoint = 1;
    for (let i = 0; i < fieldsPerPoint; i++) await readInt("orbital id");
  }

  const values = new Float32Array(totalPoints);
  let min = Infinity;
  let max = -Infinity;
  for (let p = 0; p < totalPoints; p++) {
    const v = await readNumber("grid value");
    for (let f = 1; f < fieldsPerPoint; f++) await readNumber("grid value");
    values[p] = v;
    if (v < min) min = v;
    if (v > max) max = v;
    if ((p & 0x3ffff) === 0) onProgress?.({ bytesRead, totalBytes, pointsRead: p, totalPoints });
  }
  onProgress?.({ bytesRead, totalBytes, pointsRead: totalPoints, totalPoints });

  return { atoms, grid, values, min, max };
}
