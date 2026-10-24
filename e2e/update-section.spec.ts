import { test, expect, type Page } from '@playwright/test'
import { installTauriStub, type StubPlan } from './helpers/tauri-stub'
import { IPC_CHANNELS as CH } from '../shared/ipc-channels'

/**
 * 「设置页 · 版本更新」区 E2E —— 覆盖 e727c1a 的状态化改造。
 *
 * 改造要点（每条断言都对应其中一条）：
 *   1. 「最新版本」行改名「可更新版本」，且**只在确有更新时渲染**
 *      —— 无更新时整行不渲染，不再有 `—` 占位。
 *   2. 状态化：未检查 / 检查中 / 已是最新 / 有更新 / 失败 各用独立文案，
 *      集中在 `src/features/update/updateStatus.ts`。
 *   3. 新增「复制版本号」按钮。
 *   4. 更新弹窗可关闭（`dialogOpen` 与流程状态分离）。
 *   5. 错误兜底不再说「当前已是最新版本」。
 *
 * 环境约定（与实现一致，见 `src/features/settings/UpdateSection.tsx`）：
 *   - 纯浏览器（无 `window.__TAURI_INTERNALS__`）→ `isTauri()` 为 false，
 *     「当前版本」回落到 `package.json` 的 `v1.4.0`，「可更新版本」行不渲染，
 *     状态区提示「浏览器预览环境不支持检查更新……」。
 *   - 注入 Tauri IPC stub → 可触达「检查中 / 有更新 / 失败」等真实分支。
 *
 * 为什么浏览器也要测：真实用户里「设置页打开着但更新检查失败」是最容易
 * 出错的状态（曾经会把失败说成「已是最新版本」），必须锁死文案。
 */

/** `package.json` 的 version = 1.4.0 → 非 Tauri 回落到 `v1.4.0` */
const BROWSER_PREVIEW_VERSION = 'v1.4.0'

/** 非 Tauri 环境的状态区文案（与 `UPDATE_STATUS_COPY.browserUnsupported` 一致） */
const BROWSER_PREVIEW_HINT = '浏览器预览环境不支持检查更新，请在桌面应用中查看版本信息。'

/** 模拟 Tauri 环境下「发现新版本」的状态文案 */
const AVAILABLE_HINT = '发现新版本 v1.4.1，可立即更新。'

/** 模拟 Tauri 环境下「检查失败（网络）」的状态文案 */
const NETWORK_FAIL_HINT = '网络连接失败，请检查网络后重试。'

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

test.describe('设置页 · 版本更新（浏览器预览环境）', () => {
  test.beforeEach(async ({ page }) => {
    // 注意：这里**不**安装 Tauri stub —— `isTauri()` 必须保持 false，
    // 否则测的就不是「浏览器预览」这条分支了。
    await installClipboardStub(page)
  })

  test('「版本更新」区渲染，当前版本回落到 package.json 的 v1.4.0', async ({ page }) => {
    await page.goto('/#/settings')

    const section = page.getByTestId('update-section')
    await expect(section).toBeVisible()
    await expect(section.getByRole('heading', { name: '版本更新' })).toBeVisible()

    // 当前版本：非 Tauri 回落到 package.json（version = 1.4.0）
    await expect(page.getByTestId('update-current-version')).toHaveText(BROWSER_PREVIEW_VERSION)
    await expect(section.getByText('当前版本')).toBeVisible()
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

  test('状态区是唯一的 live region（role=status + aria-live/aria-atomic）', async ({ page }) => {
    await page.goto('/#/settings')

    const section = page.getByTestId('update-section')
    const status = page.getByTestId('update-status')

    await expect(status).toHaveAttribute('role', 'status')
    await expect(status).toHaveAttribute('aria-live', 'polite')
    await expect(status).toHaveAttribute('aria-atomic', 'true')

    // 整个「版本更新」区只有一个 live region，避免读屏重复播报
    await expect(section.getByRole('status')).toHaveCount(1)
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

    await copyBtn.click()

    // 确实把当前版本号写进了剪贴板
    await expect.poll(() => clipboardWrites(page)).toEqual([BROWSER_PREVIEW_VERSION])
    // 有明确的成功反馈（toast 文案 + 按钮态）
    await expect(page.getByText(`已复制版本号 ${BROWSER_PREVIEW_VERSION}`)).toBeVisible()
    await expect(copyBtn).toHaveText(/已复制/)
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
})
