/**
 * 状态机转换校验的纯函数单测
 */
import { describe, it, expect } from 'vitest'
import { isValidTransition } from './stateMachine'

describe('isValidTransition', () => {
  it('allows idle → available (新版本检查成功)', () => {
    expect(isValidTransition('idle', 'available')).toBe(true)
  })

  it('allows available → downloading (用户触发下载)', () => {
    expect(isValidTransition('available', 'downloading')).toBe(true)
  })

  it('allows downloading → downloaded (下载完成)', () => {
    expect(isValidTransition('downloading', 'downloaded')).toBe(true)
  })

  it('allows downloaded → installing (用户点击安装)', () => {
    expect(isValidTransition('downloaded', 'installing')).toBe(true)
  })

  it('allows any → idle (重置 / 已运行最新版)', () => {
    expect(isValidTransition('available', 'idle')).toBe(true)
    expect(isValidTransition('downloading', 'idle')).toBe(true)
  })

  it('rejects downloading → installing (跳过 downloaded 状态)', () => {
    expect(isValidTransition('downloading', 'installing')).toBe(false)
  })

  it('rejects idle → installing (无中间步骤直接装)', () => {
    expect(isValidTransition('idle', 'installing')).toBe(false)
  })

  it('rejects available → downloaded (跳过 downloading 状态)', () => {
    expect(isValidTransition('available', 'downloaded')).toBe(false)
  })
})
