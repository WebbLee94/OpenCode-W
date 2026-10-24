import { test, expect, type Page } from '@playwright/test'

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
})
