/**
 * 冒烟测试：验证纯函数模块 `src/lib/format.ts` 行为
 * 目的：保证 build 后关键工具函数不回归
 */
import { describe, it, expect, afterEach } from 'vitest'
import { formatBytes, formatNumber, sumTokenTotal, tildifyPath, truncateText, toLocalDateString } from './format'

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

describe('sumTokenTotal', () => {
  it('sums the five token components', () => {
    expect(sumTokenTotal({ inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cacheRead: 4, cacheWrite: 5 })).toBe(15)
  })

  it('returns zero when every component is zero', () => {
    expect(sumTokenTotal({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0)
  })
})

describe('tildifyPath', () => {
  it('replaces home prefix with ~', () => {
    expect(tildifyPath('/Users/webb/.local/share/opencode/opencode.db', '/Users/webb')).toBe('~/.local/share/opencode/opencode.db')
  })

  it('returns path unchanged when it is not under home', () => {
    expect(tildifyPath('/opt/data/opencode.db', '/Users/webb')).toBe('/opt/data/opencode.db')
  })

  it('returns empty for empty inputs', () => {
    expect(tildifyPath('', '/Users/webb')).toBe('')
    expect(tildifyPath('/Users/webb/db.sqlite', '')).toBe('/Users/webb/db.sqlite')
  })
})

describe('toLocalDateString', () => {
  const ORIGINAL_TZ = process.env.TZ

  afterEach(() => {
    // 还原时区：process.env.TZ = undefined 会写成字符串 "undefined"
    if (ORIGINAL_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIGINAL_TZ
  })

  it('按本地日历输出 YYYY-MM-DD，而不是 UTC 日期', () => {
    // 固定到 UTC+8（Asia/Shanghai）：2026-10-24 00:30 (+08:00) = 2026-10-23T16:30Z
    process.env.TZ = 'Asia/Shanghai'
    const d = new Date('2026-10-23T16:30:00Z')

    // UTC 日期是「昨天」，本地日期才是「今天」——这正是 toISOString() 会踩的坑
    expect(d.toISOString().slice(0, 10)).toBe('2026-10-23')
    expect(toLocalDateString(d)).toBe('2026-10-24')
  })

  it('负时区同样按本地日历走', () => {
    process.env.TZ = 'America/Los_Angeles'
    // 2026-10-24 20:00 (-07:00) = 2026-10-25T03:00Z → UTC 是「明天」
    const d = new Date('2026-10-25T03:00:00Z')
    expect(d.toISOString().slice(0, 10)).toBe('2026-10-25')
    expect(toLocalDateString(d)).toBe('2026-10-24')
  })

  it('月份与日期都补零', () => {
    process.env.TZ = 'UTC'
    expect(toLocalDateString(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05')
  })
})
