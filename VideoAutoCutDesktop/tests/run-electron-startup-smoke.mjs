import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = process.env.VACUT_SMOKE_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'vacut-startup-smoke-'))
const env = { ...process.env, VACUT_SMOKE_OUTPUT: output }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [path.join(desktop, 'tests/electron-startup-smoke.cjs')], {
  cwd: desktop, env, windowsHide: true, stdio: 'inherit',
})
const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', resolve)
})
if (code !== 0) throw new Error(`Electron startup smoke failed (${code}); report: ${output}`)
const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'))
if (!report.passed) throw new Error(`Electron startup smoke did not pass: ${output}`)
console.log(`Hidden Electron startup verified: ${output}`)
