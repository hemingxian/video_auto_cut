import {
  Boxes,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  List,
  MoreVertical,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'

import { MaterialArtwork } from './MaterialArtwork'
import { referenceFolders, referenceMaterials } from './fixtures'
import {
  filterReferenceMaterials,
  type ReferenceMaterial,
} from './model'
import { ReferenceSidebar } from './ReferenceChrome'

type LibraryFilter = 'all' | 'local' | 'cloud' | 'failed' | 'pending'

const filterOptions: Array<{ id: LibraryFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'local', label: '仅本地' },
  { id: 'cloud', label: '仅云端' },
  { id: 'failed', label: '同步失败' },
  { id: 'pending', label: '未分析' },
]

function statusLabel(material: ReferenceMaterial) {
  if (material.status === 'processing') return '分析中'
  if (material.status === 'failed') return '同步失败'
  return '已分析'
}

function storageLabel(material: ReferenceMaterial) {
  if (material.storage === 'cloud') return '仅云端'
  if (material.storage === 'both') return '本地和云端'
  return '仅本地'
}

export function MaterialLibraryReferencePage() {
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [filter, setFilter] = useState<LibraryFilter>('all')
  const [activeFolder, setActiveFolder] = useState('product')
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(['storage-front', 'product-close', 'product-speaker']),
  )
  const [focusedId, setFocusedId] = useState('storage-front')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [notice, setNotice] = useState('')

  const visibleMaterials = useMemo(() => {
    const source = activeFolder === 'all' || activeFolder === 'product'
      ? referenceMaterials
      : referenceMaterials.filter((material) => material.folderId === activeFolder)
    return filterReferenceMaterials(source, submittedQuery, filter)
  }, [activeFolder, filter, submittedQuery])
  const focused = referenceMaterials.find((material) => material.id === focusedId)
    || visibleMaterials[0]
    || referenceMaterials[0]

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const perform = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 1800)
  }

  return <div className="vac-ref-page vac-ref-library-page">
    <div className="vac-ref-library-shell">
      <ReferenceSidebar />
      <main className="vac-ref-library-main">
        <header className="vac-ref-library-header">
          <h1>素材库</h1>
          <div>
            <button type="button" onClick={() => {
              setQuery('')
              setSubmittedQuery('')
              setFilter('all')
              setSelected(new Set())
              perform('素材列表已刷新')
            }}><RefreshCw />刷新</button>
            <button type="button" onClick={() => perform('素材目录：本地素材库')}><FolderOpen />素材目录</button>
            <button type="button" onClick={() => perform('已创建新文件夹')}><FolderPlus />新建文件夹</button>
            <button className="primary" type="button" onClick={() => perform('请选择需要添加的视频文件')}><Upload />添加素材</button>
          </div>
        </header>

        <section className="vac-ref-library-toolbar">
          <button className="vac-ref-library-search-mode" type="button">文件名搜索<ChevronDown /></button>
          <label>
            <Search />
            <input
              value={query}
              placeholder="搜索素材名称或描述"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setSubmittedQuery(query)
              }}
            />
          </label>
          <button className="search-button" type="button" onClick={() => setSubmittedQuery(query)}>搜索</button>
          <div className="vac-ref-library-filters">
            {filterOptions.map((option) => <button
              className={filter === option.id ? 'active' : undefined}
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
            >{option.label}</button>)}
          </div>
          <div className="vac-ref-library-view">
            <button className={view === 'grid' ? 'active' : undefined} type="button" aria-label="网格视图" onClick={() => setView('grid')}><Grid2X2 /></button>
            <button className={view === 'list' ? 'active' : undefined} type="button" aria-label="列表视图" onClick={() => setView('list')}><List /></button>
          </div>
        </section>

        <section className="vac-ref-library-workspace">
          <aside className="vac-ref-library-folders">
            <header><strong>素材文件夹</strong><button type="button" aria-label="新建文件夹" onClick={() => perform('已创建新文件夹')}><FolderPlus /></button></header>
            <nav>
              {referenceFolders
                .filter((folder) => ['all', 'project', 'cloud', 'product', 'factory', 'interview'].includes(folder.id))
                .map((folder) => <button
                  className={activeFolder === folder.id ? 'active' : undefined}
                  key={folder.id}
                  type="button"
                  onClick={() => {
                    setActiveFolder(folder.id)
                    setSelected(new Set())
                  }}
                ><Folder /><span>{folder.name}</span><em>{folder.videoCount}</em></button>)}
            </nav>
          </aside>

          <section className="vac-ref-library-content">
            <header className="vac-ref-library-content-head">
              <div><span>本地素材</span><ChevronRight /><strong>{referenceFolders.find((folder) => folder.id === activeFolder)?.name || '全部素材'}</strong></div>
              <span>{visibleMaterials.length || 0} 个素材</span>
            </header>

            {selected.size ? <div className="vac-ref-library-batch">
              <span>已选择 <strong>{selected.size}</strong> 项</span>
              <div>
                <button type="button" onClick={() => perform('请选择目标文件夹')}><FolderInput />移动</button>
                <button type="button" onClick={() => perform('云端上传需要接入对象存储服务')}><CloudUpload />上传云端</button>
                <button className="danger" type="button" onClick={() => {
                  perform('演示页面不会删除真实素材')
                  setSelected(new Set())
                }}><Trash2 />删除</button>
                <button type="button" aria-label="取消选择" onClick={() => setSelected(new Set())}><X /></button>
              </div>
            </div> : null}

            <div className={`vac-ref-library-grid ${view === 'list' ? 'is-list' : ''}`}>
              {visibleMaterials.map((material) => {
                const isSelected = selected.has(material.id)
                return <article className={isSelected ? 'selected' : undefined} key={material.id}>
                  <button
                    className="vac-ref-library-check"
                    type="button"
                    aria-label={`${isSelected ? '取消选择' : '选择'} ${material.name}`}
                    aria-pressed={isSelected}
                    onClick={() => toggleSelected(material.id)}
                  >{isSelected ? '✓' : ''}</button>
                  <button className="vac-ref-library-card-main" type="button" onClick={() => setFocusedId(material.id)}>
                    <span className="vac-ref-library-thumb">
                      <MaterialArtwork material={material} />
                      <em>{material.duration}</em>
                    </span>
                    <strong>{material.name}</strong>
                  </button>
                  <div className="vac-ref-library-badges">
                    <span className={`status-${material.status}`}>{statusLabel(material)}</span>
                    <span className={`storage-${material.storage}`}>{storageLabel(material)}</span>
                    {material.visibility === 'public' ? <span>公开</span> : null}
                  </div>
                  <button className="vac-ref-library-more" type="button" aria-label={`更多操作 ${material.name}`}><MoreVertical /></button>
                </article>
              })}
            </div>

            <footer className="vac-ref-library-pagination">
              <nav>
                <button type="button" aria-label="上一页"><ChevronLeft /></button>
                <button className="active" type="button">1</button>
                <button type="button">2</button>
                <button type="button">3</button>
                <button type="button" aria-label="下一页"><ChevronRight /></button>
              </nav>
              <button type="button">每页 24 项<ChevronDown /></button>
            </footer>
          </section>

          <aside className="vac-ref-library-details">
            <header><strong>素材详情</strong><ChevronDown /></header>
            <div className="vac-ref-library-detail-body">
              <div className="vac-ref-library-player">
                <MaterialArtwork material={focused} />
                <div className="vac-ref-library-player-controls">
                  <Play /><span>00:00 / {focused.duration}</span><Volume2 />
                  <Boxes />
                </div>
              </div>
              <h2>{focused.name}</h2>
              <div className="vac-ref-library-detail-badges">
                <span className={`status-${focused.status}`}>{statusLabel(focused)}</span>
                <span className={`storage-${focused.storage}`}>{storageLabel(focused)}</span>
                <span>{focused.visibility === 'public' ? '公开' : '私有'}</span>
              </div>
              <dl>
                <div><dt>时长</dt><dd>{focused.duration}</dd></div>
                <div><dt>分辨率</dt><dd>{focused.resolution}</dd></div>
                <div><dt>大小</dt><dd>{focused.size}</dd></div>
                <div><dt>所在文件夹</dt><dd>{focused.folderName}</dd></div>
              </dl>
              <div className="vac-ref-library-detail-actions">
                <button type="button" onClick={() => perform(`打开视频：${focused.name}`)}><Play />打开视频</button>
                <button type="button"><MoreVertical />更多操作<ChevronDown /></button>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
    {notice ? <div className="vac-ref-notice" role="status">{notice}</div> : null}
  </div>
}
