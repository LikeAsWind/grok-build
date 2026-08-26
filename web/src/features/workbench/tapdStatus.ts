// TAPD 工作台里 status 字段的展示：每个 workspace 自定义状态机，所以服务端返回的
// 是字符串 + 数字代号的混合（"planning" / "status_10" / "status_13" 之类）。
// 这里做一层轻量映射：常见英文状态和官方文档里讲的数字代号给一个可读中文标签，
// 未识别的代号原样保留（不假装翻译——免得误传状态）。
//
// 真要全面映射得让用户给每个 workspace 配一组 status 名字表，这里只覆盖 workspace
// 69280376 实测到的几种，加上文档里讲到的状态_7/9/13/15 的高频别名。

import type { TFunction } from 'i18next'

const KNOWN_LABELS: Record<string, { zh: string; en: string }> = {
  planning: { zh: '规划中', en: 'Planning' },
  resolved: { zh: '已解决', en: 'Resolved' },
  rejected: { zh: '已拒绝', en: 'Rejected' },
  open: { zh: '打开', en: 'Open' },
  done: { zh: '已完成', en: 'Done' },
  closed: { zh: '已关闭', en: 'Closed' },
  // TAPD 默认状态机里的代号——workspace 69280376 实测会返回这些：
  status_7: { zh: '已规划', en: 'Planned' },
  status_9: { zh: '已发布', en: 'Released' },
  status_10: { zh: '已评估', en: 'Evaluated' },
  status_12: { zh: '设计中', en: 'Designing' },
  status_13: { zh: '待验收', en: 'Pending acceptance' },
  status_15: { zh: '已验收', en: 'Accepted' },
}

export function translateTapdStatus(raw: string, t: TFunction<'workbench'>): string {
  const known = KNOWN_LABELS[raw]
  if (known) return t('tapdStatus.' + raw, { defaultValue: known.zh })
  // 未识别的 status_NN：原样返回；这通常意味着 workspace 用了自定义状态代号，
  // UI 直接展示原始字符串比掩盖状态更安全。
  return raw
}