/**
 * Wave 3（B-10 收尾）搜索索引状态单测：
 *   - 挂载且库健康时 ensure_index 只调用一次（幂等、不阻塞）
 *   - building：显示进度行，progress 事件实时更新，done 后回到正常搜索
 *   - ready：FTS 权威；空结果是「未找到匹配的消息」，不再误导为未适配
 *   - LIKE 回退：<3 字关键词或索引未就绪时显示 30 天回退说明
 *   - error：失败提示 + 重试（重发 ensure_index 与当前搜索）
 *
 * 纯渲染层断言：不依赖真实 Tauri、不依赖真实索引文件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import Messages from './Messages'
import { DataSourceContext, type DataSourceState } from '@/features/datasource/DataSourceContext'
import { ToastProvider } from '@/components/ToastProvider'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { SchemaInfoDTO, SearchIndexProgress, SearchIndexStatus } from '@shared/types'

const { invokeSafe, listen } = vi.hoisted(() => ({
  invokeSafe: vi.fn(),
  listen: vi.fn(),
}))

vi.mock('@/lib/ipc', () => ({
  invokeSafe,
  isTauri: () => true,
}))

vi.mock('@tauri-apps/api/event', () => ({ listen }))

function info(overrides: Partial<SchemaInfoDTO> = {}): SchemaInfoDTO {
  return {
    mode: 'v2-mixed',
    migrationPhase: 'completed',
    hasLegacyTables: true,
    v2SessionCount: 6,
    unsupportedReason: null,
    ...overrides,
  }
}

function status(overrides: Partial<SearchIndexStatus> = {}): SearchIndexStatus {
  return {
    state: 'ready',
    indexed: 100,
    total: 100,
    watermark: 1,
    error: null,
    ...overrides,
  }
}

function renderMessages(schemaOverrides: Partial<SchemaInfoDTO> = {}) {
  const value: DataSourceState = {
    connected: true,
    dbPath: '/tmp/opencode.db',
    dbSize: 4096,
    schema: { kind: 'ready', info: info(schemaOverrides) },
    schemaRefreshing: false,
    schemaRefreshError: null,
    refreshSchema: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  }
  render(
    <MemoryRouter initialEntries={['/sessions/ses_abc/messages']}>
      <DataSourceContext.Provider value={value}>
        <ToastProvider>
          <Routes>
            <Route path="/sessions/:sessionId/messages" element={<Messages />} />
          </Routes>
        </ToastProvider>
      </DataSourceContext.Provider>
    </MemoryRouter>,
  )
  return value
}

/** 触发一次 search:index-progress 事件 */
async function emitProgress(payload: SearchIndexProgress) {
  const handler = listen.mock.calls[0]?.[1] as ((event: { payload: SearchIndexProgress }) => void) | undefined
  expect(handler, 'listen 应已注册 progress 处理器').toBeTruthy()
  await act(async () => {
    handler?.({ payload })
  })
}

function callsTo(channel: string): unknown[][] {
  return invokeSafe.mock.calls.filter(([c]) => c === channel)
}

async function searchKeyword(keyword: string) {
  const input = screen.getByPlaceholderText('全文搜索消息...')
  fireEvent.change(input, { target: { value: keyword } })
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  await act(async () => {})
}

beforeEach(() => {
  listen.mockReset()
  listen.mockResolvedValue(() => {})
})

afterEach(() => {
  cleanup()
  invokeSafe.mockReset()
})

describe('搜索索引状态（B-10）', () => {
  it('挂载时 ensure 只调一次；building 显示进度行并随事件更新；done 后恢复正常', async () => {
    invokeSafe.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.SEARCH_ENSURE_INDEX) {
        return status({ state: 'building', indexed: 100, total: 2000 })
      }
      if (channel === IPC_CHANNELS.SEARCH_INDEX_STATUS) {
        return status({ state: 'building', indexed: 100, total: 2000 })
      }
      if (channel === IPC_CHANNELS.MESSAGES_LIST) return { data: [], total: 0, page: 1 }
      if (channel === IPC_CHANNELS.MESSAGES_SEARCH) return []
      return []
    })

    renderMessages()
    await act(async () => {})

    // ensure 幂等：挂载 + 事件 + 搜索后仍只有一次
    expect(callsTo(IPC_CHANNELS.SEARCH_ENSURE_INDEX)).toHaveLength(1)

    // building：显示进度行（x/y），不显示体积/耗时数字
    expect(screen.getByRole('status').textContent).toContain('正在建立搜索索引（100/2,000）…')
    expect(document.body.textContent).not.toMatch(/GB|MB|耗时/)

    // progress 事件更新分子分母，不轮询
    await emitProgress({ indexed: 1500, total: 2000, phase: 'legacy' })
    expect(screen.getByRole('status').textContent).toContain('正在建立搜索索引（1,500/2,000）…')

    await searchKeyword('关键词内容')
    expect(callsTo(IPC_CHANNELS.SEARCH_ENSURE_INDEX)).toHaveLength(1)

    // done 事件 → ready：进度行消失
    await emitProgress({ indexed: 2000, total: 2000, phase: 'done' })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/正在建立搜索索引/)).toBeNull()
  })

  it('ready：空结果是权威「未找到匹配的消息」，不显示回退说明', async () => {
    invokeSafe.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.SEARCH_ENSURE_INDEX) return status({ state: 'ready' })
      if (channel === IPC_CHANNELS.SEARCH_INDEX_STATUS) return status({ state: 'ready' })
      if (channel === IPC_CHANNELS.MESSAGES_LIST) return { data: [], total: 0, page: 1 }
      if (channel === IPC_CHANNELS.MESSAGES_SEARCH) return []
      return []
    })

    renderMessages()
    await act(async () => {})
    await searchKeyword('不存在的关键词')

    expect(screen.getByText('未找到匹配的消息')).toBeTruthy()
    expect(screen.queryByText(/回退到最近 30 天搜索/)).toBeNull()
    // 每次搜索后做一次性的状态校准（不是轮询）
    expect(callsTo(IPC_CHANNELS.SEARCH_INDEX_STATUS)).toHaveLength(1)
  })

  it('短关键词（<3 字）回退 LIKE：显示 30 天回退说明', async () => {
    invokeSafe.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.SEARCH_ENSURE_INDEX) return status({ state: 'ready' })
      if (channel === IPC_CHANNELS.SEARCH_INDEX_STATUS) return status({ state: 'ready' })
      if (channel === IPC_CHANNELS.MESSAGES_LIST) return { data: [], total: 0, page: 1 }
      if (channel === IPC_CHANNELS.MESSAGES_SEARCH) return []
      return []
    })

    renderMessages()
    await act(async () => {})
    await searchKeyword('ab')

    expect(screen.getByText('回退到最近 30 天搜索（索引未就绪或短关键词）')).toBeTruthy()
  })

  it('索引未就绪时回退 LIKE：显示 30 天回退说明', async () => {
    invokeSafe.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.SEARCH_ENSURE_INDEX) return status({ state: 'building', indexed: 0, total: 5000 })
      if (channel === IPC_CHANNELS.SEARCH_INDEX_STATUS) return status({ state: 'building', indexed: 0, total: 5000 })
      if (channel === IPC_CHANNELS.MESSAGES_LIST) return { data: [], total: 0, page: 1 }
      if (channel === IPC_CHANNELS.MESSAGES_SEARCH) return []
      return []
    })

    renderMessages()
    await act(async () => {})
    await searchKeyword('很长的关键词')

    expect(screen.getByText('回退到最近 30 天搜索（索引未就绪或短关键词）')).toBeTruthy()
    // building 进度行同时存在（error 优先级之下，building 优先于 fallback 说明）
    expect(screen.getByText(/正在建立搜索索引/)).toBeTruthy()
  })

  it('error：失败提示 + 重试；重试重发 ensure_index 与当前搜索', async () => {
    invokeSafe.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.SEARCH_ENSURE_INDEX) throw new Error('索引目录不可写')
      if (channel === IPC_CHANNELS.MESSAGES_LIST) return { data: [], total: 0, page: 1 }
      if (channel === IPC_CHANNELS.MESSAGES_SEARCH) return []
      return []
    })

    renderMessages()
    await act(async () => {})
    await searchKeyword('数据库')

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('搜索索引构建失败，已回退到最近 30 天搜索')
    expect(alert.textContent).toContain('索引目录不可写')

    expect(callsTo(IPC_CHANNELS.SEARCH_ENSURE_INDEX)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await act(async () => {})

    // 重试：重发 ensure_index 与当前关键词搜索
    expect(callsTo(IPC_CHANNELS.SEARCH_ENSURE_INDEX)).toHaveLength(2)
    await waitFor(() => {
      expect(callsTo(IPC_CHANNELS.MESSAGES_SEARCH).length).toBeGreaterThanOrEqual(2)
    })
  })

  it('迁移进行中不触发 ensure（库不健康）', async () => {
    invokeSafe.mockImplementation(async (channel: string) => {
      if (channel === IPC_CHANNELS.MESSAGES_LIST) return { data: [], total: 0, page: 1 }
      return []
    })

    renderMessages({ migrationPhase: 'running', mode: 'v1', hasLegacyTables: true })
    await act(async () => {})

    expect(callsTo(IPC_CHANNELS.SEARCH_ENSURE_INDEX)).toHaveLength(0)
  })
})
