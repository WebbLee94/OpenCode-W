/**
 * UpdateSection 单测 —— 覆盖「版本更新」区的状态机与文案映射：
 *   - 非 Tauri / 未检查 / 检查中 / 已是最新 / 有更新 / 下载中 / 已下载 / 安装中
 *   - 检查失败：network / ratelimit / unknown / manifest-missing / no-platform-asset / signature-failed
 *   - 「可更新版本」行只在真的有更新时渲染
 *   - 回归：后端返回 v2 / legacy 之类无关字段时，不得出现额外分列或错误文案
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UpdateSection } from './UpdateSection'
import { UpdateContext } from '@/features/update/UpdateContext'
import type { UseUpdateStatus } from '@/features/update/useUpdateStatus'
import type { UpdateErrorCode, UpdateInfo } from '@shared/types'
import { UPDATE_ERROR_COPY } from '@/features/update/errorClassifier'

const { isTauriMock, getVersionMock, addToast, writeText } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => true),
  getVersionMock: vi.fn(() => Promise.resolve('1.4.0')),
  addToast: vi.fn(),
  writeText: vi.fn(() => Promise.resolve()),
}))

vi.mock('@/lib/ipc', () => ({
  isTauri: isTauriMock,
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
  it('只有一个 live region 承载状态文案', () => {
    renderSection({ checkStatus: 'up-to-date' })
    expect(screen.getAllByRole('status')).toHaveLength(1)
    const region = screen.getByTestId('update-status')
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
