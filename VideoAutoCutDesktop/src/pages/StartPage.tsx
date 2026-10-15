import { useMemo, useState } from 'react'
import { Boxes, Edit3, FileJson, FileText, Film, ListChecks, Pause, Play, RefreshCw, Terminal } from 'lucide-react'
import { FileActionButton } from '../components/common/FileActionButton'
import { LogDrawer } from '../components/common/LogDrawer'
import { PageLayout } from '../components/common/PageLayout'
import { Panel } from '../components/common/Panel'
import { StatusPill } from '../components/common/StatusPill'
import { buildShotMaterialBoard } from './start/shotArtifacts'
import { MaterialSettingsDialog } from './start/MaterialSettingsDialog'
import { MaterialSourceModeSelect } from './start/MaterialSourceModeSelect'
import { ShotMaterialBoard } from './start/ShotMaterialBoard'
import { ShotEditorDrawer } from './start/ShotEditorDrawer'
import { ScriptFilesDialog } from './start/ScriptFilesDialog'
import { shotText } from './start/shotPlan'
import { TaskQueuePopover } from './start/TaskQueuePopover'
import { TaskResultToast } from './start/TaskResultToast'
import type { StartTaskController } from './start/useStartTaskController'
import { WorkflowProgress } from './start/WorkflowProgress'

function hasAnyShotText(shots: StartTaskController['shots'], keys: string[]) {
  return shots.some((shot) => keys.some((key) => shotText(shot[key]).trim()))
}

function shotHasVoiceContent(shot: StartTaskController['shots'][number]) {
  if (shot.voiceover === false) return false
  return Boolean(shotText(shot.voice_text).trim())
}

export function StartPage({ task }: { task: StartTaskController }) {
  const [scriptFilesOpen, setScriptFilesOpen] = useState(false)
  const [materialSettingsOpen, setMaterialSettingsOpen] = useState(false)
  const statusRunning = task.viewRunning
  const materialBoard = useMemo(
    () => buildShotMaterialBoard(task.shots, task.currentRun),
    [task.currentRun, task.shots],
  )
  const workflowContent = useMemo(() => ({
    hasVoiceContent: task.shots.some(shotHasVoiceContent),
    hasProgressBarContent: hasAnyShotText(task.shots, ['progress_text', 'highlight_rule']),
  }), [task.shots])

  return <PageLayout
    className="start-page"
    title="开始任务"
    action={<div className="button-row">
      <button className="button" onClick={() => setScriptFilesOpen(true)}><FileText className="button-icon" />脚本文件</button>
      <MaterialSourceModeSelect
        value={task.materialSourceMode}
        disabled={task.materialStrategyDisabled}
        onChange={task.setMaterialSourceMode}
      />
      <button className="button" onClick={() => setMaterialSettingsOpen(true)}><Boxes className="button-icon" />素材设置</button>
      <button className="button" onClick={() => task.setLogOpen(true)}><Terminal className="button-icon" />查看日志</button>
      <button className="button" onClick={() => task.hasPendingVoiceScript ? setScriptFilesOpen(true) : void task.analyzeShots()} disabled={!task.hasScript}><FileJson className="button-icon" />{task.scriptCount > 1 ? '批量预览分镜' : '预览分镜'}</button>
      {task.hasVisiblePlan ? <button className="button" onClick={task.regenerateAll} disabled={task.materialStrategyDisabled} title="创建新运行，保留原有结果">重新生成全部</button> : null}
      <button className="button primary" onClick={() => task.hasPendingVoiceScript ? setScriptFilesOpen(true) : void task.generateVideo()} disabled={!task.canGenerate}><Play className="button-icon" />{task.generateButtonText}</button>
    </div>}
  >
    <div className="start-task-queue-slot">
      <TaskQueuePopover
        items={task.queueItems}
        selectedId={task.selectedQueueId}
        running={task.running}
        onSelect={task.selectQueueItem}
        onStop={task.pauseCurrentTask}
        paused={task.queuePaused}
        onPauseAll={task.pauseQueue}
        onContinue={task.continueQueue}
        onResume={task.resumeQueueItem}
        onRemove={task.removeQueueItem}
      />
    </div>
    <TaskResultToast message={task.toast} tone={task.toastTone} />
    <div className="content-grid start-grid">
      <Panel className="workflow-panel">
        <div className="panel-title spread">
          <span><ListChecks className="title-icon" />当前流程</span>
          <div className="button-row" role="group" aria-label="任务执行控制">
            <button className="button" type="button" disabled={!task.running || task.queuePaused} onClick={task.pauseCurrentTask}>
              <Pause className="button-icon" />暂停当前
            </button>
          </div>
        </div>
        <WorkflowProgress
          running={task.viewRunning}
          taskStage={task.taskStage}
          materialMode={task.materialMode}
          hasVisiblePlan={task.hasVisiblePlan}
          dirty={task.dirty}
          workflowStage={task.workflowStage}
          workflowPlan={task.workflowPlan}
          workflowProgress={task.workflowProgress}
          workflowFailed={task.workflowFailed}
          hasVoiceContent={workflowContent.hasVoiceContent}
          hasProgressBarContent={workflowContent.hasProgressBarContent}
          activeTaskLabel={task.activeTaskLabel}
          currentRun={task.currentRun}
          materialBoard={materialBoard}
        />
      </Panel>

      <Panel className="shot-workspace-panel">
        <div className="panel-title spread">
          <span><Film className="title-icon" />分镜工作区</span>
          <span className="button-row">
            <StatusPill running={statusRunning} label={task.taskStatusLabel} />
            {task.dirty ? <span className="shots-dirty-badge">未保存</span> : null}
            <button className="text-button" onClick={() => task.setShotDrawerOpen(true)} disabled={!task.shots.length}><Edit3 className="button-icon" />编辑分镜</button>
            <button className="text-button" onClick={() => task.refreshShotsPreview()} disabled={!task.currentRun}><RefreshCw className="button-icon" />刷新</button>
            {task.currentRun?.path ? <FileActionButton className="text-button" file={task.currentRun.path} kind="folder" label="目录" /> : null}
            {task.currentRun?.finalVideo ? <FileActionButton className="text-button" file={task.currentRun.finalVideo} kind="play" label="播放成片" /> : null}
          </span>
        </div>
        {task.currentRun || task.shotTopic ? <div className="shot-context-line">
          {task.currentRun ? <span>当前任务：{task.selectedTaskLabel || task.currentRun.projectName || task.currentRun.id}</span> : null}
          {task.shotTopic ? <span>{task.shotTopic}</span> : null}
        </div> : null}
        <ShotMaterialBoard
          key={task.currentRun?.id || 'empty'}
          board={materialBoard}
          materialMode={task.materialMode}
          message={task.shotsMessage}
        />
      </Panel>
    </div>
    <ScriptFilesDialog
      open={scriptFilesOpen}
      scripts={task.scripts}
      aspectRatio={task.aspectRatio}
      outputResolution={task.outputResolution}
      onAspectRatioChange={task.setAspectRatio}
      onOutputResolutionChange={task.setOutputResolution}
      materialSelections={task.scriptMaterialSelections}
      voiceScriptModes={task.voiceScriptModes}
      voiceScriptBodyPaths={task.voiceScriptBodyPaths}
      voiceScriptTaskIds={task.voiceScriptTaskIds}
      onVoiceScriptChange={task.updateVoiceScript}
      allowMaterialBindings={!task.manualMaterialSelectionDisabled}
      onMaterialsChange={task.updateScriptMaterials}
      onClose={() => setScriptFilesOpen(false)}
      onChooseScripts={task.chooseScriptFiles}
      onScriptsChange={task.updateScriptPaths}
      onImportAndPlan={(preparedBodyPaths) => {
        setScriptFilesOpen(false)
        void task.analyzeShots(preparedBodyPaths)
      }}
      onImportAndGenerate={(preparedBodyPaths) => {
        setScriptFilesOpen(false)
        task.generateImportedScripts(preparedBodyPaths)
      }}
    />
    <MaterialSettingsDialog
      open={materialSettingsOpen}
      source={task.source}
      onClose={() => setMaterialSettingsOpen(false)}
      onSourceChange={task.setSource}
    />
    <ShotEditorDrawer
      open={task.shotDrawerOpen}
      topic={task.shotTopic}
      shots={task.shots}
      planRoot={task.planRoot}
      allowMaterialBindings={!task.manualMaterialSelectionDisabled}
      dirty={task.dirty}
      draftSaveStatus={task.draftSaveStatus}
      draftSavedAt={task.draftSavedAt}
      currentRun={task.currentRun}
      message={task.shotsMessage}
      onClose={() => task.setShotDrawerOpen(false)}
      onSave={() => task.saveShots()}
      onRefresh={task.refreshShotsPreview}
      onTopicChange={task.updateTopic}
      onShotChange={task.updateShotField}
      onShotMetaChange={task.updateShotMetaField}
      onConfirmReview={task.confirmShotFields}
      onAcknowledgeWarning={task.acknowledgeShotReviewWarning}
      onRestoreField={task.restoreShotField}
      onShotMaterialsChange={task.updateShotMaterials}
    />
    <LogDrawer
      open={task.logOpen}
      title="实时日志"
      subtitle={task.selectedTaskLabel || task.currentRun?.id || '开始任务'}
      log={task.logs.join('') || '暂无日志'}
      filePath={task.currentRun?.logPath}
      onClose={() => task.setLogOpen(false)}
    />
  </PageLayout>
}
