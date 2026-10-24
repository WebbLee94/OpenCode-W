/**
 * SchemaBlockedState 键盘可达性补测 —— 对应 TEST-014「键盘完成重新检测 / 打开所在目录」
 * 与 08.1 规格第 7 节验收清单 5（Tab 顺序 + 可见 focus-visible 环）。
 *
 * 既有覆盖情况：
 *   - `DatabaseModeBadge.test.tsx` 只断言「重新检测」按钮存在、可点击、refreshing 时禁用；
 *   - `DataSourceSection.test.tsx` 只断言设置页的「打开数据库所在目录」**常显**（不依赖 hover）；
 *   - **`unsupported` 占位块里的三个动作按钮（重新检测 / 打开所在目录 / 切换数据源）
 *     的键盘可达性与 Tab 顺序没有任何断言。**
 *
 * 本文件补上（纯 jsdom，不依赖 Tauri）：
 *   1. 三个动作都是原生 `<button type="button">` —— 原生按钮默认可聚焦、可被 Enter/Space 激活；
 *   2. DOM 顺序 = 规格要求的 Tab 顺序：重新检测 → 打开所在目录 → 切换数据源；
 *   3. 每个按钮都带 `focus-visible` 可见焦点环类；
 *   4. 焦点能真正落到按钮上（jsdom 可验证的部分），且 tabIndex 未被置负；
 *   5. 重新检测在 refreshing 时禁用并带 aria-busy。
 *
 * 说明：jsdom 不实现 Tab 键导航，也不实现 Enter/Space 的默认激活行为，
 * 因此「真实 Tab 键顺序」与「真实按键激活」属于**浏览器/真机不可自动化**的部分，
 * 本文件只覆盖可自动化的等价物（原生语义 + DOM 顺序 + 可聚焦 + 焦点环）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SchemaBlockedState } from './SchemaBlockedState'

afterEach(() => {
  cleanup()
})

function renderBlocked(overrides: Partial<Parameters<typeof SchemaBlockedState>[0]> = {}) {
  const onRetry = vi.fn()
  const onReveal = vi.fn()
  const onSwitch = vi.fn()
  const utils = render(
    <SchemaBlockedState
      reason="缺少 session_message / session_v2 等表"
      path="/tmp/bad.db"
      onRetry={onRetry}
      onReveal={onReveal}
      onSwitch={onSwitch}
      {...overrides}
    />,
  )
  return { onRetry, onReveal, onSwitch, ...utils }
}

const ACTIONS = ['重新检测', '打开所在目录', '切换数据源'] as const

describe('SchemaBlockedState 键盘可达性', () => {
  it('三个动作都渲染为原生 button[type=button]（原生可聚焦、可被 Enter/Space 激活）', () => {
    renderBlocked()
    for (const name of ACTIONS) {
      const btn = screen.getByRole('button', { name })
      expect(btn.tagName).toBe('BUTTON')
      expect(btn.getAttribute('type')).toBe('button')
    }
  })

  it('DOM 顺序 = Tab 顺序：重新检测 → 打开所在目录 → 切换数据源', () => {
    renderBlocked()
    const retry = screen.getByRole('button', { name: '重新检测' })
    const reveal = screen.getByRole('button', { name: '打开所在目录' })
    const sw = screen.getByRole('button', { name: '切换数据源' })

    expect(
      retry.compareDocumentPosition(reveal) & Node.DOCUMENT_POSITION_FOLLOWING,
      '「重新检测」应排在「打开所在目录」之前',
    ).toBeTruthy()
    expect(
      reveal.compareDocumentPosition(sw) & Node.DOCUMENT_POSITION_FOLLOWING,
      '「打开所在目录」应排在「切换数据源」之前',
    ).toBeTruthy()
  })

  it('三个动作都带 focus-visible 可见焦点环，且 focus 时不残留浏览器默认 outline 之外的可读边框', () => {
    renderBlocked()
    for (const name of ACTIONS) {
      const cls = screen.getByRole('button', { name }).getAttribute('class') || ''
      expect(cls, `${name} 缺少 focus-visible:outline-none`).toContain('focus-visible:outline-none')
      expect(cls, `${name} 缺少 focus-visible:ring-2`).toContain('focus-visible:ring-2')
      expect(cls, `${name} 缺少 focus-visible 环色`).toMatch(/focus-visible:ring-(brand|red|blue|gray)-\d+/)
      expect(cls, `${name} 缺少 focus-visible 偏移`).toContain('focus-visible:ring-offset')
    }
  })

  it('焦点可以真正落到每个动作按钮上，且 tabIndex 未被置负', () => {
    renderBlocked()
    for (const name of ACTIONS) {
      const btn = screen.getByRole('button', { name }) as HTMLButtonElement
      expect(btn.tabIndex, `${name} 的 tabIndex 不应为负`).toBeGreaterThanOrEqual(0)
      btn.focus()
      expect(document.activeElement, `${name} 无法获得焦点`).toBe(btn)
    }
  })

  it('点击「重新检测」只触发 onRetry，不触发 onReveal / onSwitch', () => {
    const { onRetry, onReveal, onSwitch } = renderBlocked()
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onReveal).not.toHaveBeenCalled()
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('点击「打开所在目录」只触发 onReveal', () => {
    const { onRetry, onReveal, onSwitch } = renderBlocked()
    fireEvent.click(screen.getByRole('button', { name: '打开所在目录' }))
    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('点击「切换数据源」只触发 onSwitch', () => {
    const { onRetry, onReveal, onSwitch } = renderBlocked()
    fireEvent.click(screen.getByRole('button', { name: '切换数据源' }))
    expect(onSwitch).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(onReveal).not.toHaveBeenCalled()
  })

  it('refreshing 时「重新检测」禁用并带 aria-busy，其余动作仍可点', () => {
    const { onReveal } = renderBlocked({ refreshing: true })

    const retry = screen.getByRole('button', { name: /检测中/ }) as HTMLButtonElement
    expect(retry.disabled).toBe(true)
    expect(retry.getAttribute('aria-busy')).toBe('true')

    const reveal = screen.getByRole('button', { name: '打开所在目录' }) as HTMLButtonElement
    expect(reveal.disabled).toBe(false)
    fireEvent.click(reveal)
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it('没有 onReveal 时不渲染「打开所在目录」（不出现空按钮）', () => {
    renderBlocked({ onReveal: undefined })
    expect(screen.queryByRole('button', { name: '打开所在目录' })).toBeNull()
    expect(screen.getByRole('button', { name: '重新检测' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '切换数据源' })).toBeTruthy()
  })

  it('占位块整体在 DOM 中位于原因文本之后、动作区之前（读屏顺序合理）', () => {
    renderBlocked()
    const block = screen.getByTestId('schema-blocked-state')
    const reason = screen.getByText('缺少 session_message / session_v2 等表')
    const retry = screen.getByRole('button', { name: '重新检测' })
    expect(reason.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(block.contains(retry)).toBe(true)
  })
})
