import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  TaskOutputDecoder,
  extractWorkflowEvent,
  parseRunPath,
  parseWorkflowEventLine,
} from '../electron/task-events.ts'

const u6EventLine = (await readFile(new URL('./fixtures/u6-template-import-event.txt', import.meta.url), 'utf8')).trimEnd()

test('workflow event parser normalizes progress and removes terminal plan stages', () => {
  const parsed = parseWorkflowEventLine(`VACUT_EVENT:${JSON.stringify({
    workflowStage: 'material',
    workflowStatus: 'running',
    workflowProgress: {
      phase: ' downloading ',
      current: 0,
      total: '12',
      label: ' 候选素材 ',
    },
    workflowPlan: {
      stages: ['script', 'material', 'card', 'material', 'done', 'unknown'],
    },
  })}`)

  assert.deepEqual(parsed, {
    workflowStage: 'material',
    workflowProgress: {
      stage: 'material',
      status: 'running',
      phase: 'downloading',
      current: 0,
      total: 12,
      label: '候选素材',
    },
    workflowPlan: ['script', 'material'],
  })
})

test('task output hides valid protocol lines and keeps normal or malformed output', () => {
  const output = extractWorkflowEvent([
    '开始处理',
    'VACUT_EVENT:{broken-json}',
    `VACUT_EVENT:${JSON.stringify({ workflowStage: 'clip', workflowStatus: 'running' })}`,
    '剪辑完成',
  ].join('\r\n'))

  assert.equal(output.text, '开始处理\nVACUT_EVENT:{broken-json}\n剪辑完成')
  assert.equal(output.workflowStage, 'clip')
  assert.deepEqual(output.workflowProgress, { stage: 'clip', status: 'running' })
})

test('unsupported protocol values do not create phantom events', () => {
  assert.equal(parseWorkflowEventLine('ordinary log line'), null)
  assert.equal(parseWorkflowEventLine('VACUT_EVENT:[]'), null)
  assert.equal(parseWorkflowEventLine('VACUT_EVENT:{"workflowStage":"unknown"}'), null)
})

test('D7 template import reports are normalized, capped, forwarded and hidden from visible logs', () => {
  const issues = Array.from({ length: 205 }, (_, index) => ({ code: 'text_cell_pending', message: `问题 ${index}`, shot: index + 1, cell: `I${index + 2}`, column: '口播' }))
  const line = `VACUT_EVENT:${JSON.stringify({
    workflowStage: 'script', workflowStatus: 'failed',
    scriptImport: { route: 'template', format: 'VAC-SB-1', file: 'blocked.xlsx', shots: 9, blocked: issues, warnings: [] },
  })}`
  const output = extractWorkflowEvent(`可见日志\n${line}\n结束`)
  assert.equal(output.text, '可见日志\n结束')
  assert.equal(output.scriptImport.blocked.length, 200)
  assert.deepEqual(output.scriptImport.blocked[0], issues[0])
  assert.deepEqual(parseWorkflowEventLine(`VACUT_EVENT:${JSON.stringify({ scriptImport: { route: 'template', format: 'VAC-SB-1', file: 'x.xlsx', shots: 1, blocked: [{ code: {}, message: 'bad' }], warnings: [] } })}`).scriptImport.blocked,
    [{ code: 'script_import_blocked', message: '导入被阻断，详见日志' }])
  assert.equal(parseWorkflowEventLine(`VACUT_EVENT:${JSON.stringify({ scriptImport: { route: 'template', format: 'VAC-SB-1', file: 'x.xlsx', shots: 1.5, blocked: [], warnings: [] } })}`), null)
})

test('invalid issue shot numbers are omitted without hiding the blocking import report', () => {
  const blocked = [-1, 0, 1.5, 2].map((shot, index) => ({
    code: `bad_shot_${index}`,
    message: `镜号问题 ${shot}`,
    shot,
    cell: `A${index + 2}`,
  }))
  const parsed = parseWorkflowEventLine(`VACUT_EVENT:${JSON.stringify({
    scriptImport: { route: 'template', format: 'VAC-SB-1', file: 'bad-shots.xlsx', shots: 1, blocked, warnings: [] },
  })}`)
  assert.ok(parsed.scriptImport)
  assert.equal(parsed.scriptImport.blocked.length, 4)
  for (let index = 0; index < 3; index += 1) {
    assert.equal('shot' in parsed.scriptImport.blocked[index], false)
    assert.equal(parsed.scriptImport.blocked[index].cell, blocked[index].cell)
    assert.equal(parsed.scriptImport.blocked[index].message, blocked[index].message)
  }
  assert.equal(parsed.scriptImport.blocked[3].shot, 2)
})

test('index file, cache and heartbeat output stays visible without replacing workflow counts', () => {
  const decoder = new TaskOutputDecoder()
  const lines = [
    'Indexing file 2/74: source.mp4 [chunk 4/12]',
    'VACUT_INDEX_PROGRESS:{"file":2,"files":74,"chunks":12,"chunk":4,"completed_chunks":3,"cached_chunks":2,"phase":"embedding"}',
    'cache hit: reused analysis',
    '索引仍在处理：已运行 10 秒；文件 2/74，当前文件完成 3/12（缓存 2）',
  ]
  const output = decoder.push(`${lines.join('\n')}\n`)
  assert.equal(output.text.trimEnd(), lines.join('\n'))
  assert.equal(output.workflowProgress, undefined)
  assert.equal(output.workflowStage, '')
})

test('run directory parsing is independent of slash style', () => {
  assert.deepEqual(parseRunPath('运行目录: C:\\workspace\\runs\\run-42\n'), {
    runId: 'run-42',
    runPath: 'C:\\workspace\\runs\\run-42',
  })
  assert.deepEqual(parseRunPath('info\n运行目录: /tmp/runs/run-7'), {
    runId: 'run-7',
    runPath: '/tmp/runs/run-7',
  })
  assert.deepEqual(parseRunPath('运行目录: \\\\?\\D:\\workspace\\runs\\run-drive'), {
    runId: 'run-drive',
    runPath: 'D:\\workspace\\runs\\run-drive',
  })
  assert.deepEqual(parseRunPath('运行目录: \\\\?\\UNC\\server\\share\\runs\\run-unc'), {
    runId: 'run-unc',
    runPath: '\\\\server\\share\\runs\\run-unc',
  })
  assert.equal(parseRunPath('没有运行目录'), null)
})

test('stream decoder reassembles protocol lines split across process chunks', () => {
  const decoder = new TaskOutputDecoder()

  assert.equal(decoder.push('VACUT_EV'), null)
  assert.equal(decoder.push('ENT:{"workflowStage":"compose","workflowStatus":"running"}'), null)
  assert.deepEqual(decoder.push('\r\n普通日志'), {
    text: '',
    workflowStage: 'compose',
    workflowProgress: { stage: 'compose', status: 'running' },
    workflowPlan: undefined,
  })
  assert.deepEqual(decoder.flush(), {
    text: '普通日志',
    workflowStage: '',
    workflowProgress: undefined,
    workflowPlan: undefined,
  })
  assert.equal(decoder.flush(), null)
})

test('U6 real template report survives every possible decoder chunk boundary', () => {
  assert.ok(u6EventLine.length > 14_000)

  for (let boundary = 0; boundary <= u6EventLine.length; boundary += 1) {
    const decoder = new TaskOutputDecoder()
    const first = decoder.push(u6EventLine.slice(0, boundary))
    assert.equal(first, null, `unexpected complete line before boundary ${boundary}`)
    const output = decoder.push(`${u6EventLine.slice(boundary)}\n`)
    assert.equal(output?.scriptImport?.blocked.length, 2, `blocked count at boundary ${boundary}`)
    assert.equal(output?.scriptImport?.warnings.length, 53, `warning count at boundary ${boundary}`)
    assert.deepEqual(output?.scriptImport?.blocked.map((issue) => issue.cell), ['I9', 'K9'])
  }
})

test('stream decoder emits carriage-return progress without waiting for process close', () => {
  const decoder = new TaskOutputDecoder()

  assert.deepEqual(decoder.push('下载进度 50%\r'), {
    text: '下载进度 50%\n',
    workflowStage: '',
    workflowProgress: undefined,
    workflowPlan: undefined,
  })
})
