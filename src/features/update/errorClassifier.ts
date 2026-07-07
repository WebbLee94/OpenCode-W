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
      return e?.code === 'ENOTFOUND' || e?.code === 'ECONNREFUSED' || e?.code === 'ETIMEDOUT'
    },
    payload: { code: 'network', message: '网络异常，请检查网络连接' },
  },
  {
    test: (err) => /403|rate.?limit/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'ratelimit', message: 'API 限流，请稍后再试' },
  },
  {
    test: (err) => /no.?asset/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'no-asset', message: '当前平台暂未提供更新包' },
  },
  {
    test: (err) => /download.?fail|network/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'download-failed', message: '下载失败，请重试' },
  },
  {
    test: (err) => /install|cancel/i.test(String((err as Error)?.message ?? '')),
    payload: { code: 'install-failed', message: '安装被取消' },
  },
]

export function classifyUpdateError(err: unknown): UpdateErrorPayload {
  for (const rule of RULES) {
    if (rule.test(err)) return rule.payload
  }
  return {
    code: 'unknown',
    message: err instanceof Error ? err.message : '未知错误',
  }
}
