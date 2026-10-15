import { CheckCircle2, RefreshCw, Sparkles, Terminal } from 'lucide-react'
import { CloseButton } from '../components/common/CloseButton'
import { EmptyState } from '../components/common/EmptyState'
import { FileActionButton } from '../components/common/FileActionButton'
import { LogDrawer } from '../components/common/LogDrawer'
import { SelectField } from '../components/common/SelectField'
import { GeneratedMaterialCard } from './generate-material/GeneratedMaterialCard'
import { materialEngineOptions } from './generate-material/options'
import { useGenerateMaterial } from './generate-material/useGenerateMaterial'

export function GenerateMaterialPanel({ onClose }: { onClose: () => void }) {
  const material = useGenerateMaterial()

  return <div className="generate-material-panel">
    <div className="generate-material-panel-head">
      <div>
        <strong>生成素材</strong>
        <span>描述内容后生成可复用的视频素材</span>
      </div>
      <div className="button-row">
        <button className="button" onClick={material.refreshRecords}><RefreshCw className="button-icon" />刷新记录</button>
        <button className="button" onClick={() => material.setLogOpen(true)}><Terminal className="button-icon" />查看日志</button>
        <button className="button primary" onClick={material.generateMaterial} disabled={material.generating}><Sparkles className="button-icon" />{material.generating ? '处理中' : '智能创作'}</button>
        <CloseButton onClick={onClose} iconClassName="icon" />
      </div>
    </div>

    <div className="generate-material-surface">
      <section className="generate-material-form-card">
        <div className="generate-form-title">
          <Sparkles className="title-icon" />
          <div>
            <strong>描述你想生成的素材</strong>
            <span>先检索素材库，已有合适素材直接复用；没有命中时再选择动画引擎生成。</span>
          </div>
        </div>

        <textarea
          value={material.prompt}
          onChange={(event) => material.setPrompt(event.target.value)}
          placeholder="例如：生成一个 8 秒的工业机器人数据流动画，蓝绿色科技感，镜头从左向右推进，数据节点依次亮起"
        />

        <div className="generate-material-fields">
          <div className="clean-field compact-field">
            <label>引擎倾向</label>
            <SelectField value={material.engine} options={materialEngineOptions} onChange={material.handleEngineChange} />
          </div>
        </div>

        <div className="generate-material-tip">
          <span>默认优先复用已经完成分析的本地或云端素材。</span>
          <span>素材库未命中时自动选择引擎。</span>
          <span>需要指定时长、风格或节奏时，直接写进描述里。</span>
          <span>技术细节会进入后台校验和预渲染，不暴露给用户。</span>
        </div>

        {material.reusedMaterial ? <div className="generate-material-reuse-result">
          <CheckCircle2 />
          <span>
            <strong>已复用素材库内容</strong>
            <em>{material.reusedMaterial.name} · 匹配分数 {material.reusedMaterial.score.toFixed(3)}</em>
          </span>
          {material.reusedMaterial.localPath ? <FileActionButton
            className="button ghost"
            file={material.reusedMaterial.localPath}
            kind="play"
            label="打开素材"
          /> : null}
        </div> : null}
      </section>

      <section className="generate-material-records-card">
        <div className="generate-records-head">
          <div>
            <strong>生成记录</strong>
            <span>{material.records.length} 条</span>
          </div>
          {material.latestRecord ? <FileActionButton className="button ghost" file={material.latestRecord.record_dir} kind="folder" label="最新目录" /> : null}
        </div>

        <div className="generated-material-record-grid">
          {material.records.length === 0 ? <EmptyState title="暂无生成记录" description="生成成功后会在这里显示输出素材和生成记录。" /> : null}
          {material.records.map((record) => <GeneratedMaterialCard key={record.id} record={record} deleting={material.deletingIds.has(record.id)} onDelete={() => material.deleteGeneratedRecord(record)} />)}
        </div>
      </section>
    </div>

    <LogDrawer
      open={material.logOpen}
      title="生成素材日志"
      subtitle={material.generating ? '正在生成素材' : '生成素材任务日志'}
      log={material.log || '暂无日志'}
      onClose={() => material.setLogOpen(false)}
    />
  </div>
}
