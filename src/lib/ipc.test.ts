/**
 * IPC 封装单测 —— 覆盖 schema 读取与「重新检测」的 payload 形状。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const { tauriInvoke, shellOpen } = vi.hoisted(() => ({
  tauriInvoke: vi.fn(),
  shellOpen: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriInvoke,
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: shellOpen,
}))

import { fetchSchemaInfo, openExternal } from './ipc'

const SCHEMA = {
  mode: 'v1',
  migrationPhase: 'none',
  hasLegacyTables: false,
  v2SessionCount: 0,
  unsupportedReason: null,
}

afterEach(() => {
  tauriInvoke.mockReset()
  shellOpen.mockReset()
  vi.restoreAllMocks()
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

describe('openExternal', () => {
  /** 临时伪装成 Tauri 环境（isTauri() 只看 window 上有没有这两个键） */
  function enterTauri(): void {
    const w = window as unknown as Record<string, unknown>
    w.__TAURI_INTERNALS__ = {}
  }

  afterEach(() => {
    const w = window as unknown as Record<string, unknown>
    delete w.__TAURI_INTERNALS__
  })

  it('Tauri 环境：走 shell.open，不碰 window.open', async () => {
    enterTauri()
    shellOpen.mockResolvedValue(undefined)
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)

    const result = await openExternal('https://example.com/x')

    expect(result).toBe('system')
    expect(shellOpen).toHaveBeenCalledWith('https://example.com/x')
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('Tauri 环境：shell.open 失败 → 降级到 window.open', async () => {
    enterTauri()
    shellOpen.mockRejectedValue(new Error('shell unavailable'))
    const fakeWin = { opener: {} as unknown } as unknown as Window
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin)

    const result = await openExternal('https://example.com/x')

    expect(result).toBe('builtin')
    expect(openSpy).toHaveBeenCalledWith('https://example.com/x', '_blank')
  })

  it('浏览器降级：window.open 不带 noopener —— 否则 Chromium 会返回 null', async () => {
    const fakeWin = { opener: {} as unknown } as unknown as Window
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin)

    const result = await openExternal('https://example.com/x')

    expect(result).toBe('builtin')
    // ⚠️ 不能带 'noopener,noreferrer'：规范规定带 noopener 时 window.open 返回
    // null，会被误判成「打开失败」。这里只开普通新窗口，再手动断开 opener。
    expect(openSpy).toHaveBeenCalledWith('https://example.com/x', '_blank')
    // opener 已被断开（等价 noopener）
    expect(fakeWin.opener).toBeNull()
  })

  it('浏览器降级：window.open 返回 null（被拦截）→ 抛错，由调用方展示 URL 供复制', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    await expect(openExternal('https://example.com/x')).rejects.toThrow('打开内置浏览器失败')
  })

  it('浏览器降级：window.open 抛错（严格 CSP / 沙箱）→ 抛错而不是未捕获异常', async () => {
    vi.spyOn(window, 'open').mockImplementation(() => { throw new Error('blocked') })
    await expect(openExternal('https://example.com/x')).rejects.toThrow('打开内置浏览器失败')
  })

  it('空链接直接抛错', async () => {
    await expect(openExternal('')).rejects.toThrow('链接为空')
  })
})
