// 任务队列状态 → 徽章外观的纯映射函数。延续 sessions-hub/status.ts 的设计
// 语言（颜色圆点 + 文案），但描述的是"这条数据从拉取到落库"这条流水线自身
// 的状态，不代表 AI 已经处理了这个 TAPD 任务本身。

import type { TapdTask } from '../../api/tapd'

export interface QueueStateBadge {
  dot: string
  labelKey: 'pending' | 'processing' | 'completed' | 'failed'
}

export function queueStateBadge(queueState: TapdTask['queueState']): QueueStateBadge {
  switch (queueState) {
    case 'processing':
      return { dot: 'bg-blue-500', labelKey: 'processing' }
    case 'completed':
      return { dot: 'bg-emerald-500', labelKey: 'completed' }
    case 'failed':
      return { dot: 'bg-danger-100', labelKey: 'failed' }
    default:
      return { dot: 'bg-text-500', labelKey: 'pending' }
  }
}
