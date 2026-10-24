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
import { classifyUpdateError, canRetryUpdate, errorText, UPDATE_ERROR_COPY } from './errorClassifier'

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

  it('清单不可用的其它说法 → manifest-missing', () => {
    expect(classifyUpdateError('ReleaseNotFound').code).toBe('manifest-missing')
    expect(classifyUpdateError('release not found').code).toBe('manifest-missing')
    expect(classifyUpdateError('Updater does not have any endpoints set.').code).toBe('manifest-missing')
    expect(classifyUpdateError('failed to deserialize update response: expected value').code)
      .toBe('manifest-missing')
  })

  it('无关的 "not found" 不再被误判成清单缺失', () => {
    // 旧规则含裸 `not found`：任何无关的 "not found" 都会掉进「清单缺失」。
    for (const err of [
      'config file not found',
      'state directory not found',
      'helper binary not found',
    ]) {
      expect(classifyUpdateError(err).code, err).not.toBe('manifest-missing')
    }
    // 兜底仍是 unknown（绝不谎报「已是最新」）
    expect(classifyUpdateError('config file not found').code).toBe('unknown')
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

  it('签名 base64 解码失败（插件只抛 Invalid symbol N, offset M）→ signature-failed', () => {
    // 插件把错误序列化成纯字符串，且不带任何上下文：
    // 既没有 "signature" 也没有 "minisign"，旧实现会掉进 unknown。
    const err = 'Invalid symbol 45, offset 3.'
    const result = classifyUpdateError(err)
    expect(result.code).toBe('signature-failed')
    expect(result.message).toBe(UPDATE_ERROR_COPY['signature-failed'])
    expect(result.message).not.toContain('已是最新')
  })

  it('签名校验失败的其它说法 → signature-failed', () => {
    expect(classifyUpdateError('The signature verification failed').code).toBe('signature-failed')
    expect(classifyUpdateError('failed to verify signature').code).toBe('signature-failed')
    expect(classifyUpdateError('invalid signature').code).toBe('signature-failed')
    expect(classifyUpdateError('The signature was created with a different key than the one provided').code)
      .toBe('signature-failed')
    expect(classifyUpdateError('Invalid encoding in minisign data').code).toBe('signature-failed')
  })

  it('TLS 校验失败 → network（绝不是 signature-failed）', () => {
    // ⚠️ 这类错误里有裸 "verify"，旧规则会先命中签名规则，
    // 被误报成「更新包签名校验未通过，已拒绝安装」—— 比真实原因严重得多。
    const err = 'failed to verify TLS certificate'
    const result = classifyUpdateError(err)
    expect(result.code).toBe('network')
    expect(result.message).toBe(UPDATE_ERROR_COPY.network)
    expect(result.message).not.toContain('签名')
  })

  it('证书 / TLS 握手的其它说法 → network', () => {
    expect(classifyUpdateError('certificate verify failed').code).toBe('network')
    expect(classifyUpdateError('certificate verification failed').code).toBe('network')
    expect(classifyUpdateError('invalid peer certificate: UnknownIssuer').code).toBe('network')
    expect(classifyUpdateError('SSL: CERTIFICATE_VERIFY_FAILED').code).toBe('network')
    expect(classifyUpdateError('tls handshake eof').code).toBe('network')
  })

  it('证书语境下的 signature 也不该命中签名规则 → network', () => {
    // 证书链校验同样会用到 "signature" 一词，但它与更新包签名无关。
    expect(classifyUpdateError('certificate signature verification failed').code).toBe('network')
  })

  it('压缩包里没有本平台可执行文件 → install-failed（不是「官方没提供本平台包」）', () => {
    const err = 'binary for the current target not found in the archive'
    const result = classifyUpdateError(err)
    expect(result.code).toBe('install-failed')
    expect(result.message).toBe(UPDATE_ERROR_COPY['install-failed'])
    expect(result.message).not.toContain('官方暂未提供')
  })

  it('更新源端点非 HTTPS → 文案要说明原因（不得笼统报「检查更新失败」）', () => {
    const err = 'InsecureTransportProtocol'
    const result = classifyUpdateError(err)
    // 端点非 https 属于配置错误，暂无独立错误码，先归 unknown 兜底
    expect(result.code).toBe('unknown')
    expect(result.message).toContain('更新源配置异常')
    expect(result.message).not.toContain('已是最新')
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
      'Invalid symbol 45, offset 3.',
      'binary for the current target not found in the archive',
      'InsecureTransportProtocol',
      // TLS / 证书类错误：必须落在 network，绝不能变成「已是最新」
      'failed to verify TLS certificate',
      'certificate verification failed',
      'invalid peer certificate: UnknownIssuer',
      // 无关的 "not found"：兜底 unknown，也绝不能变成「已是最新」
      'config file not found',
    ]
    for (const sample of samples) {
      expect(classifyUpdateError(sample).message).not.toContain('已是最新')
    }
  })
})

describe('canRetryUpdate', () => {
  it('无错误 → 允许重试', () => {
    expect(canRetryUpdate(null)).toBe(true)
  })

  it('网络等临时故障 → 允许重试', () => {
    expect(canRetryUpdate({ code: 'network', message: UPDATE_ERROR_COPY.network })).toBe(true)
    expect(canRetryUpdate({ code: 'download-failed', message: UPDATE_ERROR_COPY['download-failed'] })).toBe(true)
  })

  it('签名失败 / 本平台无产物 → 不允许重试（再点一次必然同样失败）', () => {
    expect(canRetryUpdate({ code: 'signature-failed', message: UPDATE_ERROR_COPY['signature-failed'] })).toBe(false)
    expect(canRetryUpdate({ code: 'no-platform-asset', message: UPDATE_ERROR_COPY['no-platform-asset'] })).toBe(false)
  })
})
