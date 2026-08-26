// 工作台项目选择器：在已知项目目录之间切换工作台视角。
// 候选目录来自会话列表（前端已有的数据）+ 当前目录，去重后按目录名展示——
// 后端没有"项目"实体，工作台就是"某个目录的 TAPD 视图"。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDownIcon, FolderIcon } from '../../components/Icons'
import { getDirectoryName } from '../../utils'

export interface WorkbenchProjectSelectorProps {
  /** 当前工作台展示的目录 */
  directory: string
  /** 可切换的候选目录（含当前目录；调用方负责去重排序） */
  candidates: string[]
  onSelect: (directory: string) => void
}

export function WorkbenchProjectSelector({ directory, candidates, onSelect }: WorkbenchProjectSelectorProps) {
  const { t } = useTranslation('workbench')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点外部关闭：下拉是绝对定位浮层，不关会一直盖住下方任务列表
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const items = useMemo(() => {
    return candidates.map(dir => ({ dir, name: getDirectoryName(dir) || dir }))
  }, [candidates])

  const currentName = getDirectoryName(directory) || directory
  // 只有一个候选时没有可切换的对象，退化成纯标题（不给假的下拉）
  const switchable = items.length > 1

  if (!switchable) {
    return <h2 className="text-[length:var(--fs-heading-2)] font-semibold text-text-100 truncate">{currentName}</h2>
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t('switchProject')}
        className="flex items-center gap-1.5 min-w-0 rounded-md px-1 -mx-1 hover:bg-bg-200/60 transition-colors"
      >
        <h2 className="text-[length:var(--fs-heading-2)] font-semibold text-text-100 truncate">{currentName}</h2>
        <span className="shrink-0 text-text-400">
          <ChevronDownIcon size={14} />
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full mt-1 z-30 min-w-[240px] max-w-[420px] max-h-72 overflow-y-auto custom-scrollbar rounded-lg border border-border-200/60 bg-bg-100 shadow-sm p-1"
        >
          {items.map(item => {
            const active = item.dir === directory
            return (
              <button
                key={item.dir}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onSelect(item.dir)
                  setOpen(false)
                }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors ${
                  active ? 'text-accent-main-100 bg-accent-main-100/10' : 'text-text-200 hover:text-text-100 hover:bg-bg-200/50'
                }`}
              >
                <span className="shrink-0 text-text-400">
                  <FolderIcon size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[length:var(--fs-sm)] truncate">{item.name}</span>
                  <span className="block text-[length:var(--fs-xxs)] text-text-500 truncate font-mono">{item.dir}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
