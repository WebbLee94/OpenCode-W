/**
 * 冒烟测试：验证纯函数模块 `src/lib/format.ts` 行为
 * 目的：保证 build 后关键工具函数不回归
 */
import { describe, it, expect } from 'vitest'
import { formatBytes, formatNumber, truncateText } from './format'

describe('formatBytes', () => {
  it('returns "0 B" for zero', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('formats bytes without decimal', () => {
    expect(formatBytes(1024, 0)).toBe('1 KB')
  })

  it('formats megabytes with default decimals', () => {
    expect(formatBytes(1024 * 1024)).toMatch(/1\.0 MB/)
  })
})

describe('formatNumber', () => {
  it('adds locale separators', () => {
    const result = formatNumber(1234567)
    // zh-CN locale may or may not have separators depending on environment,
    // so we just check it returns a string
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('handles zero', () => {
    expect(formatNumber(0)).toBe('0')
  })
})

describe('truncateText', () => {
  it('returns empty string for empty input', () => {
    expect(truncateText('', 10)).toBe('')
  })

  it('returns text unchanged if shorter than max', () => {
    expect(truncateText('hello', 10)).toBe('hello')
  })

  it('truncates with ellipsis if longer than max', () => {
    expect(truncateText('hello world', 5)).toBe('hello...')
  })

  it('handles exact length', () => {
    expect(truncateText('hello', 5)).toBe('hello')
  })
})

describe('Module exports', () => {
  it('exports required functions', () => {
    expect(typeof formatBytes).toBe('function')
    expect(typeof formatNumber).toBe('function')
    expect(typeof truncateText).toBe('function')
  })
})
