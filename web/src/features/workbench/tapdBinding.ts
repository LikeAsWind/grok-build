// 工作台绑定的纯函数：从 TAPD 链接解析 Workspace ID、按目录推导默认模块、
// 生成写入 config.toml 的 patch 路径。
//
// 后端对应逻辑在 crates/codegen/xai-grok-shell/src/tapd/disk_config_source.rs
// （default_module_for_directory / derived_binding）——两边保持同一套规则。

/**
 * 从 TAPD 链接里取 Workspace ID。TAPD 的各种链接形态里 workspace id 都是
 * 域名后的第一段纯数字：
 *   https://www.tapd.cn/tapd_fe/69280376/iteration/card/1169280376001008721?q=...
 *   https://www.tapd.cn/69280376/prong/stories/view/1169280376001008721
 * 直接传数字 id 也接受（用户可能只知道 id 而没有链接）。
 * 解析不出返回 null，调用方给出提示而不是写入脏值。
 */
export function parseWorkspaceIdFromTapdUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // 纯数字：本身就是 workspace id
  if (/^\d+$/.test(trimmed)) return trimmed

  // 取路径里第一段纯数字。tapd_fe 之类的前缀段不是数字，会被自动跳过；
  // 长条目 id（如 1169280376001008721）总是出现在 workspace id 之后，
  // 所以「第一段数字」就是 workspace id。
  const withoutQuery = trimmed.split(/[?#]/)[0]
  const afterHost = withoutQuery.replace(/^[a-z]+:\/\/[^/]+/i, '')
  for (const segment of afterHost.split('/')) {
    if (/^\d+$/.test(segment)) return segment
  }
  return null
}

/**
 * 目录名转小写作为默认模块筛选。与后端
 * `default_module_for_directory` 同规则：末尾分隔符忽略，盘根（`C:`）不算项目。
 */
export function defaultModuleForDirectory(directory: string): string | null {
  const segments = directory.split(/[/\\]/).filter(Boolean)
  const name = segments[segments.length - 1]
  if (!name || name.endsWith(':')) return null
  const lowered = name.toLowerCase()
  return lowered || null
}

/** 逗号分隔的模块输入 → 去空白去空项的数组 */
export function parseModuleFilter(input: string): string[] {
  return input
    .split(',')
    .map(m => m.trim())
    .filter(Boolean)
}

/**
 * `[tapd.projects.<slug>]` 的 key。同一目录必须稳定映射到同一个 slug，
 * 否则重复保存会在 config.toml 里堆出多份绑定。
 */
export function slugForDirectory(directory: string): string {
  const hash = Array.from(directory).reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 1_000_000_007, 7)
  const base =
    directory
      .split(/[/\\]/)
      .filter(Boolean)
      .pop() ?? 'project'
  return `${base.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${hash.toString(36)}`
}

export interface BindingPatchInput {
  directory: string
  workspaceId: string
  modules: string[]
}

/** 写一个目录绑定所需的 set 操作（供 patchGrokConfig 使用） */
export function buildBindingPatchOps({ directory, workspaceId, modules }: BindingPatchInput) {
  const slug = slugForDirectory(directory)
  return [
    { path: ['tapd', 'projects', slug, 'directory'], value: directory },
    { path: ['tapd', 'projects', slug, 'workspace_id'], value: workspaceId },
    { path: ['tapd', 'projects', slug, 'entity_types'], value: ['task'] },
    // 空数组也要写：用户清空模块筛选意味着"不筛选"，
    // 省略这一项会让旧值留在 config.toml 里继续生效
    { path: ['tapd', 'projects', slug, 'module_filter'], value: modules },
    { path: ['tapd', 'projects', slug, 'enabled'], value: true },
  ]
}
