/**
 * Sessions 方言相关文案单测 —— 覆盖独立审查的 P2-8 / P2-9：
 *   - P2-8：删除确认文案按方言区分（v2 递归删子会话；v1 只删当前会话）
 *   - P2-9：failed 状态的空态文案与 running 区分
 *
 * 后端事实（compat/write.rs）：
 *   `collect_targets` 只在存在 `session_v2` 表时递归子会话
 *   （Rust 用例名即 `collect_targets_recurses_only_on_the_v2_session_tree`），
 *   纯 v1 库不递归。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Sessions from './Sessions'
import { DataSourceContext, type DataSourceState } from '@/features/datasource/DataSourceContext'
import { ToastProvider } from '@/components/ToastProvider'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { SchemaInfoDTO, SessionDetailDTO } from '@shared/types'
import type { SchemaUiState } from '@/features/datasource/useSchemaInfo'

const { invokeSafe } = vi.hoisted(() => ({ invokeSafe: vi.fn() }))

vi.mock('@/lib/ipc', () => ({
  invokeSafe,
  isTauri: () => true,
  openExternal: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}))

vi.mock('recharts', () => ({
  PieChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Pie: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Cell: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
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

const SESSION = {
  id: 's1',
  title: '待删除的会话',
  directory: '/tmp',
  msg_count: 3,
  total_tokens: 100,
  data_size: 2048,
  tokens_input: 10,
  tokens_output: 20,
  tokens_reasoning: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  time_created: 1_700_000_000_000,
  time_updated: 1_700_000_000_000,
  childCount: 0,
}

const DETAIL: SessionDetailDTO = {
  ...SESSION,
  tokenStats: {
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    estimatedCost: 0,
    cacheHitRate: 0,
  },
  toolRanking: [],
  skillRanking: [],
}

function renderSessions(schema: SchemaUiState) {
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
    <MemoryRouter initialEntries={['/sessions']}>
      <ToastProvider>
        <DataSourceContext.Provider value={value}>
          <Sessions />
        </DataSourceContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  )
}

const V1: SchemaUiState = { kind: 'ready', info: info({ mode: 'v1' }) }
const V2: SchemaUiState = { kind: 'ready', info: info({ mode: 'v2', migrationPhase: 'completed' }) }
const V2_MIXED: SchemaUiState = { kind: 'ready', info: info({ mode: 'v2-mixed', migrationPhase: 'completed' }) }

async function openDetailAndDelete() {
  const rowTitle = await waitFor(() => screen.getByText('待删除的会话'))
  fireEvent.click(rowTitle)
  const del = await waitFor(() => screen.getByRole('button', { name: '删除会话' }))
  fireEvent.click(del)
  await waitFor(() => expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy())
}

describe('Sessions 删除确认文案按方言区分（P2-8）', () => {
  beforeEach(() => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SESSIONS_LIST) {
        return Promise.resolve({ data: [SESSION], total: 1, page: 1, pageSize: 10 })
      }
      if (channel === IPC_CHANNELS.SESSIONS_DETAIL) return Promise.resolve(DETAIL)
      return Promise.resolve([])
    })
  })

  it('v1：只说删除当前会话，不提子会话', async () => {
    renderSessions(V1)
    await openDetailAndDelete()

    expect(screen.getByText(/这将仅删除当前会话的消息记录和相关数据/)).toBeTruthy()
    expect(screen.queryByText(/所有子会话/)).toBeNull()
  })

  it('v2：保留「同时删除其所有子会话」', async () => {
    renderSessions(V2)
    await openDetailAndDelete()

    expect(screen.getByText(/这将同时删除其所有子会话/)).toBeTruthy()
    expect(screen.queryByText(/仅删除当前会话/)).toBeNull()
  })

  it('v2-mixed：同样保留递归删除的说明', async () => {
    renderSessions(V2_MIXED)
    await openDetailAndDelete()

    expect(screen.getByText(/这将同时删除其所有子会话/)).toBeTruthy()
  })
})

describe('Sessions 迁移期间保持普通空态（P2-9 收口）', () => {
  it('running：不再显示迁移专用提示，回落普通空态', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SESSIONS_LIST) {
        return Promise.resolve({ data: [], total: 0, page: 1, pageSize: 10 })
      }
      return Promise.resolve([])
    })

    renderSessions({ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'running' }) })

    await waitFor(() => expect(screen.getByText('暂无会话数据')).toBeTruthy())
    expect(screen.queryByText('迁移中，暂时没有可显示的会话')).toBeNull()
  })

  it('failed：不再显示迁移专用提示，回落普通空态', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SESSIONS_LIST) {
        return Promise.resolve({ data: [], total: 0, page: 1, pageSize: 10 })
      }
      return Promise.resolve([])
    })

    renderSessions({ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'failed' }) })

    await waitFor(() => expect(screen.getByText('暂无会话数据')).toBeTruthy())
    expect(screen.queryByText('迁移未完成，请先在 OpenCode 中完成迁移')).toBeNull()
    expect(screen.queryByText('迁移中，暂时没有可显示的会话')).toBeNull()
  })
})
