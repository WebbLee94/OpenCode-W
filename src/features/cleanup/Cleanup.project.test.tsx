/**
 * 清理向导「按项目」口径单测（v1.4 修复）：
 *   - 下拉值是 sessions:projects 返回的项目目录；
 *   - 预览请求带着该目录值，后端返回非空预览时用户能看到会话列表；
 *   - 预览与执行使用同一份过滤值（同一批候选会话），无排除时仅
 *     excludedSessionIds 初始为空数组这一处差别。
 *
 * 回归背景：后端 sessions:projects 返回 DISTINCT directory，而清理过滤
 * 原本错配成 `s.project_id`（.git HEAD / sha1），导致按项目预览永远为空。
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
  vi.useRealTimers()
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

function renderCleanup(schema: SchemaUiState = { kind: 'ready', info: info() }) {
  const value: DataSourceState = {
    connected: true,
    dbPath: '/tmp/opencode.db',
    dbSize: 1024,
    schema,
    schemaRefreshing: false,
    schemaRefreshError: null,
    refreshSchema: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  }
  render(
    <MemoryRouter initialEntries={['/cleanup']}>
      <DataSourceContext.Provider value={value}>
        <Cleanup />
      </DataSourceContext.Provider>
    </MemoryRouter>,
  )
}

const PROJECT_DIR = '/Users/webb/dev/demo'

const SESSIONS = [
  { id: 'ses_a', title: '会话 A', msg_count: 4, data_size: 100 },
  { id: 'ses_b', title: '会话 B', msg_count: 6, data_size: 200 },
]

const PREVIEW = {
  sessionCount: SESSIONS.length,
  messageCount: 10,
  partCount: 12,
  estimatedSize: 300,
  sessions: SESSIONS,
  childSessionIds: [],
}

const RESULT = {
  deletedSessions: 2,
  deletedMessages: 10,
  deletedParts: 12,
  freedBytes: 300,
  vacuumBefore: 1024,
  vacuumAfter: 724,
}

/** 第一步：选中「按项目」并选定项目，返回预览步骤所需元素。 */
async function selectProjectAndGoPreview() {
  invokeSafe.mockImplementation(async (channel: string) => {
    if (channel === IPC_CHANNELS.SESSIONS_PROJECTS) return [PROJECT_DIR]
    if (channel === IPC_CHANNELS.CLEANUP_PREVIEW) return PREVIEW
    if (channel === IPC_CHANNELS.CLEANUP_EXECUTE) return RESULT
    return []
  })

  renderCleanup()

  // 选中「按项目」策略
  fireEvent.click(screen.getByText('按项目'))
  // 等项目下拉加载完成并选定项目目录值
  const select = (await screen.findByRole('combobox')) as HTMLSelectElement
  await waitFor(() => expect(select.options.length).toBe(2))
  fireEvent.change(select, { target: { value: PROJECT_DIR } })

  fireEvent.click(screen.getByRole('button', { name: /下一步: 预览/ }))

  await waitFor(() => expect(screen.getByText('预览清理范围')).toBeTruthy())
}

function previewCallPayload(): Record<string, unknown> {
  const call = invokeSafe.mock.calls.find(([ch]) => ch === IPC_CHANNELS.CLEANUP_PREVIEW)
  if (!call) throw new Error('CLEANUP_PREVIEW 未被调用')
  return call[1] as Record<string, unknown>
}

function executeCallPayload(): Record<string, unknown> {
  const call = invokeSafe.mock.calls.find(([ch]) => ch === IPC_CHANNELS.CLEANUP_EXECUTE)
  if (!call) throw new Error('CLEANUP_EXECUTE 未被调用')
  return call[1] as Record<string, unknown>
}

describe('Cleanup 按项目口径', () => {
  it('任选项目后能在预览页看到非空会话列表', async () => {
    await selectProjectAndGoPreview()

    // 请求必须带着项目目录值（不是 project_id）
    const filter = previewCallPayload()
    expect(filter).toEqual(
      expect.objectContaining({ strategy: 'project', projectId: PROJECT_DIR }),
    )

    // 非空预览：会话列表渲染出来
    expect(screen.getByText('会话 A')).toBeTruthy()
    expect(screen.getByText('会话 B')).toBeTruthy()
  })

  it('预览与执行命中同一批会话（同一过滤值）', async () => {
    await selectProjectAndGoPreview()

    // 走完确认 → 执行（等待 3 秒倒计时自然结束）
    fireEvent.click(screen.getByRole('button', { name: /确认清理/ }))
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy())
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(
      () => {
        const btn = screen.getByRole('button', { name: /确认清理/ }) as HTMLButtonElement
        expect(/^确认清理$/.test(btn.textContent ?? '')).toBe(true)
      },
      { timeout: 4500 },
    )
    fireEvent.click(screen.getByRole('button', { name: /^确认清理$/ }))

    await waitFor(() => expect(screen.getByText('清理结果')).toBeTruthy())

    const pFilter = previewCallPayload()
    const eFilter = executeCallPayload()
    // 过滤策略与项目目录值一致；仅初始预览的排除集合固定为空
    expect(eFilter.strategy).toBe(pFilter.strategy)
    expect(eFilter.projectId).toBe(pFilter.projectId)
    expect(pFilter.excludedSessionIds).toEqual([])
    expect(eFilter.strategy).toBe('project')
    expect(eFilter.projectId).toBe(PROJECT_DIR)
  })
})
