import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
console.log('[开发] 编译当前源码的生成引擎…')
const build = spawnSync('cargo', ['build', '--manifest-path', path.join(repo, 'VideoAutoCutApp/Cargo.toml')], { stdio: 'inherit', windowsHide: true })
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status || 1)
const engine = path.join(repo, 'VideoAutoCutApp/target/debug/VideoAutoCutEngine.exe')
const check = spawnSync(engine, ['--help'], { encoding: 'utf8', windowsHide: true })
if (check.status !== 0 || !check.stdout.includes('--aspect-ratio')) throw new Error('开发引擎能力检查失败')
fs.copyFileSync(engine, path.join(repo, 'VideoAutoCut/VideoAutoCutEngine.exe'))
console.log('[开发] 引擎已更新，支持成片比例。')
