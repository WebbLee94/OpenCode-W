/**
 * Backup unsupported「不显示 0」补测 —— 对应 TEST-014「unsupported 下四个页面
 * 不出现『0 个会话』」与 08.1 规格第 7 节验收清单 8。
 *
 * 既有覆盖情况：
 *   - Dashboard：`Dashboard.degraded.test.tsx` 已断言 `/0 个会话/`、`/共 0 条会话/`、
 *     `/暂无会话数据/`、`/暂无Token数据/` 全部缺席，且不发统计 IPC；
 *   - Sessions：`Sessions.degraded.test.tsx` 已断言 `/共 0 条会话/`、`/0 个会话/`、
 *     `暂无会话数据` 缺席，且不发 `sessions:list`；
 *   - Cleanup：`Cleanup.degraded.test.tsx` 已断言 `没有匹配的会话`、`/0 个会话/` 缺席；
 *   - **Backup：既有 `Backup.degraded.test.tsx` 的 unsupported 用例只断言了
 *     「恢复被禁用」「导出可用」「内容统计不可用」，**没有**任何一条
 *     「页面里不出现 0 / 不出现会话数」的断言 —— 四页里唯一缺口。**
 *
 * 本文件补上这一页，并顺带锁死「不解析内容」时不会退化成 0。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Backup from './Backup'
import { DataSourceContext, type DataSourceState } from '@/features/datasource/DataSourceContext'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { SchemaInfoDTO } from '@shared/types'
import type { SchemaUiState } from '@/features/datasource/useSchemaInfo'

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

const UNSUPPORTED: SchemaUiState = {
  kind: 'unsupported',
  reason: '缺少 session_message / session_v2 等表',
  path: '/tmp/bad.db',
}

describe('Backup unsupported 不显示 0', () => {
  it('页面上不出现「0 个会话」「共 0 条会话」「暂无会话数据」「暂无Token数据」', async () => {
    invokeSafe.mockResolvedValue([BACKUP])

    renderBackup(UNSUPPORTED)

    await waitFor(() => expect(screen.getByText('内容统计不可用')).toBeTruthy())

    expect(screen.queryByText(/0 个会话/)).toBeNull()
    expect(screen.queryByText(/共 0 条会话/)).toBeNull()
    expect(screen.queryByText(/暂无会话数据/)).toBeNull()
    expect(screen.queryByText(/暂无Token数据/)).toBeNull()
    expect(screen.queryByText(/会话数/)).toBeNull()
  })

  it('不出现任何裸的「0」数字（统计区整体退化为「内容统计不可用」）', async () => {
    invokeSafe.mockResolvedValue([BACKUP])

    renderBackup(UNSUPPORTED)

    await waitFor(() => expect(screen.getByText('内容统计不可用')).toBeTruthy())

    // 备份列表里的文件大小等真实数字仍然显示，只有「统计」不许退化成 0
    const stats = screen.getByText('内容统计不可用').closest('div') as HTMLElement
    expect(stats.textContent).not.toMatch(/\b0\b/)
    expect(screen.queryByText('0')).toBeNull()
  })

  it('unsupported 下不发起 backup:preview（不解析内容）', async () => {
    invokeSafe.mockResolvedValue([BACKUP])

    renderBackup(UNSUPPORTED)
    await waitFor(() => expect(screen.getByText('内容统计不可用')).toBeTruthy())

    const previewCalls = invokeSafe.mock.calls.filter(([c]) => c === IPC_CHANNELS.BACKUP_PREVIEW)
    expect(previewCalls).toHaveLength(0)
  })

  it('unsupported 下「恢复」禁用、「立即备份」可用，且显示被复制的路径', async () => {
    invokeSafe.mockResolvedValue([BACKUP])

    renderBackup(UNSUPPORTED)

    const restore = await waitFor(() => screen.getByRole('button', { name: /恢复/ }) as HTMLButtonElement)
    expect(restore.disabled).toBe(true)

    const create = screen.getByRole('button', { name: /立即备份/ }) as HTMLButtonElement
    expect(create.disabled).toBe(false)

    expect(screen.getByText('文件级复制，不解析内容')).toBeTruthy()
    expect(screen.getByText(/将复制：/)).toBeTruthy()
  })

  it('对照：正常态才显示会话/消息/Part 统计，且不是 0', async () => {
    invokeSafe.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.BACKUP_LIST) return Promise.resolve([BACKUP])
      if (channel === IPC_CHANNELS.BACKUP_PREVIEW) {
        return Promise.resolve({ ...BACKUP, sessionCount: 12, messageCount: 34, partCount: 56 })
      }
      return Promise.resolve([])
    })

    renderBackup({ kind: 'ready', info: info({ mode: 'v1' }) })

    // 正常态的统计在「恢复」弹窗预览里；这里只确认页面本身没有退化成 0
    await waitFor(() => expect(screen.getByRole('button', { name: /立即备份/ })).toBeTruthy())
    expect(screen.queryByText('内容统计不可用')).toBeNull()
    expect(screen.queryByText(/0 个会话/)).toBeNull()
  })
})
