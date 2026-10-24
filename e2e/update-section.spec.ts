import { test, expect, type Page } from '@playwright/test'
import { installTauriStub, type StubPlan } from './helpers/tauri-stub'
import { IPC_CHANNELS as CH } from '../shared/ipc-channels'
import { expectContrastAtLeast } from './helpers/contrast'

/**
 * 「设置页 · 版本更新」区 E2E —— 覆盖 e727c1a 的状态化改造。
 *
 * 改造要点（每条断言都对应其中一条）：
 *   1. 「最新版本」行改名「可更新版本」，且**只在确有更新时渲染**
 *      —— 无更新时整行不渲染，不再有 `—` 占位。
 *   2. 状态化：未检查 / 检查中 / 已是最新 / 有更新 / 失败 各用独立文案，
 *      集中在 `src/features/update/updateStatus.ts`。
 *   3. 新增「复制版本号」按钮：**常驻但弱化**（只留图标，自绘 tooltip 覆盖鼠标与
 *      键盘两条路径），复制结果由 toast + 图标态 + 读屏 live region 三重反馈。
 *   4. 更新弹窗可关闭（`dialogOpen` 与流程状态分离）。
 *   5. 错误兜底不再说「当前已是最新版本」。
 *
 * 环境约定（与实现一致，见 `src/features/settings/UpdateSection.tsx`）：
 *   - 纯浏览器（无 `window.__TAURI_INTERNALS__`）→ `isTauri()` 为 false，
 *     「当前版本」回落到 `package.json` 的 `v1.4.0`（并明确标注为**构建版本**，
 *     因为那不是用户装的那个版本），「可更新版本」行不渲染，
 *     状态区提示「浏览器预览环境不支持检查更新……」。
 *   - 注入 Tauri IPC stub → 可触达「检查中 / 有更新 / 失败」等真实分支。
 *
 * 为什么浏览器也要测：真实用户里「设置页打开着但更新检查失败」是最容易
 * 出错的状态（曾经会把失败说成「已是最新版本」），必须锁死文案。
 */

/** `package.json` 的 version = 1.4.0 → 非 Tauri 回落到 `v1.4.0` */
const BROWSER_PREVIEW_VERSION = 'v1.4.0'

/** 非 Tauri 环境下版本号旁的来源标注（不能把仓库构建版本说成已安装版本） */
const BUILD_VERSION_LABEL = '构建版本'

/** 非 Tauri 环境的状态区文案（与 `UPDATE_STATUS_COPY.browserUnsupported` 一致） */
const BROWSER_PREVIEW_HINT = '浏览器预览环境不支持检查更新，请在桌面应用中查看版本信息。'

/** 模拟 Tauri 环境下「发现新版本」的状态文案 */
const AVAILABLE_HINT = '发现新版本 v1.4.1，可立即更新。'

/** 模拟 Tauri 环境下「检查失败（网络）」的状态文案 */
const NETWORK_FAIL_HINT = '网络连接失败，请检查网络后重试。'

/** 模拟 Tauri 环境下「签名校验失败」的状态文案 */
const SIGNATURE_FAIL_HINT = '更新包签名校验未通过，已拒绝安装。请从官方发布页手动下载安装。'

const SCHEMA = {
  mode: 'v2',
  migrationPhase: 'none',
  hasLegacyTables: false,
  v2SessionCount: 3,
  unsupportedReason: null,
}

const HEALTH = {
  ok: true,
  pageCount: 1,
  freelistPages: 0,
  walSize: 0,
  dbSize: 4096,
  currentPath: '/tmp/opencode.db',
}

/** tauri-plugin-updater 的 `check()` 成功时返回的元数据 */
const UPDATER_METADATA = {
  rid: 1,
  currentVersion: '1.4.0',
  version: '1.4.1',
  date: '2026-10-01T00:00:00Z',
  body: '修复若干问题',
  rawJson: {},
}

/** 模拟 Tauri 运行时所需的 IPC 计划 */
function tauriPlan(): StubPlan {
  return {
    respond: {
      [CH.DATABASE_INFO]: SCHEMA,
      [CH.DATABASE_HEALTH]: HEALTH,
      [CH.SESSIONS_PROJECTS]: [],
    },
    respondRaw: {
      'plugin:app|version': '1.4.0',
      'plugin:path|home_dir': '/Users/tester',
    },
  }
}

/**
 * 注入剪贴板 stub。
 *
 * ⚠️ 注入时机：`addInitScript` 必须在 `page.goto` **之前**调用，否则页面
 * 自己的脚本已经跑过，stub 覆盖不到 `navigator.clipboard`。无头浏览器里
 * 真实剪贴板还受权限 / 焦点限制，不可依赖。
 */
async function installClipboardStub(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const writes: string[] = []
    ;(window as unknown as { __clipboardWrites?: string[] }).__clipboardWrites = writes
    const clipboard = {
      writeText: async (text: string) => {
        writes.push(text)
      },
      readText: async () => writes.join(''),
    }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      get: () => clipboard,
    })
  })
}

/**
 * 把 `plugin:updater|check` 挂起，直到测试显式放行。
 *
 * 目的：让「检查中」这一瞬时状态可被稳定断言（不必靠 sleep 撞运气），
 * 同时能分别构造「成功」与「失败」两个结局。
 */
async function installUpdaterGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke: (cmd: string, payload?: unknown, options?: unknown) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    if (!internals) throw new Error('Tauri stub 未安装：必须先调用 installTauriStub')

    const original = internals.invoke.bind(internals)
    let settle: { resolve?: (v: unknown) => void; reject?: (e: unknown) => void } = {}

    ;(window as unknown as { __updaterGate?: unknown }).__updaterGate = {
      resolve(value: unknown) {
        settle.resolve?.(value)
      },
      reject(message: string) {
        settle.reject?.(new Error(message))
      },
    }

    internals.invoke = (cmd, payload, options) => {
      if (cmd === 'plugin:updater|check') {
        return new Promise((resolve, reject) => {
          settle = { resolve, reject }
        })
      }
      return original(cmd, payload, options)
    }
  })
}

async function resolveUpdaterCheck(page: Page, metadata: unknown): Promise<void> {
  await page.evaluate((value) => {
    const gate = (
      window as unknown as { __updaterGate?: { resolve(v: unknown): void } }
    ).__updaterGate
    if (!gate) throw new Error('updater gate 未安装')
    gate.resolve(value)
  }, metadata)
}

async function rejectUpdaterCheck(page: Page, message: string): Promise<void> {
  await page.evaluate((msg) => {
    const gate = (
      window as unknown as { __updaterGate?: { reject(m: string): void } }
    ).__updaterGate
    if (!gate) throw new Error('updater gate 未安装')
    gate.reject(msg)
  }, message)
}

async function clipboardWrites(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __clipboardWrites?: string[] }).__clipboardWrites ?? [],
  )
}

/**
 * 「打开发布页」实际发出的 shell open IPC 目标地址。
 *
 * 桌面端走 `@tauri-apps/plugin-shell` 的 open()，在 stub 环境里表现为
 * `plugin:shell|open` 调用 —— 用它断言用户拿到的是真正的发布页地址。
 */
async function shellOpenTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const qa = (
      window as unknown as {
        __qa?: { log: Array<{ channel: string; payload: unknown }> }
      }
    ).__qa
    if (!qa) return []
    return qa.log
      .filter(c => c.channel === 'plugin:shell|open')
      .map(c => String((c.payload as { path?: unknown } | null)?.path ?? ''))
  })
}

/**
 * 让 `plugin:shell|open` 失败 —— 模拟「系统浏览器打不开」。
 *
 * 打开发布页时 `openExternal` 先试 shell plugin，失败才降级到 `window.open`。
 * 把 shell 打掉，就能测到这条浏览器降级路径。
 */
async function breakShellOpen(page: Page): Promise<void> {
  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke: (cmd: string, payload?: unknown, options?: unknown) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__
    if (!internals) throw new Error('Tauri stub 未安装：必须先调用 installTauriStub')

    const original = internals.invoke.bind(internals)
    internals.invoke = (cmd, payload, options) => {
      if (cmd === 'plugin:shell|open') return Promise.reject(new Error('shell unavailable'))
      return original(cmd, payload, options)
    }
  })
}

interface CollectedErrors {
  consoleErrors: string[]
  pageErrors: string[]
}

/** 与 `e2e/console-errors.spec.ts` 相同的收集方式 */
function attachErrorCollectors(page: Page): CollectedErrors {
  const errors: CollectedErrors = { consoleErrors: [], pageErrors: [] }

  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => {
    errors.pageErrors.push(`${err.name}: ${err.message}\n${err.stack ?? ''}`)
  })

  return errors
}

function describeErrors(errors: CollectedErrors): string {
  return [
    `console.error (${errors.consoleErrors.length})`,
    errors.consoleErrors.join('\n'),
    `pageerror (${errors.pageErrors.length})`,
    errors.pageErrors.join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * toast 提示条。
 *
 * ⚠️ toast 与读屏 live region 的文案**完全相同**（都是「已复制版本号 v1.4.0」），
 * 直接用 `getByText` 会同时命中两个元素（strict mode violation）。
 * 这里按 toast 自己的形态（绿色提示条）精确定位。
 */
function successToast(page: Page, text: string) {
  return page.locator('div.bg-green-600', { hasText: text })
}

test.describe('设置页 · 版本更新（浏览器预览环境）', () => {
  test.beforeEach(async ({ page }) => {
    // 注意：这里**不**安装 Tauri stub —— `isTauri()` 必须保持 false，
    // 否则测的就不是「浏览器预览」这条分支了。
    await installClipboardStub(page)
  })

  test('「版本更新」区渲染：当前版本回落到 package.json 的 v1.4.0（标注为构建版本）', async ({ page }) => {
    await page.goto('/#/settings')

    const section = page.getByTestId('update-section')
    await expect(section).toBeVisible()
    await expect(section.getByRole('heading', { name: '版本更新' })).toBeVisible()

    // 当前版本：非 Tauri 回落到 package.json（version = 1.4.0）
    await expect(page.getByTestId('update-current-version')).toHaveText(BROWSER_PREVIEW_VERSION)
    await expect(section.getByText('当前版本')).toBeVisible()

    // ⚠️ 回落值是**仓库构建版本**，不是用户装的那个版本 —— 措辞必须如实标注
    await expect(page.getByTestId('update-version-source')).toHaveText(BUILD_VERSION_LABEL)
    await expect(page.getByTestId('update-version-note')).toContainText('构建版本')
  })

  test('无更新时不渲染「可更新版本」行（无更新时整行不渲染，不是 `—`）', async ({ page }) => {
    await page.goto('/#/settings')

    const section = page.getByTestId('update-section')
    await expect(section).toBeVisible()

    // 条件渲染：可更新版本行不存在
    await expect(page.getByTestId('update-available-version')).toHaveCount(0)
    // 页面上连「可更新版本」四个字都没有
    await expect(section.getByText('可更新版本')).toHaveCount(0)
    await expect(page.getByText('可更新版本')).toHaveCount(0)
    // 旧实现遗留的占位符 `—` 也不该出现
    await expect(section.getByText('—')).toHaveCount(0)

    // 未检查过时「上次检查」行同样不渲染
    await expect(section.getByText('上次检查')).toHaveCount(0)
  })

  test('状态区显示浏览器环境提示文案', async ({ page }) => {
    await page.goto('/#/settings')

    const status = page.getByTestId('update-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveText(BROWSER_PREVIEW_HINT)
  })

  test('状态区是 live region（role=status + aria-live/aria-atomic）', async ({ page }) => {
    await page.goto('/#/settings')

    const section = page.getByTestId('update-section')
    const status = page.getByTestId('update-status')

    await expect(status).toHaveAttribute('role', 'status')
    await expect(status).toHaveAttribute('aria-live', 'polite')
    await expect(status).toHaveAttribute('aria-atomic', 'true')

    // 更新状态区与复制播报区职责不同，各自是独立的 live region
    await expect(section.getByTestId('update-status')).toHaveCount(1)
    const copyStatus = section.getByTestId('copy-version-status')
    await expect(copyStatus).toHaveAttribute('role', 'status')
    await expect(copyStatus).toHaveAttribute('aria-live', 'polite')
  })

  test('「检查更新」按钮在非 Tauri 环境下不可用', async ({ page }) => {
    await page.goto('/#/settings')

    const checkBtn = page.getByRole('button', { name: '检查更新' })
    await expect(checkBtn).toBeVisible()
    await expect(checkBtn).toBeDisabled()

    // 点了也不能把状态区改成别的文案（disabled 按钮在浏览器里不会派发 click，
    // 这里用 force 绕过 Playwright 的可点击性检查，模拟「用户真的去点了」）
    await checkBtn.click({ force: true })
    await expect(page.getByTestId('update-status')).toHaveText(BROWSER_PREVIEW_HINT)
  })

  test('「复制版本号」按钮可点击：写入剪贴板并给出成功反馈', async ({ page }) => {
    await page.goto('/#/settings')

    const copyBtn = page.getByRole('button', { name: '复制版本号' })
    await expect(copyBtn).toBeVisible()
    await expect(copyBtn).toBeEnabled()

    // 按钮只留图标，没有可见文案（文案在 tooltip 里）
    await expect(copyBtn).toHaveText('')

    await copyBtn.click()

    // 确实把当前版本号写进了剪贴板
    await expect.poll(() => clipboardWrites(page)).toEqual([BROWSER_PREVIEW_VERSION])
    // 有明确的成功反馈：toast 文案 + 图标态（对勾）+ 读屏播报
    await expect(successToast(page, `已复制版本号 ${BROWSER_PREVIEW_VERSION}`)).toBeVisible()
    await expect(copyBtn.locator('svg.lucide-check')).toHaveCount(1)
    await expect(page.getByTestId('copy-version-status')).toHaveText(
      `已复制版本号 ${BROWSER_PREVIEW_VERSION}`,
    )
  })

  test('复制按钮常驻但弱化：自绘 tooltip 覆盖鼠标与键盘两条路径', async ({ page }) => {
    await page.goto('/#/settings')

    const copyBtn = page.getByRole('button', { name: '复制版本号' })
    const tooltip = page.getByTestId('copy-version-tooltip')

    // 不用原生 title：它与自绘 tooltip 并存会弹出两个互相遮挡的提示
    await expect(copyBtn).not.toHaveAttribute('title', /.+/)
    // 按钮本身常驻可见（不靠 hover 才出现，触屏没有 hover）
    await expect(copyBtn).toBeVisible()
    // 常态隐藏
    await expect(tooltip).toHaveCSS('opacity', '0')

    // 鼠标路径
    await copyBtn.hover()
    await expect(tooltip).toHaveCSS('opacity', '1')
    await expect(tooltip).toHaveText('复制版本号')

    // 移开鼠标 → 重新隐藏
    await page.mouse.move(0, 0)
    await expect(tooltip).toHaveCSS('opacity', '0')

    // 键盘路径：原生 title 在 focus 时不显示，自绘 tooltip 必须补上这一条
    await copyBtn.focus()
    await expect(tooltip).toHaveCSS('opacity', '1')
  })

  test('复制图标静止态对比度 ≥ 3:1（WCAG 1.4.11：图标是按钮唯一的视觉标识）', async ({ page }) => {
    await page.goto('/#/settings')

    const copyBtn = page.getByRole('button', { name: '复制版本号' })
    await expect(copyBtn).toBeVisible()

    // 量真实渲染出来的颜色（不是 class 名）：
    // 弱化一档在肉眼看来毫无差别，却可能直接跌破 3:1。
    // 测量逻辑见共享 helper（e2e/helpers/contrast.ts）。
    await expectContrastAtLeast(
      page,
      'button[aria-label="复制版本号"]',
      3,
      '复制版本号图标',
    )

    // 顺手钉住颜色本身：text-gray-500（对白底 ≈ 4.8:1）
    // ⚠️ 不要退回 text-gray-400（≈ 2.5:1，达不到 3:1）
    await expect(copyBtn).toHaveClass(/text-gray-500/)
    await expect(copyBtn).not.toHaveClass(/text-gray-400/)
  })

  test('复制按钮：连续复制两次都会更新读屏播报区', async ({ page }) => {
    await page.goto('/#/settings')

    const copyBtn = page.getByRole('button', { name: '复制版本号' })
    const copyStatus = page.getByTestId('copy-version-status')

    await copyBtn.click()
    await expect(copyStatus).toHaveText(`已复制版本号 ${BROWSER_PREVIEW_VERSION}`)

    // 连点第二次：文案相同，但 live region 节点被重建 → 读屏会重播
    await copyBtn.click()
    await expect(copyStatus).toHaveText(`已复制版本号 ${BROWSER_PREVIEW_VERSION}`)
    await expect.poll(() => clipboardWrites(page)).toEqual([
      BROWSER_PREVIEW_VERSION,
      BROWSER_PREVIEW_VERSION,
    ])
  })

  test('设置页全程无控制台错误', async ({ page }) => {
    const errors = attachErrorCollectors(page)

    await page.goto('/#/settings')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(500)

    expect(errors.consoleErrors, describeErrors(errors)).toEqual([])
    expect(errors.pageErrors, describeErrors(errors)).toEqual([])
  })
})

test.describe('设置页 · 版本更新（模拟 Tauri 环境）', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriStub(page, tauriPlan())
    await installClipboardStub(page)
  })

  test('检查中 → 有更新：渲染「可更新版本」行、上次检查行与立即更新入口', async ({ page }) => {
    await page.goto('/#/settings')
    await installUpdaterGate(page)

    const section = page.getByTestId('update-section')
    const status = page.getByTestId('update-status')
    await expect(section).toBeVisible()

    // 未检查：尚未检查，且不渲染「可更新版本」
    await expect(status).toHaveText('尚未检查更新。')
    await expect(page.getByTestId('update-available-version')).toHaveCount(0)

    await page.getByRole('button', { name: '检查更新' }).click()

    // 检查中：独立文案 + 按钮进入 busy 态
    await expect(status).toHaveText('正在检查更新…')
    const checkBtn = page.getByRole('button', { name: /检查中…/ })
    await expect(checkBtn).toBeVisible()
    await expect(checkBtn).toHaveAttribute('aria-busy', 'true')

    await resolveUpdaterCheck(page, UPDATER_METADATA)

    // 有更新：状态文案 + 「可更新版本」行 + 「上次检查」行
    await expect(status).toHaveText(AVAILABLE_HINT)
    await expect(page.getByTestId('update-available-version')).toHaveText('v1.4.1')
    await expect(section.getByText('可更新版本')).toBeVisible()
    await expect(section.getByText('上次检查')).toBeVisible()

    // 「立即更新」入口出现
    await expect(page.getByRole('button', { name: '立即更新' })).toBeVisible()
  })

  test('更新弹窗可关闭，关闭后仍保留「有更新」结论', async ({ page }) => {
    await page.goto('/#/settings')
    await installUpdaterGate(page)

    await page.getByRole('button', { name: '检查更新' }).click()
    await resolveUpdaterCheck(page, UPDATER_METADATA)

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('v1.4.1')).toBeVisible()

    await dialog.getByRole('button', { name: '关闭' }).click()

    // 弹窗关掉了
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // 但「有更新」的结论没有被一起丢掉
    await expect(page.getByTestId('update-status')).toHaveText(AVAILABLE_HINT)
    await expect(page.getByTestId('update-available-version')).toHaveText('v1.4.1')
    await expect(page.getByRole('button', { name: '立即更新' })).toBeVisible()
  })

  test('检查失败：提示失败原因，绝不显示「已是最新版本」', async ({ page }) => {
    await page.goto('/#/settings')
    await installUpdaterGate(page)

    await page.getByRole('button', { name: '检查更新' }).click()
    await rejectUpdaterCheck(page, 'network unreachable: failed to fetch')

    const status = page.getByTestId('update-status')
    await expect(status).toHaveText(NETWORK_FAIL_HINT)

    // 核心回归：失败不得伪装成「已是最新版本」
    await expect(status).not.toContainText('已是最新版本')
    await expect(status).not.toContainText('已是最新版本，无需更新')
    // 失败时也不该渲染「可更新版本」行
    await expect(page.getByTestId('update-available-version')).toHaveCount(0)
  })

  test('已是最新：显示独立文案且不渲染「可更新版本」行', async ({ page }) => {
    await page.goto('/#/settings')
    await installUpdaterGate(page)

    await page.getByRole('button', { name: '检查更新' }).click()
    // check() 返回 null = 没有更新（成功路径，不是错误）
    await resolveUpdaterCheck(page, null)

    const status = page.getByTestId('update-status')
    await expect(status).toHaveText('已是最新版本，无需更新。')
    await expect(page.getByTestId('update-available-version')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('签名校验失败：不提供重试入口，只给「打开发布页」', async ({ page }) => {
    await page.goto('/#/settings')
    await installUpdaterGate(page)

    await page.getByRole('button', { name: '检查更新' }).click()
    await rejectUpdaterCheck(page, 'minisign error: signature verification failed')

    const status = page.getByTestId('update-status')
    await expect(status).toHaveText(SIGNATURE_FAIL_HINT)
    // 失败原因可见，且绝不伪装成「已是最新」
    await expect(status).not.toContainText('已是最新')

    // 再点一次必然同样失败 → 不给重试入口
    await expect(page.getByRole('button', { name: '立即更新' })).toHaveCount(0)

    // 替代动作：打开发布页
    const releaseBtn = page.getByRole('button', { name: '打开发布页' })
    await expect(releaseBtn).toBeVisible()
    await releaseBtn.click()
    await expect.poll(() => shellOpenTargets(page)).toHaveLength(1)
    expect((await shellOpenTargets(page))[0]).toContain('/releases/latest')
  })

  test('TLS 校验失败：报「网络连接失败」，绝不报「签名校验未通过」', async ({ page }) => {
    await page.goto('/#/settings')
    await installUpdaterGate(page)

    await page.getByRole('button', { name: '检查更新' }).click()
    // ⚠️ 这类错误里有裸 "verify"：旧规则会先命中签名规则，
    // 报成「更新包签名校验未通过，已拒绝安装」—— 比真实原因严重得多。
    await rejectUpdaterCheck(page, 'failed to verify TLS certificate')

    const status = page.getByTestId('update-status')
    await expect(status).toHaveText(NETWORK_FAIL_HINT)
    await expect(status).not.toContainText('签名')
    await expect(status).not.toContainText('已是最新')
  })

  test('系统浏览器不可用时：降级到浏览器新窗口打开发布页（不走失败提示）', async ({ page, context }) => {
    const errors = attachErrorCollectors(page)
    await page.goto('/#/settings')
    await installUpdaterGate(page)
    // shell plugin 打掉 → openExternal 走浏览器降级路径
    await breakShellOpen(page)

    await page.getByRole('button', { name: '检查更新' }).click()
    await rejectUpdaterCheck(page, 'minisign error: signature verification failed')

    const releaseBtn = page.getByRole('button', { name: '打开发布页' })
    await expect(releaseBtn).toBeVisible()

    // ⚠️ 回归点：浏览器降级路径必须真的开出一个窗口。
    // 旧实现用 window.open(url, '_blank', 'noopener,noreferrer')，
    // 按规范带 noopener 时 window.open 返回 null → 被误判成「打开失败」。
    const popupPromise = context.waitForEvent('page')
    await releaseBtn.click()
    const popup = await popupPromise
    // GitHub 会把 /releases/latest 重定向到具体的 tag 页，两者都算对
    expect(popup.url()).toContain('/WebbLee94/OpenCode-W/releases')
    await popup.close()

    // 没有走失败提示分支。
    // ⚠️ 失败提示是 toast，3 秒后自动消失 —— 必须在其消失前断言，
    // 否则「不存在」会先假通过、再变真（反过来也一样会漏判）。
    await page.waitForTimeout(500)
    expect(errors.consoleErrors.filter(e => e.includes('打开发布页失败'))).toEqual([])
    expect(await page.getByText(/打开发布页失败/).count()).toBe(0)
  })
})
