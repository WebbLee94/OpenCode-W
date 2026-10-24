/**
 * Modal 可访问性单测 —— 覆盖 role / aria-modal / 焦点管理 / Esc / 遮罩关闭。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import Modal from './Modal'

afterEach(() => {
  cleanup()
})

describe('Modal', () => {
  it('渲染为 role=dialog + aria-modal=true，并用标题关联', () => {
    render(<Modal isOpen onClose={() => {}} title="版本更新">内容</Modal>)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toBe('版本更新')
  })

  it('关闭按钮有可访问名称', () => {
    render(<Modal isOpen onClose={() => {}} title="版本更新">内容</Modal>)
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()
  })

  it('打开时把焦点移入弹窗，关闭后归还给触发元素', () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const { rerender } = render(
      <Modal isOpen onClose={() => {}} title="版本更新">
        <button>确认</button>
      </Modal>,
    )
    expect(document.activeElement).not.toBe(trigger)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))

    rerender(
      <Modal isOpen={false} onClose={() => {}} title="版本更新">
        <button>确认</button>
      </Modal>,
    )
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('Esc 触发 onClose', () => {
    const onClose = vi.fn()
    render(<Modal isOpen onClose={onClose} title="版本更新">内容</Modal>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点击遮罩触发 onClose，点击内容不触发', () => {
    const onClose = vi.fn()
    render(<Modal isOpen onClose={onClose} title="版本更新">内容</Modal>)
    fireEvent.click(screen.getByText('内容'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(document.querySelector('.fixed') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Tab 在弹窗内循环，不会跑到弹窗外', () => {
    render(
      <Modal isOpen onClose={() => {}} title="版本更新">
        <button>第一个</button>
        <button>第二个</button>
      </Modal>,
    )
    const first = screen.getByRole('button', { name: '第一个' })
    const last = screen.getByRole('button', { name: '第二个' })
    const close = screen.getByRole('button', { name: '关闭' })

    // 焦点从最后一个可聚焦元素继续 Tab → 回到第一个（弹窗内的关闭按钮）
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    // Shift+Tab 从第一个可聚焦元素 → 跳到最后一个
    close.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    expect(first).toBeTruthy()
  })
})
