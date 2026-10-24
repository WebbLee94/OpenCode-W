/**
 * 状态文案映射单测 —— 锁定「状态 → 语气 / 图标 / 文案」的唯一映射，
 * 保证设置页与更新弹窗不会出现两套说法。
 */
import { describe, it, expect } from 'vitest'
import { resolveUpdateStatus, formatCheckedAt, UPDATE_STATUS_COPY } from './updateStatus'
import { UPDATE_ERROR_COPY } from './errorClassifier'
import type { UpdateCheckStatus, UpdateErrorCode, UpdateState } from '@shared/types'

function resolve(partial: {
  tauri?: boolean
  checkStatus?: UpdateCheckStatus
  state?: UpdateState
  version?: string | null
  error?: { code: UpdateErrorCode; message: string } | null
}) {
  return resolveUpdateStatus({
    tauri: partial.tauri ?? true,
    checkStatus: partial.checkStatus ?? 'idle',
    state: partial.state ?? 'idle',
    version: partial.version ?? null,
    error: partial.error ?? null,
  })
}

describe('resolveUpdateStatus', () => {
  it('非 Tauri：提示浏览器预览不支持', () => {
    const view = resolve({ tauri: false, checkStatus: 'available', state: 'available', version: '1.4.1' })
    expect(view.text).toBe(UPDATE_STATUS_COPY.browserUnsupported)
  })

  it('未检查', () => {
    expect(resolve({}).text).toBe(UPDATE_STATUS_COPY.idle)
  })

  it('检查中', () => {
    const view = resolve({ checkStatus: 'checking' })
    expect(view.text).toBe(UPDATE_STATUS_COPY.checking)
    expect(view.spinning).toBe(true)
  })

  it('已是最新', () => {
    const view = resolve({ checkStatus: 'up-to-date' })
    expect(view.text).toBe(UPDATE_STATUS_COPY.upToDate)
    expect(view.tone).toBe('success')
  })

  it('有更新', () => {
    const view = resolve({ checkStatus: 'available', state: 'available', version: '1.4.1' })
    expect(view.text).toBe('发现新版本 v1.4.1，可立即更新。')
    expect(view.tone).toBe('info')
  })

  it('下载中', () => {
    const view = resolve({ checkStatus: 'available', state: 'downloading', version: '1.4.1' })
    expect(view.text).toBe('正在下载 v1.4.1…')
  })

  it('已下载待安装', () => {
    const view = resolve({ checkStatus: 'available', state: 'downloaded', version: '1.4.1' })
    expect(view.text).toBe('新版本 v1.4.1 已下载完成，重启后生效。')
  })

  it('安装中', () => {
    const view = resolve({ checkStatus: 'available', state: 'installing', version: '1.4.1' })
    expect(view.text).toBe('正在安装并重启应用，请稍候。')
    expect(view.spinning).toBe(true)
  })

  it('错误优先于状态：展示错误文案', () => {
    const view = resolve({
      checkStatus: 'failed',
      error: { code: 'network', message: UPDATE_ERROR_COPY.network },
    })
    expect(view.text).toBe(UPDATE_ERROR_COPY.network)
    expect(view.tone).toBe('danger')
  })

  it('检查失败但没有 error 时兜底为 unknown 文案，绝不退化成「已是最新」', () => {
    const view = resolve({ checkStatus: 'failed' })
    expect(view.text).toBe(UPDATE_ERROR_COPY.unknown)
    expect(view.text).not.toContain('已是最新')
  })

  it('错误码 → 语气映射：限流与清单/平台缺失是警告，其余是危险', () => {
    const tone = (code: UpdateErrorCode) => resolve({
      checkStatus: 'failed',
      error: { code, message: UPDATE_ERROR_COPY[code] },
    }).tone
    expect(tone('ratelimit')).toBe('warning')
    expect(tone('manifest-missing')).toBe('warning')
    expect(tone('no-platform-asset')).toBe('warning')
    expect(tone('network')).toBe('danger')
    expect(tone('signature-failed')).toBe('danger')
    expect(tone('download-failed')).toBe('danger')
    expect(tone('install-failed')).toBe('danger')
    expect(tone('unknown')).toBe('danger')
  })
})

describe('formatCheckedAt', () => {
  it('格式化为 YYYY-MM-DD HH:mm', () => {
    const ts = new Date(2026, 9, 24, 15, 4).getTime()
    expect(formatCheckedAt(ts)).toBe('2026-10-24 15:04')
  })
})
