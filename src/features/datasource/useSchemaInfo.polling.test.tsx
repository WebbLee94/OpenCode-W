/**
 * 「running 下无自动轮询」补测 —— 对应 TEST-014 后半段与 08.1 规格 1.6 / 6.1
 * 「迁移期间不与 OpenCode 抢 SQLite 锁，因此不自动轮询」。
 *
 * 既有覆盖情况：**没有任何测试断言过「running 状态下不会重复发起 database:info」**。
 * 既有的 `useSchemaInfo.controller.test.tsx` 只验证 DTO 优先级与 schemaChanged；
 * `DatabaseModeBadge.test.tsx` 只验证「停滞提示」的时间推进。
 *
 * 本文件用 fake timers 证明：
 *   1. `useSchemaInfoController` 只在挂载时拉一次 schema，running 状态下静置 10 分钟
 *      **不会**再发 `database:info`；
 *   2. `DatabaseModeBadge` 内部的 30s 计时器只是本地时钟（用于「已持续 N 分钟」文案），
 *      **不发任何 IPC**；
 *   3. 徽标 + 控制器同时挂载（最接近真实页面的组合）时，10 分钟内 IPC 次数保持为 1。
 *
 * 纯前端，不依赖 Tauri / 真实数据库。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { DatabaseModeBadge } from '@/components/DatabaseModeBadge'
import { useSchemaInfoController } from './useSchemaInfo'
import type { SchemaInfoDTO } from '@shared/types'

const { fetchSchemaInfo, isTauri } = vi.hoisted(() => ({
  fetchSchemaInfo: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock('@/lib/ipc', () => ({
  fetchSchemaInfo,
  isTauri,
}))

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

beforeEach(() => {
  vi.useFakeTimers()
  fetchSchemaInfo.mockReset()
  isTauri.mockReset()
  isTauri.mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** 推进 fake timers 并把挂起的 Promise 一并 flush */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

describe('running 状态无自动轮询', () => {
  it('控制器：running 状态下静置 10 分钟，database:info 仍只调用 1 次', async () => {
    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v1', migrationPhase: 'running' }))

    const { result } = renderHook(() => useSchemaInfoController())
    await advance(0)

    expect(fetchSchemaInfo).toHaveBeenCalledTimes(1)
    expect(result.current.state.kind).toBe('ready')

    await advance(10 * 60_000)

    expect(fetchSchemaInfo, 'running 状态下不应重复拉取 schema').toHaveBeenCalledTimes(1)
    expect(result.current.state.kind).toBe('ready')
  })

  it('控制器：failed 状态同样不轮询（读只写锁的迁移失败态也不抢锁）', async () => {
    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v1', migrationPhase: 'failed' }))

    renderHook(() => useSchemaInfoController())
    await advance(0)
    expect(fetchSchemaInfo).toHaveBeenCalledTimes(1)

    await advance(10 * 60_000)
    expect(fetchSchemaInfo).toHaveBeenCalledTimes(1)
  })

  it('徽标：30 秒计时器只更新本地时钟，10 分钟内不发任何 IPC', async () => {
    render(<DatabaseModeBadge state={{ kind: 'ready', info: info({ mode: 'v1', migrationPhase: 'running' }) }} />)

    await advance(10 * 60_000)

    expect(fetchSchemaInfo, '徽标不应发起任何 IPC').not.toHaveBeenCalled()
    expect(isTauri, '徽标不应探测运行环境').not.toHaveBeenCalled()
    // 计时器确实在跑（停滞提示出现），说明「不轮询」不是因为「计时器没启动」
    expect(screen.getByText(/迁移已持续/)).toBeTruthy()
  })

  it('徽标 + 控制器同时挂载：10 分钟内 database:info 总次数保持为 1', async () => {
    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v1', migrationPhase: 'running' }))

    function Harness() {
      const controller = useSchemaInfoController()
      return <DatabaseModeBadge state={controller.state} />
    }

    render(<Harness />)
    await advance(0)
    expect(fetchSchemaInfo).toHaveBeenCalledTimes(1)

    await advance(10 * 60_000)
    expect(fetchSchemaInfo).toHaveBeenCalledTimes(1)
  })

  it('重新检测是唯一会再次拉取 schema 的入口（显式点击，非自动）', async () => {
    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v1', migrationPhase: 'running' }))

    const { result } = renderHook(() => useSchemaInfoController())
    await advance(0)
    expect(fetchSchemaInfo).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.refresh()
    })
    expect(fetchSchemaInfo).toHaveBeenCalledTimes(2)

    // 自动轮询依然没有发生
    await advance(10 * 60_000)
    expect(fetchSchemaInfo).toHaveBeenCalledTimes(2)
  })
})
