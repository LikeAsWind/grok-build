import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listTapdTasks, type TapdTask, type TapdTaskListFilter } from '../../api/tapd'
import { WorkbenchTaskRow } from './WorkbenchTaskRow'
import { SearchIcon } from '../../components/Icons'

export interface WorkbenchTaskListProps {
  /** 未选工作目录时为 undefined —— 任务框仍渲染但不拉数据,显示"选个任务查看"占位 */
  directory?: string
  modules: string[]
  onOpenTask: (task: TapdTask) => void
  /** 递增以强制重新拉取（同步完成后由父组件驱动） */
  refreshToken: number
}

const QUEUE_STATES: TapdTask['queueState'][] = ['pending', 'processing', 'completed', 'failed']
const SORTS = ['modified_desc', 'modified_asc', 'created_desc', 'priority'] as const

export function WorkbenchTaskList({ directory, modules, onOpenTask, refreshToken }: WorkbenchTaskListProps) {
  const { t } = useTranslation('workbench')
  const [tasks, setTasks] = useState<TapdTask[]>([])
  const [loading, setLoading] = useState(false)
  const [queueState, setQueueState] = useState<string>('')
  const [module, setModule] = useState<string>('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<string>('modified_desc')

  useEffect(() => {
    // 未选工作目录:任务框保持空,不调 API
    if (!directory) {
      setTasks([])
      setLoading(false)
      return
    }
    const filter: TapdTaskListFilter = {
      queueState: queueState || undefined,
      module: module || undefined,
      search: search.trim() || undefined,
      sort,
    }
    setLoading(true)
    let cancelled = false
    listTapdTasks(directory, filter)
      .then(result => {
        if (!cancelled) setTasks(result)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directory, queueState, module, search, sort, refreshToken])

  const showFilters = Boolean(directory)

  return (
    <div className="flex flex-col gap-2 flex-1 min-h-0">
      {showFilters && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[160px]">
            <SearchIcon size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-500" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="w-full h-8 pl-8 pr-3 text-[length:var(--fs-sm)] rounded-md bg-bg-200/60 border border-transparent focus:border-accent-main-100/50 outline-none text-text-100 placeholder:text-text-500"
            />
          </div>

          <select
            value={queueState}
            onChange={e => setQueueState(e.target.value)}
            className="h-8 px-2 rounded-md bg-bg-200/60 text-[length:var(--fs-sm)] text-text-200 outline-none"
          >
            <option value="">{t('allStates')}</option>
            {QUEUE_STATES.map(s => (
              <option key={s} value={s}>
                {t(s)}
              </option>
            ))}
          </select>

          {modules.length > 0 && (
            <select
              value={module}
              onChange={e => setModule(e.target.value)}
              className="h-8 px-2 rounded-md bg-bg-200/60 text-[length:var(--fs-sm)] text-text-200 outline-none"
            >
              <option value="">{t('allModules')}</option>
              {modules.map(m => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}

          <select
            value={sort}
            onChange={e => setSort(e.target.value)}
            className="h-8 px-2 rounded-md bg-bg-200/60 text-[length:var(--fs-sm)] text-text-200 outline-none"
          >
            {SORTS.map(s => (
              <option key={s} value={s}>
                {t(`sort${s.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join('')}`)}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
        {!directory ? (
          // 任务框本身保持可见,空态提示"选个任务查看"
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="text-[length:var(--fs-sm)] text-text-300">{t('selectTaskToView')}</div>
            <div className="text-[length:var(--fs-xs)] text-text-500 mt-1">{t('selectTaskToViewHint')}</div>
          </div>
        ) : loading && tasks.length === 0 ? (
          <div className="flex items-center justify-center py-10">
            <span className="w-4 h-4 border-2 border-text-400/30 border-t-text-400 rounded-full animate-spin" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <div className="text-[length:var(--fs-sm)] text-text-300">{t('emptyTitle')}</div>
            <div className="text-[length:var(--fs-xs)] text-text-500 mt-1">{t('emptyDescriptionBound')}</div>
          </div>
        ) : (
          <div className="flex flex-col">
            {tasks.map(task => (
              <WorkbenchTaskRow key={task.id} task={task} onOpen={onOpenTask} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
