// 文件夹视图单个项目分组：ProjectGroupHeader + 展开时的会话列表。
// diff 统计（diffStatsMap）按 session.id 查表后传给 SessionListItem 渲染。

import { ProjectGroupHeader } from './ProjectGroupHeader'
import { SessionListItem } from './SessionListItem'
import type { SessionUiStatus } from './status'
import type { SessionDiffStats } from './useResidentSessionDiffStats'
import type { ApiSession } from '../../api'

export interface ProjectGroupProps {
  directory: string
  sessions: ApiSession[]
  isExpanded: boolean
  diffStatsMap: Map<string, SessionDiffStats>
  onToggleExpand: () => void
  selectedSessionId?: string | null
  uiStatusMap?: Map<string, SessionUiStatus>
  onSelect?: (session: ApiSession) => void
  onRename?: (sessionId: string, title: string) => Promise<void>
  onDelete?: (sessionId: string) => Promise<void>
  /** 顶层会话 id → 子会话列表；子会话紧跟其父渲染，缩进显示 */
  childrenByParent?: Map<string, ApiSession[]>
}

const noopSelect = () => {}
const noopRename = async () => {}
const noopDelete = async () => {}

export function ProjectGroup({
  directory,
  sessions,
  isExpanded,
  diffStatsMap,
  onToggleExpand,
  selectedSessionId = null,
  uiStatusMap,
  onSelect = noopSelect,
  onRename = noopRename,
  onDelete = noopDelete,
  childrenByParent,
}: ProjectGroupProps) {
  const renderItem = (session: ApiSession, indent = false) => (
    <SessionListItem
      key={session.id}
      session={session}
      isSelected={session.id === selectedSessionId}
      uiStatus={uiStatusMap?.get(session.id) ?? { kind: 'idle' }}
      onSelect={onSelect}
      onRename={onRename}
      onDelete={onDelete}
      indent={indent}
      diffStats={diffStatsMap.get(session.id) ?? null}
    />
  )

  return (
    <div className="project-group">
      <ProjectGroupHeader
        directory={directory}
        sessions={sessions}
        isExpanded={isExpanded}
        onToggle={onToggleExpand}
      />

      {isExpanded && (
        <div className="space-y-0.5 pl-2">
          {sessions.map(session => {
            const children = childrenByParent?.get(session.id)
            if (!children?.length) return renderItem(session)
            return (
              <div key={session.id} className="space-y-0.5">
                {renderItem(session)}
                {children.map(child => renderItem(child, true))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
