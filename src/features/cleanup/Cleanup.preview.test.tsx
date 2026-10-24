/**
 * Cleanup 预览单测 —— 覆盖口径标签与大库加载态：
 *   - 预览汇总卡始终用 v1.3.5 的「共 Part」，不再向用户暴露 v2 口径措辞
 *   - v2 / 混合库均沿用 v1.3.5 的按会话比例估算，后端保证 partCount 口径
 *   - 后端返回的 v2 / legacy 字段不参与前端渲染，不出现分列明细
 *   - 预览请求期间按钮禁用、不重复触发，并明确告知用户可能需要数十秒
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const PREVIEW = {
  sessionCount: 3,
  messageCount: 20,
  partCount: 42,
  estimatedSize: 1024,
  sessions: [],
}

/** v2-mixed：顶层汇总 = v2(3 会话/20 消息/20 part) + legacy(2 会话/10 消息/24 part) */
const V2_MIXED_PREVIEW = {
  ...PREVIEW,
  sessionCount: 5,
  messageCount: 30,
  partCount: 44,
  estimatedSize: 4096,
  sessions: [
    { id: 'm1', title: 'M1', msg_count: 8, data_size: 1000 },
    { id: 'm2', title: 'M2', msg_count: 7, data_size: 900 },
    { id: 'm3', title: 'M3', msg_count: 6, data_size: 800 },
    { id: 'm4', title: 'M4', msg_count: 5, data_size: 700 },
    { id: 'm5', title: 'M5', msg_count: 4, data_size: 696 },
  ],
  v2: {
    sessionCount: 3,
    messageCount: 20,
    // v2 侧 part_count 语义 = 消息行数
    partCount: 20,
    estimatedSize: 3000,
  },
  legacy: {
    sessionCount: 2,
    messageCount: 10,
    // 旧版侧 part_count = part 行数
    partCount: 24,
    estimatedSize: 1096,
  },
}

describe('Cleanup 预览口径与加载态', () => {
  it('v2 预览也显示 v1.3.5 的「共 Part」，不出现「消息行数」', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) return Promise.resolve(PREVIEW)
      return Promise.resolve([])
    })

    renderCleanup({ kind: 'ready', info: info({ mode: 'v2', migrationPhase: 'completed' }) })

    fireEvent.click(screen.getByRole('button', { name: /下一步: 预览/ }))

    await waitFor(() => expect(screen.getByText('共 Part')).toBeTruthy())
    expect(screen.queryByText('消息行数')).toBeNull()
    expect(screen.queryByText('共内容块')).toBeNull()
  })

  it('v1 预览保持「共 Part」措辞', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) return Promise.resolve(PREVIEW)
      return Promise.resolve([])
    })

    renderCleanup({ kind: 'ready', info: info({ mode: 'v1' }) })

    fireEvent.click(screen.getByRole('button', { name: /下一步: 预览/ }))

    await waitFor(() => expect(screen.getByText('共 Part')).toBeTruthy())
    expect(screen.queryByText('消息行数')).toBeNull()
  })

  it('预览请求期间：按钮禁用、不重复触发，并提示大型数据库可能需要数十秒', async () => {
    let resolvePreview: (value: unknown) => void = () => { /* noop */ }
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SESSIONS_PROJECTS) return Promise.resolve([])
      if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) {
        return new Promise(resolve => {
          resolvePreview = resolve
        })
      }
      return Promise.resolve([])
    })

    renderCleanup({ kind: 'ready', info: info({ mode: 'v1' }) })

    const next = screen.getByRole('button', { name: /下一步: 预览/ }) as HTMLButtonElement
    fireEvent.click(next)
    // 连点两次：第二次必须被挡住，不能重复发起统计请求
    fireEvent.click(next)

    await waitFor(() => expect(screen.getByText(/正在统计数据库，大型数据库可能需要数十秒/)).toBeTruthy())

    const busyButton = screen.getByRole('button', { name: /正在统计/ }) as HTMLButtonElement
    expect(busyButton.disabled).toBe(true)
    expect(busyButton.getAttribute('aria-busy')).toBe('true')

    const previewCalls = invokeSafe.mock.calls.filter(([ch]) => ch === IPC_CHANNELS.CLEANUP_PREVIEW)
    expect(previewCalls).toHaveLength(1)

    await act(async () => {
      resolvePreview(PREVIEW)
    })
    await waitFor(() => expect(screen.getByText('预览清理范围')).toBeTruthy())
  })
})

describe('Cleanup 摘要口径（P2-12）', () => {
  /** 两个会话，消息数 10 + 20 = 30；后端汇总给的是 100（与精确和不同） */
  const SESSIONS_WITH_COUNTS = [
    { id: 'a', title: 'A', msg_count: 10, data_size: 100 },
    { id: 'b', title: 'B', msg_count: 20, data_size: 200 },
  ]

  const PREVIEW_WITH_SESSIONS = {
    sessionCount: 2,
    messageCount: 30,
    partCount: 100,
    estimatedSize: 300,
    sessions: SESSIONS_WITH_COUNTS,
  }

  /** 读取汇总卡上某个标签对应的数字（卡片结构：标签 div + 数值 div） */
  function summaryValue(label: string): string | undefined {
    return screen.getByText(label).nextElementSibling?.textContent ?? undefined
  }

  it('v2：与 v1 一样走比例估算（2 * 100/2 = 100），不再用消息数', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) return Promise.resolve(PREVIEW_WITH_SESSIONS)
      return Promise.resolve([])
    })

    renderCleanup({ kind: 'ready', info: info({ mode: 'v2', migrationPhase: 'completed' }) })

    fireEvent.click(screen.getByRole('button', { name: /下一步: 预览/ }))
    await waitFor(() => expect(screen.getByText('预览清理范围')).toBeTruthy())

    // 精确求和会算出 30；v1.3.5 的比例估算必须是 2 * (100/2) = 100
    expect(summaryValue('共 Part')).toBe('100')
    expect(summaryValue('共消息')).toBe('30')
    expect(screen.queryByText('消息行数')).toBeNull()
  })

  it('v2-mixed：共 Part 与后端顶层 partCount 一致（44），不取消息数 30', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) return Promise.resolve(V2_MIXED_PREVIEW)
      return Promise.resolve([])
    })

    renderCleanup({ kind: 'ready', info: info({ mode: 'v2-mixed', migrationPhase: 'completed' }) })

    fireEvent.click(screen.getByRole('button', { name: /下一步: 预览/ }))
    await waitFor(() => expect(screen.getByText('预览清理范围')).toBeTruthy())

    // 顶层 partCount = v2.partCount(20) + legacy.partCount(24) = 44；
    // 无排除时 5 * (44/5) = 44，与结果页「删除 Part 数」同源。
    expect(summaryValue('共 Part')).toBe('44')
    expect(summaryValue('共消息')).toBe('30')
  })

  it('v1：保持比例估算的旧逻辑', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) return Promise.resolve(PREVIEW_WITH_SESSIONS)
      return Promise.resolve([])
    })

    renderCleanup({ kind: 'ready', info: info({ mode: 'v1' }) })

    fireEvent.click(screen.getByRole('button', { name: /下一步: 预览/ }))
    await waitFor(() => expect(screen.getByText('预览清理范围')).toBeTruthy())

    // v1 仍是按比例估算：2 * (100/2) = 100（与精确和 30 不同）
    expect(summaryValue('共 Part')).toBe('100')
    expect(summaryValue('共消息')).toBe('30')
  })
})

describe('Cleanup 预览不暴露数据形态（v1.3.5 呈现）', () => {
  it('v2-mixed：后端返回 v2 / legacy 字段也不显示分列明细', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) return Promise.resolve(V2_MIXED_PREVIEW)
      return Promise.resolve([])
    })

    renderCleanup({ kind: 'ready', info: info({ mode: 'v2-mixed', migrationPhase: 'completed' }) })

    fireEvent.click(screen.getByRole('button', { name: /下一步: 预览/ }))

    await waitFor(() => expect(screen.getByText('预览清理范围')).toBeTruthy())
    expect(screen.queryByText('分列明细')).toBeNull()
    expect(screen.queryByText('v2 数据')).toBeNull()
    expect(screen.queryByText('旧版副本')).toBeNull()
    expect(screen.queryByText('消息行数')).toBeNull()
    expect(screen.queryByText('内容块数')).toBeNull()
    expect(screen.queryByText('会话数')).toBeNull()
    expect(screen.queryByText('预计体积')).toBeNull()

    // 汇总卡保持 v1.3.5 的四项
    expect(screen.getByText('将删除会话')).toBeTruthy()
    expect(screen.getByText('共消息')).toBeTruthy()
    expect(screen.getByText('共 Part')).toBeTruthy()
    expect(screen.getByText('预计释放')).toBeTruthy()
  })

  it('v2 字段缺失：只显示汇总，不出现分列', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) return Promise.resolve(PREVIEW)
      return Promise.resolve([])
    })

    renderCleanup({ kind: 'ready', info: info({ mode: 'v2', migrationPhase: 'completed' }) })

    fireEvent.click(screen.getByRole('button', { name: /下一步: 预览/ }))

    await waitFor(() => expect(screen.getByText('预览清理范围')).toBeTruthy())
    expect(screen.queryByText('分列明细')).toBeNull()
    // 汇总仍在
    expect(screen.getByText('将删除会话')).toBeTruthy()
    expect(screen.getByText('共消息')).toBeTruthy()
    expect(screen.getByText('共 Part')).toBeTruthy()
    expect(screen.getByText('预计释放')).toBeTruthy()
  })
})
