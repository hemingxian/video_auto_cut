import { Check, Film, Flag, Globe2, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { CloseButton } from '../../components/common/CloseButton'
import { formatSize } from '../../lib/format'
import type { PublicMaterialItem } from '../../types/videoauto-api'

export function PublicMaterialDialog({
  folderId,
  folderName,
  onAdded,
  onClose,
}: {
  folderId?: string
  folderName: string
  onAdded: () => Promise<void>
  onClose: () => void
}) {
  const [keyword, setKeyword] = useState('')
  const [items, setItems] = useState<PublicMaterialItem[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set())
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set())
  const [reported, setReported] = useState<ReadonlySet<string>>(new Set())
  const [reportTarget, setReportTarget] = useState<PublicMaterialItem | null>(null)
  const [reportCategory, setReportCategory] = useState<'copyright' | 'privacy' | 'harmful' | 'other'>('copyright')
  const [reportDescription, setReportDescription] = useState('')
  const [reportMessage, setReportMessage] = useState('')
  const [reporting, setReporting] = useState(false)

  async function load(searchKeyword = keyword) {
    setLoading(true)
    setMessage('')
    try {
      const result = await window.videoAutoCut.listPublicMaterials({
        keyword: searchKeyword.trim(),
        limit: 50,
      })
      if (!result.ok) {
        setItems([])
        setMessage(result.message || '读取公共素材失败。')
        return
      }
      setItems(result.items)
      if (!result.items.length) setMessage('没有找到匹配的公共素材。')
    } catch (error) {
      console.error('[VideoAutoCut] list public materials failed', error)
      setItems([])
      setMessage('读取公共素材失败，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load('')
  }, [])

  useEffect(() => {
    const closeFromKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || adding.size || reporting) return
      if (reportTarget) setReportTarget(null)
      else onClose()
    }
    window.addEventListener('keydown', closeFromKey)
    return () => window.removeEventListener('keydown', closeFromKey)
  }, [adding.size, onClose, reporting, reportTarget])

  async function add(item: PublicMaterialItem) {
    if (!folderId || adding.has(item.publication_id) || added.has(item.publication_id)) return
    setAdding((current) => new Set(current).add(item.publication_id))
    try {
      const result = await window.videoAutoCut.addPublicMaterial({
        publicationId: item.publication_id,
        folderId,
      })
      if (!result.ok) {
        window.alert(result.message || '添加公共素材失败。')
        return
      }
      setAdded((current) => new Set(current).add(item.publication_id))
      await onAdded()
    } finally {
      setAdding((current) => {
        const next = new Set(current)
        next.delete(item.publication_id)
        return next
      })
    }
  }

  function openReport(item: PublicMaterialItem) {
    setReportTarget(item)
    setReportCategory('copyright')
    setReportDescription('')
    setReportMessage('')
  }

  async function submitReport() {
    if (!reportTarget || reporting) return
    const description = reportDescription.trim()
    if (description.length < 10) {
      setReportMessage('请至少填写 10 个字符，说明具体问题。')
      return
    }
    setReporting(true)
    setReportMessage('')
    try {
      const result = await window.videoAutoCut.reportPublicMaterial({
        publicationId: reportTarget.publication_id,
        category: reportCategory,
        description,
      })
      if (!result.ok) {
        setReportMessage(result.message || '提交举报失败，请稍后重试。')
        return
      }
      setReported((current) => new Set(current).add(reportTarget.publication_id))
      setItems((current) => current.map((item) => item.publication_id === reportTarget.publication_id
        ? { ...item, report_status: result.status || 'pending' }
        : item))
      setReportTarget(null)
    } catch (error) {
      console.error('[VideoAutoCut] report public material failed', error)
      setReportMessage('提交举报失败，请稍后重试。')
    } finally {
      setReporting(false)
    }
  }

  return createPortal(<div
    className="setup-overlay material-public-overlay"
    onMouseDown={(event) => {
      if (event.target === event.currentTarget && !adding.size && !reporting && !reportTarget) onClose()
    }}
  >
    <section className="setup-dialog material-public-dialog" role="dialog" aria-modal="true" aria-label="公共素材">
      <div className="setup-head">
        <div>
          <Globe2 className="title-icon" />
          <span><strong>公共素材</strong><em>审核通过的共享素材</em></span>
        </div>
        <CloseButton disabled={Boolean(adding.size) || reporting} onClick={onClose} iconClassName="icon" />
      </div>

      <div className="material-public-search">
        <Search />
        <input
          autoFocus
          value={keyword}
          placeholder="搜索公共素材名称"
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void load() }}
        />
        <button className="button primary" type="button" disabled={loading} onClick={() => void load()}>
          {loading ? '搜索中' : '搜索'}
        </button>
      </div>

      <div className="setup-body material-public-body">
        {!folderId ? <div className="material-public-notice">请先进入“本地素材”或其子文件夹，再添加公共素材。</div> : null}
        {reportTarget ? <section className="material-public-report-panel" aria-label="举报公共素材">
          <div className="material-public-report-head">
            <span><Flag />举报素材</span>
            <strong title={reportTarget.display_name}>{reportTarget.display_name}</strong>
          </div>
          <div className="material-public-report-fields">
            <label>
              <span>问题类型</span>
              <select
                value={reportCategory}
                disabled={reporting}
                onChange={(event) => setReportCategory(event.target.value as typeof reportCategory)}
              >
                <option value="copyright">版权侵权</option>
                <option value="privacy">隐私信息</option>
                <option value="harmful">违法或有害内容</option>
                <option value="other">其他问题</option>
              </select>
            </label>
            <label>
              <span>问题说明</span>
              <textarea
                autoFocus
                value={reportDescription}
                disabled={reporting}
                maxLength={2000}
                placeholder="请说明具体问题和判断依据（至少 10 个字符）"
                onChange={(event) => setReportDescription(event.target.value)}
              />
            </label>
          </div>
          <div className="material-public-report-actions">
            <span className={reportMessage ? 'error' : ''}>{reportMessage || `${reportDescription.trim().length}/2000`}</span>
            <button className="button" type="button" disabled={reporting} onClick={() => setReportTarget(null)}>取消</button>
            <button className="button primary" type="button" disabled={reporting} onClick={() => void submitReport()}>
              {reporting ? '提交中' : '提交举报'}
            </button>
          </div>
        </section> : null}
        {loading ? <div className="loading-line">正在读取公共素材...</div> : null}
        {!loading && message ? <div className="material-public-empty">{message}</div> : null}
        {!loading && items.length ? <div className="material-public-grid">
          {items.map((item) => {
            const isAdding = adding.has(item.publication_id)
            const isAdded = added.has(item.publication_id)
            const isReported = reported.has(item.publication_id) || Boolean(item.report_status)
            return <article key={item.publication_id} className="material-public-card">
              <div className="material-public-thumbnail"><Film /></div>
              <div className="material-public-card-copy">
                <strong title={item.display_name}>{item.display_name}</strong>
                <span>{formatSize(item.file_size_bytes)} · {item.analysis_status === 'ready' ? '已分析' : '待分析'}</span>
              </div>
              <div className="material-public-card-actions">
                {item.can_report ? <button
                  className="button material-public-report-button"
                  type="button"
                  disabled={isReported || reporting}
                  onClick={() => openReport(item)}
                >
                  {isReported ? <><Check className="button-icon" />已举报</> : <><Flag className="button-icon" />举报</>}
                </button> : null}
                <button
                  className="button"
                  type="button"
                  disabled={!folderId || isAdding || isAdded}
                  onClick={() => void add(item)}
                >
                  {isAdded ? <><Check className="button-icon" />已添加</> : <><Plus className="button-icon" />{isAdding ? '添加中' : '添加'}</>}
                </button>
              </div>
            </article>
          })}
        </div> : null}
      </div>

      <div className="setup-footer material-public-footer">
        <span>添加到：{folderId ? folderName : '请选择可写文件夹'}</span>
        <button className="button" type="button" disabled={Boolean(adding.size) || reporting} onClick={onClose}>关闭</button>
      </div>
    </section>
  </div>, document.body)
}
