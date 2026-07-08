/**
 * 错误分类器
 * 把任意错误归类为 UpdateErrorCode,供 UI 决定 Toast 文案 / 重试策略
 */
import type { UpdateErrorPayload } from '@shared/types'

type NodeError = Error & { code?: string }

const RULES: Array<{
  test: (err: NodeError | unknown) => boolean
  payload: UpdateErrorPayload
}> = [
  {
    test: (err) => {
      const e = err as NodeError
      return e?.code === 'ENOTFOUND' || e?.code === 'ECONNREFUSED' || e?.code === 'ETIMEDOUT' || e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH'
    },
    payload: { code: 'network', message: '网络异常，请检查网络连接后重试' },
  },
  {
    test: (err) => /403|rate.?limit|too.?many.?requests/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'ratelimit', message: '请求过于频繁，请稍后再试' },
  },
  {
    test: (err) => /download.?fail|download.?error/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'download-failed', message: '下载失败，请检查网络后重试' },
  },
  {
    test: (err) => /install|cancel/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'install-failed', message: '安装被取消' },
  },
  {
    test: (err) => /no.?asset|no.?update|up.?to.?date|latest.?version|already.?latest/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'no-asset', message: '当前已是最新版本' },
  },
  {
    test: (err) => /endpoint.?did.?not.?respond|unsuccessful.?status|404|not.?found/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'no-asset', message: '当前已是最新版本' },
  },
  {
    test: (err) => /signature|pubkey|verify|invalid.?signature/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'no-asset', message: '当前已是最新版本' },
  },
  {
    test: (err) => /timed.?out|timeout|connection.?reset/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'network', message: '网络连接超时，请检查网络后重试' },
  },
  {
    test: (err) => /dns.?resolve|getaddrinfo/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'network', message: 'DNS解析失败，请检查网络连接' },
  },
  {
    test: (err) => /tls|ssl|certificate/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'network', message: 'SSL证书验证失败，请检查网络环境' },
  },
  {
    test: (err) => /error.?sending.?request|error.?connecting|request.?failed|failed.?to.?fetch/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'network', message: '网络请求失败，请检查网络连接后重试' },
  },
  {
    test: (err) => /network/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'network', message: '网络异常，请检查网络连接后重试' },
  },
]

export function classifyUpdateError(err: unknown): UpdateErrorPayload {
  console.error('更新错误分类:', err)
  for (const rule of RULES) {
    if (rule.test(err)) return rule.payload
  }
  return {
    code: 'no-asset',
    message: '当前已是最新版本',
  }
}
