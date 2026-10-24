/**
 * Backup 恢复弹窗的内容统计口径 —— 覆盖后端 BackupPreviewDTO.isV2：
 *   - v2 备份：只显示「会话 / 消息」，不出现 Part 行，也不显示 0
 *   - v1 备份：三行「会话 / 消息 / Part」
 *   - isV2 缺失（旧后端 / 旧备份）：按 v1 处理
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  fileName: 'opencode-backup-2026-10-21.db',
  filePath: '/Users/tester/.opencode-w/backups/opencode-backup-2026-10-21.db',
  fileSize: 1024,
  createdAt: '2026-10-21T00:00:00.000Z',
}

function renderBackup(schema: SchemaUiState = { kind: 'ready', info: info({ mode: 'v1' }) }) {
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
    <MemoryRouter>
      <DataSourceContext.Provider value={value}>
        <Backup />
      </DataSourceContext.Provider>
    </MemoryRouter>,
  )
}

function mockPreview(preview: Record<string, unknown>) {
  invokeSafe.mockImplementation((channel: string) => {
    if (channel === IPC_CHANNELS.BACKUP_LIST) return Promise.resolve([BACKUP])
    if (channel === IPC_CHANNELS.BACKUP_PREVIEW) {
      return Promise.resolve({ ...BACKUP, sessionCount: 12, messageCount: 34, partCount: 56, ...preview })
    }
    return Promise.resolve([])
  })
}

async function openRestoreModal() {
  const restore = await waitFor(() => screen.getByRole('button', { name: /恢复/ }))
  fireEvent.click(restore)
  await waitFor(() => expect(screen.getByText('备份内容')).toBeTruthy())
}

describe('Backup 恢复弹窗内容统计口径', () => {
  it('v2 备份：不出现 Part 行，只显示会话 / 消息', async () => {
    mockPreview({ isV2: true })
    renderBackup()

    await openRestoreModal()

    expect(screen.getByText('会话')).toBeTruthy()
    expect(screen.getByText('消息')).toBeTruthy()
    expect(screen.queryByText('Part')).toBeNull()
    // 也不该出现 Part 的数字
    expect(screen.queryByText('56')).toBeNull()
  })

  it('v1 备份：出现 Part 行', async () => {
    mockPreview({ isV2: false })
    renderBackup()

    await openRestoreModal()

    expect(screen.getByText('会话')).toBeTruthy()
    expect(screen.getByText('消息')).toBeTruthy()
    expect(screen.getByText('Part')).toBeTruthy()
    expect(screen.getByText('56')).toBeTruthy()
  })

  it('isV2 缺失（旧后端 / 旧备份）：按 v1 处理，仍显示 Part 行', async () => {
    mockPreview({})
    renderBackup()

    await openRestoreModal()

    expect(screen.getByText('Part')).toBeTruthy()
    expect(screen.getByText('56')).toBeTruthy()
  })
})
