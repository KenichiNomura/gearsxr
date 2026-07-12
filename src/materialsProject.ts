// Loads crystal structures from the Materials Project by ID (e.g. "mp-149")
// via its keyless OPTIMADE endpoint, converting the returned structure to
// extended XYZ text so it flows through the normal trajectory loader.

const OPTIMADE_HOST = "optimade.materialsproject.org";
const ID_PATTERN = /^(mp|mvc)-\d+$/i;

interface OptimadeSpecies {
  name: string;
  chemical_symbols?: string[];
}

interface OptimadeAttributes {
  cartesian_site_positions?: number[][];
  species_at_sites?: string[];
  species?: OptimadeSpecies[];
  lattice_vectors?: number[][];
}

interface OptimadePayload {
  data?: { attributes?: OptimadeAttributes } | null;
}

export interface FetchMaterialsProjectOptions {
  /** http(s) base of the room server hosting the /proxy fallback route. */
  proxyBase?: string | null;
  signal?: AbortSignal;
  onStatus?: (message: string) => void;
}

function isAbortError(err: unknown) {
  return err instanceof DOMException && err.name === "AbortError";
}

export function optimadeUrlForId(id: string): string {
  return `https://${OPTIMADE_HOST}/v1/structures/${encodeURIComponent(id)}`;
}

/**
 * Extracts a canonical Materials Project id from a bare id ("mp-149"), a
 * materialsproject.org page URL, or an OPTIMADE structures URL. Returns null
 * when the input is not a Materials Project reference.
 */
export function materialsProjectId(input: string): string | null {
  const value = input.trim();
  if (ID_PATTERN.test(value)) return value.toLowerCase();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === OPTIMADE_HOST) {
    const match = url.pathname.match(/\/v1\/structures\/((?:mp|mvc)-\d+)/i);
    return match ? match[1].toLowerCase() : null;
  }
  if (host === "materialsproject.org" || host.endsWith(".materialsproject.org")) {
    const match = url.pathname.match(/\b((?:mp|mvc)-\d+)\b/i);
    return match ? match[1].toLowerCase() : null;
  }
  return null;
}

/** Returns the id only when the URL is the OPTIMADE structures endpoint. */
export function optimadeIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== OPTIMADE_HOST) return null;
  const match = parsed.pathname.match(/^\/v1\/structures\/((?:mp|mvc)-\d+)$/i);
  return match ? match[1].toLowerCase() : null;
}

function elementForSite(label: string, speciesByName: Map<string, string>): string {
  return speciesByName.get(label) ?? label ?? "X";
}

/** Converts an OPTIMADE structure's attributes into extended XYZ text. */
export function optimadeToXyz(attributes: OptimadeAttributes, id: string): string {
  const positions = attributes.cartesian_site_positions;
  const labels = attributes.species_at_sites;
  if (!Array.isArray(positions) || !Array.isArray(labels) || positions.length === 0) {
    throw new Error(`Materials Project ${id} returned no atomic sites.`);
  }

  const speciesByName = new Map<string, string>();
  for (const species of attributes.species ?? []) {
    if (species && typeof species.name === "string") {
      speciesByName.set(species.name, species.chemical_symbols?.[0] ?? species.name);
    }
  }

  const lattice = attributes.lattice_vectors?.flat();
  const latticeAttr = lattice && lattice.length === 9 && lattice.every((n) => Number.isFinite(n))
    ? `Lattice="${lattice.join(" ")}" `
    : "";
  const comment = `${latticeAttr}Properties=species:S:1:pos:R:3 material_id=${id}`;

  const lines: string[] = [String(positions.length), comment];
  for (let i = 0; i < positions.length; i++) {
    const [x, y, z] = positions[i] ?? [];
    if (![x, y, z].every((n) => Number.isFinite(n))) {
      throw new Error(`Materials Project ${id} site ${i} has invalid coordinates.`);
    }
    lines.push(`${elementForSite(labels[i], speciesByName)} ${x} ${y} ${z}`);
  }
  return lines.join("\n") + "\n";
}

async function fetchOptimadeDirect(url: string, signal?: AbortSignal): Promise<OptimadePayload> {
  const response = await fetch(url, { credentials: "omit", signal, headers: { accept: "application/json" } });
  return (await response.json()) as OptimadePayload;
}

async function fetchOptimadeViaProxy(proxyBase: string, url: string, signal?: AbortSignal): Promise<OptimadePayload> {
  const response = await fetch(`${proxyBase}/proxy?url=${encodeURIComponent(url)}`, { credentials: "omit", signal });
  if (!response.ok) throw new Error(`proxy HTTP ${response.status}`);
  return JSON.parse(await response.text()) as OptimadePayload;
}

/**
 * Fetches a Materials Project structure and returns it as extended XYZ text.
 * The MP OPTIMADE endpoint sends no CORS headers, so a direct browser fetch is
 * blocked; when a room-server /proxy base is available it is used first (it
 * fetches server-side), with a direct fetch only as a fallback in case MP ever
 * enables cross-origin access.
 */
export async function fetchMaterialsProjectXyz(id: string, options: FetchMaterialsProjectOptions = {}): Promise<string> {
  const { proxyBase, signal, onStatus } = options;
  const url = optimadeUrlForId(id);

  const attempts: Array<() => Promise<OptimadePayload>> = [];
  if (proxyBase) attempts.push(() => fetchOptimadeViaProxy(proxyBase, url, signal));
  attempts.push(() => fetchOptimadeDirect(url, signal));

  let payload: OptimadePayload | null = null;
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      payload = await attempt();
      break;
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastError = err;
    }
  }

  if (!payload) {
    const detail = lastError instanceof Error ? lastError.message : "network error";
    onStatus?.("");
    throw new Error(`Could not reach Materials Project (${detail}).`);
  }

  const attributes = payload.data?.attributes;
  if (!payload.data || !attributes) {
    throw new Error(`Materials Project "${id}" was not found (check the ID at materialsproject.org).`);
  }
  return optimadeToXyz(attributes, id);
}
