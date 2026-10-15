import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildShotMaterialQuery,
  mergeSearchResults,
  resolveAutomaticShotMaterials,
  selectReusableMaterial,
} from '../dist-electron/material-auto-reuse.js'

function result(overrides = {}) {
  return {
    rank: 1,
    score: 0.9,
    name: '工业机械臂.mp4',
    path: 'C:\\materials\\robot.mp4',
    start: '',
    end: '',
    text: '',
    materialId: 'mat_robot',
    localPath: 'C:\\materials\\robot.mp4',
    localStatus: 'present',
    analysisStatus: 'ready',
    cloudStatus: 'not_uploaded',
    ...overrides,
  }
}

test('resume reuses unchanged resolved shots but searches the edited shot', async () => {
  const original = { shot_id: 'kept', visual_query: 'robot', download_material: false,
    material_bindings: [{ binding_type: 'material', material_id: 'mat_robot' }],
    material_resolution: { strategy: 'library', query: 'robot' } }
  const queries = []
  const resolved = await resolveAutomaticShotMaterials({ reuseUnchanged: true, shots: [original, { ...original, shot_id: 'changed', visual_query: 'conveyor' }] }, async (query) => {
    queries.push(query)
    return { ok: true, results: [result()] }
  })
  assert.deepEqual(queries, ['conveyor'])
  assert.equal(resolved.shots[0], original)
})

test('automatic reuse query prefers visual intent and removes duplicate text', () => {
  assert.equal(buildShotMaterialQuery({
    visual_query: '工业机械臂 装配线',
    download_query: 'industrial robot assembly line',
    title: '工业机械臂 装配线',
    clip_requirements: '镜头缓慢推进',
  }), '工业机械臂 装配线；industrial robot assembly line；镜头缓慢推进')
})

test('merged local and cloud results deduplicate by material identity and keep the best score', () => {
  const merged = mergeSearchResults([
    [result({ score: 0.72, name: '本地名称.mp4' })],
    [result({ score: 0.91, name: '云端名称.mp4', localStatus: 'missing', cloudStatus: 'ready' })],
    [result({ materialId: 'mat_other', score: 0.8, name: '其他素材.mp4' })],
  ])

  assert.deepEqual(merged.map((item) => [item.materialId, item.score, item.name]), [
    ['mat_robot', 0.91, '云端名称.mp4'],
    ['mat_other', 0.8, '其他素材.mp4'],
  ])
})

test('reuse selection requires a business material id, availability and threshold match', () => {
  assert.equal(selectReusableMaterial([
    result({ score: 0.99, materialId: '' }),
    result({ score: 0.95, localStatus: 'missing', cloudStatus: 'failed' }),
    result({ score: 0.61 }),
  ], 0.62), null)

  assert.equal(selectReusableMaterial([
    result({ score: 0.79, localStatus: 'missing', localPath: '', cloudStatus: 'ready' }),
  ], 0.62)?.materialId, 'mat_robot')
})

test('automatic shot resolution binds matching library material and leaves misses for download', async () => {
  const queries = []
  const resolution = await resolveAutomaticShotMaterials({
    fallbackSource: 'pexels',
    threshold: 0.62,
    shots: [
      {
        shot_id: 'shot_match',
        title: '工业机械臂',
        visual_query: '机械臂装配汽车',
        download_material: true,
        material_bindings: [],
      },
      {
        shot_id: 'shot_miss',
        title: '海上风电场',
        download_material: true,
        material_bindings: [],
      },
      {
        shot_id: 'shot_manual',
        title: '手动素材',
        download_material: false,
        material_bindings: [{ binding_type: 'material', material_id: 'mat_manual' }],
      },
    ],
  }, async (query) => {
    queries.push(query)
    return query.includes('机械臂')
      ? { ok: true, results: [result()] }
      : { ok: true, results: [result({ materialId: 'mat_wind', score: 0.4 })] }
  })

  assert.deepEqual({
    matched: resolution.matched,
    fallback: resolution.fallback,
    skipped: resolution.skipped,
  }, { matched: 1, fallback: 1, skipped: 1 })
  assert.equal(queries.length, 2)
  assert.deepEqual(resolution.shots[0].material_bindings, [
    { binding_type: 'material', material_id: 'mat_robot' },
  ])
  assert.equal(resolution.shots[0].download_material, false)
  assert.equal(resolution.shots[0].material_resolution.strategy, 'library')
  assert.equal(resolution.shots[1].download_material, true)
  assert.deepEqual(resolution.shots[1].material_bindings, [])
  assert.equal(resolution.shots[1].material_resolution.fallback_source, 'pexels')
  assert.equal(resolution.decisions[2].status, 'skipped')
  assert.equal(resolution.blocked, 0)
})

test('search failures are recoverable and keep the external download fallback', async () => {
  const resolution = await resolveAutomaticShotMaterials({
    shots: [{
      shot_id: 'shot_offline',
      visual_query: '夜间城市延时',
      download_material: true,
      material_bindings: [],
    }],
  }, async () => {
    throw new Error('vector service unavailable')
  })

  assert.equal(resolution.ok, true)
  assert.equal(resolution.fallback, 1)
  assert.equal(resolution.shots[0].download_material, true)
  assert.equal(resolution.shots[0].material_resolution.reason, 'search_unavailable')
})

test('legacy disabled local priority bypasses search and clears all bindings', async () => {
  const resolution = await resolveAutomaticShotMaterials({
    preferLocalMaterials: false,
    shots: [
      { shot_id: 'new', download_material: true, title: 'new shot' },
      { shot_id: 'previous', download_material: false,
        material_bindings: [{ binding_type: 'material', material_id: 'mat_old' }],
        material_resolution: { strategy: 'library' } },
      { shot_id: 'legacy_empty', download_material: false, material_bindings: [] },
      { shot_id: 'manual', download_material: false,
        material_bindings: [{ binding_type: 'material', material_id: 'mat_manual' }] },
    ],
  }, async () => { assert.fail('direct download must not search any library') })
  assert.deepEqual([resolution.matched, resolution.fallback, resolution.skipped, resolution.blocked], [0, 4, 0, 0])
  for (const shot of resolution.shots) {
    assert.equal(shot.download_material, true)
    assert.deepEqual(shot.material_bindings, [])
    assert.equal(shot.material_resolution.reason, 'pexels_only')
    assert.equal(shot.material_resolution.source_mode, 'pexels-only')
    assert.equal(shot.source, 'pexels')
    assert.equal(shot.material_resolution.fallback_source, 'pexels')
  }
})

test('library priority includes available cloud materials and selects the best match', async () => {
  const resolution = await resolveAutomaticShotMaterials({
    preferLocalMaterials: true,
    shots: [{ shot_id: 'local', visual_query: 'robot', download_material: true }],
  }, async () => ({ ok: true, results: [
    result({ materialId: 'cloud', localStatus: 'missing', localPath: '', cloudStatus: 'ready', score: 0.99 }),
    result({ materialId: 'local', score: 0.8 }),
  ] }))
  assert.equal(resolution.matched, 1)
  assert.equal(resolution.shots[0].material_bindings[0].material_id, 'cloud')
  assert.equal(resolution.shots[0].material_resolution.source_mode, 'library-first')
})

test('library priority falls back when only unavailable or below-threshold files are available', async () => {
  const resolution = await resolveAutomaticShotMaterials({
    shots: [{ shot_id: 'miss', visual_query: 'robot', download_material: true }],
  }, async () => ({ ok: true, results: [
    result({ materialId: 'cloud', localStatus: 'missing', localPath: '', cloudStatus: 'failed' }),
    result({ materialId: 'low', score: 0.1 }),
    result({ materialId: 'failed', analysisStatus: 'failed' }),
  ] }))
  assert.equal(resolution.matched, 0)
  assert.equal(resolution.fallback, 1)
  assert.equal(resolution.shots[0].download_material, true)
})

test('explicit Pexels mode overrides legacy priority and previous manual or automatic bindings', async () => {
  const resolution = await resolveAutomaticShotMaterials({
    materialSourceMode: 'pexels-only',
    preferLocalMaterials: true,
    reuseUnchanged: true,
    source: 'pixabay',
    fallbackSource: 'pixabay',
    shots: [
      { shot_id: 'auto', visual_query: 'robot', source: 'pixabay', download_material: false,
        material_bindings: [{ binding_type: 'material', material_id: 'old' }],
        material_resolution: { strategy: 'library', query: 'robot' } },
      { shot_id: 'folder', download_material: false,
        material_bindings: [{ binding_type: 'folder', folder_id: 'folder' }] },
    ],
  }, async () => { assert.fail('Pexels-only mode cannot search the library') })
  assert.equal(resolution.ok, true)
  assert.equal(resolution.fallback, 2)
  assert.equal(resolution.blocked, 0)
  for (const shot of resolution.shots) {
    assert.equal(shot.download_material, true)
    assert.equal(shot.source, 'pexels')
    assert.deepEqual(shot.material_bindings, [])
    assert.equal(shot.material_resolution.fallback_source, 'pexels')
  }
})

test('both library modes preserve manual ranges and can bind cloud-only matches', async () => {
  for (const materialSourceMode of ['library-first', 'library-only']) {
    const manualBindings = [{ binding_type: 'folder', folder_id: 'folder' }]
    const resolution = await resolveAutomaticShotMaterials({
      materialSourceMode,
      preferLocalMaterials: false,
      shots: [
        { shot_id: 'manual', download_material: true, material_bindings: manualBindings },
        { shot_id: 'cloud', visual_query: 'robot' },
      ],
    }, async () => ({ ok: true, results: [result({ localStatus: 'missing', localPath: '', cloudStatus: 'ready' })] }))
    assert.equal(resolution.ok, true)
    assert.equal(resolution.blocked, 0)
    assert.equal(resolution.fallback, 0)
    assert.equal(resolution.skipped, 1)
    assert.equal(resolution.matched, 1)
    assert.deepEqual(resolution.shots[0].material_bindings, manualBindings)
    assert.equal(resolution.shots[0].download_material, false)
    assert.equal(resolution.shots[1].material_bindings[0].material_id, 'mat_robot')
    assert.equal(resolution.shots[1].material_resolution.source_mode, materialSourceMode)
  }
})

test('library-only blocks misses, empty queries and search failures without allowing downloads', async () => {
  const resolution = await resolveAutomaticShotMaterials({
    materialSourceMode: 'library-only',
    shots: [
      { shot_id: 'no_match', title: '海上风电场', download_material: true },
      { shot_id: 'empty', download_material: true },
      { shot_id: 'failure', title: '夜间城市', download_material: true },
      { shot_id: 'false_response', title: '森林航拍', download_material: true },
    ],
  }, async (query) => {
    if (query === '夜间城市') throw new Error('vector service timed out')
    if (query === '森林航拍') return { ok: false, results: [] }
    return { ok: true, results: [result({ score: 0.3 })] }
  })
  assert.equal(resolution.ok, false)
  assert.equal(resolution.blocked, 4)
  assert.equal(resolution.fallback, 0)
  assert.deepEqual(resolution.decisions.map((item) => item.reason), [
    'below_threshold', 'empty_query', 'search_unavailable', 'search_unavailable',
  ])
  assert.match(resolution.message, /分镜 1「海上风电场」.*没有达到匹配阈值/)
  assert.match(resolution.message, /分镜 2「empty」.*缺少可用于检索的画面描述/)
  assert.match(resolution.message, /分镜 3「夜间城市」.*vector service timed out/)
  assert.match(resolution.message, /分镜 4「森林航拍」.*素材库检索失败/)
  assert.match(resolution.message, /不能从 Pexels 下载/)
  for (const shot of resolution.shots) {
    assert.equal(shot.download_material, false)
    assert.deepEqual(shot.material_bindings, [])
    assert.equal(shot.material_resolution.strategy, 'library')
    assert.equal(shot.material_resolution.source_mode, 'library-only')
    assert.equal(shot.material_resolution.fallback_source, undefined)
  }
  assert.ok(resolution.decisions.every((item) => item.status === 'blocked' && item.strategy === 'library'))
})

test('switching to library-only retries previous fallback instead of retaining a download decision', async () => {
  const resolution = await resolveAutomaticShotMaterials({
    materialSourceMode: 'library-only',
    reuseUnchanged: true,
    shots: [{ shot_id: 'previous_miss', visual_query: 'robot', download_material: true,
      material_resolution: { strategy: 'download', query: 'robot', fallback_source: 'pexels' } }],
  }, async () => ({ ok: true, results: [] }))
  assert.equal(resolution.ok, false)
  assert.equal(resolution.blocked, 1)
  assert.equal(resolution.shots[0].download_material, false)
})
