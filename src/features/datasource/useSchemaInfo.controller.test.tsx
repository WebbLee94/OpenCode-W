/**
 * useSchemaInfoController 单测 —— 后端返回 unsupported DTO 的优先级。
 *
 * 后端方案 A：`database:info` 在 pool 未打开时用 last_attempt_path 重探，
 * 直接返回 `mode: 'unsupported'` 的 DTO。这份 DTO 必须优先于前端合成的
 * unsupported 状态（原因取后端的 `unsupportedReason`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'

const { fetchSchemaInfo } = vi.hoisted(() => ({ fetchSchemaInfo: vi.fn() }))

vi.mock('@/lib/ipc', () => ({
  fetchSchemaInfo,
  isTauri: () => true,
}))

import { useSchemaInfoController, deriveSchemaState } from './useSchemaInfo'
import type { SchemaInfoDTO } from '@shared/types'

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
  fetchSchemaInfo.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useSchemaInfoController', () => {
  it('后端返回 unsupported DTO → 派生状态为 unsupported，原因取后端', async () => {
    fetchSchemaInfo.mockResolvedValue(
      info({ mode: 'unsupported', unsupportedReason: '缺少 session_message / session_v2 等表' }),
    )

    const { result } = renderHook(() => useSchemaInfoController())

    await waitFor(() => expect(result.current.state.kind).toBe('ready'))
    const derived = deriveSchemaState(result.current.state)
    expect(derived.key).toBe('unsupported')
    expect(derived.isSchemaBlocked).toBe(true)
    expect(derived.reason).toBe('缺少 session_message / session_v2 等表')
  })

  it('后端返回 unsupported DTO 时覆盖前端合成的 unsupported 状态', async () => {
    fetchSchemaInfo.mockResolvedValue(
      info({ mode: 'unsupported', unsupportedReason: '后端给的原因' }),
    )

    const { result } = renderHook(() => useSchemaInfoController())
    await waitFor(() => expect(result.current.state.kind).toBe('ready'))

    // 前端先合成一个 unsupported（原因不同）
    act(() => {
      result.current.reportUnsupported('/tmp/bad.db', '前端合成的原因')
    })
    expect(deriveSchemaState(result.current.state).reason).toBe('前端合成的原因')

    // 重新检测拿到后端 DTO → 以后端为准
    await act(async () => {
      await result.current.refresh()
    })

    const derived = deriveSchemaState(result.current.state)
    expect(derived.key).toBe('unsupported')
    expect(derived.reason).toBe('后端给的原因')
    // 路径沿用前端记录的尝试路径（后端 DTO 不带路径）
    expect(derived.path).toBe('/tmp/bad.db')
  })

  it('后端返回正常 DTO 时清除前端合成的 unsupported 状态', async () => {
    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v2', migrationPhase: 'completed' }))

    const { result } = renderHook(() => useSchemaInfoController())
    await waitFor(() => expect(result.current.state.kind).toBe('ready'))

    act(() => {
      result.current.reportUnsupported('/tmp/bad.db', '前端合成的原因')
    })
    expect(deriveSchemaState(result.current.state).key).toBe('unsupported')

    await act(async () => {
      await result.current.refresh()
    })

    const derived = deriveSchemaState(result.current.state)
    expect(derived.key).toBe('v2')
    expect(derived.isSchemaBlocked).toBe(false)
  })

  it('重新检测失败时保留原状态并给出错误信息', async () => {
    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v1' }))

    const { result } = renderHook(() => useSchemaInfoController())
    await waitFor(() => expect(result.current.state.kind).toBe('ready'))

    fetchSchemaInfo.mockRejectedValue(new Error('没有已连接的数据库'))
    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.refreshError).toBe('没有已连接的数据库')
    expect(deriveSchemaState(result.current.state).key).toBe('v1')
  })

  it('mode 变化时暴露 schemaChanged（v1 → v2-mixed）', async () => {
    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v1' }))

    const { result } = renderHook(() => useSchemaInfoController())
    await waitFor(() => expect(result.current.state.kind).toBe('ready'))
    expect(result.current.schemaChanged).toBeNull()

    // 运行期 OpenCode 完成迁移，refresh 读到新形态
    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v2-mixed', migrationPhase: 'completed' }))
    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.schemaChanged).toEqual({ from: 'v1', to: 'v2-mixed' })
  })

  it('mode 未变化时不产生 schemaChanged', async () => {
    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v1' }))

    const { result } = renderHook(() => useSchemaInfoController())
    await waitFor(() => expect(result.current.state.kind).toBe('ready'))

    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v1', migrationPhase: 'completed' }))
    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.schemaChanged).toBeNull()
  })

  it('clearSchemaChanged 清除提示', async () => {
    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v1' }))

    const { result } = renderHook(() => useSchemaInfoController())
    await waitFor(() => expect(result.current.state.kind).toBe('ready'))

    fetchSchemaInfo.mockResolvedValue(info({ mode: 'v2-mixed' }))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.schemaChanged).not.toBeNull()

    act(() => {
      result.current.clearSchemaChanged()
    })
    expect(result.current.schemaChanged).toBeNull()
  })
})
