# VR MD Viewer

A browser-based molecular dynamics trajectory viewer for extended XYZ files, with desktop controls and WebXR support for virtual reality headsets.

[Open the viewer](https://kenichinomura.github.io/vr-md-viewer/)

![MD Trajectory VR Viewer screenshot](docs/screenshot.png)

## Features

- Load extended XYZ trajectories from a local file, drag-and-drop, or URL.
- Play multi-frame trajectories with a frame slider, step buttons, and FPS control.
- Color atoms by element and update atom types correctly on each frame.
- Compute bonds per frame from covalent radii.
- Enter VR through WebXR when the browser and headset support it.
- Grab, move, and scale the molecule with VR controllers.
- Select atoms to measure distances and angles.
- Join a lightweight multiuser room to share trajectory URL, frame, playback, and view state.

## Supported XYZ Format

The viewer supports standard XYZ and extended XYZ trajectory files:

```text
natoms
comment or Properties=...
Element x y z ...
Element x y z ...
```

For extended XYZ files, the parser reads `Properties=...` metadata to find species, position, and atom-ID columns. When atom IDs are present, each frame is reordered to the first frame's ID order so atom identity stays stable across the trajectory. Atom types are stored per frame, so color and bond-radius logic follow the current frame rather than only the first frame.

The bundled default sample is `public/samples/tobe.xyz`.

## How To Use

Open the hosted app:

[https://kenichinomura.github.io/vr-md-viewer/](https://kenichinomura.github.io/vr-md-viewer/)

Click **Load URL** to load the default sample trajectory, or choose/drag-drop your own `.xyz` file. Use the frame slider, step buttons, and play button to inspect the trajectory over time.

Double-click atoms on desktop, or select atoms in VR, to show measurements. Selecting two atoms reports a distance; selecting three reports an angle. Press `c` to clear measurements.

## Multiuser Rooms

The viewer can join a shared room through a WebSocket room server. Each browser loads the same trajectory locally from a URL; the room only synchronizes lightweight state such as the current frame, play/pause state, FPS, presenter, molecule transform, and desktop camera view.

For desktop testing across browsers on the same network, use the HTTP app URL and WebSocket server URL shown by the dev servers:

```text
App:         http://<computer-ip>:5174/
Room server: ws://<computer-ip>:8787
```

For WebXR or the hosted GitHub Pages page, use HTTPS with a secure WebSocket server:

```text
App:         https://kenichinomura.github.io/vr-md-viewer/
Room server: wss://...workers.dev
```

The first user in a room becomes the presenter. The presenter controls the shared frame, playback, and view. Other users follow the presenter until they click **Take Presenter**.

Local file loads are not sent through the room. Use **Load URL** for trajectories that should appear for other users.

## VR Usage

Use the hosted HTTPS page for VR:

[https://kenichinomura.github.io/vr-md-viewer/](https://kenichinomura.github.io/vr-md-viewer/)

If the browser supports WebXR `immersive-vr`, the page shows an **Enter VR** button. In VR, use the controllers to grab, move, and scale the molecule.

Opening the app from `file://` is fine for desktop previewing, but it is not suitable for WebXR VR sessions.

## Browser And Headset Compatibility

Desktop viewing works in modern browsers with WebGL.

VR mode requires:

- A WebXR-compatible browser.
- A headset/runtime exposed to the browser as an `immersive-vr` device.
- A secure context, such as the hosted HTTPS page.

Quest Browser should work from the hosted page. Windows Mixed Reality support depends on the Windows version, browser, and active XR runtime.

## Known Limitations

- Variable atom counts across frames are not supported.
- Periodic-boundary unwrap/rewrap controls are not implemented yet.
- Bond detection is heuristic and based on covalent radii.
- Very large trajectories may take time to parse in browser memory.
- Multiuser rooms share trajectory URLs and interaction state, not local file contents.
- The room server is intended for small rooms and currently limits rooms to six users.

## Room Server Notes

The room server is a Cloudflare Worker with a Durable Object per room. It includes basic guardrails for public demo use:

- allowed-origin checks
- maximum users per room
- maximum WebSocket message size
- per-client message rate limits

Room state is temporary and should be treated as shared with everyone who has the room link.

## Tech Stack

- Three.js
- WebXR
- Vite
- TypeScript
- Cloudflare Workers
- Cloudflare Durable Objects
