import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { loadReleaseUploadConfig, releasePublicUrls, releaseTargets } from './release-upload-config.js'

interface PackageInfo {
  build?: Record<string, unknown>
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktopRoot, '..')
const engineRoot = path.join(repoRoot, 'VideoAutoCutApp')
const enginePath = path.join(engineRoot, 'target', 'release', 'VideoAutoCutEngine.exe')
const installedElectronDist = path.join(desktopRoot, 'node_modules', 'electron', 'dist')
const node = process.execPath

function run(
  label: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = desktopRoot,
): void {
  console.log(`\n[发布] ${label}`)
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label}失败，退出码 ${result.status ?? 'unknown'}`)
}

function assertEngineCapabilities(): void {
  if (!fs.existsSync(enginePath)) throw new Error(`编译完成后没有找到引擎：${enginePath}`)
  const result = spawnSync(enginePath, ['--help'], {
    cwd: engineRoot,
    encoding: 'utf8',
    shell: false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`无法检查引擎参数，退出码 ${result.status ?? 'unknown'}`)

  const help = `${result.stdout || ''}\n${result.stderr || ''}`
  const requiredArguments = ['--material-manifest', '--project-name']
  const missing = requiredArguments.filter((argument) => !help.includes(argument))
  if (missing.length) {
    throw new Error(`最新引擎缺少桌面壳需要的参数：${missing.join('、')}`)
  }
  console.log(`[发布] 引擎参数检查通过：${requiredArguments.join('、')}`)
}

function runNpm(label: string, args: string[], env: NodeJS.ProcessEnv): void {
  console.log(`\n[发布] ${label}`)
  const result = spawnSync('npm', args, {
    cwd: desktopRoot,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label}失败，退出码 ${result.status ?? 'unknown'}`)
}

function scriptPath(name: string): string {
  return path.join(desktopRoot, 'dist-scripts', name)
}

function main(): void {
  const targets = releaseTargets(process.argv.slice(2))
  const config = loadReleaseUploadConfig(desktopRoot, { requireCredentials: false })
  const urls = releasePublicUrls(config)
  const tempRoot = path.join(desktopRoot, 'node_modules', '.tmp')
  const builderConfigPath = path.join(tempRoot, 'electron-builder.release.json')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VIDEOAUTO_RUNTIME_BASE_URL: urls.runtime,
    VIDEOAUTO_REMOTE_CONFIG_BASE_URL: urls.desktop,
  }

  if (targets.desktop) {
    const packageJsonPath = path.join(desktopRoot, 'package.json')
    const packageInfo = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageInfo
    const electronExecutable = path.join(installedElectronDist, 'electron.exe')
    if (!fs.existsSync(electronExecutable)) {
      throw new Error(`没有找到本地 Electron 运行环境：${electronExecutable}`)
    }
    fs.mkdirSync(tempRoot, { recursive: true })
    fs.writeFileSync(builderConfigPath, `${JSON.stringify({
      ...(packageInfo.build || {}),
      electronDist: installedElectronDist,
      publish: [{ provider: 'generic', url: `${urls.desktop}/` }],
    }, null, 2)}\n`, 'utf8')
  }

  try {
    if (targets.runtime) {
      run('编译最新 Rust 视频生成引擎', 'cargo', ['build', '--release', '--locked'], env, engineRoot)
      assertEngineCapabilities()
      run('打包视频生成引擎运行环境', node, [scriptPath('pack-runtime.js')], env)
    }
    if (targets.desktop) {
      runNpm('编译桌面壳', ['run', 'build'], env)
      run('写入桌面壳更新地址', node, [scriptPath('pack-remote-config.js'), '--defaults-only'], env)
      run('打包桌面壳', node, [path.join(desktopRoot, 'node_modules', 'electron-builder', 'cli.js'), '--config', builderConfigPath, '--win', 'nsis', 'zip', '--publish', 'never'], env)
      run('验证安装包真实界面启动', node, [path.join(desktopRoot, 'tests', 'run-electron-startup-smoke.mjs')], {
        ...env,
        VACUT_SMOKE_APP_ROOT: path.join(desktopRoot, 'release', 'win-unpacked', 'resources', 'app.asar'),
        VACUT_SMOKE_OUTPUT: fs.mkdtempSync(path.join(tempRoot, 'startup-smoke-')),
        VACUT_SMOKE_EXPECT_BROKEN: '0',
      })
      run('生成远程配置', node, [scriptPath('pack-remote-config.js'), '--artifact-only'], env)
    }
    const completed = targets.desktop && targets.runtime ? '桌面壳和视频生成引擎' : targets.desktop ? '桌面壳' : '视频生成引擎'
    console.log(`\n[发布] ${completed}已打包完成`)
  } finally {
    if (targets.desktop) {
      const cleanup = spawnSync(node, [scriptPath('pack-remote-config.js'), '--cleanup'], {
        cwd: desktopRoot,
        env,
        stdio: 'inherit',
        shell: false,
      })
      if (cleanup.error) console.warn(`[发布] 清理远程配置失败：${cleanup.error.message}`)
      fs.rmSync(builderConfigPath, { force: true })
    }
  }
}

try {
  main()
} catch (error) {
  console.error(`\n[发布失败] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
