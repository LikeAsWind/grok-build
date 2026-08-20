// 目录选择器：最近目录列表 + 手动输入路径。被 NewSessionDialog 使用。

import { useMemo, useState } from 'react'
import { FolderIcon } from '../../components/Icons'
import { normalizeToForwardSlash } from '../../utils'

export interface DirectorySelectorProps {
  recentProjects: Record<string, number>
  selected: string
  onSelect: (path: string) => void
}

const MAX_RECENT = 5

export function DirectorySelector({ recentProjects, selected, onSelect }: DirectorySelectorProps) {
  const [manualPath, setManualPath] = useState('')

  const recents = useMemo(() => {
    return Object.entries(recentProjects)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_RECENT)
      .map(([path]) => path)
  }, [recentProjects])

  const handleManualSubmit = () => {
    const trimmed = manualPath.trim()
    if (!trimmed) return
    onSelect(normalizeToForwardSlash(trimmed))
  }

  return (
    <div className="space-y-2">
      <div className="text-[length:var(--fs-xs)] font-medium uppercase tracking-wider text-text-400">
        工作目录
      </div>

      {recents.length > 0 && (
        <div className="space-y-0.5">
          {recents.map(path => (
            <button
              key={path}
              type="button"
              data-selected={path === selected}
              onClick={() => onSelect(path)}
              className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left transition-colors ${
                path === selected
                  ? 'bg-accent-main-100/10 text-accent-main-100'
                  : 'text-text-200 hover:bg-bg-200/60'
              }`}
            >
              <FolderIcon size={14} className="shrink-0 text-text-400" />
              <span className="truncate text-[length:var(--fs-sm)] font-mono">{path}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={manualPath}
          onChange={e => setManualPath(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') handleManualSubmit()
          }}
          placeholder="手动输入路径，回车确认"
          spellCheck={false}
          className="flex-1 h-8 px-2.5 text-[length:var(--fs-sm)] font-mono rounded-md bg-transparent text-text-100 border border-border-200 outline-none focus:border-accent-main-100"
        />
        <button
          type="button"
          onClick={handleManualSubmit}
          className="h-8 px-2.5 rounded-md text-[length:var(--fs-sm)] text-text-300 hover:text-text-100 hover:bg-bg-200/60 transition-colors"
        >
          确认
        </button>
      </div>
    </div>
  )
}