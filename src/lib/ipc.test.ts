/**
 * IPC 封装单测 —— 覆盖 schema 读取与「重新检测」的 payload 形状。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { tauriInvoke } = vi.hoisted(() => ({ tauriInvoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriInvoke,
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(),
}))

import { fetchSchemaInfo } from './ipc'

const SCHEMA = {
  mode: 'v1',
  migrationPhase: 'none',
  hasLegacyTables: false,
  v2SessionCount: 0,
  unsupportedReason: null,
}

afterEach(() => {
  tauriInvoke.mockReset()
})

describe('fetchSchemaInfo', () => {
  it('普通读取不带参数', async () => {
    tauriInvoke.mockResolvedValue({ success: true, data: SCHEMA })
    const info = await fetchSchemaInfo()
    expect(tauriInvoke).toHaveBeenCalledWith('database_info', undefined)
    expect(info.mode).toBe('v1')
  })

  it('「重新检测」传 refresh: true（对应后端 TASK-051 的可选参数）', async () => {
    tauriInvoke.mockResolvedValue({ success: true, data: { ...SCHEMA, mode: 'v2' } })
    const info = await fetchSchemaInfo({ refresh: true })
    expect(tauriInvoke).toHaveBeenCalledWith('database_info', { refresh: true })
    expect(info.mode).toBe('v2')
  })

  it('失败时抛出后端错误信息', async () => {
    tauriInvoke.mockResolvedValue({ success: false, error: '没有已连接的数据库' })
    await expect(fetchSchemaInfo()).rejects.toThrow('没有已连接的数据库')
  })
})
