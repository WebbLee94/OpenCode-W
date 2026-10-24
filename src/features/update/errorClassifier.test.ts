/**
 * 错误分类器单测
 *
 * 背景（历史缺陷）：tauri-plugin-updater 的错误被 `serialize_str` 序列化成
 * **纯字符串**，JS 侧 `err.message` 是 undefined，旧实现读 `err.message` 导致
 * 所有规则都不命中，最后落到兜底文案「当前已是最新版本」——
 * 网络失败 / 清单 404 / 平台无产物 / 签名失败全部骗用户「你已经是最新了」。
 *
 * 这里逐条锁定修复后的映射，并显式断言：**任何错误都不得**报「当前已是最新版本」。
 */
import { describe, it, expect } from 'vitest'
import { classifyUpdateError, errorText, UPDATE_ERROR_COPY } from './errorClassifier'

describe('errorText', () => {
  it('读取纯字符串错误本身', () => {
    expect(errorText('boom')).toContain('boom')
  })

  it('读取 Error 实例的 message', () => {
    expect(errorText(new Error('boom'))).toContain('boom')
  })

  it('读取结构化对象上的 message / code', () => {
    const text = errorText(Object.assign(new Error('boom'), { code: 'ENOTFOUND' }))
    expect(text).toContain('boom')
    expect(text).toContain('ENOTFOUND')
  })

  it('空值不抛异常', () => {
    expect(errorText(null)).toBe('')
    expect(errorText(undefined)).toBe('')
  })
})

describe('classifyUpdateError', () => {
  it('ENOTFOUND → network', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    expect(classifyUpdateError(err)).toEqual({
      code: 'network',
      message: UPDATE_ERROR_COPY.network,
    })
  })

  it('纯字符串的 DNS 错误 → network（插件把错误序列化成字符串）', () => {
    expect(classifyUpdateError('error sending request for url (https://example.com/latest.json)').code)
      .toBe('network')
  })

  it('超时 → network', () => {
    expect(classifyUpdateError('operation timed out').code).toBe('network')
  })

  it('403 rate limit → ratelimit', () => {
    expect(classifyUpdateError('403 rate limit').code).toBe('ratelimit')
  })

  it('429 → ratelimit', () => {
    expect(classifyUpdateError('HTTP 429 Too Many Requests').code).toBe('ratelimit')
  })

  it('远端清单 404 → manifest-missing（绝不能是「已是最新」）', () => {
    const err = 'Could not fetch a valid release JSON from the remote'
    const result = classifyUpdateError(err)
    expect(result.code).toBe('manifest-missing')
    expect(result.message).toBe(UPDATE_ERROR_COPY['manifest-missing'])
    expect(result.message).not.toContain('已是最新')
  })

  it('裸 404 文本 → manifest-missing', () => {
    expect(classifyUpdateError('HTTP status client error (404 Not Found)').code).toBe('manifest-missing')
  })

  it('清单里没有当前平台产物 → no-platform-asset', () => {
    const err = 'the platform `darwin-aarch64` was not found in the response `platforms` object'
    expect(classifyUpdateError(err).code).toBe('no-platform-asset')
  })

  it('所有 fallback 平台都缺失 → no-platform-asset', () => {
    const err = 'None of the fallback platforms `["darwin-aarch64-app"]` were found in the response `platforms` object'
    expect(classifyUpdateError(err).code).toBe('no-platform-asset')
  })

  it('签名校验失败 → signature-failed', () => {
    const err = 'minisign error: signature verification failed'
    const result = classifyUpdateError(err)
    expect(result.code).toBe('signature-failed')
    expect(result.message).toBe(UPDATE_ERROR_COPY['signature-failed'])
  })

  it('签名 base64 非法 → signature-failed', () => {
    const err = 'The signature abc could not be decoded, please check if it is a valid base64 string.'
    expect(classifyUpdateError(err).code).toBe('signature-failed')
  })

  it('下载阶段 404 → download-failed（不是 manifest-missing）', () => {
    const err = 'Download request failed with status: 404 Not Found'
    expect(classifyUpdateError(err).code).toBe('download-failed')
  })

  it('安装失败 → install-failed', () => {
    expect(classifyUpdateError('Failed to install package').code).toBe('install-failed')
  })

  it('无法归类的错误 → unknown', () => {
    const err = new Error('boom')
    const result = classifyUpdateError(err)
    expect(result.code).toBe('unknown')
    expect(result.message).toBe(UPDATE_ERROR_COPY.unknown)
  })

  it('非 Error 值 → unknown', () => {
    expect(classifyUpdateError('string error').code).toBe('unknown')
    expect(classifyUpdateError(undefined).code).toBe('unknown')
    expect(classifyUpdateError(null).code).toBe('unknown')
    expect(classifyUpdateError({}).code).toBe('unknown')
  })

  it('兜底文案是「检查更新失败，请稍后重试。」而不是「当前已是最新版本」', () => {
    expect(classifyUpdateError(new Error('boom')).message).toBe('检查更新失败，请稍后重试。')
  })

  it('任何输入都不得产出「当前已是最新版本」', () => {
    const samples: unknown[] = [
      'boom',
      new Error('boom'),
      undefined,
      null,
      {},
      'Could not fetch a valid release JSON from the remote',
      'the platform `darwin-x86_64` was not found in the response `platforms` object',
      'minisign error: signature verification failed',
      'error sending request for url (https://example.com)',
      'HTTP 429 Too Many Requests',
    ]
    for (const sample of samples) {
      expect(classifyUpdateError(sample).message).not.toContain('已是最新')
    }
  })
})
