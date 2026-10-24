/**
 * 错误分类器
 * 把任意错误归类为 UpdateErrorCode，供 UI 决定状态文案 / 重试策略。
 *
 * ⚠️ 关键约定：
 *   tauri-plugin-updater 的 `Error` 在 Rust 侧被 `serialize_str(self.to_string())`
 *   序列化，因此 JS 侧拿到的**是纯字符串**，`err.message` 为 undefined。
 *   所以这里必须读 `String(err)`，不能只读 `err.message`。
 *
 * ⚠️ 另一条硬约束：**兜底分支只能是 unknown**。
 *   「当前已是最新版本」是 `check()` 返回 null 的**成功**结果，绝不能出现在错误文案里，
 *   否则网络失败 / 清单 404 / 平台无产物 / 签名失败都会骗用户「你已经是最新了」。
 */
import type { UpdateErrorCode, UpdateErrorPayload } from '@shared/types'

/**
 * 把任意抛出值压平成一段可检索的文本。
 *
 * 优先使用 `String(err)`：插件抛出的纯字符串、Error 实例、带 code 的
 * Node 风格错误都能落到同一段文本上；再补齐 `message` / `code`，
 * 兼容那些把信息放在字段里而不是字符串里的包装对象。
 */
export function errorText(err: unknown): string {
  if (err === null || err === undefined) return ''
  if (typeof err === 'string') return err
  if (typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown; name?: unknown }
    const parts = [String(err)]
    if (typeof e.message === 'string' && e.message) parts.push(e.message)
    if (typeof e.code === 'string' && e.code) parts.push(e.code)
    if (typeof e.name === 'string' && e.name) parts.push(e.name)
    return parts.join(' ')
  }
  return String(err)
}

/**
 * 每个错误码对应的**唯一**用户可见文案。
 * 设置页状态区、Toast、更新弹窗共用同一份字符串，避免同一错误出现两种说法。
 */
export const UPDATE_ERROR_COPY: Record<UpdateErrorCode, string> = {
  network: '网络连接失败，请检查网络后重试。',
  ratelimit: '请求过于频繁，请稍后再试。',
  'manifest-missing': '尚未发布正式版本，暂无可用更新。',
  'no-platform-asset': '官方暂未提供适用于本平台的更新包，可前往发布页手动下载。',
  'signature-failed': '更新包签名校验未通过，已拒绝安装。请从官方发布页手动下载安装。',
  'download-failed': '更新包下载失败，请检查网络后重试。',
  'install-failed': '更新安装失败，请从官方发布页手动下载安装。',
  unknown: '检查更新失败，请稍后重试。',
}

interface Rule {
  code: UpdateErrorCode
  test: RegExp
  /**
   * 命中 `test` 之后还要**排除**的语境。
   *
   * 用来表达「同一段文字里出现了关键词，但属于另一个领域」的情况：
   * 例如 TLS 错误里的 `certificate` / `verify` 会被签名规则先撞上，
   * 但它跟更新包签名毫无关系。
   */
  exclude?: RegExp
  /**
   * 覆盖该错误码的默认文案。
   * 只在「同一错误码下有更具体的场景」时使用（例如更新源端点非 HTTPS）。
   */
  message?: string
}

/**
 * 规则顺序即优先级：越具体的规则越靠前。
 *
 * 例子：`Download request failed with status: 404 Not Found` 必须先命中
 * download-failed 再轮到 404 规则，否则会被误判成「清单不可用」。
 * 再如：清单 URL 本身含 `download` 字样（.../releases/latest/download/latest.json），
 * 所以下载相关规则不能用裸 `/download/`。
 */
const RULES: Rule[] = [
  {
    // 更新源端点不是 https（插件抛 InsecureTransportProtocol）：属于**配置错误**，
    // 必须说清原因，否则用户只会看到笼统的「检查更新失败」。
    // 仍归到 unknown 兜底码 —— 新增错误码要改 shared/types.ts，超出本次改动范围。
    code: 'unknown',
    test: /InsecureTransportProtocol|insecure transport|url scheme is not allowed/i,
    message: '更新源配置异常：更新地址不是安全连接（HTTPS），请检查网络环境后重试。',
  },
  {
    // minisign / base64 签名错误：更新包与公钥不匹配。
    // `Invalid symbol 45, offset 3.` 是 base64 解码失败，插件不带任何上下文，
    // 所以要单独匹配，否则会掉进 unknown 兜底。
    //
    // ⚠️ 这里**不能**匹配裸 `verify`：TLS 类错误（"failed to verify TLS certificate"、
    // "certificate verify failed"）会先撞上这条规则，被误报成
    // 「更新包签名校验未通过，已拒绝安装」—— 这个文案比真实原因严重得多，
    // 会让用户以为更新包被篡改。
    // 因此：只认**签名**相关关键词，并用 exclude 把 TLS / 证书语境整个挡掉，
    // 让这类错误继续往下面的 network 规则落。
    code: 'signature-failed',
    test: /minisign|signature|pubkey|public key|invalid symbol \d+, offset \d+|base64|签名/i,
    exclude: /\b(?:tls|ssl|cert|certificate|certificates|x509)\b/i,
  },
  {
    // 限流
    code: 'ratelimit',
    test: /\b429\b|too many requests|rate.?limit|请求过于频繁/i,
  },
  {
    // 下载阶段失败（状态码 / 传输中断 / 连接被重置）
    code: 'download-failed',
    test: /download request failed|failed to download|download failed|error downloading|download error/i,
  },
  {
    // 安装阶段失败。
    // `binary for the current target not found in the archive` 是**压缩包里缺少
    // 本平台可执行文件**（包坏了），属于安装期问题 —— 不能说成「官方没提供本平台包」。
    code: 'install-failed',
    test: /failed to install|install failed|installing failed|package install|deb install|invalid updater binary format|extract path|temp dir|installation|binary for the current target not found|not found in the archive/i,
  },
  {
    // 清单里没有当前平台的产物。
    // 负向断言排除「压缩包内缺少可执行文件」那一句（安装期问题，见上一条规则）。
    code: 'no-platform-asset',
    test: /was not found in the response|fallback platforms|targets? ?not ?found(?! in the archive)|unsupported application architecture|unsupported os|unsupported target|no asset/i,
  },
  {
    // 远端更新清单不可用（404 / 非 JSON / 端点未配置）
    // 注：端点**非 HTTPS** 由上面的 InsecureTransportProtocol 规则先命中。
    //
    // ⚠️ 这里**不能**用裸 `not found`：任何无关的 "not found"（某个配置文件、
    // 某个临时文件……）都会被误判成「清单缺失」。
    // 只认**远端清单不可用**的表述：插件的 ReleaseNotFound、清单 JSON 解析失败、
    // 更新端点未配置、以及端点返回的 HTTP 404 / 5xx。
    code: 'manifest-missing',
    test: /could not fetch a valid release json|release ?not ?found|failed to deserialize update response|update endpoint did not respond|endpoints? (?:set|not set|not configured|are not set)|\b404\b|forbidden|\b5\d\d\b|server error/i,
  },
  {
    // 网络层失败：超时 / DNS / TLS / 连接被拒
    // TLS 握手类错误（"handshake failure"）也归这里 —— 它们同样是网络/证书问题，
    // 不能落到签名规则去（见上面的 exclude）。
    code: 'network',
    test: /timed.?out|timeout|connection reset|connection refused|connection aborted|network|dns|getaddrinfo|tls|ssl|certificate|handshake|error sending request|error connecting|request failed|failed to fetch|unable to resolve|no route to host|econnreset|econnrefused|enotfound|etimedout|ehostunreach|enetunreach|epipe/i,
  },
]

/**
 * 把任意错误归类为一个明确的错误码 + 用户可见文案。
 *
 * 兜底返回 `unknown`，绝不返回「当前已是最新版本」。
 */
export function classifyUpdateError(err: unknown): UpdateErrorPayload {
  const text = errorText(err)
  for (const rule of RULES) {
    if (!rule.test.test(text)) continue
    // 命中排除语境（例如 TLS 证书错误撞上签名规则）→ 不采用这条规则，
    // 继续往下匹配，让它落到更贴切的分类上。
    if (rule.exclude?.test(text)) continue
    return { code: rule.code, message: rule.message ?? UPDATE_ERROR_COPY[rule.code] }
  }
  return { code: 'unknown', message: UPDATE_ERROR_COPY.unknown }
}

/**
 * 这两类错误**重试也不会成功**，UI 不应再提供「立即更新 / 重试」入口：
 *   - signature-failed：更新包与公钥不匹配，再点一次必然同样失败
 *   - no-platform-asset：清单里根本没有本平台产物，重试毫无意义
 *
 * 命中时应改为引导用户去官方发布页手动下载安装，
 * 同时**必须保留**失败原因文案（用户仍要知道出了什么事）。
 */
export function canRetryUpdate(error: UpdateErrorPayload | null): boolean {
  if (!error) return true
  return error.code !== 'signature-failed' && error.code !== 'no-platform-asset'
}
