// ============================================
// Agent API Functions
// ACP 模式：grok 无独立 agent 列表（模型/模式在 Composer 单独切换），
// 返回空列表让 UI 隐藏 agent 选择器
// ============================================

import type { ApiAgent } from './types'

/**
 * 获取 agent 列表
 */
export async function getAgents(_directory?: string): Promise<ApiAgent[]> {
  return []
}

/**
 * 获取可选择的 agent 列表（过滤掉 hidden 的）
 */
export async function getSelectableAgents(directory?: string): Promise<ApiAgent[]> {
  const agents = await getAgents(directory)
  return agents.filter(agent => !agent.hidden)
}
