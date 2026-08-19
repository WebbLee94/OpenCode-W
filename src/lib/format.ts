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
