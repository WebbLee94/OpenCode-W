/**
 * UpdateSection 单测 —— 覆盖「版本更新」区的状态机与文案映射：
 *   - 非 Tauri / 未检查 / 检查中 / 已是最新 / 有更新 / 下载中 / 已下载 / 安装中
 *   - 检查失败：network / ratelimit / unknown / manifest-missing / no-platform-asset / signature-failed
 *   - 「可更新版本」行只在真的有更新时渲染
 *   - 回归：后端返回 v2 / legacy 之类无关字段时，不得出现额外分列或错误文案
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UpdateSection } from './UpdateSection'
import { UpdateContext } from '@/features/update/UpdateContext'
import type { UseUpdateStatus } from '@/features/update/useUpdateStatus'
import type { UpdateErrorCode, UpdateInfo } from '@shared/types'
import { UPDATE_ERROR_COPY } from '@/features/update/errorClassifier'

const { isTauriMock, getVersionMock, addToast, writeText, openExternalMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => true),
  getVersionMock: vi.fn(() => Promise.resolve('1.4.0')),
  addToast: vi.fn(),
  writeText: vi.fn(() => Promise.resolve()),
  openExternalMock: vi.fn<(url: string) => Promise<'system' | 'builtin'>>(),
}))

vi.mock('@/lib/ipc', () => ({
  isTauri: isTauriMock,
  openExternal: openExternalMock,
}))

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: getVersionMock,
}))

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ addToast }),
}))

const INFO: UpdateInfo = {
  version: '1.4.1',
  releaseDate: '2026-10-01T00:00:00Z',
  releaseNotes: '修复若干问题',
  sizeBytes: 0,
}

function makeContext(overrides: Partial<UseUpdateStatus> = {}): UseUpdateStatus {
  return {
    state: 'idle',
    checkStatus: 'idle',
    info: null,
    progress: null,
    error: null,
    isChecking: false,
    lastCheckedAt: null,
    dialogOpen: false,
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    dismissDialog: vi.fn(),
    ...overrides,
  }
}

function renderSection(overrides: Partial<UseUpdateStatus> = {}) {
  const value = makeContext(overrides)
  render(
    <UpdateContext.Provider value={value}>
      <UpdateSection />
    </UpdateContext.Provider>,
  )
  return value
}

function statusText(): string {
  return screen.getByTestId('update-status').textContent?.trim() ?? ''
}

beforeEach(() => {
  isTauriMock.mockReturnValue(true)
  getVersionMock.mockResolvedValue('1.4.0')
  openExternalMock.mockResolvedValue('system')
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UpdateSection 状态机', () => {
  it('非 Tauri（浏览器预览）：提示不支持，可更新版本行不渲染', () => {
    isTauriMock.mockReturnValue(false)
    renderSection({ checkStatus: 'idle' })
    expect(statusText()).toBe('浏览器预览环境不支持检查更新，请在桌面应用中查看版本信息。')
    expect(screen.queryByTestId('update-available-version')).toBeNull()
    expect(screen.queryByText('可更新版本')).toBeNull()
  })

  it('未检查：提示尚未检查，可更新版本行不渲染', () => {
    renderSection()
    expect(statusText()).toBe('尚未检查更新。')
    expect(screen.queryByTestId('update-available-version')).toBeNull()
  })

  it('未检查时不显示「上次检查」行', () => {
    renderSection({ lastCheckedAt: null })
    expect(screen.queryByText('上次检查')).toBeNull()
  })

  it('检查中：提示正在检查', () => {
    renderSection({ checkStatus: 'checking', isChecking: true })
    expect(statusText()).toBe('正在检查更新…')
  })

  it('已是最新：提示无需更新，可更新版本行不渲染', () => {
    renderSection({ checkStatus: 'up-to-date', lastCheckedAt: 1_700_000_000_000 })
    expect(statusText()).toBe('已是最新版本，无需更新。')
    expect(screen.queryByTestId('update-available-version')).toBeNull()
    expect(screen.getByText('上次检查')).toBeTruthy()
  })

  it('有更新：渲染「可更新版本」行与对应文案', () => {
    renderSection({
      state: 'available',
      checkStatus: 'available',
      info: INFO,
      lastCheckedAt: 1_700_000_000_000,
    })
    expect(screen.getByTestId('update-available-version').textContent).toBe('v1.4.1')
    expect(screen.getByText('可更新版本')).toBeTruthy()
    expect(statusText()).toBe('发现新版本 v1.4.1，可立即更新。')
  })

  it('下载中：仍展示可更新版本，文案为下载中', () => {
    renderSection({
      state: 'downloading',
      checkStatus: 'available',
      info: INFO,
      progress: { bytesPerSecond: 1024, percent: 42, transferred: 42, total: 100 },
    })
    expect(screen.getByTestId('update-available-version').textContent).toBe('v1.4.1')
    expect(statusText()).toBe('正在下载 v1.4.1…')
  })

  it('已下载待安装：文案提示重启后生效', () => {
    renderSection({
      state: 'downloaded',
      checkStatus: 'available',
      info: INFO,
      progress: { bytesPerSecond: 0, percent: 100, transferred: 100, total: 100 },
    })
    expect(statusText()).toBe('新版本 v1.4.1 已下载完成，重启后生效。')
  })

  it('安装中：文案提示正在安装并重启', () => {
    renderSection({
      state: 'installing',
      checkStatus: 'available',
      info: INFO,
    })
    expect(statusText()).toBe('正在安装并重启应用，请稍候。')
  })
})

describe('UpdateSection 检查失败', () => {
  const cases: Array<[UpdateErrorCode, string]> = [
    ['network', UPDATE_ERROR_COPY.network],
    ['ratelimit', UPDATE_ERROR_COPY.ratelimit],
    ['unknown', UPDATE_ERROR_COPY.unknown],
    ['manifest-missing', UPDATE_ERROR_COPY['manifest-missing']],
    ['no-platform-asset', UPDATE_ERROR_COPY['no-platform-asset']],
    ['signature-failed', UPDATE_ERROR_COPY['signature-failed']],
  ]

  it.each(cases)('%s → 对应文案', (code, message) => {
    renderSection({
      checkStatus: 'failed',
      error: { code, message },
      lastCheckedAt: 1_700_000_000_000,
    })
    expect(statusText()).toBe(message)
    expect(screen.queryByTestId('update-available-version')).toBeNull()
  })

  it('检查失败时不得出现「当前已是最新版本」', () => {
    renderSection({
      checkStatus: 'failed',
      error: { code: 'network', message: UPDATE_ERROR_COPY.network },
    })
    expect(statusText()).not.toContain('已是最新版本，无需更新')
  })
})

describe('UpdateSection 可访问性与交互', () => {
  it('更新状态区是 live region（role=status + aria-live/aria-atomic）', () => {
    renderSection({ checkStatus: 'up-to-date' })
    const region = screen.getByTestId('update-status')
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.getAttribute('aria-atomic')).toBe('true')
  })

  it('section 用 aria-labelledby 关联标题', () => {
    renderSection()
    const section = screen.getByTestId('update-section')
    const labelledBy = section.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toContain('版本更新')
  })

  it('版本号用 dl / dt / dd 组织', () => {
    renderSection()
    expect(screen.getByText('当前版本').tagName).toBe('DT')
  })

  it('复制版本号按钮把当前版本写入剪贴板', async () => {
    renderSection()
    await waitFor(() => expect(screen.getByTestId('update-current-version').textContent).toBe('v1.4.0'))
    fireEvent.click(screen.getByRole('button', { name: '复制版本号' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('v1.4.0'))
    expect(addToast).toHaveBeenCalledWith('已复制版本号 v1.4.0', 'success')
  })

  it('有更新时提供「立即更新」入口，点击后触发下载', () => {
    const value = renderSection({
      state: 'available',
      checkStatus: 'available',
      info: INFO,
    })
    fireEvent.click(screen.getByRole('button', { name: '立即更新' }))
    expect(value.download).toHaveBeenCalledTimes(1)
  })

  it('非 Tauri 环境下「检查更新」按钮不可用', () => {
    isTauriMock.mockReturnValue(false)
    renderSection()
    const btn = screen.getByRole('button', { name: '检查更新' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('UpdateSection 复制按钮（弱化图标 + 读屏反馈）', () => {
  /** 等版本号加载完成再操作（复制按钮依赖 displayVersion） */
  async function renderReady(overrides: Partial<UseUpdateStatus> = {}) {
    const value = renderSection(overrides)
    await waitFor(() => expect(screen.getByTestId('update-current-version').textContent).toBe('v1.4.0'))
    return value
  }

  it('按钮常驻但弱化：不靠隐藏实现，只用颜色层级表达次要性', async () => {
    await renderReady()
    const btn = screen.getByRole('button', { name: '复制版本号' })
    const cls = btn.className

    // 命中区 28×28，触屏可用
    expect(cls).toContain('size-7')
    // 默认弱化 / hover 强化 / 焦点环 / 禁用态
    expect(cls).toContain('text-gray-400')
    expect(cls).toContain('hover:text-gray-700')
    expect(cls).toContain('hover:bg-gray-100')
    expect(cls).toContain('focus-visible:ring-2')
    expect(cls).toContain('focus-visible:ring-brand-500')
    expect(cls).toContain('focus-visible:ring-offset-2')
    expect(cls).toContain('disabled:opacity-40')
    expect(cls).toContain('disabled:cursor-not-allowed')

    // ⚠️ 不得用隐藏实现：触屏没有 hover，藏起来等于按钮不存在；
    // opacity-0 还会把焦点环一起藏掉（WCAG 2.4.7）。
    expect(cls).not.toContain('opacity-0')
    expect(cls).not.toContain('hidden')
    expect(cls).not.toContain('group-hover:opacity-100')
  })

  it('按钮只留图标，不再有可见文案', async () => {
    await renderReady()
    const btn = screen.getByRole('button', { name: '复制版本号' })

    // 按钮内没有任何文字节点（aria-label 不算可见文案）
    expect(btn.textContent).toBe('')
    expect(btn.querySelector('svg')?.getAttribute('class')).toContain('lucide-copy')
    // 页面上也不该再有独立的「复制」文字按钮
    expect(screen.queryByText('复制')).toBeNull()
  })

  it('自绘 tooltip 取代原生 title，并覆盖鼠标与键盘两条路径', async () => {
    await renderReady()
    const btn = screen.getByRole('button', { name: '复制版本号' })
    const tooltip = screen.getByTestId('copy-version-tooltip')

    // 原生 title 与自绘 tooltip 并存会弹出两个互相遮挡的提示
    expect(btn.getAttribute('title')).toBeNull()
    // 键盘路径：原生 title 在 focus 时不显示、多数读屏也不暴露
    expect(tooltip.className).toContain('group-hover:opacity-100')
    expect(tooltip.className).toContain('group-focus-within:opacity-100')
    // 常态隐藏（不是 display:none，键盘 focus 时才能淡入）
    expect(tooltip.className).toContain('opacity-0')
    // 读屏不重复播报：按钮已有 aria-label，再用 aria-describedby 会念两遍
    expect(tooltip.getAttribute('aria-hidden')).toBe('true')
    expect(tooltip.textContent).toBe('复制版本号')
  })

  it('复制成功后：图标换成对勾、tooltip 变「已复制」，aria-label 保持静态', async () => {
    await renderReady()
    const btn = screen.getByRole('button', { name: '复制版本号' })

    fireEvent.click(btn)

    await waitFor(() => expect(screen.getByTestId('copy-version-tooltip').textContent).toBe('已复制'))
    // 状态用图标形状表达，不依赖颜色
    expect(btn.querySelector('svg')?.getAttribute('class')).toContain('lucide-check')
    // aria-label 静态：控件列表里不会出现两个同名条目，焦点按钮改名也不会打断朗读
    expect(btn.getAttribute('aria-label')).toBe('复制版本号')
  })

  it('复制成功后 live region 播报「已复制版本号 v1.4.0」', async () => {
    await renderReady()
    const region = screen.getByTestId('copy-version-status')
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.textContent).toBe('')

    fireEvent.click(screen.getByRole('button', { name: '复制版本号' }))

    await waitFor(() => expect(screen.getByTestId('copy-version-status').textContent).toBe('已复制版本号 v1.4.0'))
  })

  it('复制失败时 live region 播报失败文案', async () => {
    writeText.mockRejectedValueOnce(new Error('clipboard denied'))
    await renderReady()

    fireEvent.click(screen.getByRole('button', { name: '复制版本号' }))

    await waitFor(() => expect(screen.getByTestId('copy-version-status').textContent).toBe('复制失败，请手动记录版本号。'))
    expect(addToast).toHaveBeenCalledWith('复制失败，请手动记录版本号。', 'error')
  })

  it('连续复制两次都被播报：文案相同，靠重建 live region 节点强制重播', async () => {
    await renderReady()
    const btn = screen.getByRole('button', { name: '复制版本号' })

    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('copy-version-status').textContent).toBe('已复制版本号 v1.4.0'))
    const firstNode = screen.getByTestId('copy-version-status')

    // 连点第二次：文案与第一次**完全相同**
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByTestId('copy-version-status')).not.toBe(firstNode))
    const secondNode = screen.getByTestId('copy-version-status')

    // 文案没变 → 只有节点被重建，读屏才会把它当成一次新的播报
    expect(secondNode.textContent).toBe(firstNode.textContent)
    expect(secondNode.textContent).toBe('已复制版本号 v1.4.0')
    expect(secondNode).not.toBe(firstNode)
    expect(firstNode.isConnected).toBe(false)
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('2 秒后复位：live region 清空，再次复制重新播报', async () => {
    vi.useFakeTimers()
    try {
      renderSection()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByTestId('update-current-version').textContent).toBe('v1.4.0')

      const btn = screen.getByRole('button', { name: '复制版本号' })
      await act(async () => {
        fireEvent.click(btn)
        await Promise.resolve()
      })
      expect(screen.getByTestId('copy-version-status').textContent).toBe('已复制版本号 v1.4.0')

      // 2 秒后复位
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(screen.getByTestId('copy-version-status').textContent).toBe('')
      expect(screen.getByTestId('copy-version-tooltip').textContent).toBe('复制版本号')

      // 再复制一次 → 重新播报
      await act(async () => {
        fireEvent.click(btn)
        await Promise.resolve()
      })
      expect(screen.getByTestId('copy-version-status').textContent).toBe('已复制版本号 v1.4.0')
    } finally {
      vi.useRealTimers()
    }
  })

  it('版本号获取失败时保留禁用按钮', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    getVersionMock.mockRejectedValueOnce(new Error('boom'))
    renderSection()
    await waitFor(() => expect(screen.getByTestId('update-current-version').textContent).toBe('获取失败'))
    const btn = screen.getByRole('button', { name: '复制版本号' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
    consoleError.mockRestore()
  })
})

describe('UpdateSection 版本号措辞', () => {
  it('浏览器预览：版本号旁标注「构建版本」并给出说明', () => {
    isTauriMock.mockReturnValue(false)
    renderSection()
    expect(screen.getByTestId('update-current-version').textContent).toBe('v1.4.0')
    expect(screen.getByTestId('update-version-source').textContent).toBe('构建版本')
    expect(screen.getByTestId('update-version-note').textContent).toContain('构建版本')
  })

  it('桌面端（Tauri）：不出现「构建版本」标注', async () => {
    renderSection()
    await waitFor(() => expect(screen.getByTestId('update-current-version').textContent).toBe('v1.4.0'))
    expect(screen.queryByTestId('update-version-source')).toBeNull()
    expect(screen.queryByTestId('update-version-note')).toBeNull()
  })
})

describe('UpdateSection 重试入口', () => {
  it('签名失败：不提供「立即更新」，只给「打开发布页」', () => {
    renderSection({
      state: 'available',
      checkStatus: 'available',
      info: INFO,
      error: { code: 'signature-failed', message: UPDATE_ERROR_COPY['signature-failed'] },
    })

    // 失败原因仍然可见
    expect(statusText()).toBe(UPDATE_ERROR_COPY['signature-failed'])
    // 再点一次必然同样失败 → 不给重试入口
    expect(screen.queryByRole('button', { name: '立即更新' })).toBeNull()
    // 给出的下一步是可执行的动作
    const releaseBtn = screen.getByRole('button', { name: '打开发布页' })
    fireEvent.click(releaseBtn)
    expect(openExternalMock).toHaveBeenCalledTimes(1)
    expect(String(openExternalMock.mock.calls[0][0])).toContain('/releases/latest')
  })

  it('本平台无产物：同样不给「立即更新」，改给发布页入口', () => {
    renderSection({
      checkStatus: 'failed',
      error: { code: 'no-platform-asset', message: UPDATE_ERROR_COPY['no-platform-asset'] },
    })
    expect(statusText()).toBe(UPDATE_ERROR_COPY['no-platform-asset'])
    expect(screen.queryByRole('button', { name: '立即更新' })).toBeNull()
    expect(screen.getByRole('button', { name: '打开发布页' })).toBeTruthy()
  })

  it('网络类失败：保留「立即更新」重试入口', () => {
    renderSection({
      state: 'available',
      checkStatus: 'available',
      info: INFO,
      error: { code: 'download-failed', message: UPDATE_ERROR_COPY['download-failed'] },
    })
    expect(screen.getByRole('button', { name: '立即更新' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '打开发布页' })).toBeNull()
  })
})

describe('UpdateSection 回归', () => {
  it('后端返回 v2 / legacy 之类无关字段时，不出现额外分列或错误文案', () => {
    const dirtyInfo = {
      ...INFO,
      // 插件的 rawJson 里可能混有与更新无关的字段
      rawJson: { v2: true, legacy: false, schema: 'v2-mixed' },
    } as unknown as UpdateInfo

    renderSection({
      state: 'available',
      checkStatus: 'available',
      info: dirtyInfo,
      lastCheckedAt: 1_700_000_000_000,
    })

    // 只有约定的三行，不多不少
    expect(screen.getByText('当前版本')).toBeTruthy()
    expect(screen.getByText('可更新版本')).toBeTruthy()
    expect(screen.getByText('上次检查')).toBeTruthy()
    expect(screen.queryByText('legacy')).toBeNull()
    expect(screen.queryByText('v2')).toBeNull()
    expect(screen.queryByText('v2-mixed')).toBeNull()

    // 没有错误文案、没有 alert
    expect(screen.queryByRole('alert')).toBeNull()
    expect(statusText()).toBe('发现新版本 v1.4.1，可立即更新。')
    expect(statusText()).not.toContain('失败')
  })
})
