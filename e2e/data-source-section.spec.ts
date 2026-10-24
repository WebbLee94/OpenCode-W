import { test, expect } from '@playwright/test'
import { installTauriStub, type StubPlan } from './helpers/tauri-stub'
import { IPC_CHANNELS as CH } from '../shared/ipc-channels'
import { expectContrastAtLeast } from './helpers/contrast'

/**
 * 设置页 · 数据源区 E2E。
 *
 * 覆盖点：数据库路径行右侧的「打开数据库所在目录」图标按钮。
 *
 * 这个按钮是**图标按钮**（只有图标，没有文字、没有边框），
 * 图形本身就是它唯一的视觉标识 → 适用 WCAG 1.4.11（非文本图形）：
 * 对比度必须 ≥ 3:1。
 *
 * ⚠️ 弱化一档在肉眼看来毫无差别，却可能直接跌破 3:1
 * （text-gray-400 = #99a1af 对白底只有 2.60:1），
 * 所以这里**量真实渲染出来的颜色**，而不是读 class 名。
 * 测量逻辑见共享 helper（e2e/helpers/contrast.ts）。
 */

const SCHEMA = {
  mode: 'v2',
  migrationPhase: 'none',
  hasLegacyTables: false,
  v2SessionCount: 3,
  unsupportedReason: null,
}

/**
 * database:health —— 「已连接」态。
 *
 * ⚠️ `currentPath` 必须有值：路径行（含「打开数据库所在目录」按钮）
 * 只在 `connected && dbPath` 时才渲染。
 */
const HEALTH = {
  ok: true,
  pageCount: 1,
  freelistPages: 0,
  walSize: 0,
  dbSize: 4096,
  currentPath: '/tmp/opencode.db',
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
      'plugin:path|home_dir': '/Users/tester',
    },
  }
}

test.describe('设置页 · 数据源区', () => {
  test.beforeEach(async ({ page }) => {
    await installTauriStub(page, tauriPlan())
  })

  test('「打开数据库所在目录」图标静止态对比度 ≥ 3:1（WCAG 1.4.11）', async ({ page }) => {
    await page.goto('/#/settings')

    const btn = page.getByRole('button', { name: '打开数据库所在目录' })
    await expect(btn).toBeVisible()

    // 量真实渲染出来的颜色（不是 class 名）：
    // 弱化一档在肉眼看来毫无差别，却可能直接跌破 3:1。
    await expectContrastAtLeast(
      page,
      'button[aria-label="打开数据库所在目录"]',
      3,
      '「打开数据库所在目录」图标',
    )

    // 顺手钉住颜色本身：text-gray-500（对白底 ≈ 4.84:1）
    // ⚠️ 不要退回 text-gray-400（≈ 2.60:1，达不到 3:1）
    await expect(btn).toHaveClass(/text-gray-500/)
    await expect(btn).not.toHaveClass(/text-gray-400/)
    // hover 态（已合规）保持不动
    await expect(btn).toHaveClass(/hover:text-gray-600/)
  })
})
