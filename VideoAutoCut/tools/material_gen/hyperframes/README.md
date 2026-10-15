# VideoAutoCut HyperFrames Renderer

This directory keeps the bundled HyperFrames CLI used by `tools/material_gen/generate_material.py`.

Install dependencies here before packing the runtime:

```powershell
npm install --prefix VideoAutoCut/tools/material_gen/hyperframes
```

Rendering is executed with the packaged `VideoAutoCut/node-runtime/node.exe`; runtime code does not call `npx`.
