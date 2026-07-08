/**
 * 错误分类器单测
 * 把任意错误归类为预定义的 UpdateErrorCode,供 UI 决定 Toast 文案 / 重试策略
 */
import { describe, it, expect } from 'vitest'
import { classifyUpdateError } from './errorClassifier'

describe('classifyUpdateError', () => {
  it('classifies ENOTFOUND as network', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    expect(classifyUpdateError(err)).toEqual({
      code: 'network',
      message: '网络异常，请检查网络连接后重试',
    })
  })

  it('classifies 403 as ratelimit', () => {
    const err = new Error('403 rate limit')
    expect(classifyUpdateError(err).code).toBe('ratelimit')
  })

  it('classifies "no asset" message as no-asset', () => {
    const err = new Error('No asset found for darwin arm64')
    expect(classifyUpdateError(err).code).toBe('no-asset')
  })

  it('classifies generic Error as no-asset (default fallback)', () => {
    const err = new Error('boom')
    expect(classifyUpdateError(err).code).toBe('no-asset')
  })

  it('handles non-Error values (default fallback)', () => {
    expect(classifyUpdateError('string error').code).toBe('no-asset')
    expect(classifyUpdateError(undefined).code).toBe('no-asset')
    expect(classifyUpdateError(null).code).toBe('no-asset')
  })
})
