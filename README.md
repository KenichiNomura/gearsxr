# GEARS XR

GEARS XR (Extended Reality) is a browser-based molecular dynamics trajectory viewer for extended XYZ files, with desktop controls and WebXR support for virtual reality headsets.

- **[Open the viewer](https://gearsxr.space/)**
- **[Read the tutorial](https://gearsxr.space/tutorial.html)** — a friendly, step-by-step guide with illustrations

![GEARS XR screenshot](docs/screenshot.png)

## Features

- Load extended XYZ trajectories from a local file, drag-and-drop, or URL — including Google Drive, Dropbox, OneDrive, and GitHub share links.
- Play multi-frame trajectories with a frame slider, step buttons, and FPS control.
- Color atoms by element and compute bonds per frame from covalent radii.
- Measure distances (2 atoms) and angles (3 atoms) on desktop and in VR.
- Choose bundled 360-degree VR backgrounds.
- Enter VR through WebXR; grab, move, and scale the molecule with controllers.
- Join a lightweight multiuser room that shares trajectory URL, frame, playback, and view state through a short room code.

## Quick Start

1. Open [gearsxr.space](https://gearsxr.space/) — the URL field is prefilled with a demo trajectory.
2. Click **Load URL**.
3. Click **Play** in the bottom-left playback panel.

Everything else — loading your own files, multiuser rooms, VR controls, measurements — is covered in the [tutorial](https://gearsxr.space/tutorial.html).

## File Format

The viewer reads standard XYZ and extended XYZ trajectory files:

```text
natoms
comment or Properties=...
Element x y z ...
Element x y z ...
```

For extended XYZ files, the parser reads `Properties=...` metadata to find species, position, and atom-ID columns. When atom IDs are present, each frame is reordered to the first frame's ID order so atom identity stays stable across the trajectory. Atom types are stored per frame, so color and bond-radius logic follow the current frame. URL loads accept only `https://` links, and when the URL shows a file name it must end in `.xyz` or `.extxyz`.

## Development

```bash
npm install
npm run dev          # frontend dev server (https, for WebXR/Quest testing)
npm run dev:http     # frontend dev server over plain http
npm run build        # production build into dist/
npm run worker:dev   # room server (Cloudflare Worker) on :8787
npm run worker:deploy  # deploy the room server
```

The frontend deploys to GitHub Pages ([gearsxr.space](https://gearsxr.space/)) on every push to `main`. The multiuser room server is a Cloudflare Worker with a Durable Object per room, deployed at:

```text
wss://vr-md-viewer-room.kenichi-nomura.workers.dev
```

The Worker also provides a `/proxy` route that fetches trajectories from known cloud-storage hosts when a provider blocks direct browser downloads (Google Drive usually does).

## Troubleshooting

Common issues (share-link permissions, room connection, VR support) are covered in the [tutorial's help section](https://gearsxr.space/tutorial.html#troubleshooting).

## License

MIT License. See [LICENSE](LICENSE).
