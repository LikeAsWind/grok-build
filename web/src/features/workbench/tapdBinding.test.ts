import { describe, expect, it } from 'vitest'
import {
  buildBindingPatchOps,
  defaultModuleForDirectory,
  parseModuleFilter,
  parseWorkspaceIdFromTapdUrl,
  slugForDirectory,
} from './tapdBinding'

describe('parseWorkspaceIdFromTapdUrl', () => {
  it('从 tapd_fe 迭代卡片链接里解析（跳过非数字前缀段，长条目 id 不误取）', () => {
    expect(
      parseWorkspaceIdFromTapdUrl(
        'https://www.tapd.cn/tapd_fe/69280376/iteration/card/1169280376001008721?q=ac382c1266a394907ab6a97cfe83a17c',
      ),
    ).toBe('69280376')
  })

  it('从经典 prong 链接里解析', () => {
    expect(parseWorkspaceIdFromTapdUrl('https://www.tapd.cn/69280376/prong/stories/view/1169280376001008721')).toBe(
      '69280376',
    )
  })

  it('直接给数字 id 也接受', () => {
    expect(parseWorkspaceIdFromTapdUrl('69280376')).toBe('69280376')
    expect(parseWorkspaceIdFromTapdUrl('  69280376  ')).toBe('69280376')
  })

  it('解析不出时返回 null，不写脏值', () => {
    expect(parseWorkspaceIdFromTapdUrl('')).toBeNull()
    expect(parseWorkspaceIdFromTapdUrl('   ')).toBeNull()
    expect(parseWorkspaceIdFromTapdUrl('https://www.tapd.cn/tapd_fe/company/home')).toBeNull()
    expect(parseWorkspaceIdFromTapdUrl('not-a-url')).toBeNull()
  })

  it('不把主机名里的数字当 workspace id', () => {
    expect(parseWorkspaceIdFromTapdUrl('https://192.168.1.1/12345/prong')).toBe('12345')
  })
})

describe('defaultModuleForDirectory', () => {
  it('目录名转小写', () => {
    expect(defaultModuleForDirectory('C:/Program Files/AI/grok-build')).toBe('grok-build')
    expect(defaultModuleForDirectory('/home/me/My-Repo')).toBe('my-repo')
  })

  it('反斜杠与末尾分隔符归一', () => {
    expect(defaultModuleForDirectory('C:\\repo\\Grok-Build\\')).toBe('grok-build')
  })

  it('盘根和空串没有项目名', () => {
    expect(defaultModuleForDirectory('C:/')).toBeNull()
    expect(defaultModuleForDirectory('')).toBeNull()
  })

  it('与后端 default_module_for_directory 同规则（同输入同输出）', () => {
    // 后端测试用例：C:/Program Files/AI/grok-build → grok-build；C:/ → None
    expect(defaultModuleForDirectory('C:/Program Files/AI/grok-build')).toBe('grok-build')
    expect(defaultModuleForDirectory('C:/')).toBeNull()
  })
})

describe('parseModuleFilter', () => {
  it('逗号分隔并去空白空项', () => {
    expect(parseModuleFilter('a, b ,, c ')).toEqual(['a', 'b', 'c'])
    expect(parseModuleFilter('')).toEqual([])
    expect(parseModuleFilter('  ,  ')).toEqual([])
  })
})

describe('slugForDirectory', () => {
  it('同一目录稳定映射到同一 slug（避免重复保存堆出多份绑定）', () => {
    const a = slugForDirectory('C:/repo/grok-build')
    const b = slugForDirectory('C:/repo/grok-build')
    expect(a).toBe(b)
  })

  it('不同目录得到不同 slug', () => {
    expect(slugForDirectory('C:/repo/a')).not.toBe(slugForDirectory('C:/repo/b'))
  })

  it('同名不同路径不冲突', () => {
    expect(slugForDirectory('C:/x/app')).not.toBe(slugForDirectory('C:/y/app'))
  })
})

describe('buildBindingPatchOps', () => {
  it('写入 directory / workspace_id / entity_types / module_filter / enabled', () => {
    const ops = buildBindingPatchOps({ directory: 'C:/repo/app', workspaceId: '123', modules: ['app'] })
    const slug = slugForDirectory('C:/repo/app')

    expect(ops).toEqual([
      { path: ['tapd', 'projects', slug, 'directory'], value: 'C:/repo/app' },
      { path: ['tapd', 'projects', slug, 'workspace_id'], value: '123' },
      { path: ['tapd', 'projects', slug, 'entity_types'], value: ['task'] },
      { path: ['tapd', 'projects', slug, 'module_filter'], value: ['app'] },
      { path: ['tapd', 'projects', slug, 'enabled'], value: true },
    ])
  })

  it('清空模块时写空数组，而不是省略该项（否则旧值继续生效）', () => {
    const ops = buildBindingPatchOps({ directory: 'C:/repo/app', workspaceId: '123', modules: [] })
    const moduleOp = ops.find(op => op.path[3] === 'module_filter')
    expect(moduleOp).toBeDefined()
    expect(moduleOp!.value).toEqual([])
  })
})
