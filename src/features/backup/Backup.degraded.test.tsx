/**
 * Backup 降级态单测 —— 覆盖规格 08.1 第 5.5 / 6.2 节：
 *   - running/failed：UI 不再显示横幅 / 禁用恢复（写保护由后端自行校验）
 *   - unsupported：禁用「恢复」；导出保持可用并显示被复制的路径；
 *     内容统计显示「暂不可用」而不是 0
 *   - v1/v2 正常态行为不变
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Backup from './Backup'
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

const BACKUP = {
  fileName: 'opencode-2026-10-21.db',
  filePath: '/Users/tester/.opencode-w/backups/opencode-2026-10-21.db',
  fileSize: 1024,
  createdAt: '2026-10-21T00:00:00.000Z',
}

function renderBackup(schema: SchemaUiState, dbPath = '/tmp/opencode.db') {
  const value: DataSourceState = {
    connected: true,
    dbPath,
    dbSize: 1024,
    schema,
    schemaRefreshing: false,
    schemaRefreshError: null,
    refreshSchema: vi.fn().mockResolvedValue(undefined),
  }
  return render(
    <MemoryRouter>
      <DataSourceContext.Provider value={value}>
        <Backup />
      </DataSourceContext.Provider>
    </MemoryRouter>,
  )
}

describe('Backup 降级态', () => {
  it('running：不显示迁移横幅，「恢复」不再因迁移态禁用，导出仍可用', async () => {
    invokeSafe.mockResolvedValue([BACKUP])

    renderBackup({ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'running' }) })

    const restore = await waitFor(() => screen.getByRole('button', { name: /恢复/ }) as HTMLButtonElement)
    expect(restore.disabled).toBe(false)
    expect(screen.queryByTestId('schema-status-banner')).toBeNull()
    expect(screen.queryByText(/恢复已暂停/)).toBeNull()
    expect(screen.queryByText(/迁移进行中/)).toBeNull()

    // 导出仍然可用
    const create = screen.getByRole('button', { name: /立即备份/ }) as HTMLButtonElement
    expect(create.disabled).toBe(false)
  })

  it('unsupported：禁用「恢复」，导出可用并显示被复制的路径，内容统计不可用', async () => {
    invokeSafe.mockResolvedValue([BACKUP])

    renderBackup({ kind: 'unsupported', reason: '缺少 session_message / session_v2 等表', path: null })

    const restore = await waitFor(() => screen.getByRole('button', { name: /恢复/ }) as HTMLButtonElement)
    expect(restore.disabled).toBe(true)
    expect(screen.getByText(/恢复会替换当前数据库，需要先能识别数据库格式/)).toBeTruthy()

    // 导出保持可用，并显示被复制的路径
    const create = screen.getByRole('button', { name: /立即备份/ }) as HTMLButtonElement
    expect(create.disabled).toBe(false)
    expect(screen.getByText('文件级复制，不解析内容')).toBeTruthy()
    expect(screen.getByText(/将复制：/)).toBeTruthy()
    expect(screen.getByText('内容统计不可用')).toBeTruthy()
  })

  it('unsupported 且没有可复制路径：创建备份按钮禁用并说明', async () => {
    invokeSafe.mockResolvedValue([BACKUP])

    renderBackup({ kind: 'unsupported', reason: '缺少 session_message / session_v2 等表', path: null }, '')

    const create = await waitFor(() => screen.getByRole('button', { name: /没有可备份的数据库/ }) as HTMLButtonElement)
    expect(create.disabled).toBe(true)
    expect(screen.getByText('内容统计不可用')).toBeTruthy()
  })

  it('正常态：恢复可用、创建备份可用、内容统计正常显示', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.BACKUP_LIST) return Promise.resolve([BACKUP])
      if (channel === IPC_CHANNELS.BACKUP_PREVIEW) {
        return Promise.resolve({ ...BACKUP, sessionCount: 12, messageCount: 34, partCount: 56 })
      }
      return Promise.resolve([])
    })

    renderBackup({ kind: 'ready', info: info({ mode: 'v1' }) })

    const restore = await waitFor(() => screen.getByRole('button', { name: /恢复/ }) as HTMLButtonElement)
    expect(restore.disabled).toBe(false)
    expect(screen.queryByTestId('schema-status-banner')).toBeNull()
    expect(screen.getByRole('button', { name: /立即备份/ })).toBeTruthy()
    // 卡片副标题保持原样
    expect(screen.getByText('将当前数据库导出为备份文件')).toBeTruthy()
  })
})
