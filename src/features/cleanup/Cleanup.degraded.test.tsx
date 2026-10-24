/**
 * Cleanup 降级态单测 —— 覆盖规格 08.1 第 5.4 / 5.6 节：
 *   - unsupported：整块受限占位，不显示「没有匹配的会话」与 0 个会话
 *   - running / failed：写入暂停，「下一步: 预览」禁用
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

describe('Cleanup 降级态', () => {
  it('unsupported：整块受限占位，隐藏步骤条与策略表单', async () => {
    invokeSafe.mockResolvedValue([])

    renderCleanup({ kind: 'unsupported', reason: '缺少 session_message / session_v2 等表', path: '/tmp/bad.db' })

    await waitFor(() => expect(screen.getByTestId('schema-blocked-state')).toBeTruthy())
    expect(screen.getByText('无法读取这个数据库')).toBeTruthy()
    expect(screen.queryByText('按时间')).toBeNull()
    expect(screen.queryByText('选择策略')).toBeNull()
    expect(screen.queryByText('没有匹配的会话')).toBeNull()
    expect(screen.queryByText(/0 个会话/)).toBeNull()
  })

  it('running：不再显示迁移暂停提示，清理向导照常可交互', async () => {
    invokeSafe.mockResolvedValue([])

    renderCleanup({ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'running' }) })

    await waitFor(() => {
      const next = screen.getByRole('button', { name: /下一步: 预览/ }) as HTMLButtonElement
      expect(next.disabled).toBe(false)
    })
    expect(screen.queryByText('迁移期间清理已暂停')).toBeNull()
    expect(screen.getByText('按时间')).toBeTruthy()
  })

  it('failed：不再显示迁移暂停提示', async () => {
    invokeSafe.mockResolvedValue([])

    renderCleanup({ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'failed' }) })

    await waitFor(() => {
      const next = screen.getByRole('button', { name: /下一步: 预览/ }) as HTMLButtonElement
      expect(next.disabled).toBe(false)
    })
    expect(screen.queryByText('迁移未完成，清理已暂停')).toBeNull()
  })

  it('正常态：清理向导照常进入预览', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.SESSIONS_PROJECTS) return Promise.resolve([])
      if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) {
        return Promise.resolve({
          sessionCount: 2,
          messageCount: 10,
          partCount: 20,
          estimatedSize: 1024,
          sessions: [],
        })
      }
      return Promise.resolve([])
    })

    renderCleanup({ kind: 'ready', info: info({ mode: 'v1' }) })

    const next = screen.getByRole('button', { name: /下一步: 预览/ }) as HTMLButtonElement
    await waitFor(() => expect(next.disabled).toBe(false))
  })
})
