import fs from 'node:fs'
import path from 'node:path'

/** Packaging must ship its renderer; never defer an installation to an end user. */
export function verifyTemplateRuntime(root: string): void {
  const hf = path.join(root, 'tools', 'material_gen', 'hyperframes')
  const required = [
    path.join(root, 'node-runtime', 'node.exe'),
    path.join(hf, 'node_modules', 'hyperframes', 'dist', 'cli.js'),
    path.join(hf, 'node_modules', 'gsap', 'dist', 'gsap.min.js'),
  ]
  const browsers = [
    path.join(hf, 'chrome-headless-shell', 'chrome-headless-shell.exe'),
    path.join(root, 'tools', 'material_gen', 'remotion', 'node_modules', '.remotion', 'chrome-headless-shell', 'win64', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
  ]
  const missing = required.filter((file) => !fs.existsSync(file) || fs.statSync(file).size === 0)
  if (!browsers.some((file) => fs.existsSync(file) && fs.statSync(file).size > 0)) missing.push('Chrome Headless Shell')
  if (missing.length) throw new Error(`模板包装运行组件未打包完整：${missing.join(', ')}`)
  for (const [name, version] of [['hyperframes', '0.7.3'], ['gsap', '3.14.2']]) {
    const actual = JSON.parse(fs.readFileSync(path.join(hf, 'node_modules', name, 'package.json'), 'utf8')).version
    if (actual !== version) throw new Error(`模板包装 ${name} 版本不匹配：${actual}，需要 ${version}`)
  }
}
