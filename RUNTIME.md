# Runtime Setup

The repository keeps source code in Git and keeps heavyweight runtime payloads out of Git.

Do not commit:

- `VideoAutoCut/ffmpeg/`
- `VideoAutoCut/python-3.11.9-embed-amd64/`
- `VideoAutoCut/node-runtime/`
- `VideoAutoCut/sentrysearch/.venv/`
- `VideoAutoCut/tools/material_gen/**/node_modules/`
- `VideoAutoCut/*.exe`
- `VideoAutoCut/.env`

Developers should install dependencies separately:

```powershell
cd VideoAutoCutDesktop
npm install
npm run build
npm run start
```

The desktop app installs the video runtime into the local workspace/runtime directory when needed. Runtime packages should be built and published separately from Git source.

To pack a runtime artifact from a prepared local runtime:

```powershell
cd VideoAutoCutDesktop
npm run runtime:pack
```

The runtime artifact is the correct place for embedded Python, ffmpeg, yt-dlp, sentrysearch venv, Node runtime, and material generator `node_modules`.
