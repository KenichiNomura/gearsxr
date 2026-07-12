// Runs marching-cubes extraction off the main thread. The grid is sent once via
// an "init" message (the values buffer is transferred in), then each "extract"
// message re-runs extraction for one isolevel from the cached grid. The token
// is echoed back so the renderer can match results to layers and drop stale
// ones.

import { marchingCubes } from "./marchingCubes";
import type { CubeGrid } from "./cubeParser";

interface InitMessage {
  type: "init";
  values: ArrayBuffer;
  grid: CubeGrid;
}

interface ExtractMessage {
  type: "extract";
  token: number;
  level: number;
}

type IncomingMessage = InitMessage | ExtractMessage;

let cached: { values: Float32Array; grid: CubeGrid } | null = null;

self.onmessage = (event: MessageEvent<IncomingMessage>) => {
  const message = event.data;

  if (message.type === "init") {
    cached = { values: new Float32Array(message.values), grid: message.grid };
    return;
  }

  if (message.type === "extract") {
    if (!cached) return;
    const geometry = marchingCubes({ values: cached.values, grid: cached.grid, isolevel: message.level });
    (self as unknown as Worker).postMessage(
      { type: "result", token: message.token, geometry },
      [geometry.positions.buffer as ArrayBuffer, geometry.normals.buffer as ArrayBuffer],
    );
  }
};
