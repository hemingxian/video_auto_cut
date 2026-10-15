import {
  Check,
  ChevronDown,
  ChevronRight,
  FileVideo2,
  Folder,
  FolderOpen,
  Library,
  Search,
  Upload,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { MaterialArtwork } from './MaterialArtwork'
import {
  initialPickerSelections,
  referenceFolders,
  referenceMaterials,
} from './fixtures'
import {
  summarizeReferenceSelections,
  toggleReferenceSelection,
  toggleReferenceSubfolders,
  type ReferenceSelection,
} from './model'
import { ReferenceBackdrop } from './ReferenceChrome'

function selectionKey(selection: Pick<ReferenceSelection, 'id' | 'kind'>) {
  return `${selection.kind}:${selection.id}`
}

export function ShotMaterialPickerReferencePage({
  embedded = false,
  onClose,
  onConfirm,
}: {
  embedded?: boolean
  onClose?: () => void
  onConfirm?: (selections: ReferenceSelection[]) => void
}) {
  const [query, setQuery] = useState('')
  const [activeFolder, setActiveFolder] = useState('all')
  const [selections, setSelections] = useState<ReferenceSelection[]>(initialPickerSelections)
  const [confirmed, setConfirmed] = useState(false)

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleFolders = useMemo(() => referenceFolders
    .filter((folder) => ['product', 'factory', 'city', 'interview'].includes(folder.id))
    .filter((folder) => !normalizedQuery || folder.name.toLocaleLowerCase().includes(normalizedQuery)), [normalizedQuery])
  const visibleMaterials = useMemo(() => referenceMaterials
    .filter((material) => activeFolder === 'all' || material.folderId === activeFolder)
    .filter((material) => !normalizedQuery || material.name.toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, 6), [activeFolder, normalizedQuery])
  const selectedKeys = useMemo(
    () => new Set(selections.map(selectionKey)),
    [selections],
  )
  const summary = summarizeReferenceSelections(selections)

  const toggle = (selection: ReferenceSelection) => {
    setConfirmed(false)
    setSelections((current) => toggleReferenceSelection(current, selection))
  }

  return <div className={`vac-ref-page vac-ref-picker-page${embedded ? ' is-embedded' : ''}`}>
    {!embedded ? <ReferenceBackdrop /> : null}
    <div className="vac-ref-picker-shade">
      <section className="vac-ref-picker-dialog" role="dialog" aria-modal="true" aria-label="选择分镜素材">
        <header className="vac-ref-picker-header">
          <div className="vac-ref-picker-title">
            <span><Library /></span>
            <div>
              <h1>选择分镜素材</h1>
              <p>分镜 02 · 核心：智能储能产品展示</p>
            </div>
          </div>
          <div className="vac-ref-picker-actions">
            <button type="button"><Upload />从电脑导入</button>
            <button className="icon" type="button" aria-label="关闭" onClick={onClose}><X /></button>
          </div>
        </header>

        <div className="vac-ref-picker-toolbar">
          <button className="vac-ref-search-mode" type="button">文件名搜索<ChevronDown /></button>
          <label className="vac-ref-picker-search">
            <Search />
            <input
              value={query}
              placeholder="搜索文件夹或视频文件名"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <span>选择模式不会删除、移动或重命名素材</span>
        </div>

        <div className="vac-ref-picker-browser">
          <aside className="vac-ref-picker-locations">
            <strong>素材位置</strong>
            {referenceFolders
              .filter((folder) => ['all', 'project', 'product', 'interview', 'scene', 'cloud'].includes(folder.id))
              .map((folder) => <button
                className={activeFolder === folder.id ? 'active' : undefined}
                key={folder.id}
                type="button"
                onClick={() => setActiveFolder(folder.id === 'all' ? 'all' : folder.id)}
              >
                {folder.id === 'all' ? <Library /> : <Folder />}
                <span>{folder.name}</span>
                {folder.id !== 'all' ? <em>{folder.videoCount}</em> : null}
              </button>)}
          </aside>

          <main className="vac-ref-picker-results">
            <div className="vac-ref-picker-result-head">
              <nav><strong>全部素材</strong><ChevronRight /><span>当前目录</span></nav>
              <span>{visibleFolders.length} 个文件夹 · {visibleMaterials.length} 个视频</span>
            </div>
            <div className="vac-ref-picker-grid">
              {visibleFolders.map((folder) => {
                const selection: ReferenceSelection = {
                  id: folder.id,
                  kind: 'folder',
                  name: folder.name,
                  videoCount: folder.videoCount,
                }
                const selected = selectedKeys.has(selectionKey(selection))
                return <article className={`vac-ref-picker-card folder-card${selected ? ' selected' : ''}`} key={folder.id}>
                  <button
                    className="vac-ref-picker-check"
                    type="button"
                    aria-label={`${selected ? '取消选择' : '选择'} ${folder.name}`}
                    aria-pressed={selected}
                    onClick={() => toggle(selection)}
                  >{selected ? <Check /> : null}</button>
                  <button className="vac-ref-folder-main" type="button" onDoubleClick={() => setActiveFolder(folder.id)}>
                    <Folder />
                  </button>
                  <button className="vac-ref-picker-open" type="button" onClick={() => setActiveFolder(folder.id)}>
                    <FolderOpen />打开
                  </button>
                  <div><strong>{folder.name}</strong><span>{folder.videoCount} 个视频 · {folder.folderCount} 个子文件夹</span></div>
                </article>
              })}
              {visibleMaterials.map((material) => {
                const selection: ReferenceSelection = {
                  id: material.id,
                  kind: 'material',
                  name: material.name,
                }
                const selected = selectedKeys.has(selectionKey(selection))
                return <article className={`vac-ref-picker-card material-card${selected ? ' selected' : ''}`} key={material.id}>
                  <button
                    className="vac-ref-picker-check"
                    type="button"
                    aria-label={`${selected ? '取消选择' : '选择'} ${material.name}`}
                    aria-pressed={selected}
                    onClick={() => toggle(selection)}
                  >{selected ? <Check /> : null}</button>
                  <button className="vac-ref-material-main" type="button" onClick={() => toggle(selection)}>
                    <MaterialArtwork material={material} />
                    <span><strong>{material.name}</strong><em>{material.size} · 已分析</em></span>
                  </button>
                </article>
              })}
            </div>
          </main>
        </div>

        <section className="vac-ref-picker-selected">
          <div className="vac-ref-picker-selection-summary">
            <strong>已选素材范围</strong>
            <span>{summary.materialCount} 个视频 · {summary.folderCount} 个文件夹 · 合并去重后约 {summary.candidateCount} 个候选视频</span>
          </div>
          <div className="vac-ref-picker-selection-list">
            {selections.map((selection) => <article key={selectionKey(selection)}>
              {selection.kind === 'folder' ? <Folder /> : <FileVideo2 />}
              <div>
                <strong>{selection.name}</strong>
                {selection.kind === 'folder' ? <button
                  className={selection.includeSubfolders ? 'active' : undefined}
                  type="button"
                  onClick={() => setSelections((current) => toggleReferenceSubfolders(current, selection.id))}
                ><span />包含子文件夹</button> : null}
              </div>
              <button type="button" aria-label={`移除 ${selection.name}`} onClick={() => toggle(selection)}><X /></button>
            </article>)}
          </div>
        </section>

        <footer className="vac-ref-picker-footer">
          <span>{confirmed ? '素材范围已确认。' : '确认后只会在这些素材中检索画面，不会搜索全局素材库。'}</span>
          <div>
            <button type="button" onClick={onClose}>取消</button>
            <button
              className="primary"
              type="button"
              disabled={!selections.length}
              onClick={() => {
                setConfirmed(true)
                onConfirm?.(selections)
              }}
            >确认选择（{selections.length}）</button>
          </div>
        </footer>
      </section>
    </div>
  </div>
}
