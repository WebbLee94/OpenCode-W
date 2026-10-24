/**
 * Cleanup 预览的子会话锁定与父子联动 —— 覆盖独立审查 P2-2。
 *
 * 语义（后端）：
 *   - `childSessionIds`：随父会话一起删除的子会话 id（v1 恒为空数组）
 *   - 每行的 `parentId`：父会话 id（根行为空）
 *
 * 前端规则：
 *   1. 子会话行：checkbox 跟随父会话且 disabled，不能单独取消；
 *   2. 取消父行 → 它的**整棵子树**都从汇总里扣掉（父被删，子树一起没）；
 *   3. 「全不选」只作用于根行，但汇总会因根被排除而扣掉其子树；
 *   4. v1（childSessionIds 为空、parentId 为空）→ 行为与原来完全一致。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Cleanup from './Cleanup'
import { DataSourceContext, type DataSourceState } from '@/features/datasource/DataSourceContext'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { SchemaInfoDTO, SchemaUiState } from '@/features/datasource/useSchemaInfo'

const { invokeSafe } = vi.hoisted(() => ({ invokeSafe: vi.fn() }))

vi.mock('@/lib/ipc', () => ({
  invokeSafe,
  isTauri: () => true,
}))

afterEach(() => {
  cleanup()
  invokeSafe.mockReset()
})

function info(overrides: Partial<SchemaInfoDTO> = {}): SchemaInfoDTO {
  return {
    mode: 'v1',
    migrationPhase: 'none',
    hasLegacyTables: false,
    v2SessionCount: 0,
    unsupportedReason: null,
    ...overrides,
  }
}

const PARENT = {
  id: 'p1',
  title: '父会话',
  directory: '/tmp',
  msg_count: 30,
  total_tokens: 100,
  data_size: 1024,
  tokens_input: 10,
  tokens_output: 20,
  tokens_reasoning: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  time_created: 1_700_000_000_000,
  time_updated: 1_700_000_000_000,
  childCount: 1,
}

/** 子会话：标题刻意不叫「子会话」，避免与 UI 上的「子会话」小标签同名 */
const CHILD = {
  ...PARENT,
  id: 'c1',
  title: '儿子会话',
  parentId: 'p1',
  msg_count: 10,
  data_size: 512,
  childCount: 1,
}

/** 孙会话：验证子树是逐层展开的 */
const GRANDCHILD = {
  ...PARENT,
  id: 'g1',
  title: '孙子会话',
  parentId: 'c1',
  msg_count: 4,
  data_size: 128,
  childCount: 0,
}

const OTHER = {
  ...PARENT,
  id: 'o1',
  title: '另一个根会话',
  msg_count: 5,
  data_size: 256,
  childCount: 0,
}

function renderCleanup(schema: SchemaUiState) {
  const value: DataSourceState = {
    connected: true,
    dbPath: '/tmp/opencode.db',
    dbSize: 1024,
    schema,
    schemaRefreshing: false,
    schemaRefreshError: null,
    refreshSchema: vi.fn().mockResolvedValue(undefined),
  }
  return render(
    <MemoryRouter initialEntries={['/cleanup']}>
      <DataSourceContext.Provider value={value}>
        <Cleanup />
      </DataSourceContext.Provider>
    </MemoryRouter>,
  )
}

function mockPreview(preview: Record<string, unknown>) {
  invokeSafe.mockImplementation((channel: string) => {
    if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) return Promise.resolve(preview)
    return Promise.resolve([])
  })
}

async function openPreview() {
  fireEvent.click(screen.getByRole('button', { name: /下一步: 预览/ }))
  await waitFor(() => expect(screen.getByText('预览清理范围')).toBeTruthy())
}

/** 读取汇总卡上某个标签对应的数字 */
function summaryValue(label: string): string | undefined {
  return screen.getByText(label).nextElementSibling?.textContent ?? undefined
}

const V2: SchemaUiState = { kind: 'ready', info: info({ mode: 'v2', migrationPhase: 'completed' }) }
const V1: SchemaUiState = { kind: 'ready', info: info({ mode: 'v1' }) }

/** v2-mixed 预览：父 → 子 → 孙，另一条根会话 */
const V2_PREVIEW = {
  sessionCount: 4,
  messageCount: 49,
  partCount: 49,
  estimatedSize: 1920,
  sessions: [PARENT, CHILD, GRANDCHILD, OTHER],
  childSessionIds: ['c1', 'g1'],
}

describe('Cleanup 预览的子会话锁定与父子联动（P2-2）', () => {
  it('子会话行：checkbox 强制勾选 + disabled + 「子会话」小标签与说明', async () => {
    mockPreview(V2_PREVIEW)
    renderCleanup(V2)
    await openPreview()

    const childCheckbox = screen.getAllByLabelText(/随父会话一起删除，不可单独保留/)[0] as HTMLInputElement
    expect(childCheckbox.checked).toBe(true)
    expect(childCheckbox.disabled).toBe(true)
    expect(childCheckbox.getAttribute('title')).toBe('子会话随父会话一起删除，不可单独保留')

    // 视觉标记
    expect(screen.getAllByText('子会话')).toHaveLength(2)

    // 两条根行仍可勾选
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(checkboxes).toHaveLength(4)
    expect(checkboxes.filter(b => b.disabled)).toHaveLength(2)
  })

  it('取消父行：summary 扣掉父行及其整棵子树，子行改显示「随父会话保留」', async () => {
    mockPreview(V2_PREVIEW)
    renderCleanup(V2)
    await openPreview()

    // 初始 4 条全部计入
    expect(summaryValue('将删除会话')).toBe('4')

    // 取消父会话 → 父 + 子 + 孙 一起被扣掉，只剩另一个根会话
    const parentCheckbox = screen.getAllByRole('checkbox')[0] as HTMLInputElement
    expect(parentCheckbox.checked).toBe(true)
    fireEvent.click(parentCheckbox)

    await waitFor(() => expect(summaryValue('将删除会话')).toBe('1'))
    // 消息行数也只算剩下那个根会话（5）
    expect(summaryValue('共消息')).toBe('5')

    // 子行跟随父行：未勾选 + 仍然 disabled（不能单独操作），标签改成「随父会话保留」
    const childCheckbox = screen.getAllByLabelText(/随父会话一起保留/)[0] as HTMLInputElement
    expect(childCheckbox.checked).toBe(false)
    expect(childCheckbox.disabled).toBe(true)
    expect(childCheckbox.getAttribute('title')).toBe('父会话已被排除，子会话随父会话一起保留')
    expect(screen.getAllByText('随父会话保留')).toHaveLength(2) // 子 + 孙
    expect(screen.queryByText('子会话')).toBeNull()
  })

  it('重新勾选父会话 → 整棵子树恢复计入', async () => {
    mockPreview(V2_PREVIEW)
    renderCleanup(V2)
    await openPreview()

    const parentCheckbox = screen.getAllByRole('checkbox')[0] as HTMLInputElement
    fireEvent.click(parentCheckbox)
    await waitFor(() => expect(summaryValue('将删除会话')).toBe('1'))

    // 再点回来 → 子树整体恢复
    fireEvent.click(parentCheckbox)
    await waitFor(() => expect(summaryValue('将删除会话')).toBe('4'))
    expect(summaryValue('共消息')).toBe('49')

    const childCheckbox = screen.getAllByLabelText(/随父会话一起删除，不可单独保留/)[0] as HTMLInputElement
    expect(childCheckbox.checked).toBe(true)
    expect(childCheckbox.disabled).toBe(true)
    expect(screen.getAllByText('子会话')).toHaveLength(2)
    expect(screen.queryByText('随父会话保留')).toBeNull()
  })

  it('「全不选」只作用于根行，但汇总会扣掉根的子树', async () => {
    mockPreview(V2_PREVIEW)
    renderCleanup(V2)
    await openPreview()

    fireEvent.click(screen.getByRole('button', { name: '全不选' }))

    // 两个根行被排除 → 连同各自的子树全没了
    await waitFor(() => expect(summaryValue('将删除会话')).toBe('0'))

    // 子行仍然是 disabled，并显示「随父会话保留」
    const childCheckbox = screen.getAllByLabelText(/随父会话一起保留/)[0] as HTMLInputElement
    expect(childCheckbox.disabled).toBe(true)
    expect(childCheckbox.checked).toBe(false)
  })

  it('v1：childSessionIds 为空、parentId 也为空 → 行为与原来完全一致', async () => {
    mockPreview({
      sessionCount: 3,
      messageCount: 45,
      partCount: 45,
      estimatedSize: 1792,
      sessions: [
        { ...PARENT },
        { ...CHILD, parentId: undefined },
        { ...OTHER },
      ],
      childSessionIds: [],
    })
    renderCleanup(V1)
    await openPreview()

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(checkboxes).toHaveLength(3)
    expect(checkboxes.every(b => !b.disabled)).toBe(true)
    expect(screen.queryByText('子会话')).toBeNull()

    // 「全不选」对所有行生效
    fireEvent.click(screen.getByRole('button', { name: '全不选' }))
    await waitFor(() => expect(summaryValue('将删除会话')).toBe('0'))
  })

  it('后端字段缺失（旧后端）→ 按空数组处理，不报错', async () => {
    mockPreview({
      sessionCount: 1,
      messageCount: 30,
      partCount: 30,
      estimatedSize: 1024,
      sessions: [PARENT],
    })
    renderCleanup(V2)
    await openPreview()

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(checkboxes).toHaveLength(1)
    expect(checkboxes[0].disabled).toBe(false)
    expect(screen.queryByText('子会话')).toBeNull()
  })
})
