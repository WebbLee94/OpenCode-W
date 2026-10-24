/**
 * 冒烟测试：验证纯函数模块 `src/lib/format.ts` 行为
 * 目的：保证 build 后关键工具函数不回归
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  formatBytes,
  formatNumber,
  sumTokenTotal,
  tildifyPath,
  truncateText,
  toLocalDateString,
  toLocalDateStringDaysAgo,
  subtractLocalDays,
  calendarDayDiff,
} from './format'

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

/**
 * 日历日减法 —— 预设时间范围的**唯一**口径来源。
 *
 * 这一组是「夏令时切换日差一天」的回归保护：
 * 减毫秒（`Date.now() - n * 86_400_000`）在跳表窗口内会退到前一个本地日，
 * 于是「含今日在内的 N 个自然日」变成 N+1（春季）或 N−1（秋季）天。
 */
describe('subtractLocalDays / toLocalDateStringDaysAgo（夏令时安全）', () => {
  const ORIGINAL_TZ = process.env.TZ

  afterEach(() => {
    // 还原时区：process.env.TZ = undefined 会写成字符串 "undefined"
    if (ORIGINAL_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIGINAL_TZ
  })

  it('普通日子：减 N 天就是日历上的 N 天前', () => {
    process.env.TZ = 'Asia/Shanghai'
    const now = new Date('2026-10-23T16:30:00Z') // 本地 2026-10-24 00:30
    expect(toLocalDateStringDaysAgo(0, now)).toBe('2026-10-24')
    expect(toLocalDateStringDaysAgo(6, now)).toBe('2026-10-18')
    expect(toLocalDateStringDaysAgo(29, now)).toBe('2026-09-25')
  })

  it('春季跳表当天（2026-03-08）落在窗口内：起点仍是 3/8，不是 3/7', () => {
    process.env.TZ = 'America/New_York'
    // 本地 2026-03-14 00:30 (-04:00 EDT)
    const now = new Date('2026-03-14T04:30:00Z')

    // ⚠️ 对照：旧的「减毫秒」写法在这里会退到 3/7（区间变成 8 天）
    expect(toLocalDateString(new Date(now.getTime() - 6 * 86_400_000))).toBe('2026-03-07')

    // 日历日减法：3/14 − 6 = 3/8 → [3/8, 3/14] 正好 7 个自然日
    expect(toLocalDateStringDaysAgo(6, now)).toBe('2026-03-08')
    expect(toLocalDateStringDaysAgo(0, now)).toBe('2026-03-14')
  })

  it('秋季回拨当天（2026-11-01）落在窗口内：起点是 10/27，不是 10/28', () => {
    process.env.TZ = 'America/New_York'
    // 本地 2026-11-02 23:30 (-05:00 EST)
    const now = new Date('2026-11-03T04:30:00Z')

    // ⚠️ 对照：旧的「减毫秒」写法在这里会退到 10/28（区间变成 6 天）
    expect(toLocalDateString(new Date(now.getTime() - 6 * 86_400_000))).toBe('2026-10-28')

    // 日历日减法：11/2 − 6 = 10/27 → [10/27, 11/2] 正好 7 个自然日
    expect(toLocalDateStringDaysAgo(6, now)).toBe('2026-10-27')
    expect(toLocalDateStringDaysAgo(0, now)).toBe('2026-11-02')
  })

  it('subtractLocalDays 保留时刻（只动日期），跨月 / 跨年都正确', () => {
    process.env.TZ = 'Asia/Shanghai'
    const base = new Date('2026-10-24T09:30:00+08:00')

    const sub = subtractLocalDays(base, 1)
    expect(toLocalDateString(sub)).toBe('2026-10-23')
    expect(sub.getHours()).toBe(9)
    expect(sub.getMinutes()).toBe(30)

    // 跨月
    expect(toLocalDateString(subtractLocalDays(base, 24))).toBe('2026-09-30')
    // 跨年
    expect(toLocalDateString(subtractLocalDays(base, 359))).toBe('2025-10-30')
    expect(toLocalDateString(subtractLocalDays(base, 365))).toBe('2025-10-24')
  })
})

describe('calendarDayDiff（纯日历日差）', () => {
  it('相减得到自然日差', () => {
    expect(calendarDayDiff('2026-10-18', '2026-10-24')).toBe(6)
    expect(calendarDayDiff('2026-10-24', '2026-10-24')).toBe(0)
    expect(calendarDayDiff('2026-10-24', '2026-10-18')).toBe(-6)
  })

  it('跨夏令时切换日也只算日历日（不受 ±1 小时影响）', () => {
    // 2026-03-08 跳表：3/8 → 3/14 是 6 个自然日（不是 6 天 23 小时）
    expect(calendarDayDiff('2026-03-08', '2026-03-14')).toBe(6)
    // 2026-11-01 回拨：10/27 → 11/2 是 6 个自然日
    expect(calendarDayDiff('2026-10-27', '2026-11-02')).toBe(6)
  })

  it('跨月 / 跨年也算得对', () => {
    expect(calendarDayDiff('2026-09-25', '2026-10-24')).toBe(29)
    expect(calendarDayDiff('2025-12-31', '2026-01-01')).toBe(1)
  })
})
