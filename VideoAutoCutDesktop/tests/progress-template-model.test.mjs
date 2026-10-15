import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { subtitlePreviewLayout } from '../src/pages/config/subtitlePreviewLayout.ts'

import {
  featuredProgressTemplates,
  progressTemplateItems,
  resolveProgressTemplate,
} from '../src/pages/config/progressTemplateModel.ts'

const progressTemplates = JSON.parse(await readFile(
  new URL('../../VideoAutoCut/config/progress-templates.json', import.meta.url),
  'utf8',
))
const configStyles = await readFile(new URL('../src/styles/voice-material-config.css', import.meta.url), 'utf8')

test('subtitle preview uses the same picture anchors as the renderer', () => {
  const base = { fontSize: 68, progressHeight: 38, progressEnabled: true }
  assert.deepEqual(subtitlePreviewLayout(base).lineY, [957, 1037])
  assert.deepEqual(subtitlePreviewLayout({ ...base, progressEnabled: false }).lineY, [995, 1075])
  const letterbox = subtitlePreviewLayout({ ...base, pictureMode: 'letterbox' })
  assert.equal(letterbox.anchor, 'top')
  assert.deepEqual(letterbox.lineY, [865, 945])
  assert.equal(letterbox.progressBottom, 220)
  const large = subtitlePreviewLayout({ ...base, fontSize: 96, pictureMode: 'letterbox' })
  assert.equal(large.anchor, 'bottom')
  assert.deepEqual(large.lineY, [704, 817])
})

function template(key) {
  return { key, label: key, tone: key, settings: {} }
}

test('custom templates are followed by the default template', () => {
  const items = progressTemplateItems(
    [template('classic')],
    [template('user-first'), template('user-second')],
  )

  assert.deepEqual(items.map((item) => item.key), ['user-first', 'user-second', 'classic'])
  assert.deepEqual(items.map((item) => item.source), ['user', 'user', 'built-in'])
})

test('selected custom template remains visible while classic stays last', () => {
  const items = progressTemplateItems(
    [template('classic')],
    ['one', 'two', 'three', 'selected'].map((key) => template(`user-${key}`)),
  )
  const featured = featuredProgressTemplates(items, 'user-selected', 4)

  assert.equal(featured[0].key, 'user-selected')
  assert.equal(featured.at(-1).key, 'classic')
  assert.equal(resolveProgressTemplate(items, 'user-selected').key, 'user-selected')
  assert.equal(resolveProgressTemplate(items, 'missing').key, 'classic')
})

test('default progress bar is bottom aligned and template previews stay compact', () => {
  const classic = progressTemplates.find((templateItem) => templateItem.key === 'classic')
  assert.equal(classic.settings.PROGRESS_BOTTOM_MARGIN, '0')
  assert.match(
    configStyles,
    /\.visual-style-section \.progress-template-featured-grid\s*\{[^}]*repeat\(4, minmax\(0, 1fr\)\)/s,
  )
  assert.match(
    configStyles,
    /\.progress-template-editor\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) 280px/s,
  )
})
