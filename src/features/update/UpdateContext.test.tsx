/**
 * UpdateContext 单测 —— 覆盖检查/下载状态机与失败分支：
 *   - check() 返回 null → 已是最新（成功路径，不是错误）
 *   - check() 返回更新 → 有更新 + 打开弹窗
 *   - check() 抛错 → **必须写入 error**（否则渲染不出错误态）+ 失败状态
 *   - download() 复用 check() 的结果，**不再发第二次检查请求**
 *   - download() 接入真实进度事件
 *   - 非 Tauri 环境不做任何事
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { DownloadEvent } from '@tauri-apps/plugin-updater'
import { UpdateProvider } from './UpdateContext'
import { useUpdateStatus } from './useUpdateStatus'
import type { UseUpdateStatus } from './useUpdateStatus'

const { checkMock, isTauriMock, addToast, relaunchMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
  addToast: vi.fn(),
  relaunchMock: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: checkMock,
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: relaunchMock,
}))

vi.mock('@/lib/ipc', () => ({
  isTauri: isTauriMock,
}))

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ addToast }),
}))

let latest: UseUpdateStatus
/** 记录每次渲染时的进度快照，用来验证真实进度事件确实被消费 */
const progressLog: Array<UseUpdateStatus['progress']> = []

function Consumer() {
  latest = useUpdateStatus()
  progressLog.push(latest.progress)
  return null
}

function renderProvider() {
  render(
    <UpdateProvider>
      <Consumer />
    </UpdateProvider>,
  )
}

function makeUpdate(overrides: Record<string, unknown> = {}) {
  return {
    version: '1.4.1',
    date: '2026-10-01T00:00:00Z',
    body: '修复若干问题',
    downloadAndInstall: vi.fn(async () => {}),
    ...overrides,
  }
}

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  checkMock.mockReset()
  addToast.mockReset()
  relaunchMock.mockReset()
  relaunchMock.mockResolvedValue(undefined)
  progressLog.length = 0
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UpdateProvider.check', () => {
  it('check() 返回 null → 已是最新（不写 error）', async () => {
    checkMock.mockResolvedValue(null)
    renderProvider()
    await act(async () => { await latest.check() })

    expect(latest.checkStatus).toBe('up-to-date')
    expect(latest.error).toBeNull()
    expect(latest.state).toBe('idle')
    expect(latest.info).toBeNull()
    expect(latest.lastCheckedAt).not.toBeNull()
  })

  it('check() 找到更新 → 有更新 + 打开弹窗', async () => {
    checkMock.mockResolvedValue(makeUpdate())
    renderProvider()
    await act(async () => { await latest.check() })

    expect(latest.checkStatus).toBe('available')
    expect(latest.state).toBe('available')
    expect(latest.info?.version).toBe('1.4.1')
    expect(latest.dialogOpen).toBe(true)
    expect(latest.error).toBeNull()
  })

  it('check() 抛错 → 写入 error 并进入失败状态（不再谎报「已是最新」）', async () => {
    // 插件把错误序列化成纯字符串，err.message 为 undefined
    checkMock.mockRejectedValue('Could not fetch a valid release JSON from the remote')
    renderProvider()
    await act(async () => { await latest.check() })

    expect(latest.checkStatus).toBe('failed')
    expect(latest.error).not.toBeNull()
    expect(latest.error?.code).toBe('manifest-missing')
    expect(latest.error?.message).not.toContain('已是最新')
    expect(latest.state).toBe('idle')
  })

  it('非 Tauri 环境不做检查', async () => {
    isTauriMock.mockReturnValue(false)
    renderProvider()
    await act(async () => { await latest.check() })

    expect(checkMock).not.toHaveBeenCalled()
    expect(latest.checkStatus).toBe('idle')
  })

  it('并发调用只发出一次 check()（双击守卫）', async () => {
    // 模拟按钮双击：两次 check() 在同一个 tick 内发起
    let resolveCheck!: (v: unknown) => void
    checkMock.mockImplementation(() => new Promise(resolve => { resolveCheck = resolve }))

    renderProvider()
    await act(async () => {
      void latest.check()
      void latest.check()
      void latest.check()
    })

    // 守卫是同步生效的：只有第一次真的发出了请求
    expect(checkMock).toHaveBeenCalledTimes(1)

    await act(async () => { resolveCheck(null) })

    expect(checkMock).toHaveBeenCalledTimes(1)
    expect(latest.checkStatus).toBe('up-to-date')
  })

  it('上一次检查结束后可以再次检查（守卫不会永久卡死）', async () => {
    checkMock.mockResolvedValue(null)
    renderProvider()
    await act(async () => { await latest.check() })
    await act(async () => { await latest.check() })

    expect(checkMock).toHaveBeenCalledTimes(2)
    expect(latest.isChecking).toBe(false)
  })
})

describe('UpdateProvider.download', () => {
  it('复用 check() 的结果，不再发第二次检查请求', async () => {
    const update = makeUpdate()
    checkMock.mockResolvedValue(update)
    renderProvider()
    await act(async () => { await latest.check() })
    expect(checkMock).toHaveBeenCalledTimes(1)

    await act(async () => { await latest.download() })

    expect(checkMock).toHaveBeenCalledTimes(1)
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)
    expect(latest.state).toBe('downloaded')
  })

  it('接入真实进度事件（不再硬编码 0 → 50 → 100）', async () => {
    let onEvent: ((e: DownloadEvent) => void) | undefined
    const update = makeUpdate({
      downloadAndInstall: vi.fn(async (cb: (e: DownloadEvent) => void) => { onEvent = cb }),
    })
    checkMock.mockResolvedValue(update)
    renderProvider()
    await act(async () => { await latest.check() })
    await act(async () => { await latest.download() })

    // 事件回调确实传给了插件
    expect(typeof onEvent).toBe('function')

    // 模拟插件推送真实进度：总共 100 字节，已收到 40 字节
    await act(async () => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } })
      onEvent?.({ event: 'Progress', data: { chunkLength: 40 } })
    })

    expect(latest.progress?.total).toBe(100)
    expect(latest.progress?.transferred).toBe(40)
    expect(latest.progress?.percent).toBe(40)
    // 不再出现硬编码的 50%
    expect(progressLog.some(p => p?.percent === 50)).toBe(false)
  })

  it('下载失败 → 写入 error 并回到「有更新」，允许重试', async () => {
    const update = makeUpdate({
      downloadAndInstall: vi.fn(async () => { throw new Error('Download request failed with status: 500') }),
    })
    checkMock.mockResolvedValue(update)
    renderProvider()
    await act(async () => { await latest.check() })
    await act(async () => { await latest.download() })

    expect(latest.error?.code).toBe('download-failed')
    expect(latest.state).toBe('available')
  })

  it('并发调用只下载一次（双击守卫，不会并发跑两次 downloadAndInstall）', async () => {
    // 双击「立即更新」：三次 download() 在同一个 tick 内发起
    let resolveDownload!: () => void
    const update = makeUpdate({
      downloadAndInstall: vi.fn(() => new Promise<void>(resolve => { resolveDownload = resolve })),
    })
    checkMock.mockResolvedValue(update)
    renderProvider()
    await act(async () => { await latest.check() })

    await act(async () => {
      void latest.download()
      void latest.download()
      void latest.download()
    })

    // 守卫是同步生效的：同一个 Update 实例上只跑了一次下载
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)

    await act(async () => { resolveDownload() })

    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1)
    expect(latest.state).toBe('downloaded')
  })

  it('下载失败后可以重试（守卫不会永久卡死）', async () => {
    const downloadAndInstall = vi.fn()
      .mockRejectedValueOnce(new Error('Download request failed with status: 500'))
      .mockResolvedValueOnce(undefined)
    const update = makeUpdate({ downloadAndInstall })
    checkMock.mockResolvedValue(update)
    renderProvider()
    await act(async () => { await latest.check() })

    await act(async () => { await latest.download() })
    expect(latest.state).toBe('available')

    await act(async () => { await latest.download() })
    expect(downloadAndInstall).toHaveBeenCalledTimes(2)
    expect(latest.state).toBe('downloaded')
  })
})

describe('UpdateProvider.install', () => {
  /** 先跑一遍 check + download，把状态推到「已下载待安装」 */
  async function reachDownloaded(): Promise<void> {
    checkMock.mockResolvedValue(makeUpdate())
    renderProvider()
    await act(async () => { await latest.check() })
    await act(async () => { await latest.download() })
    expect(latest.state).toBe('downloaded')
  }

  it('并发调用只重启一次（双击守卫，不会重复 relaunch）', async () => {
    await reachDownloaded()
    let resolveRelaunch!: () => void
    relaunchMock.mockImplementation(() => new Promise<void>(resolve => { resolveRelaunch = resolve }))

    await act(async () => {
      void latest.install()
      void latest.install()
      void latest.install()
    })

    // 守卫是同步生效的：只重启了一次
    expect(relaunchMock).toHaveBeenCalledTimes(1)

    await act(async () => { resolveRelaunch() })
    expect(relaunchMock).toHaveBeenCalledTimes(1)
  })

  it('重启失败 → 回到「已下载待安装」，允许再点一次安装', async () => {
    await reachDownloaded()
    relaunchMock.mockRejectedValueOnce(new Error('relaunch failed'))

    await act(async () => { await latest.install() })

    expect(addToast).toHaveBeenCalledWith('重启失败，请手动启动应用。', 'error')
    expect(latest.state).toBe('downloaded')

    await act(async () => { await latest.install() })
    expect(relaunchMock).toHaveBeenCalledTimes(2)
  })
})

describe('UpdateProvider.dismissDialog', () => {
  it('关闭弹窗后仍保留「有更新」结论', async () => {
    checkMock.mockResolvedValue(makeUpdate())
    renderProvider()
    await act(async () => { await latest.check() })
    expect(latest.dialogOpen).toBe(true)

    await act(async () => { latest.dismissDialog() })

    expect(latest.dialogOpen).toBe(false)
    expect(latest.state).toBe('available')
    expect(latest.info?.version).toBe('1.4.1')
  })
})
