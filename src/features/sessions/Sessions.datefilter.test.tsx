/**
 * 会话浏览页日期筛选口径单测 —— 三个缺陷的回归保护：
 *
 *   1. off-by-one：后端窗口两端都含（start 当天 00:00:00 ~ end 当天 23:59:59），
 *      所以「近3天/近一周/近一月」必须是**含今日在内**的 3/7/30 个自然日，
 *      起点是「今天 − (N−1) 天」，不是「今天 − N 天」。
 *   2. UTC 日期：旧实现用 `toISOString().slice(0,10)`（UTC）。在 UTC+8 的
 *      每天 08:00 之前它返回「昨天」，用户点「今天」实际筛的是昨天。
 *   3. 夏令时切换日：旧实现用 `Date.now() - n * 86_400_000`（减毫秒）算起点，
 *      跨过夏令时边界时本地墙钟偏移 ±1 小时 → 本地日期翻转一天
 *      （春季变 8 天、秋季变 6 天）。见文件末尾的专项 describe。
 *
 * 测试固定「现在」= 2026-10-24 00:30 (+08:00)（UTC 那天还是 10-23），
 * 正好落在这个 8 小时窗口里：旧实现在这里必然算错。
 *
 * 期望值一律写成**字面日期串**（时区 + 时钟钉死），
 * 不是照抄实现公式 —— 照抄的断言在夏令时切换日会跟着实现一起错。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import Sessions from './Sessions'
import { DataSourceContext, type DataSourceState } from '@/features/datasource/DataSourceContext'
import { ToastProvider } from '@/components/ToastProvider'
import { IPC_CHANNELS } from '@shared/ipc-channels'
import type { SchemaInfoDTO } from '@shared/types'
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

/** 原来的时区，用完还原 */
const ORIGINAL_TZ = process.env.TZ
/** 2026-10-24 00:30 (+08:00) = 2026-10-23T16:30Z（UTC 日期还是「昨天」） */
const FIXED_NOW = new Date('2026-10-23T16:30:00Z')

beforeEach(() => {
  // 固定到 UTC+8：只有在这个时区下，UTC 日期与本地日期才差一天
  process.env.TZ = 'Asia/Shanghai'
  // 只伪造 Date（定时器保持真实，testing-library 的 waitFor 才能正常轮询）
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)

  invokeSafe.mockImplementation((channel: string) => {
    if (channel === IPC_CHANNELS.SESSIONS_LIST) {
      return Promise.resolve({ data: [], total: 0, page: 1, pageSize: 10 })
    }
    return Promise.resolve([])
  })
})

afterEach(() => {
  cleanup()
  invokeSafe.mockReset()
  vi.useRealTimers()
  // process.env.TZ = undefined 会写成字符串 "undefined"，必须 delete
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

function info(overrides: Partial<SchemaInfoDTO> = {}): SchemaInfoDTO {
  return {
    mode: 'v2',
    migrationPhase: 'completed',
    hasLegacyTables: false,
    v2SessionCount: 3,
    unsupportedReason: null,
    ...overrides,
  }
}

function renderSessions() {
  const schema: SchemaUiState = { kind: 'ready', info: info() }
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

/** 最近一次会话列表请求带的日期条件。 */
function lastDateFilter(): { startDate?: string; endDate?: string } {
  const calls = invokeSafe.mock.calls.filter(([channel]) => channel === IPC_CHANNELS.SESSIONS_LIST)
  const last = calls[calls.length - 1]
  return (last?.[1] ?? {}) as { startDate?: string; endDate?: string }
}

/** 两个 YYYY-MM-DD 之间的天数差（按日历日算，不受夏令时影响）。 */
function dayDiff(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number)
  const [y2, m2, d2] = to.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000)
}
/** 打开日期下拉并选中某个预设，返回该次请求实际带的日期条件。 */
async function selectPreset(label: string): Promise<{ startDate?: string; endDate?: string }> {
  renderSessions()
  await waitFor(() =>
    expect(invokeSafe).toHaveBeenCalledWith(IPC_CHANNELS.SESSIONS_LIST, expect.anything()),
  )

  // 触发按钮初始显示「日期范围」；下拉里的预设项此时是唯一同名元素
  fireEvent.click(screen.getByRole('button', { name: '日期范围' }))
  fireEvent.click(screen.getByRole('button', { name: label }))

  await waitFor(() => expect(lastDateFilter().startDate).toBeTruthy())
  return lastDateFilter()
}

describe('会话浏览页日期筛选口径', () => {
  it('「今天」取本地当天，不是 UTC 的昨天', async () => {
    const filter = await selectPreset('今天')

    // 本地当天是 2026-10-24；同一时刻的 UTC 日期还是 2026-10-23
    expect(filter.startDate).toBe('2026-10-24')
    expect(filter.endDate).toBe('2026-10-24')
    expect(filter.startDate).toBe(filter.endDate)
  })

  it('「近3天」= 含今日在内的 3 个自然日', async () => {
    const filter = await selectPreset('近3天')

    expect(filter.startDate).toBe('2026-10-22')
    expect(filter.endDate).toBe('2026-10-24')
    // 端点差 2 天 → 区间含 3 个自然日
    expect(dayDiff(filter.startDate!, filter.endDate!)).toBe(2)
  })

  it('「近一周」= 含今日在内的 7 个自然日', async () => {
    const filter = await selectPreset('近一周')

    expect(filter.startDate).toBe('2026-10-18')
    expect(filter.endDate).toBe('2026-10-24')
    // 端点差 6 天 → 区间含 7 个自然日
    expect(dayDiff(filter.startDate!, filter.endDate!)).toBe(6)
  })

  it('「近一月」= 含今日在内的 30 个自然日', async () => {
    const filter = await selectPreset('近一月')

    expect(filter.startDate).toBe('2026-09-25')
    expect(filter.endDate).toBe('2026-10-24')
    // 端点差 29 天 → 区间含 30 个自然日
    expect(dayDiff(filter.startDate!, filter.endDate!)).toBe(29)
  })
})

/**
 * 夏令时切换日专项 —— 预设起点必须按**日历日**算。
 *
 * 背景：旧实现用 `Date.now() - n * 86_400_000`（减毫秒）算起点，
 * 跨过夏令时边界时本地墙钟偏移 ±1 小时 → 本地日期翻转一天：
 *   - 春季跳表落在窗口内 → 区间变成 8 天（起点早一天）
 *   - 秋季回拨落在窗口内 → 区间变成 6 天（起点晚一天）
 *
 * 期望值写成**字面日期串**：时区与时钟都钉死，断言钉的是日历语义本身，
 * 不是「照抄实现公式」——那种断言在切换日会跟着实现一起错。
 */
describe('会话浏览页日期筛选口径（夏令时切换日）', () => {
  beforeEach(() => {
    // 固定到有夏令时的时区（美国东部时间）
    process.env.TZ = 'America/New_York'
  })

  afterEach(() => {
    // 还原给同文件其它用例
    process.env.TZ = 'Asia/Shanghai'
  })

  it('春季跳表（2026-03-08）落在窗口内：「近一周」起点是 3/8，不是 3/7', async () => {
    // 本地 2026-03-14 00:30 (-04:00 EDT) = 2026-03-14T04:30Z
    vi.setSystemTime(new Date('2026-03-14T04:30:00Z'))

    const filter = await selectPreset('近一周')

    expect(filter.startDate).toBe('2026-03-08')
    expect(filter.endDate).toBe('2026-03-14')
    // 端点差恰好 6 天 → 区间含 7 个自然日（不是 8 天）
    expect(dayDiff(filter.startDate!, filter.endDate!)).toBe(6)
  })

  it('秋季回拨（2026-11-01）落在窗口内：「近一周」起点是 10/27，不是 10/28', async () => {
    // 本地 2026-11-02 23:30 (-05:00 EST) = 2026-11-03T04:30Z
    vi.setSystemTime(new Date('2026-11-03T04:30:00Z'))

    const filter = await selectPreset('近一周')

    expect(filter.startDate).toBe('2026-10-27')
    expect(filter.endDate).toBe('2026-11-02')
    // 端点差恰好 6 天 → 区间含 7 个自然日（不是 6 天）
    expect(dayDiff(filter.startDate!, filter.endDate!)).toBe(6)
  })

  it('夏令时切换日：「近3天」同样按日历日', async () => {
    // 本地 2026-03-14 00:30 (-04:00 EDT)
    vi.setSystemTime(new Date('2026-03-14T04:30:00Z'))

    const three = await selectPreset('近3天')
    expect(three.startDate).toBe('2026-03-12')
    expect(three.endDate).toBe('2026-03-14')
    expect(dayDiff(three.startDate!, three.endDate!)).toBe(2)
  })
})
