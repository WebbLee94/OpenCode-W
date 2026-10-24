import { test, expect } from '@playwright/test'
import { installTauriStub, type QaBridge, type StubPlan, type TauriStub } from './helpers/tauri-stub'
import { IPC_CHANNELS as CH } from '../shared/ipc-channels'

/**
 * 仪表盘 / 设置 / 清理的请求生命周期 e2e —— 对应 B-3（请求生命周期）与
 * B-4（体验收口）在**真实浏览器**里的验收。
 *
 * 这些行为已有 Vitest 覆盖（`Dashboard.lifecycle.test.tsx` 等），但 jsdom
 * 没有排版与真实事件循环，无法证明「真实浏览器里也是这个行为」。
 * 前提：`isTauri()` 检查 `window.__TAURI_INTERNALS__`（`ipc.ts:19-22`），
 * 因此用 `addInitScript` 注入可控的 IPC stub 即可触达这些状态。
 *
 * 覆盖 B-5 报告里 e2e 待补清单的 1-7（8/9 依赖 Wave 2 UI，另行补）：
 *   1 仪表盘首屏 loading，不闪「暂无数据」
 *   2 失败保留：旧数据 + 「上一次结果」，不退化成空态
 *   3 乱序丢弃：旧范围响应晚到不覆盖新范围
 *   4 趋势面板跨 Tab 保活（同一 DOM 节点，不重复请求）
 *   5 切范围时的 updating 状态
 *   6 设置页窗口聚焦 → 恰好一次 database:info 刷新
 *   7 清理执行后：dashboard 缓存失效 + schema / 数据源刷新 + 结果恢复 v1.3.5 呈现
 */

const OVERVIEW = (root: number) => ({
  rootSessionCount: root,
  childSessionCount: 0,
  projectCount: 2,
  partCount: 42,
})

const TOKENS = {
  inputTokens: 1_000,
  outputTokens: 2_000,
  reasoningTokens: 300,
  cacheRead: 4_000,
  cacheWrite: 500,
  estimatedCost: 1.25,
  cacheHitRate: 80,
}

const HEALTH = {
  ok: true,
  pageCount: 1,
  freelistPages: 0,
  walSize: 0,
  dbSize: 4096,
  currentPath: '/tmp/opencode.db',
}

const SCHEMA = {
  mode: 'v2',
  migrationPhase: 'none',
  hasLegacyTables: false,
  v2SessionCount: 3,
  unsupportedReason: null,
}

const TOOL_ROW = (name: string, count: number) => ({ toolName: name, count })

/**
 * 两个 YYYY-MM-DD 之间的**自然日**差（后者 − 前者）。
 *
 * 两端按 UTC 解析 → 纯日历日差，与夏令时 / 本地时区无关。
 * 用来断言「区间含端点正好 N 个自然日」这条**口径**，
 * 而不是复刻实现的减法公式。
 */
function calendarDaysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number)
  const [y2, m2, d2] = b.split('-').map(Number)
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000)
}

function basePlan(): StubPlan {
  return {
    respond: {
      [CH.DATABASE_INFO]: SCHEMA,
      [CH.DATABASE_HEALTH]: HEALTH,
      [CH.DASHBOARD_OVERVIEW]: OVERVIEW(30),
      [CH.DASHBOARD_TOKENS]: TOKENS,
      [CH.DASHBOARD_SESSION_TREND]: [],
      [CH.DASHBOARD_COST_TREND]: [],
      [CH.DASHBOARD_MESSAGE_TREND]: [],
      [CH.DASHBOARD_TOOL_RANKING]: [],
      [CH.DASHBOARD_SKILL_USAGE]: [],
      [CH.DASHBOARD_MODEL_RANKING]: [],
      [CH.DASHBOARD_PROVIDER_STATS]: [],
      [CH.DASHBOARD_PROJECT_RANKING]: [],
      [CH.SESSIONS_PROJECTS]: [],
    },
  }
}

const PREVIEW = {
  sessionCount: 3,
  messageCount: 20,
  partCount: 20,
  estimatedSize: 2048,
  sessions: [
    {
      id: 'ses_a',
      title: '旧会话 A',
      msg_count: 20,
      total_tokens: 0,
      data_size: 2048,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      time_created: 1,
      time_updated: 2,
    },
  ],
  childSessionIds: [],
  v2: { sessionCount: 3, messageCount: 20, partCount: 20, estimatedSize: 2048 },
  legacy: null,
}

const CLEAN_RESULT = {
  deletedSessions: 3,
  deletedMessages: 20,
  deletedParts: 20,
  freedBytes: 1024,
  vacuumBefore: 4096,
  vacuumAfter: 3072,
  v2: { sessionCount: 3, messageCount: 20, partCount: 20, estimatedSize: 2048 },
  legacy: { sessionCount: 1, messageCount: 4, partCount: 6, estimatedSize: 512 },
}

test.describe('请求生命周期（真实浏览器）', () => {
  let stub: TauriStub

  test.beforeEach(async ({ page }) => {
    stub = await installTauriStub(page, basePlan())
  })

  test('1 首屏 loading：显示骨架与「正在加载数据」，不闪「暂无数据」', async ({ page }) => {
    await installTauriStub(page, {
      ...basePlan(),
      hold: [CH.DASHBOARD_OVERVIEW],
    })

    await page.goto('/#/')
    const status = page.getByRole('status')

    // 骨架屏在，空态文案不在
    await expect(page.locator('.animate-pulse').first()).toBeVisible()
    await expect(status).toHaveText(/正在加载数据/)
    await expect(page.getByText('暂无数据')).toHaveCount(0)
    await expect(page.getByText('30/0')).toHaveCount(0)

    // 放行后数据落位，骨架消失
    await stub.release(0, OVERVIEW(30))
    await expect(page.getByText('30/0')).toBeVisible()
    await expect(page.locator('.animate-pulse')).toHaveCount(0)
    await expect(status).toHaveText('')
  })

  test('2 失败保留：刷新失败时旧数据仍在，并提示「上一次结果」', async ({ page }) => {
    // 先给一份有内容的工具排行（必须在导航前通过 plan 设置）
    const base = basePlan()
    await installTauriStub(page, {
      ...base,
      respond: { ...base.respond, [CH.DASHBOARD_TOOL_RANKING]: [TOOL_ROW('old-tool', 5)] },
    })

    await page.goto('/#/')
    await page.getByRole('button', { name: /统计/ }).click()
    await expect(page.getByText('old-tool').first()).toBeVisible()

    // 下一次刷新让工具排行失败
    const gate = await stub.hold(CH.DASHBOARD_TOOL_RANKING)
    await stub.fail(gate, 'tool query failed')
    await page.getByRole('button', { name: '刷新' }).click()

    await expect(page.getByText(/更新失败，仍显示上一次结果/).first()).toBeVisible()
    // 旧数据没有退化成空态
    await expect(page.getByText('old-tool').first()).toBeVisible()
    await expect(page.getByText('暂无工具使用数据')).toHaveCount(0)
  })

  test('3 乱序丢弃：旧范围响应晚到不覆盖新范围', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    const gate7 = await stub.hold(CH.DASHBOARD_OVERVIEW)
    const gate90 = await stub.hold(CH.DASHBOARD_OVERVIEW)

    await page.getByRole('button', { name: '7天' }).click()
    await page.getByRole('button', { name: '90天' }).click()
    // 两次点击各自挂起一次请求（FIFO：先 7 天后 90 天）
    await expect
      .poll(() => stub.callCount(CH.DASHBOARD_OVERVIEW), { timeout: 5_000 })
      .toBe(3)

    // 新范围（90 天）先回，旧范围（7 天）后回
    await stub.release(gate90, OVERVIEW(90))
    await expect(page.getByText('90/0')).toBeVisible()

    await stub.release(gate7, OVERVIEW(7))
    await expect(page.getByText('90/0')).toBeVisible()
    await expect(page.getByText('7/0')).toHaveCount(0)
    void gate7
  })

  test('4 趋势面板跨 Tab 保活：同一 DOM 节点，当前范围不重复请求', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    await page.getByRole('button', { name: /趋势/ }).click()
    const panel = page.getByTestId('trends-panel')
    await expect(panel).toBeVisible()
    // 在节点上打标记，稍后验证是同一个节点
    const marker = await panel.evaluate((el) => {
      void ((el as HTMLElement & { __qaMarker?: string }).__qaMarker = 'keep-alive')
      return 'keep-alive'
    })
    // 趋势页会异步补发「对比上期」请求，先等调用数稳定再取基线
    await stub.stableCount(CH.DASHBOARD_SESSION_TREND)

    // 当前范围 = startDate 最晚的那次；上期 = 最早的那次
    const ranges = await page.evaluate(() => {
      const bridge = (window as unknown as { __qa?: QaBridge }).__qa
      const seen = new Set<string>()
      for (const c of bridge?.log ?? []) {
        const start = (c.payload as { startDate?: string } | undefined)?.startDate
        if (c.channel === 'dashboard_session_trend' && start) seen.add(start)
      }
      return Array.from(seen).sort()
    })
    expect(ranges.length, '应同时存在当前范围与上期范围两次趋势请求').toBeGreaterThanOrEqual(2)
    const prevStart = ranges[0]
    const currentStart = ranges[ranges.length - 1]

    const countFor = (start: string) =>
      page.evaluate(
        ([name, s]) => {
          const bridge = (window as unknown as { __qa?: QaBridge }).__qa
          return bridge
            ? bridge.log.filter(
                (c) => c.channel === name && (c.payload as { startDate?: string }).startDate === s,
              ).length
            : 0
        },
        ['dashboard_session_trend', start],
      )

    const currentBefore = await countFor(currentStart)
    expect(currentBefore).toBeGreaterThan(0)

    await page.getByRole('button', { name: /统计/ }).click()
    await expect(panel).toBeHidden()
    // 同一节点（没有被卸载重建）
    await expect(panel.evaluate((el) => (el as HTMLElement & { __qaMarker?: string }).__qaMarker)).resolves.toBe(marker)

    await page.getByRole('button', { name: /趋势/ }).click()
    await expect(panel).toBeVisible()
    await expect(panel.evaluate((el) => (el as HTMLElement & { __qaMarker?: string }).__qaMarker)).resolves.toBe(marker)

    // 当前范围的趋势请求没有重复发起（保活命中，而不是重新挂载拉数据）
    await stub.stableCount(CH.DASHBOARD_SESSION_TREND)
    expect(await countFor(currentStart)).toBe(currentBefore)

    // ⚠️ 已知行为（设计取舍，待 lead 确认）：「对比上期」数据在离开趋势 Tab 时
    // 被清空（Dashboard.tsx:879 注释「避免陈旧数据」，effect 依赖含 dashboardTab，
    // :917），因此切回时会**重新拉取上期**。当前范围不重发，但上期会重发。
    const prevBefore = await countFor(prevStart)
    await page.getByRole('button', { name: /统计/ }).click()
    await page.getByRole('button', { name: /趋势/ }).click()
    await stub.stableCount(CH.DASHBOARD_SESSION_TREND)
    const prevAfter = await countFor(prevStart)
    // 记录事实：上期对比会重复请求（若未来改成缓存上期，这条断言要反过来）
    expect(prevAfter).toBeGreaterThan(prevBefore)
  })

  test('5 updating 状态：切范围时旧数据在屏，并提示「正在更新数据」', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    const gate = await stub.hold(CH.DASHBOARD_OVERVIEW)
    await page.getByRole('button', { name: '7天' }).click()

    const status = page.getByRole('status').first()
    await expect(status).toHaveText(/正在更新数据，当前显示上一次结果/)
    // 旧数据仍在屏上
    await expect(page.getByText('30/0')).toBeVisible()

    await stub.release(gate, OVERVIEW(7))
    await expect(page.getByText('7/0')).toBeVisible()
    await expect(status).toHaveText('')
  })

  test('6 设置页窗口聚焦 → 恰好一次 database:info 刷新', async ({ page }) => {
    const base = basePlan()
    await installTauriStub(page, {
      ...base,
      respondRaw: { ...base.respondRaw, 'plugin:path|home_dir': '/Users/tester' },
    })
    await page.goto('/#/settings')
    await expect(page.getByText('数据库：')).toBeVisible()
    await expect
      .poll(() => stub.callCount(CH.DATABASE_INFO), { timeout: 5_000 })
      .toBeGreaterThan(0)
    await stub.resetCalls()

    // 触发 window focus：DataSourceSection 的 focus 监听会刷新 schema
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect
      .poll(() => stub.callCount(CH.DATABASE_INFO), { timeout: 5_000 })
      .toBe(1)

    // 再聚焦一次 → 再刷新一次（不是只在首次挂载时刷一次）
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect
      .poll(() => stub.callCount(CH.DATABASE_INFO), { timeout: 5_000 })
      .toBe(2)
  })

  test('7 清理执行后：dashboard 缓存失效 + schema / 数据源刷新 + 结果恢复 v1.3.5 呈现', async ({ page }) => {
    const base = basePlan()
    await installTauriStub(page, {
      ...base,
      respond: {
        ...base.respond,
        [CH.CLEANUP_PREVIEW]: PREVIEW,
        [CH.CLEANUP_EXECUTE]: CLEAN_RESULT,
      },
      respondRaw: { ...base.respondRaw, 'plugin:path|home_dir': '/Users/tester' },
    })

    await page.goto('/#/cleanup')
    await expect(page.getByText('选择策略')).toBeVisible()

    const infoBefore = await stub.callCount(CH.DATABASE_INFO)
    const healthBefore = await stub.callCount(CH.DATABASE_HEALTH)

    // 步骤 1 → 2
    await page.getByRole('button', { name: /下一步: 预览/ }).click()
    await expect(page.getByText('预览清理范围')).toBeVisible()
    // 步骤 2 → 3
    await page.getByRole('button', { name: /确认清理/ }).click()
    await expect(page.getByText('请仔细确认清理范围，此操作不可逆')).toBeVisible()
    // 勾选确认（3 秒倒计时后按钮才可用）
    await page.locator('input[type="checkbox"]').first().check()
    const exec = page.getByRole('button', { name: /确认清理/ })
    await expect(exec).toBeEnabled({ timeout: 10_000 })
    await exec.click()

    // 结果页恢复 v1.3.5 呈现：只展示基础汇总字段
    await expect(page.getByText('清理完成')).toBeVisible()
    await expect(page.getByText('删除会话数')).toBeVisible()
    await expect(page.getByText('实际释放空间')).toBeVisible()
    // 后端仍返回 v2 / legacy（见 CLEAN_RESULT 夹具），但 UI 不再渲染分列明细
    await expect(page.getByText('按数据形态')).toHaveCount(0)
    await expect(page.getByText('v2 数据')).toHaveCount(0)
    await expect(page.getByText('旧版副本')).toHaveCount(0)

    // schema（database:info）与数据源（database:health）各刷新一次
    await expect
      .poll(() => stub.callCount(CH.DATABASE_INFO), { timeout: 5_000 })
      .toBe(infoBefore + 1)
    await expect
      .poll(() => stub.callCount(CH.DATABASE_HEALTH), { timeout: 5_000 })
      .toBe(healthBefore + 1)
  })

  test('8 子会话随父删除：子行勾选框禁用并给出原因，父行可勾选', async ({ page }) => {
    const base = basePlan()
    await installTauriStub(page, {
      ...base,
      respond: {
        ...base.respond,
        [CH.CLEANUP_PREVIEW]: {
          ...PREVIEW,
          sessions: [
            {
              id: 'ses_parent',
              title: '父会话（含子会话）',
              msg_count: 20,
              total_tokens: 0,
              data_size: 2048,
              tokens_input: 0,
              tokens_output: 0,
              tokens_reasoning: 0,
              tokens_cache_read: 0,
              tokens_cache_write: 0,
              time_created: 1,
              time_updated: 2,
            },
            {
              id: 'ses_child',
              parentId: 'ses_parent',
              title: '子会话（随父删除）',
              msg_count: 5,
              total_tokens: 0,
              data_size: 256,
              tokens_input: 0,
              tokens_output: 0,
              tokens_reasoning: 0,
              tokens_cache_read: 0,
              tokens_cache_write: 0,
              time_created: 1,
              time_updated: 2,
            },
          ],
          childSessionIds: ['ses_child'],
        },
      },
    })

    await page.goto('/#/cleanup')
    await page.getByRole('button', { name: /下一步: 预览/ }).click()
    await expect(page.getByText('预览清理范围')).toBeVisible()

    // 子行：禁用 + 说明随父删除
    const childRow = page.locator('tr', { hasText: '子会话（随父删除）' })
    const childBox = childRow.locator('input[type="checkbox"]')
    await expect(childBox).toBeDisabled()
    await expect(childBox).toHaveAttribute('aria-label', /子会话 子会话（随父删除）：/)
    await expect(childRow.getByText('子会话', { exact: true })).toBeVisible()

    // 父行：可正常勾选/取消
    const parentRow = page.locator('tr', { hasText: '父会话（含子会话）' })
    const parentBox = parentRow.locator('input[type="checkbox"]')
    await expect(parentBox).toBeEnabled()
    await parentBox.uncheck()
    // 父被排除：父行与子行都置灰（excludedTree 含子树），子行文案变为「随父会话保留」
    await expect(parentRow).toHaveClass(/opacity-60/)
    await expect(childRow).toHaveClass(/opacity-60/)
    await expect(childRow.getByText('随父会话保留')).toBeVisible()
  })

  test('10 VACUUM 失败提示常驻、如实描述，动作 Link 不引入网络请求', async ({ page }) => {
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    // 让一键 VACUUM 失败（hold 后 fail → invokeSafe throw，与真实后端失败等价）
    const gate = await stub.hold(CH.DATABASE_VACUUM)
    await page.getByRole('button', { name: /一键 VACUUM/ }).click()
    await stub.fail(gate, 'views may not be indexed')

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    // 如实描述：磁盘未回收，但数据不受影响；后续动作给得出
    await expect(alert).toContainText('磁盘回收未完成，数据本身不受影响')
    await expect(alert).toContainText('建议先退出 OpenCode 后重试；或先备份再通过清理向导处理')
    await expect(alert).toContainText('失败原因：views may not be indexed')
    // 不再是 3 秒 toast：常驻直到手动关闭
    await page.waitForTimeout(3_500)
    await expect(alert).toBeVisible()

    // 动作是站内路由（HashRouter 下 Link 的 href 形如 #/backup），不是外链
    const hrefs = await alert.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))
    expect(hrefs).toContain('#/backup')
    expect(hrefs).toContain('#/cleanup')
    for (const href of hrefs) {
      expect(href, '动作 Link 必须是站内路由').toMatch(/^#\//)
    }

    // 点击后确实切到备份页，且全程没有发出任何跨源网络请求
    const external: string[] = []
    page.on('request', (req) => {
      const url = new URL(req.url())
      if (url.origin !== 'http://localhost:5173') external.push(req.url())
    })
    await alert.getByRole('link', { name: '打开备份页' }).click()
    await expect(page).toHaveURL(/#\/backup/)
    expect(external, '动作 Link 不得引入网络请求').toEqual([])
  })

  test('9 tooltip 口径词：趋势首行给日期、合计行说清是分桶合计', async ({ page }) => {    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    // 概览：总计行标签说明这是「所选范围」合计
    await expect(page.getByText('所选范围 Token 合计')).toBeVisible()
    await expect(page.getByText('Token 总计', { exact: true })).toHaveCount(0)

    // 让「按分组」的 token 请求返回数组：趋势折线图才有数据可 hover。
    // stub 是按 channel 应答的，分组与总量共用同一个 channel，这里按 payload 分流。
    await page.evaluate(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, payload?: unknown) => Promise<unknown> }
      }).__TAURI_INTERNALS__
      const original = internals.invoke.bind(internals)
      internals.invoke = (cmd: string, payload?: unknown) => {
        const groupBy = (payload as { groupBy?: string } | undefined)?.groupBy
        if (cmd === 'dashboard_tokens' && groupBy) {
          return Promise.resolve({
            success: true,
            data: [
              { period: '2026-10-24', inputTokens: 1, outputTokens: 2, reasoningTokens: 3, cacheRead: 4, cacheWrite: 5, estimatedCost: 0.5 },
            ],
          })
        }
        return original(cmd, payload)
      }
    })

    await page.getByRole('button', { name: /趋势/ }).click()
    // 切一次分桶粒度 → 重新拉分组数据 → 折线图渲染出来
    await page.getByRole('button', { name: '周' }).click()
    const chart = page.locator('.recharts-wrapper').first()
    await expect(chart).toBeVisible()

    const box = await chart.boundingBox()
    if (!box) throw new Error('趋势图没有布局盒，无法 hover')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2)

    const tooltip = page.locator('.recharts-tooltip-wrapper').first()
    await expect(tooltip).toContainText('2026-10-24')
    // 分桶粒度切到「周」→ 合计行说「本周合计」，不再是含糊的「Token 总计」
    await expect(tooltip).toContainText('本周合计')
    await expect(tooltip).not.toContainText('Token 总计')
  })

  /**
   * 时间范围口径 —— **固定时区 + 固定时钟**。
   *
   * 断言钉的是**日历语义**（「含今日在内的 7 个自然日」），不是「减毫秒」
   * 推出来的同一个值：旧写法 `fmt(new Date(Date.now() - 6 * 86_400_000))`
   * 在夏令时切换日会退到前一个本地日，断言就会跟着实现**一起错**，
   * 照样是绿的，抓不到 DST 缺陷。
   *
   * 这里把时区（Asia/Shanghai）与时钟（2026-10-24 00:30 本地）都钉死，
   * 期望值就能写成**字面日期串**，断言的是口径本身。
   */
  test.describe('时间范围口径（固定时区 + 固定时钟）', () => {
    // 时区钉死 → 期望值可以写成字面日期串
    test.use({ timezoneId: 'Asia/Shanghai' })

    test('11 时间范围预设：7 天 = 含今日在内的 7 个自然日', async ({ page }) => {
      // 本地 2026-10-24 00:30 (+08:00) = 2026-10-23T16:30Z
      await page.clock.setFixedTime(new Date('2026-10-23T16:30:00Z'))
      await page.goto('/#/')
      await expect(page.getByText('30/0')).toBeVisible()

      const before = await stub.callCount(CH.DASHBOARD_OVERVIEW)
      await page.getByRole('button', { name: '7天' }).click()
      await expect
        .poll(() => stub.callCount(CH.DASHBOARD_OVERVIEW), { timeout: 5_000 })
        .toBeGreaterThan(before)

      // 后端窗口两端都含（start 00:00:00 ~ end 23:59:59），所以「7 天」
      // 必须是 [今天−6, 今天]（7 个自然日），不能是 [今天−7, 今天]（8 天）。
      const range = await page.evaluate(() => {
        const bridge = (window as unknown as { __qa?: QaBridge }).__qa
        const calls = (bridge?.log ?? []).filter(c => c.channel === 'dashboard_overview')
        const last = calls[calls.length - 1]
        return (last?.payload ?? {}) as { startDate?: string; endDate?: string }
      })

      // 今天 = 2026-10-24 → 7 天 = [2026-10-18, 2026-10-24]
      expect(range.startDate).toBe('2026-10-18')
      expect(range.endDate).toBe('2026-10-24')
      // 端点差恰好 6 天 → 含端点正好 7 个自然日
      expect(calendarDaysBetween(range.startDate!, range.endDate!)).toBe(6)
    })
  })
})
