/**
 * Sessions 降级态单测 —— 覆盖规格 08.1 第 5.3 / 5.6 节：
 *   - unsupported：整块受限占位 + 「会话数量暂不可用」，不显示「共 0 条会话」/「暂无会话数据」
 *   - running：不显示迁移横幅 / 不完整标注（写保护由后端自行校验）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Sessions from './Sessions'
import { DataSourceContext, type DataSourceState } from '@/features/datasource/DataSourceContext'
import { ToastProvider } from '@/components/ToastProvider'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { SchemaInfoDTO, SchemaUiState } from '@/features/datasource/useSchemaInfo'

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

describe('Sessions 降级态', () => {
  beforeEach(() => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SESSIONS_LIST) {
        return Promise.resolve({ data: [], total: 0, page: 1, pageSize: 10 })
      }
      return Promise.resolve([])
    })
  })

  it('unsupported：整块受限占位，不显示会话数量与「暂无会话数据」', async () => {
    renderSessions({ kind: 'unsupported', reason: '缺少 session_message / session_v2 等表', path: '/tmp/bad.db' })

    await waitFor(() => expect(screen.getByTestId('schema-blocked-state')).toBeTruthy())
    expect(screen.getByText('会话数量暂不可用')).toBeTruthy()
    expect(screen.queryByText(/共 0 条会话/)).toBeNull()
    expect(screen.queryByText('暂无会话数据')).toBeNull()
    expect(screen.queryByText(/0 个会话/)).toBeNull()
    // 搜索框 / 分页条隐藏
    expect(screen.queryByPlaceholderText('搜索会话标题...')).toBeNull()
    // 不发起会话列表查询
    const listCalls = invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.SESSIONS_LIST)
    expect(listCalls).toHaveLength(0)
  })

  it('running：不再显示迁移横幅与「迁移中，可能不完整」标注', async () => {
    renderSessions({ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'running' }) })

    expect(screen.getByText(/共 \d+ 条会话/)).toBeTruthy()
    expect(screen.queryByTestId('schema-status-banner')).toBeNull()
    expect(screen.queryByText(/迁移中，可能不完整/)).toBeNull()
  })
})
