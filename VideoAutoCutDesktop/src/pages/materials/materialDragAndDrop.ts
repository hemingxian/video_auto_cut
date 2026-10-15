import {
  draggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  createMaterialDragData,
  readMaterialDragData,
  type MaterialDragData,
} from './materialDragAndDropModel'

export function useMaterialDragSource({
  enabled,
  onDragStart,
  paths,
  sourceFolderId,
}: {
  enabled: boolean
  onDragStart?: () => void
  paths: string[]
  sourceFolderId: string
}) {
  const elementRef = useRef<HTMLElement | null>(null)
  const onDragStartRef = useRef(onDragStart)
  const [dragging, setDragging] = useState(false)
  const serializedPaths = paths.join('\u0000')
  const stablePaths = useMemo(
    () => serializedPaths.split('\u0000').filter(Boolean),
    [serializedPaths],
  )

  useEffect(() => {
    onDragStartRef.current = onDragStart
  }, [onDragStart])

  useEffect(() => {
    const element = elementRef.current
    if (!element || !enabled || !sourceFolderId || !stablePaths.length) return
    return draggable({
      element,
      getInitialData: () => createMaterialDragData(stablePaths, sourceFolderId),
      onDragStart: () => {
        setDragging(true)
        onDragStartRef.current?.()
      },
      onDrop: () => setDragging(false),
    })
  }, [enabled, sourceFolderId, stablePaths])

  return { elementRef, dragging }
}

export function useMaterialFolderDrop({
  destinationFolderId,
  enabled,
  onDrop,
}: {
  destinationFolderId: string
  enabled: boolean
  onDrop: (data: MaterialDragData) => unknown | Promise<unknown>
}) {
  const elementRef = useRef<HTMLElement | null>(null)
  const onDropRef = useRef(onDrop)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    onDropRef.current = onDrop
  }, [onDrop])

  useEffect(() => {
    const element = elementRef.current
    if (!element || !enabled) return
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => {
        const data = readMaterialDragData(source.data)
        return Boolean(data && data.sourceFolderId !== destinationFolderId)
      },
      getDropEffect: () => 'move',
      onDragEnter: () => setDragOver(true),
      onDragLeave: () => setDragOver(false),
      onDrop: ({ source }) => {
        setDragOver(false)
        const data = readMaterialDragData(source.data)
        if (data) void onDropRef.current(data)
      },
    })
  }, [destinationFolderId, enabled])

  return { dragOver, elementRef }
}
