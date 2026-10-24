/**
 * UpdateDialog 单测 —— 覆盖「弹窗可关闭」这一关键修复：
 * 旧实现传 `onClose={() => {}}`，导致 Modal 的 Esc / 遮罩 / × 全部失效，
 * 检出更新后设置页按钮永久不可达。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UpdateDialog } from './UpdateDialog'
import { UpdateContext } from './UpdateContext'
import type { UseUpdateStatus } from './useUpdateStatus'
import type { UpdateInfo } from '@shared/types'

const INFO: UpdateInfo = {
  version: '1.4.1',
  releaseDate: '2026-10-01T00:00:00Z',
  releaseNotes: '修复若干问题',
  sizeBytes: 0,
}

function makeContext(overrides: Partial<UseUpdateStatus> = {}): UseUpdateStatus {
  return {
    state: 'available',
    checkStatus: 'available',
    info: INFO,
    progress: null,
    error: null,
    isChecking: false,
    lastCheckedAt: null,
    dialogOpen: true,
    check: vi.fn(),
    download: vi.fn(),
    install: vi.fn(),
    dismissDialog: vi.fn(),
    ...overrides,
  }
}

function renderDialog(overrides: Partial<UseUpdateStatus> = {}) {
  const value = makeContext(overrides)
  render(
    <UpdateContext.Provider value={value}>
      <UpdateDialog />
    </UpdateContext.Provider>,
  )
  return value
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UpdateDialog', () => {
  it('弹窗未展开时不渲染', () => {
    renderDialog({ dialogOpen: false })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('渲染为可访问对话框', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('× 按钮可关闭弹窗', () => {
    const value = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(value.dismissDialog).toHaveBeenCalledTimes(1)
  })

  it('Esc 可关闭弹窗', () => {
    const value = renderDialog()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(value.dismissDialog).toHaveBeenCalledTimes(1)
  })

  it('点击遮罩可关闭弹窗', () => {
    const value = renderDialog()
    fireEvent.click(document.querySelector('.fixed') as HTMLElement)
    expect(value.dismissDialog).toHaveBeenCalledTimes(1)
  })

  it('下载中展示带 aria-valuenow 的进度条', () => {
    renderDialog({
      state: 'downloading',
      progress: { bytesPerSecond: 1024, percent: 42, transferred: 42, total: 100 },
    })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('42')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    expect(bar.getAttribute('aria-live')).toBe('off')
  })

  it('不知道总大小时不展示百分比', () => {
    renderDialog({
      state: 'downloading',
      progress: { bytesPerSecond: 1024, percent: 0, transferred: 512, total: 0 },
    })
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
    expect(bar.textContent).not.toContain('%')
  })

  it('展示错误文案', () => {
    renderDialog({
      state: 'available',
      error: { code: 'signature-failed', message: '更新包签名校验未通过，已拒绝安装。请从官方发布页手动下载安装。' },
    })
    expect(screen.getByText(/签名校验未通过/)).toBeTruthy()
  })
})
