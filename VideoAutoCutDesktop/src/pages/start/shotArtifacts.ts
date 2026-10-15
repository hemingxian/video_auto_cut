import type { RunArtifact, RunItem } from '../../types/videoauto'
import { shotText } from './shotPlan.ts'
import type { ShotDraft } from './types'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'])
const CANDIDATE_DIRS = new Set(['raw', '分镜视频'])
const CLIP_DIRS = new Set(['clips', 'final_clips'])

export type ShotMaterialRow = {
  shot: ShotDraft
  shotNo: number
  title: string
  timing: string
  downloadQuery: string
  visualQuery: string
  requirements: string
  candidateArtifacts: RunArtifact[]
  clipArtifacts: RunArtifact[]
}

export type ShotMaterialBoardModel = {
  boundShotCount: number
  rows: ShotMaterialRow[]
  unmatchedCandidates: RunArtifact[]
  unmatchedClips: RunArtifact[]
  candidateCount: number
  clipCount: number
}

function normalizeRelativePath(item: RunArtifact) {
  return (item.relativePath || item.name || '').replace(/\\/g, '/')
}

function fileExtension(item: RunArtifact) {
  const source = item.ext || item.name || item.path || item.relativePath || ''
  const match = source.toLowerCase().match(/\.[a-z0-9]+$/)
  return match?.[0] || ''
}

function isVideoArtifact(item: RunArtifact) {
  return VIDEO_EXTENSIONS.has(fileExtension(item))
}

function topLevelFolder(item: RunArtifact) {
  return normalizeRelativePath(item).split('/').filter(Boolean)[0]?.toLowerCase() || ''
}

function isCandidateArtifact(item: RunArtifact) {
  return CANDIDATE_DIRS.has(topLevelFolder(item)) && isVideoArtifact(item)
}

function isClipArtifact(item: RunArtifact) {
  return CLIP_DIRS.has(topLevelFolder(item)) && isVideoArtifact(item)
}

export function getShotNumber(shot: ShotDraft, index: number) {
  const value = typeof shot.shot === 'number' ? shot.shot : Number(shot.shot)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : index + 1
}

function shotTiming(shot: ShotDraft) {
  return shotText(shot.time_range) || (shot.duration ? `${shot.duration}s` : '')
}

function stripExtension(value: string) {
  return value.replace(/\.[^.]+$/, '')
}

function prefixedShotNumber(value: string) {
  const normalized = value.toLowerCase()
  const match = normalized.match(/(?:^|[_\-. #])(shot|scene|segment|clip|part|分镜|镜头)[_\-. #]*(\d{1,4})(?:$|[_\-. #])/u)
  return match ? Number(match[2]) : null
}

function leadingShotNumber(value: string) {
  const normalized = value.toLowerCase()
  const match = normalized.match(/^(\d{1,4})(?:$|[_\-. #])/u)
  return match ? Number(match[1]) : null
}

function artifactShotNumber(item: RunArtifact, validShotNumbers: Set<number>) {
  const segments = normalizeRelativePath(item).split('/').filter(Boolean).slice(1)
  const tokens = segments.length ? segments : [item.name]

  for (const token of tokens) {
    const candidates = [token, stripExtension(token)]
    for (const candidate of candidates) {
      const value = prefixedShotNumber(candidate) ?? leadingShotNumber(candidate)
      if (value && validShotNumbers.has(value)) return value
    }
  }

  return null
}

function sortArtifacts(items: RunArtifact[]) {
  return [...items].sort((a, b) => normalizeRelativePath(a).localeCompare(normalizeRelativePath(b), 'zh-CN'))
}

export function buildShotMaterialBoard(shots: ShotDraft[], run?: RunItem | null): ShotMaterialBoardModel {
  const rows = shots.map((shot, index): ShotMaterialRow => {
    const shotNo = getShotNumber(shot, index)
    return {
      shot,
      shotNo,
      title: shotText(shot.title) || `分镜 ${shotNo}`,
      timing: shotTiming(shot),
      downloadQuery: shotText(shot.download_query),
      visualQuery: shotText(shot.visual_query),
      requirements: shotText(shot.clip_requirements),
      candidateArtifacts: [],
      clipArtifacts: [],
    }
  })
  const rowByShotNo = new Map(rows.map((row) => [row.shotNo, row]))
  const rowByShotId = new Map(rows.map((row) => [row.shot.shot_id, row]))
  const validShotNumbers = new Set(rowByShotNo.keys())
  const unmatchedCandidates: RunArtifact[] = []
  const unmatchedClips: RunArtifact[] = []

  for (const item of run?.artifacts || []) {
    const isCandidate = isCandidateArtifact(item)
    const isClip = isClipArtifact(item)
    if (!isCandidate && !isClip) continue

    const shotNo = artifactShotNumber(item, validShotNumbers)
    const row = item.shotId ? rowByShotId.get(item.shotId) : shotNo ? rowByShotNo.get(shotNo) : null
    if (row) {
      if (isCandidate) row.candidateArtifacts.push(item)
      if (isClip) row.clipArtifacts.push(item)
      continue
    }

    if (isCandidate) unmatchedCandidates.push(item)
    if (isClip) unmatchedClips.push(item)
  }

  for (const row of rows) {
    row.candidateArtifacts = sortArtifacts(row.candidateArtifacts)
    row.clipArtifacts = sortArtifacts(row.clipArtifacts)
  }

  return {
    rows,
    boundShotCount: shots.filter((shot) => shot.material_bindings.length > 0).length,
    unmatchedCandidates: sortArtifacts(unmatchedCandidates),
    unmatchedClips: sortArtifacts(unmatchedClips),
    candidateCount: rows.reduce((count, row) => count + row.candidateArtifacts.length, unmatchedCandidates.length),
    clipCount: rows.reduce((count, row) => count + row.clipArtifacts.length, unmatchedClips.length),
  }
}
