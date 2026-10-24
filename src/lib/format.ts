/**
 * Format bytes into human-readable string
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const value = bytes / Math.pow(k, i)
  return `${value.toFixed(decimals)} ${sizes[i]}`
}

/**
 * Format number with locale-aware separators
 */
export function formatNumber(num: number | undefined | null): string {
  if (num == null || isNaN(num)) return '0'
  return num.toLocaleString()
}

/**
 * Format a large number with K/M/B/T/E suffixes (1000-base, 2 decimal places).
 * Examples: 1234 → "1.23K", 1234567 → "1.23M", 0 → "0"
 */
export function formatLargeNumber(num: number | undefined | null): string {
  if (num == null || isNaN(num) || num === 0) return '0'
  const k = 1000
  const sizes = ['', 'K', 'M', 'B', 'T', 'E']
  const i = Math.min(Math.floor(Math.log(Math.abs(num)) / Math.log(k)), sizes.length - 1)
  const value = num / Math.pow(k, i)
  return `${value.toFixed(2)} ${sizes[i]}`
}

/**
 * 五项 Token 分量的字段结构（输入/输出/推理/缓存读/缓存写）
 */
export interface TokenTotalParts {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Token 总量 = 输入 + 输出 + 推理 + 缓存读 + 缓存写。
 * 缓存命中率是比率，不作为第六项计入总量。
 */
export function sumTokenTotal(tokens: TokenTotalParts): number {
  return tokens.inputTokens + tokens.outputTokens + tokens.reasoningTokens + tokens.cacheRead + tokens.cacheWrite
}

/**
 * Format a timestamp (ms) into a relative time string
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp

  if (diff < 0) return '刚刚'

  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (seconds < 60) return `${seconds}秒前`
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  if (days < 30) return `${days}天前`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}个月前`

  const years = Math.floor(months / 12)
  return `${years}年前`
}

/**
 * Format a timestamp (ms) into a localized date-time string
 */
export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * 将用户 home 目录前缀替换为 ~，用于路径展示脱敏。
 * 例：/Users/webb/.local/share/opencode/opencode.db → ~/.local/share/opencode/opencode.db
 * 仅替换前缀；非 home 前缀路径原样返回。
 */
export function tildifyPath(path: string, home: string): string {
  if (!path || !home) return path
  const normalizedHome = home.replace(/\/+$/, '')
  if (!normalizedHome) return path
  if (path === normalizedHome) return '~'
  if (path.startsWith(normalizedHome + '/')) return '~' + path.slice(normalizedHome.length)
  return path
}

/**
 * Truncate text to a maximum length with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (!text) return ''
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '...'
}

/**
 * 本地日期格式 YYYY-MM-DD。
 *
 * ⚠️ **不要**用 `toISOString().slice(0, 10)` 代替：那是 **UTC** 日期。
 * 在 UTC+8 的每天 08:00 之前它返回的是「昨天」，用户点「今天」实际筛的是昨天；
 * 负时区则会快一天。日期筛选必须按**本地日历**算。
 */
export function toLocalDateString(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 在**本地日历**上减 N 天，返回同一天时刻的 Date。
 *
 * ⚠️ **不要**用 `Date.now() - n * 86_400_000` 减毫秒来代替：
 * 夏令时切换日本地墙钟偏移 ±1 小时，减出来的瞬间落在**前一个本地日**，
 * 于是「含今日在内的 N 个自然日」会变成 N+1 天（春季）或 N−1 天（秋季）。
 * `setDate()` 走的是日历日加减，跨月 / 跨年都正确，且完全不受夏令时影响。
 */
export function subtractLocalDays(d: Date, days: number): Date {
  const c = new Date(d.getTime())
  c.setDate(c.getDate() - days)
  return c
}

/**
 * 「今天（含）往前推 N 个自然日」的起点日期串 YYYY-MM-DD。
 *
 * 预设时间范围的统一口径就是它：
 * 「含今日在内的 N 个自然日」= `[今天 − (N−1), 今天]`。
 *
 * @param days 往前推的自然日数（0 = 今天）
 * @param from 基准时刻，默认现在；测试里可传入固定值来钉住口径
 */
export function toLocalDateStringDaysAgo(days: number, from: Date = new Date()): string {
  return toLocalDateString(subtractLocalDays(from, days))
}

/**
 * 两个 YYYY-MM-DD 之间的**自然日**差（后者 − 前者）。
 *
 * 两端都按 UTC 解析 → 纯日历日差，与夏令时 / 本地时区**无关**。
 * （直接减本地午夜的时间戳会带上 ±1 小时的夏令时偏移。）
 */
export function calendarDayDiff(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number)
  const [y2, m2, d2] = to.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000)
}
