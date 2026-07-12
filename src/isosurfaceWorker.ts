// Runs marching-cubes extraction off the main thread. The grid is sent once via
// an "init" message (the values buffer is transferred in), then each "extract"
// message re-runs extraction for new isolevels from the cached grid.

import { marchingCubes } from "./marchingCubes";
import type { CubeGrid } from "./cubeParser";

interface InitMessage {
  type: "init";
  values: ArrayBuffer;
  grid: CubeGrid;
}

interface ExtractMessage {
  type: "extract";
  id: number;
  positiveLevel: number | null;
  negativeLevel: number | null;
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
    const transfers: ArrayBuffer[] = [];
    const result: {
      type: "result";
      id: number;
      positive?: { positions: Float32Array; normals: Float32Array };
      negative?: { positions: Float32Array; normals: Float32Array };
    } = { type: "result", id: message.id };

    if (message.positiveLevel !== null) {
      const geom = marchingCubes({ values: cached.values, grid: cached.grid, isolevel: message.positiveLevel });
      result.positive = geom;
      transfers.push(geom.positions.buffer as ArrayBuffer, geom.normals.buffer as ArrayBuffer);
    }
    if (message.negativeLevel !== null) {
      const geom = marchingCubes({ values: cached.values, grid: cached.grid, isolevel: message.negativeLevel });
      result.negative = geom;
      transfers.push(geom.positions.buffer as ArrayBuffer, geom.normals.buffer as ArrayBuffer);
    }

    (self as unknown as Worker).postMessage(result, transfers);
  }
};
