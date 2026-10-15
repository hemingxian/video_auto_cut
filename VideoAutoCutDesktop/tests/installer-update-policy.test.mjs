import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const installerPath = new URL('../build/installer.nsh', import.meta.url)
const packagePath = new URL('../package.json', import.meta.url)
const releasePackPath = new URL('../scripts/pack-release.ts', import.meta.url)
const runtimePackPath = new URL('../scripts/pack-runtime.ts', import.meta.url)

test('installer always normalizes the application into a dedicated directory', async () => {
  const source = await readFile(installerPath, 'utf8')

  assert.match(source, /Function vacutNormalizeInstallDir/)
  assert.match(source, /\$INSTDIR\\\$\{APP_FILENAME\}/)
  assert.match(source, /Call vacutNormalizeInstallDir/)
  assert.match(source, /VACUT_INSTALL_ROOT_SENTINEL_FILE/)
})

test('installer bypasses unsafe or incomplete legacy uninstall records', async () => {
  const source = await readFile(installerPath, 'utf8')

  assert.match(source, /Function vacutPrepareLegacyInstall/)
  assert.match(source, /ReadRegStr \$0 SHELL_CONTEXT "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/)
  assert.match(source, /IfFileExists "\$0\\Uninstall \$\{PRODUCT_FILENAME\}\.exe" 0 vacutLegacyInstallNeedsMigration/)
  assert.match(source, /DeleteRegKey SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}"/)
  assert.match(source, /Call vacutPrepareLegacyInstall/)
})

test('a public desktop release always publishes the matching runtime contract', async () => {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  const releasePackSource = await readFile(releasePackPath, 'utf8')
  const runtimePackSource = await readFile(runtimePackPath, 'utf8')

  assert.equal(packageJson.scripts['release:desktop'], 'npm run release:pack && npm run release:upload')
  for (const argument of ['--material-manifest', '--project-name']) {
    assert.match(releasePackSource, new RegExp(argument))
    assert.match(runtimePackSource, new RegExp(argument))
  }
})
