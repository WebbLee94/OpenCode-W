import { test, expect, type Page } from '@playwright/test'
import { installTauriStub } from './helpers/tauri-stub'
import { IPC_CHANNELS as CH } from '../shared/ipc-channels'

/**
 * 窄屏（768px）布局巡检 —— 对应 TEST-014「768px 无横向滚动」
 * 与 08.1 规格第 7 节验收清单 6：
 *   「视口 768×800（内容区约 544px）下 `document.scrollingElement.scrollWidth <= clientWidth`」
 *
 * 为什么必须是 Playwright：jsdom 没有排版引擎，`offsetWidth` / `scrollWidth` 恒为 0，
 * 无法回答「会不会横向滚动」。Chromium 是当前唯一能自动化的真实布局引擎。
 *
 * 覆盖范围（重要，不夸大）：
 *   ✅ 真实浏览器里 768×800 视口下**应用外壳**（侧边栏 + 主区）不产生文档级横向滚动；
 *   ✅ 主区内部允许自身横向滚动（如会话表格 `overflow-auto`），这是设计意图，不算失败；
 *   ❌ **不覆盖** `unsupported` / `running` 等降级态：浏览器环境没有 Tauri，
 *      `isTauri()` 为 false → schema 状态恒为「未连接数据库」，
 *      `SchemaBlockedState` 不会渲染。降级态的 768px 布局必须真机验证。
 */

interface OverflowMetrics {
  scrollWidth: number
  clientWidth: number
  /** 产生溢出的元素（top 3），用于失败时定位 */
  offenders: Array<{ tag: string; cls: string; scrollWidth: number; clientWidth: number }>
}

async function measure(page: Page): Promise<OverflowMetrics> {
  return page.evaluate(() => {
    const el = document.scrollingElement as HTMLElement
    const offenders: Array<{ tag: string; cls: string; scrollWidth: number; clientWidth: number }> = []
    for (const node of Array.from(document.querySelectorAll('*'))) {
      const e = node as HTMLElement
      if (e.scrollWidth > e.clientWidth + 1) {
        offenders.push({
          tag: e.tagName,
          cls: (e.getAttribute('class') || '').slice(0, 80),
          scrollWidth: e.scrollWidth,
          clientWidth: e.clientWidth,
        })
      }
    }
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      offenders: offenders.slice(0, 3),
    }
  })
}

const ROUTES = [
  { name: '首页/Dashboard', hash: '#/' },
  { name: '会话浏览', hash: '#/sessions' },
  { name: '清理向导', hash: '#/cleanup' },
  { name: '备份恢复', hash: '#/backup' },
  { name: '设置', hash: '#/settings' },
]

/**
 * 「设置 · 版本更新」区在 768px 下的布局测量。
 *
 * 为什么要单独测（而不是靠上面的「文档级横向滚动」兜底）：
 *   - `main` 上有 `overflow-x-hidden`，**子容器横向溢出不会撑大文档**，
 *     所以「文档不横向滚动」这条断言发现不了「复制按钮被挤出卡片」这类问题；
 *   - 「当前版本」行新增了「复制」按钮、「上次检查」行是条件渲染，
 *     二者都可能把 `dl` 里的行撑破 —— 必须直接量 `update-section` 内部。
 */
interface UpdateSectionMetrics {
  sectionScrollWidth: number
  sectionClientWidth: number
  /** 区内部产生横向溢出的元素 */
  offenders: Array<{ tag: string; testid: string; cls: string; scrollWidth: number; clientWidth: number }>
  sectionLeft: number
  sectionRight: number
  versionLeft: number
  versionRight: number
  copyLeft: number
  copyRight: number
  copyVisible: boolean
  docScrollWidth: number
  docClientWidth: number
}

async function measureUpdateSection(page: Page): Promise<UpdateSectionMetrics> {
  return page.evaluate(() => {
    const section = document.querySelector('[data-testid="update-section"]') as HTMLElement
    const offenders: UpdateSectionMetrics['offenders'] = []
    for (const node of Array.from(section.querySelectorAll('*'))) {
      const e = node as HTMLElement
      if (e.scrollWidth > e.clientWidth + 1) {
        offenders.push({
          tag: e.tagName,
          testid: e.getAttribute('data-testid') ?? '',
          cls: (e.getAttribute('class') || '').slice(0, 80),
          scrollWidth: e.scrollWidth,
          clientWidth: e.clientWidth,
        })
      }
    }
    const sectionRect = section.getBoundingClientRect()
    const version = section.querySelector('[data-testid="update-current-version"]') as HTMLElement
    const versionRect = version.getBoundingClientRect()
    const copy = section.querySelector('[aria-label="复制版本号"]') as HTMLElement
    const copyRect = copy.getBoundingClientRect()
    const scroller = document.scrollingElement as HTMLElement
    return {
      sectionScrollWidth: section.scrollWidth,
      sectionClientWidth: section.clientWidth,
      offenders,
      sectionLeft: sectionRect.left,
      sectionRight: sectionRect.right,
      versionLeft: versionRect.left,
      versionRight: versionRect.right,
      copyLeft: copyRect.left,
      copyRight: copyRect.right,
      copyVisible: copyRect.width > 0 && copyRect.height > 0,
      docScrollWidth: scroller.scrollWidth,
      docClientWidth: scroller.clientWidth,
    }
  })
}

test.describe('768px 窄屏', () => {
  for (const route of ROUTES) {
    test(`无文档级横向滚动: ${route.name}`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 800 })
      await page.goto(`/${route.hash}`)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(400)

      const m = await measure(page)
      expect(
        m.scrollWidth,
        `「${route.name}」在 768px 下出现文档级横向滚动：scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth}；` +
          `溢出元素：${JSON.stringify(m.offenders)}`,
      ).toBeLessThanOrEqual(m.clientWidth)
    })
  }

  test('768px 下侧边栏 + 主区仍并排（未意外折叠成单列）', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 800 })
    await page.goto('/#/')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(300)

    const widths = await page.evaluate(() => {
      // 侧边栏是 `<nav class="w-56 ...">`（固定 224px）
      const nav = document.querySelector('nav')
      const navWidth = nav ? nav.getBoundingClientRect().width : 0
      const navRight = nav ? nav.getBoundingClientRect().right : 0
      // 主区 = 侧边栏右边的内容容器
      const main = document.querySelector('main, [class*="flex-1"]') as HTMLElement | null
      return {
        nav: navWidth,
        navRight,
        main: main ? main.getBoundingClientRect().width : 0,
        innerWidth: window.innerWidth,
      }
    })

    // 侧边栏固定 224px（w-56），主区吃掉剩余宽度；两者都应 > 0
    expect(widths.nav).toBeGreaterThan(0)
    expect(widths.main).toBeGreaterThan(0)
    // 侧边栏没有被压缩
    expect(widths.nav).toBeGreaterThanOrEqual(200)
    // 主区应落在 544px 左右（768 - 224）
    expect(widths.main).toBeLessThanOrEqual(widths.innerWidth)
  })

  test('768px 下「版本更新」区不溢出（当前版本 + 复制按钮 + 上次检查行）', async ({ page }) => {
    // 模拟 Tauri：只有这样才能让「上次检查」行与「可更新版本」行渲染出来，
    // 否则测到的只是「当前版本」一行，漏掉条件渲染行的布局。
    await installTauriStub(page, {
      respond: {
        [CH.DATABASE_INFO]: {
          mode: 'v2',
          migrationPhase: 'none',
          hasLegacyTables: false,
          v2SessionCount: 3,
          unsupportedReason: null,
        },
        [CH.DATABASE_HEALTH]: {
          ok: true,
          pageCount: 1,
          freelistPages: 0,
          walSize: 0,
          dbSize: 4096,
          currentPath: '/tmp/opencode.db',
        },
        [CH.SESSIONS_PROJECTS]: [],
      },
      respondRaw: {
        'plugin:app|version': '1.4.0',
        'plugin:path|home_dir': '/Users/tester',
        'plugin:updater|check': {
          rid: 1,
          currentVersion: '1.4.0',
          version: '1.4.1',
          date: '2026-10-01T00:00:00Z',
          body: '修复若干问题',
          rawJson: {},
        },
      },
    })

    await page.setViewportSize({ width: 768, height: 800 })
    await page.goto('/#/settings')
    await page.waitForLoadState('networkidle')

    const section = page.getByTestId('update-section')
    await expect(section).toBeVisible()

    // 检查一次，让「上次检查」行与「可更新版本」行都渲染出来
    await page.getByRole('button', { name: '检查更新' }).click()
    await expect(page.getByTestId('update-status')).toHaveText(/发现新版本 v1\.4\.1/)
    await expect(page.getByTestId('update-available-version')).toBeVisible()
    await expect(section.getByText('上次检查')).toBeVisible()

    // 弹窗是 fixed 定位的遮罩，会盖住设置页；先关掉再量布局
    const dialog = page.getByRole('dialog')
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: '关闭' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }

    const m = await measureUpdateSection(page)

    // 区本身不横向溢出
    expect(
      m.sectionScrollWidth,
      `「版本更新」区在 768px 下横向溢出：scrollWidth=${m.sectionScrollWidth} clientWidth=${m.sectionClientWidth}`,
    ).toBeLessThanOrEqual(m.sectionClientWidth + 1)

    // 区内部没有任何子元素被撑破（复制按钮 / 版本号 / 上次检查时间）
    expect(m.offenders, `「版本更新」区内部存在横向溢出元素：${JSON.stringify(m.offenders)}`).toEqual([])

    // 复制按钮完整落在卡片内，没有被挤到卡片外或被裁掉
    expect(m.copyVisible, '「复制版本号」按钮在 768px 下不可见').toBe(true)
    expect(m.copyRight, '「复制版本号」按钮超出「版本更新」区右边界').toBeLessThanOrEqual(m.sectionRight + 0.5)
    expect(m.copyLeft, '「复制版本号」按钮超出「版本更新」区左边界').toBeGreaterThanOrEqual(m.sectionLeft - 0.5)

    // 版本号本身也不越界
    expect(m.versionRight, '「当前版本」数值超出「版本更新」区右边界').toBeLessThanOrEqual(m.sectionRight + 0.5)
    expect(m.versionLeft, '「当前版本」数值超出「版本更新」区左边界').toBeGreaterThanOrEqual(m.sectionLeft - 0.5)

    // 文档级也没有横向滚动
    expect(
      m.docScrollWidth,
      `「设置」在 768px 下出现文档级横向滚动：scrollWidth=${m.docScrollWidth} clientWidth=${m.docClientWidth}`,
    ).toBeLessThanOrEqual(m.docClientWidth)
  })

  test('768px 下「Token 统计」总计行标签不溢出（标签比原来的「Token 总计」长）', async ({ page }) => {
    // 必须伪造 Tauri：否则浏览器里 isTauri() 为 false，仪表盘停在「未连接数据库」，
    // Token 统计面板根本不渲染，量不到任何东西。
    await installTauriStub(page, {
      respond: {
        [CH.DATABASE_INFO]: {
          mode: 'v2',
          migrationPhase: 'none',
          hasLegacyTables: false,
          v2SessionCount: 3,
          unsupportedReason: null,
        },
        [CH.DATABASE_HEALTH]: {
          ok: true,
          pageCount: 1,
          freelistPages: 0,
          walSize: 0,
          dbSize: 4096,
          currentPath: '/tmp/opencode.db',
        },
        [CH.DASHBOARD_OVERVIEW]: {
          rootSessionCount: 30,
          childSessionCount: 0,
          projectCount: 2,
          partCount: 42,
        },
        [CH.DASHBOARD_TOKENS]: {
          inputTokens: 1_000,
          outputTokens: 2_000,
          reasoningTokens: 300,
          cacheRead: 4_000,
          cacheWrite: 500,
          estimatedCost: 1.25,
          cacheHitRate: 80,
        },
        [CH.SESSIONS_PROJECTS]: [],
      },
    })

    await page.setViewportSize({ width: 768, height: 800 })
    await page.goto('/#/')
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('所选范围 Token 合计')).toBeVisible()

    const m = await page.evaluate(() => {
      const label = Array.from(document.querySelectorAll('span')).find(
        (el) => (el.textContent ?? '').trim() === '所选范围 Token 合计',
      ) as HTMLElement | undefined
      if (!label) return null
      const panel = label.closest('div.bg-white') as HTMLElement | null
      const scroller = document.scrollingElement as HTMLElement
      return {
        labelScrollWidth: label.scrollWidth,
        labelClientWidth: label.clientWidth,
        labelScrollHeight: label.scrollHeight,
        labelClientHeight: label.clientHeight,
        labelRight: label.getBoundingClientRect().right,
        panelRight: panel?.getBoundingClientRect().right ?? 0,
        docScrollWidth: scroller.scrollWidth,
        docClientWidth: scroller.clientWidth,
      }
    })

    expect(m, '未找到「所选范围 Token 合计」标签').not.toBeNull()
    const v = m!

    // 标签变长后必须**换行**而不是横向溢出自己的盒子
    expect(v.labelScrollWidth, '总计行标签横向溢出').toBeLessThanOrEqual(v.labelClientWidth + 1)
    // 换行后也不能被裁掉（文字完整可见）
    expect(v.labelScrollHeight, '总计行标签被纵向裁切').toBeLessThanOrEqual(v.labelClientHeight + 1)
    // 标签没有跑到卡片外面
    expect(v.labelRight, '总计行标签超出卡片右边界').toBeLessThanOrEqual(v.panelRight + 0.5)
    // 文档级没有横向滚动
    expect(
      v.docScrollWidth,
      `「仪表盘」在 768px 下出现文档级横向滚动：scrollWidth=${v.docScrollWidth} clientWidth=${v.docClientWidth}`,
    ).toBeLessThanOrEqual(v.docClientWidth)

    // ⚠️ 已知既有问题（**不是**本次改动引入的，单独记录，不在本用例断言）：
    // 768px 下「Token 统计」右侧指标列被固定 160px 的饼图挤到只剩 ~18px，
    // 整行与卡片早已横向溢出（实测 rowScrollWidth 73 > rowClientWidth 18，
    // 数值文本已越出卡片右边缘 ~34px）。改成更长的标签只让该列多折一行，
    // 横向溢出幅度不变；修复它属于布局改动，不在本次「tooltip 口径词」范围内。
  })
})
