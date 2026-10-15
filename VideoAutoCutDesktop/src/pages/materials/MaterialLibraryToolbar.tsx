import { LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import { Check, ChevronDown, CloudUpload, Grid2X2, List, X } from 'lucide-react'
import * as Select from 'radix-ui/select'
import * as ToggleGroup from 'radix-ui/toggle-group'

import { searchModeOptions } from './constants'
import {
  materialFilterOptions,
  type MaterialLibraryFilterCounts,
  type MaterialLibraryFilter,
  type MaterialLibraryViewMode,
} from './materialLibraryUiModel'
import type { SearchMode } from './types'
import { measureMaterialUiResponse } from './materialUiPerformance'

export function MaterialLibraryToolbar({
  activeFilter,
  autoSyncEnabled,
  autoSyncSaving,
  busy,
  folderSearchActive,
  filterCounts,
  onClearSearch,
  onAutoSyncChange,
  onFilterChange,
  onSearchModeChange,
  onSearchTextChange,
  onSubmitSearch,
  onViewModeChange,
  searchMode,
  searchText,
  viewMode,
}: {
  activeFilter: MaterialLibraryFilter
  autoSyncEnabled: boolean
  autoSyncSaving: boolean
  busy: boolean
  folderSearchActive: boolean
  filterCounts: MaterialLibraryFilterCounts
  onClearSearch: () => void
  onAutoSyncChange: (enabled: boolean) => void
  onFilterChange: (filter: MaterialLibraryFilter) => void
  onSearchModeChange: (mode: SearchMode) => void
  onSearchTextChange: (value: string) => void
  onSubmitSearch: () => void
  onViewModeChange: (mode: MaterialLibraryViewMode) => void
  searchMode: SearchMode
  searchText: string
  viewMode: MaterialLibraryViewMode
}) {
  const hasSearch = Boolean(searchText || folderSearchActive)
  const reduceMotion = useReducedMotion()
  return <div className="material-library-toolbar">
    <div className="material-library-search-row">
      <div className="material-library-search-mode">
        <Select.Root value={searchMode} onValueChange={(value) => onSearchModeChange(value as SearchMode)}>
          <Select.Trigger className="material-library-select-trigger" aria-label="搜索方式">
            <Select.Value />
            <Select.Icon><ChevronDown /></Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              className="material-library-select-content"
              position="popper"
              sideOffset={7}
            >
              <Select.Viewport>
                {searchModeOptions.map((option) => <Select.Item
                  className="material-library-select-item"
                  key={option.value}
                  value={option.value}
                >
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator><Check /></Select.ItemIndicator>
                </Select.Item>)}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </div>
      <div className="material-library-search-input">
        <input
          value={searchText}
          onChange={(event) => onSearchTextChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') onSubmitSearch() }}
          placeholder={searchMode === 'semantic'
            ? '描述画面内容，例如：工业机器人在工厂工作'
            : '搜索素材名称或描述'}
        />
        {hasSearch ? <button
          className="material-library-search-clear"
          type="button"
          aria-label="清除搜索"
          onClick={onClearSearch}
        ><X /></button> : null}
      </div>
      <button
        className="button primary material-library-search-button"
        type="button"
        onClick={onSubmitSearch}
        disabled={!searchText.trim() || busy}
      >
        {busy ? '搜索中' : '搜索'}
      </button>
    </div>

    <div className="material-library-filter-row">
      <LayoutGroup id="material-library-filter">
        <ToggleGroup.Root
          className="material-library-filter-tabs"
          aria-label="素材筛选"
          type="single"
          value={activeFilter}
          onValueChange={(value) => {
            if (value) {
              measureMaterialUiResponse('filter', () => onFilterChange(value as MaterialLibraryFilter))
            }
          }}
        >
          {materialFilterOptions.map((option) => {
            const active = activeFilter === option.value
            const count = filterCounts[option.value]
            const showBadge = count > 0 && (option.value === 'sync_failed' || option.value === 'pending')
            const badgeLabel = count > 99 ? '99+' : String(count)
            return <ToggleGroup.Item
              aria-label={showBadge ? `${option.label} ${count}` : option.label}
              className="material-library-filter-tab"
              data-tone={option.value === 'sync_failed'
                ? 'danger'
                : option.value === 'pending' ? 'warning' : undefined}
              key={option.value}
              value={option.value}
              disabled={searchMode === 'semantic'}
            >
              {active ? <motion.span
                aria-hidden="true"
                className="material-library-filter-indicator"
                layoutId="active"
                transition={reduceMotion
                  ? { duration: 0 }
                  : { type: 'spring', stiffness: 480, damping: 38, mass: 0.72 }}
              /> : null}
              <span className="material-library-filter-label">{option.label}</span>
              {showBadge ? <span
                aria-hidden="true"
                className="material-library-filter-badge"
              >{badgeLabel}</span> : null}
            </ToggleGroup.Item>
          })}
        </ToggleGroup.Root>
      </LayoutGroup>
      <div className="material-library-filter-actions">
        <div
          className="material-library-auto-sync"
          title={autoSyncEnabled
            ? '新导入的本地素材将自动同步到云端'
            : '新导入的本地素材只保存在本机'}
        >
          <CloudUpload aria-hidden="true" />
          <span>自动同步云端</span>
          <button
            aria-checked={autoSyncEnabled}
            aria-label="自动同步到云端"
            className={autoSyncEnabled ? 'is-on' : ''}
            disabled={autoSyncSaving}
            role="switch"
            type="button"
            onClick={() => onAutoSyncChange(!autoSyncEnabled)}
          ><i /></button>
        </div>
        <ToggleGroup.Root
          className="material-library-view-switch"
          aria-label="视图方式"
          type="single"
          value={viewMode}
          onValueChange={(value) => {
            if (value) {
              measureMaterialUiResponse('view-mode', () => onViewModeChange(value as MaterialLibraryViewMode))
            }
          }}
        >
          <ToggleGroup.Item
            value="grid"
            aria-label="网格视图"
          ><Grid2X2 /></ToggleGroup.Item>
          <ToggleGroup.Item
            value="list"
            aria-label="列表视图"
          ><List /></ToggleGroup.Item>
        </ToggleGroup.Root>
      </div>
    </div>
  </div>
}
