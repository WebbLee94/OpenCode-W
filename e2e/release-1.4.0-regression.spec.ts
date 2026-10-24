import { test, expect, type Page, type Locator } from '@playwright/test'
import { installTauriStub, type StubPlan, type TauriStub } from './helpers/tauri-stub'
import { IPC_CHANNELS as CH } from '../shared/ipc-channels'

/**
 * 1.4.0 发布前回归 —— 用户报的原场景 + 变更面。
 *
 * 这一批改动的本质是**同一类问题的多个变种**：界面上的数字没有说明它是
 * 「哪一段时间」的合计，用户把两个不同口径的数字并排看就以为其中一边算错了。
 * 修复方式统一为「把口径写进界面」：
 *   - 趋势 tooltip 首行给日期、合计行说清是分桶合计（当日 / 本周 / 本月）；
 *   - 排行 tooltip 说「所选范围合计」；
 *   - 概览总计行说「所选范围 Token 合计」；
 *   - 时间区间统一成「含今日在内的 N 个自然日」，且会话页用**本地**日期；
 *   - 排行缺���用一行浅灰小字如实说明，不假装排行覆盖了全部。
 *
 * 为什么必须是真浏览器：这里的每条断言都依赖**排版与真实事件**
 * （tooltip 位置、hover / focus 行为、live region 的 DOM 重建、窄屏换行），
 * jsdom 一样都测不出来。
 *
 * 覆盖范围（不夸大）：
 *   ✅ 真实 Chromium 里的 hover / focus / 剪贴板 / 窄屏布局 / IPC 请求参数；
 *   ⚠️ 时间区间在 Rust 侧还有一份实现（`src-tauri`），这里的断言只覆盖
 *      **前端发出的参数**；后端窗口语义由 `cargo test` 覆盖。
 */

// ── 本地日期工具（与 src/lib/format.ts 的 toLocalDateString 同口径）──────

const pad = (n: number) => String(n).padStart(2, '0')

/** 本地日历日 YYYY-MM-DD（**不是** UTC 日期） */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 在本地日历上加减天数（走 Date 构造器，跨月 / 跨年都正确） */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return localDate(new Date(y, m - 1, d + n))
}

/** 两个 YYYY-MM-DD 之间的天数差（b − a），按**纯日历日**算 */
function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number)
  const [y2, m2, d2] = b.split('-').map(Number)
  // 两端按 UTC 解析 → 与夏令时 / 本地时区无关（本地午夜相减会带 ±1 小时偏移）
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000)
}

// ── 夹具 ────────────────────────────────────────────────────────────────

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

const OVERVIEW = {
  rootSessionCount: 30,
  childSessionCount: 0,
  projectCount: 2,
  partCount: 42,
}

const TOKENS = {
  inputTokens: 1_000,
  outputTokens: 2_000,
  reasoningTokens: 300,
  cacheRead: 4_000,
  cacheWrite: 500,
  estimatedCost: 1.25,
  cacheHitRate: 80,
}

/** 一条模型排行项：model 是 JSON 字符串（前端解析出 id / providerID） */
const modelItem = (id: string, providerID: string, tokenCount: number) => ({
  model: JSON.stringify({ id, providerID }),
  tokenCount,
  totalCost: 1,
})

/**
 * 模型缺口与服务商缺口是**两组不相交**的 token —— 用两组明显不同的数值，
 * 一旦前端混用，断言立刻炸。
 */
const MODEL_GAP = { tokenCount: 681_728_091, sessionCount: 43 }
const PROVIDER_GAP = { tokenCount: 12_000, sessionCount: 7 }

/** 缺口行的期望文案（口径词由 src/lib/format.ts 的 formatLargeNumber 决定） */
const MODEL_GAP_TEXT = '另有 43 个会话未记录模型，合计 681.73 M tokens 未计入上方排行'
/**
 * ⚠️ 服务商缺口必须写「未计入上方**服务商**统计」：
 * 这些会话**有** model、是出现在上方模型图表里的，只是取不到 providerID。
 * 写成「上方统计」会被读成整张卡片。
 */
const PROVIDER_GAP_TEXT =
  '另有 7 个会话未记录服务商，合计 12.00 K tokens 未计入上方服务商统计'

interface DashStubOptions {
  /** dashboard:tokens 带 groupBy 时的分组数据（趋势折线图） */
  groupPoints?: unknown[]
  /** dashboard:modelRanking 的返回体（数组 = 旧后端，对象 = 新后端） */
  modelRanking?: unknown
  /** dashboard:providerStats 的返回体 */
  providerStats?: unknown
  /**
   * dashboard:tokens 不带 groupBy 时，按**请求区间**回显区间长度
   * （inputTokens = 1000 + 区间自然日数）。
   *
   * 用来验证「切预设后数据不串」：界面上的合计直接暴露「用的是哪一段」。
   */
  echoRangeTokens?: boolean
}

/**
 * 装好仪表盘需要的 IPC stub。
 *
 * `dashboard:tokens` 会被调用两次（总量 + 分组），**同一个 channel**，
 * 所以需要按 payload 分流 —— 这里用一个 init script 包一层 invoke。
 */
async function installDashboardStub(page: Page, opts: DashStubOptions = {}): Promise<TauriStub> {
  const plan: StubPlan = {
    respond: {
      [CH.DATABASE_INFO]: SCHEMA,
      [CH.DATABASE_HEALTH]: HEALTH,
      [CH.DASHBOARD_OVERVIEW]: OVERVIEW,
      [CH.DASHBOARD_TOKENS]: TOKENS,
      [CH.DASHBOARD_SESSION_TREND]: [],
      [CH.DASHBOARD_COST_TREND]: [],
      [CH.DASHBOARD_MESSAGE_TREND]: [],
      [CH.DASHBOARD_TOOL_RANKING]: [],
      [CH.DASHBOARD_SKILL_USAGE]: [],
      [CH.DASHBOARD_MODEL_RANKING]: opts.modelRanking ?? [],
      [CH.DASHBOARD_PROVIDER_STATS]: opts.providerStats ?? [],
      [CH.DASHBOARD_PROJECT_RANKING]: [],
      [CH.SESSIONS_PROJECTS]: [],
      [CH.SESSIONS_LIST]: { data: [], total: 0, page: 1, pageSize: 20 },
    },
  }
  const stub = await installTauriStub(page, plan)

  const cfg = {
    groupPoints: opts.groupPoints ?? [],
    echoRangeTokens: opts.echoRangeTokens === true,
  }
  await page.addInitScript((c) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (cmd: string, payload?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    const original = internals.invoke.bind(internals)
    // 纯日期差：用 Date.UTC 解析，避免夏令时 / 本地时区影响
    const toUtc = (iso: string) => {
      const [y, m, d] = iso.split('-').map(Number)
      return Date.UTC(y, m - 1, d)
    }
    internals.invoke = (cmd: string, payload?: unknown) => {
      const p = payload as { groupBy?: string; startDate?: string; endDate?: string } | undefined
      if (cmd === 'dashboard_tokens' && p?.groupBy) {
        return Promise.resolve({ success: true, data: c.groupPoints })
      }
      if (cmd === 'dashboard_tokens' && c.echoRangeTokens) {
        const days =
          p?.startDate && p?.endDate
            ? Math.round((toUtc(p.endDate) - toUtc(p.startDate)) / 86_400_000) + 1
            : 0
        return Promise.resolve({
          success: true,
          data: {
            inputTokens: 1_000 + days,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
            estimatedCost: 0,
            cacheHitRate: 0,
          },
        })
      }
      return original(cmd, payload)
    }
  }, cfg)

  return stub
}

/** 「模型 & Provider 统计」卡片（标题的下一个兄弟 div.bg-white） */
function modelStatsCard(page: Page): Locator {
  return page.locator(
    'xpath=//p[contains(text(), "模型 & Provider 统计")]/following-sibling::div[contains(@class,"bg-white")][1]',
  )
}

/**
 * hover 折线图的**最后一个**分类点（= 今日那个点）。
 *
 * 不用「按坐标猜」的方式：X 轴用 `interval="preserveStartEnd"`，
 * 首尾两个刻度被保留下来，最后一个刻度的 x 就是最后一个数据点的 x。
 */
async function hoverLastCategoryPoint(page: Page, chart: Locator): Promise<void> {
  const ticks = chart.locator('.recharts-xAxis .recharts-cartesian-axis-tick')
  const count = await ticks.count()
  if (count === 0) throw new Error('趋势图没有 X 轴刻度，无法定位今日那个点')
  const tick = ticks.nth(count - 1)
  const tickBox = await tick.boundingBox()
  const chartBox = await chart.boundingBox()
  if (!tickBox || !chartBox) throw new Error('趋势图没有布局盒，无法 hover')
  const x = tickBox.x + tickBox.width / 2
  const y = chartBox.y + chartBox.height / 2
  await page.mouse.move(x, y)
  await page.mouse.move(x + 1, y)
}

/** hover 横向柱状图的第一根柱子（模型排行） */
async function hoverFirstBar(page: Page, card: Locator): Promise<void> {
  const bar = card.locator('.recharts-bar-rectangle path').first()
  const box = await bar.boundingBox()
  if (!box) throw new Error('模型排行没有渲染出柱子，无法 hover')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2)
}

/**
 * 读出 tooltip 的逐行文本。
 *
 * ⚠️ 不能用 `textContent` 拆行：tooltip 的每一行是一个 `<div>`，
 * `textContent` 会把它们**直接拼在一起**（没有换行符），
 * 拆出来的是一整坨而不是「一行一项」。
 * 这里取 tooltip 内所有**叶子 div**（没有子元素的 div）——正是每一行的内容。
 */
async function tooltipLines(page: Page, scope: Locator): Promise<string[]> {
  const tooltip = scope.locator('.recharts-tooltip-wrapper').first()
  await expect(tooltip).toBeVisible()
  return tooltip.evaluate(el =>
    Array.from(el.querySelectorAll('div'))
      .filter(d => d.children.length === 0)
      .map(d => (d.textContent ?? '').trim())
      .filter(s => s.length > 0),
  )
}

// ─────────────────────────────────────────────────────────────────────────

test.describe('A. 用户报的原场景：口径误读是否已消除', () => {
  test('A1 7天 → 趋势 → Token 趋势 hover 今日点：首行是日期、合计行是「当日合计」，不出现「Token 总计」', async ({ page }) => {
    const today = localDate(new Date())
    // 7 个自然日，最后一个就是今天
    const groupPoints = Array.from({ length: 7 }, (_, i) => ({
      period: addDays(today, i - 6),
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
      cacheRead: 4,
      cacheWrite: 5,
      estimatedCost: 0.5,
    }))

    await installDashboardStub(page, { groupPoints })
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    await page.getByRole('button', { name: '7天' }).click()
    await page.getByRole('button', { name: /趋势/ }).click()

    const trends = page.getByTestId('trends-panel')
    await expect(trends).toBeVisible()
    const chart = trends.locator('.recharts-wrapper').first()
    await expect(chart).toBeVisible()

    await hoverLastCategoryPoint(page, chart)

    const lines = await tooltipLines(page, trends)
    expect(lines.length, 'tooltip 没有内容').toBeGreaterThan(0)

    // 首行 = 该数据点的日期（今天）
    expect(lines[0], `tooltip 首行不是日期：${JSON.stringify(lines)}`).toBe(today)
    // 合计行的口径词：随分桶粒度切换，day → 「当日合计」
    const totalLine = lines.find(l => l.includes('合计'))
    expect(totalLine, `tooltip 没有合计行：${JSON.stringify(lines)}`).toBeTruthy()
    expect(totalLine).toContain('当日合计')
    // 不得再出现含糊的「Token 总计」
    expect(lines.join(' | ')).not.toContain('Token 总计')
  })

  test('A2 统计 tab → 模型 & Provider 统计 hover 柱子：tooltip 是「所选范围合计」', async ({ page }) => {
    await installDashboardStub(page, {
      modelRanking: { items: [modelItem('gpt-5', 'openai', 900)], coverageGap: MODEL_GAP },
      providerStats: { items: [{ provider: 'openai', tokenCount: 900, totalCost: 1 }] },
    })
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    await page.getByRole('button', { name: /统计/ }).click()
    const card = modelStatsCard(page)
    await expect(card).toBeVisible()
    await expect(card.locator('.recharts-wrapper').first()).toBeVisible()

    await hoverFirstBar(page, card)

    const lines = await tooltipLines(page, card)
    const joined = lines.join(' | ')
    expect(joined, `模型排行 tooltip 口径词不对：${joined}`).toContain('所选范围合计')
    // 排行是范围合计，不该再自称「当日合计」
    expect(joined).not.toContain('当日合计')
    expect(joined).not.toContain('Token 总计')
  })

  test('A3 并排核对：趋势「当日合计」与排行「所选范围合计」口径词不同、趋势带日期 → 不再看起来矛盾', async ({ page }) => {
    const today = localDate(new Date())
    const groupPoints = Array.from({ length: 7 }, (_, i) => ({
      period: addDays(today, i - 6),
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
      cacheRead: 4,
      cacheWrite: 5,
      estimatedCost: 0.5,
    }))

    await installDashboardStub(page, {
      groupPoints,
      modelRanking: { items: [modelItem('gpt-5', 'openai', 900)], coverageGap: MODEL_GAP },
      providerStats: { items: [{ provider: 'openai', tokenCount: 900, totalCost: 1 }] },
    })
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    // ── 趋势侧：当日值，带日期 ──
    await page.getByRole('button', { name: /趋势/ }).click()
    const trends = page.getByTestId('trends-panel')
    await expect(trends).toBeVisible()
    const chart = trends.locator('.recharts-wrapper').first()
    await expect(chart).toBeVisible()
    await hoverLastCategoryPoint(page, chart)
    const trendLines = await tooltipLines(page, trends)

    // ── 排行侧：范围合计 ──
    await page.getByRole('button', { name: /统计/ }).click()
    const card = modelStatsCard(page)
    await expect(card.locator('.recharts-wrapper').first()).toBeVisible()
    await hoverFirstBar(page, card)
    const rankLines = await tooltipLines(page, card)

    const trendText = trendLines.join(' | ')
    const rankText = rankLines.join(' | ')

    // 趋势侧：日期 + 分桶口径
    expect(trendLines[0]).toBe(today)
    expect(trendText).toContain('当日合计')
    // 排行侧：范围口径
    expect(rankText).toContain('所选范围合计')

    // 关键：两侧**没有**同一个含糊的词，也**没有**互相串台
    expect(trendText).not.toContain('所选范围合计')
    expect(rankText).not.toContain('当日合计')
    expect(trendText).not.toContain('Token 总计')
    expect(rankText).not.toContain('Token 总计')
  })

  test('A4 概览 tab 的 Token 合计行标签是「所选范围 Token 合计」', async ({ page }) => {
    await installDashboardStub(page)
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    await expect(page.getByText('所选范围 Token 合计')).toBeVisible()
    // 旧的含糊标签整个页面上都不该再出现
    await expect(page.getByText('Token 总计', { exact: true })).toHaveCount(0)
  })
})

test.describe('B. 时间范围口径', () => {
  test('B1 7天 / 30天 / 90天：请求区间含今日在内正好 N 个自然日（端点差 N−1）', async ({ page }) => {
    const stub = await installDashboardStub(page)
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    const today = localDate(new Date())
    for (const [label, days] of [['7天', 7], ['30天', 30], ['90天', 90]] as const) {
      const before = await stub.callCount(CH.DASHBOARD_OVERVIEW)
      await page.getByRole('button', { name: label }).click()
      await expect
        .poll(() => stub.callCount(CH.DASHBOARD_OVERVIEW), { timeout: 5_000 })
        .toBeGreaterThan(before)

      const range = await page.evaluate(() => {
        const bridge = (window as unknown as {
          __qa?: { log: Array<{ channel: string; payload: unknown }> }
        }).__qa
        const calls = (bridge?.log ?? []).filter(c => c.channel === 'dashboard_overview')
        return (calls[calls.length - 1]?.payload ?? {}) as { startDate?: string; endDate?: string }
      })

      expect(range.endDate, `${label} 的 endDate 应是今天`).toBe(today)
      expect(
        daysBetween(range.startDate!, range.endDate!),
        `${label} 端点差应为 ${days - 1} 天（实际区间 ${range.startDate} ~ ${range.endDate}）`,
      ).toBe(days - 1)
      // 含端点的自然日数量 = N
      expect(daysBetween(range.startDate!, range.endDate!) + 1).toBe(days)
    }
  })

  test('B2 「对比上期」：上期与本期等长且紧邻（上期 end 与本期 start 差 1 天）', async ({ page }) => {
    const stub = await installDashboardStub(page)
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    await page.getByRole('button', { name: '7天' }).click()
    await page.getByRole('button', { name: /趋势/ }).click()
    await expect(page.getByTestId('trends-panel')).toBeVisible()

    // 「对比上期」开关（成本趋势卡片的那个）
    const compare = page.locator('label:has-text("对比上期")').first().locator('input')
    await compare.check()

    // 上期请求是异步补发的 —— 等调用数稳定再读
    await stub.stableCount(CH.DASHBOARD_COST_TREND, 3, 120)
    const payloads = (await stub.payloads(CH.DASHBOARD_COST_TREND)) as Array<{
      startDate?: string
      endDate?: string
    }>

    const ranges = payloads
      .filter(p => p?.startDate && p?.endDate)
      .map(p => ({ start: p.startDate!, end: p.endDate! }))
    expect(ranges.length, '没有拿到成本趋势的区间请求').toBeGreaterThan(0)

    const today = localDate(new Date())
    // 本期 = 以今天结尾的那个区间；其余的另一个就是上期
    const current = ranges.find(r => r.end === today)
    expect(current, `没有看到本期区间：${JSON.stringify(ranges)}`).toBeTruthy()
    const others = ranges.filter(r => r !== current)
    expect(others.length, `没有看到上期区间：${JSON.stringify(ranges)}`).toBeGreaterThan(0)
    const prev = others[0]

    // 等长（端点数相同）
    expect(
      daysBetween(prev.start, prev.end) + 1,
      `上期与本期不等长：上期 ${prev.start}~${prev.end}，本期 ${current!.start}~${current!.end}`,
    ).toBe(daysBetween(current!.start, current!.end) + 1)
    // 紧邻（不留空档、不重叠）
    expect(
      daysBetween(prev.end, current!.start),
      `上期与本期不紧邻：上期 ${prev.start}~${prev.end}，本期 ${current!.start}~${current!.end}`,
    ).toBe(1)
  })

  test('B3 会话页「今天 / 近3天 / 近一周 / 近一月」：请求区间正确，「今天」= 本地当天（UTC+8 早 8 点窗口）', async ({ page }) => {
    // 固定时钟到 **UTC+8 的 2026-10-24 00:30**（UTC 那一天还是 10-23）——
    // 这正是用户报的「早 8 点把今天筛成昨天」的窗口。
    // 用 UTC 日期实现的话，这里会得到 2026-10-23（错一天）。
    await page.clock.setFixedTime(new Date('2026-10-23T16:30:00Z'))

    const stub = await installTauriStub(page, {
      respond: {
        [CH.DATABASE_INFO]: SCHEMA,
        [CH.DATABASE_HEALTH]: HEALTH,
        [CH.SESSIONS_PROJECTS]: [],
        [CH.SESSIONS_LIST]: { data: [], total: 0, page: 1, pageSize: 20 },
      },
    })

    await page.goto('/#/sessions')
    // ⚠️ 触发器的可访问名会随预设变化（未选时是「日期范围」，选中后变成预设名），
    // 所以按**日历图标**定位，不能按文案定位。
    const dropdown = page.locator('button:has(svg.lucide-calendar)')
    await expect(dropdown).toBeVisible()

    const today = '2026-10-24' // UTC+8 本地日历日
    const cases: Array<{ label: string; start: string; end: string; days: number }> = [
      { label: '今天', start: today, end: today, days: 1 },
      { label: '近3天', start: '2026-10-22', end: today, days: 3 },
      { label: '近一周', start: '2026-10-18', end: today, days: 7 },
      { label: '近一月', start: '2026-09-25', end: today, days: 30 },
    ]

    for (const c of cases) {
      const before = await stub.callCount(CH.SESSIONS_LIST)
      await dropdown.click()
      await page.getByRole('button', { name: c.label, exact: true }).click()
      await expect
        .poll(() => stub.callCount(CH.SESSIONS_LIST), { timeout: 5_000 })
        .toBeGreaterThan(before)

      const last = (await stub.payloads(CH.SESSIONS_LIST)).pop() as {
        startDate?: string
        endDate?: string
      }
      expect(last?.startDate, `${c.label} 的 startDate`).toBe(c.start)
      expect(last?.endDate, `${c.label} 的 endDate`).toBe(c.end)
      // 含端点的自然日数量
      expect(daysBetween(last!.startDate!, last!.endDate!) + 1, `${c.label} 的自然日数量`).toBe(c.days)
    }
  })

  test('B4 切预设后数据不串：旧区间的缓存没被复用', async ({ page }) => {
    // 总量接口按**请求区间**回显区间长度 → 界面上的合计直接暴露「用的是哪一段」
    await installDashboardStub(page, { echoRangeTokens: true })
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    const total = page.getByText('所选范围 Token 合计').locator('xpath=following-sibling::span')
    // 默认 30 天 → 合计 1000 + 30
    await expect(total).toHaveText('1,030')

    await page.getByRole('button', { name: '7天' }).click()
    // 切到 7 天后必须是 7 天的数，不能还挂着 30 天的
    await expect(total).toHaveText('1,007')

    await page.getByRole('button', { name: '90天' }).click()
    await expect(total).toHaveText('1,090')
  })
})

test.describe('C. 覆盖缺口行', () => {
  test('C1 新返回体 + coverageGap 非零：缺口行可见，文案与数值正确', async ({ page }) => {
    await installDashboardStub(page, {
      modelRanking: { items: [modelItem('gpt-5', 'openai', 900)], coverageGap: MODEL_GAP },
      providerStats: {
        items: [{ provider: 'openai', tokenCount: 900, totalCost: 1 }],
        coverageGap: PROVIDER_GAP,
      },
    })
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()
    await page.getByRole('button', { name: /统计/ }).click()

    await expect(page.getByText(MODEL_GAP_TEXT)).toBeVisible()
    await expect(page.getByText(PROVIDER_GAP_TEXT)).toBeVisible()
  })

  test('C2 旧返回体（数组）：不崩、不显示缺口行', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })

    // 旧后端：直接返回数组，没有 coverageGap
    await installDashboardStub(page, {
      modelRanking: [modelItem('gpt-5', 'openai', 900)],
      providerStats: [{ provider: 'openai', tokenCount: 900, totalCost: 1 }],
    })
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()
    await page.getByRole('button', { name: /统计/ }).click()

    // 排行本身照常渲染（旧后端数据没丢）
    await expect(page.getByText('gpt-5')).toBeVisible()
    // 缺口行整行不渲染
    await expect(page.getByText(/未记录模型/)).toHaveCount(0)
    await expect(page.getByText(/未记录服务商/)).toHaveCount(0)
    expect(errors, '旧数组返回体引发了控制台错误').toEqual([])
  })

  test('C3 coverageGap 缺失 / tokenCount 为 0：整行不渲染（不显示 0、不留空占位）', async ({ page }) => {
    await installDashboardStub(page, {
      // 缺字段
      modelRanking: { items: [modelItem('gpt-5', 'openai', 900)] },
      // tokenCount 为 0
      providerStats: {
        items: [{ provider: 'openai', tokenCount: 900, totalCost: 1 }],
        coverageGap: { tokenCount: 0, sessionCount: 0 },
      },
    })
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()
    await page.getByRole('button', { name: /统计/ }).click()

    await expect(page.getByText(/未记录模型/)).toHaveCount(0)
    await expect(page.getByText(/未记录服务商/)).toHaveCount(0)
    // 不得出现「0 个会话」这种零值占位
    await expect(page.getByText(/另有 0 个会话/)).toHaveCount(0)
  })

  test('C4 模型缺口与服务商缺口各自独立：文案与数值不混用', async ({ page }) => {
    await installDashboardStub(page, {
      modelRanking: { items: [modelItem('gpt-5', 'openai', 900)], coverageGap: MODEL_GAP },
      providerStats: {
        items: [{ provider: 'openai', tokenCount: 900, totalCost: 1 }],
        coverageGap: PROVIDER_GAP,
      },
    })
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()
    await page.getByRole('button', { name: /统计/ }).click()

    const modelLine = page.getByText(/未记录模型/)
    const providerLine = page.getByText(/未记录服务商/)
    await expect(modelLine).toBeVisible()
    await expect(providerLine).toBeVisible()

    const modelText = (await modelLine.textContent()) ?? ''
    const providerText = (await providerLine.textContent()) ?? ''

    // 模型缺口行只讲模型，不带服务商的数值
    expect(modelText).toContain('43')
    expect(modelText).toContain('681.73 M')
    expect(modelText).not.toContain('未记录服务商')
    expect(modelText).not.toContain('12.00 K')

    // 服务商缺口行只讲服务商，不带模型的数值
    expect(providerText).toContain('7')
    expect(providerText).toContain('12.00 K')
    expect(providerText).not.toContain('未记录模型')
    expect(providerText).not.toContain('681.73 M')

    // 两行是**两行**，不是合并成一行
    expect(await modelLine.count()).toBe(1)
    expect(await providerLine.count()).toBe(1)
  })

  test('C5 768px 窄屏：两行缺口说明都换行，不横向溢出、不被裁切、不越出卡片右边界', async ({ page }) => {
    await installDashboardStub(page, {
      modelRanking: { items: [modelItem('gpt-5', 'openai', 900)], coverageGap: MODEL_GAP },
      providerStats: {
        items: [{ provider: 'openai', tokenCount: 900, totalCost: 1 }],
        coverageGap: PROVIDER_GAP,
      },
    })
    await page.setViewportSize({ width: 768, height: 800 })
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()
    await page.getByRole('button', { name: /统计/ }).click()

    await expect(page.getByText(MODEL_GAP_TEXT)).toBeVisible()
    await expect(page.getByText(PROVIDER_GAP_TEXT)).toBeVisible()

    const metrics = await page.evaluate(() => {
      const pick = (needle: string) =>
        Array.from(document.querySelectorAll('p')).find(
          node => (node.textContent ?? '').includes(needle),
        ) as HTMLElement | undefined
      const model = pick('未记录模型')
      const provider = pick('未记录服务商')
      const card = model?.closest('div.bg-white') as HTMLElement | null
      const scroller = document.scrollingElement as HTMLElement
      const m = (el: HTMLElement | undefined) =>
        el
          ? {
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              right: el.getBoundingClientRect().right,
              panelRight: card?.getBoundingClientRect().right ?? 0,
            }
          : null
      return {
        model: m(model),
        provider: m(provider),
        docScrollWidth: scroller.scrollWidth,
        docClientWidth: scroller.clientWidth,
      }
    })

    expect(metrics.model, '未找到模型缺口说明行').not.toBeNull()
    expect(metrics.provider, '未找到服务商缺口说明行').not.toBeNull()
    for (const [name, v] of [['模型', metrics.model], ['服务商', metrics.provider]] as const) {
      expect(v!.scrollWidth, `${name}缺口说明横向溢出`).toBeLessThanOrEqual(v!.clientWidth + 1)
      expect(v!.scrollHeight, `${name}缺口说明被纵向裁切`).toBeLessThanOrEqual(v!.clientHeight + 1)
      expect(v!.right, `${name}缺口说明超出卡片右边界`).toBeLessThanOrEqual(v!.panelRight + 0.5)
    }
    expect(
      metrics.docScrollWidth,
      `「仪表盘」在 768px 下出现文档级横向滚动：scrollWidth=${metrics.docScrollWidth} clientWidth=${metrics.docClientWidth}`,
    ).toBeLessThanOrEqual(metrics.docClientWidth)
  })
})

test.describe('D. 复制按钮', () => {
  test('D1 连续复制两次：live region 节点被重建 → 读屏会重播（不是只播一次）', async ({ page }) => {
    // 浏览器预览环境（不装 Tauri stub）：当前版本回落到仓库构建版本 v1.4.0
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

    await page.goto('/#/settings')

    const copyBtn = page.getByRole('button', { name: '复制版本号' })
    const tooltip = page.getByTestId('copy-version-tooltip')
    const live = page.getByTestId('copy-version-status')
    await expect(copyBtn).toBeVisible()

    // 弱化按钮：**没有可见的「复制」文字**，只有图标
    await expect(copyBtn).toHaveText('')
    await expect(copyBtn.locator('svg').first()).toBeVisible()
    // 用的是自绘 tooltip，不是原生 title（两者并存会弹两个互相遮挡的提示）
    await expect(copyBtn).not.toHaveAttribute('title', /.+/)

    // live region 语义正确
    await expect(live).toHaveAttribute('role', 'status')
    await expect(live).toHaveAttribute('aria-live', 'polite')

    // 第一次复制
    await copyBtn.click()
    await expect(live).toHaveText('已复制版本号 v1.4.0')
    await expect(copyBtn.locator('svg.lucide-check')).toHaveCount(1)
    await expect(tooltip).toHaveText('已复制')

    // 给当前 live region 节点打标记
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="copy-version-status"]') as
        | (HTMLElement & { __qaMark?: number })
        | null
      if (el) el.__qaMark = 1
    })

    // 第二次复制（文案相同）
    await copyBtn.click()
    await expect(live).toHaveText('已复制版本号 v1.4.0')
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __clipboardWrites?: string[] }).__clipboardWrites?.length ?? 0,
    )).toBe(2)

    // ⚠️ 关键：live region 节点被**重建**了（标记没了）——
    // 读屏把它当成一次全新的播报；只改文案不改节点的话，第二次不会重播。
    const stillSameNode = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="copy-version-status"]') as
        | (HTMLElement & { __qaMark?: number })
        | null
      return el?.__qaMark === 1
    })
    expect(stillSameNode, 'live region 节点没有被重建 → 连点两次只会播报一次').toBe(false)
  })
})

test.describe('E. 通用回归', () => {
  /** 收集控制台错误与未捕获异常 */
  function collectErrors(page: Page): { consoleErrors: string[]; pageErrors: string[] } {
    const errors = { consoleErrors: [] as string[], pageErrors: [] as string[] }
    page.on('console', m => {
      if (m.type() === 'error') errors.consoleErrors.push(m.text())
    })
    page.on('pageerror', e => errors.pageErrors.push(`${e.name}: ${e.message}`))
    return errors
  }

  test('E1 仪表盘三个 tab（概览 / 统计 / 趋势）都走一遍：无控制台错误、无未捕获异常', async ({ page }) => {
    const errors = collectErrors(page)
    const today = localDate(new Date())
    await installDashboardStub(page, {
      groupPoints: [
        {
          period: today,
          inputTokens: 1,
          outputTokens: 2,
          reasoningTokens: 3,
          cacheRead: 4,
          cacheWrite: 5,
          estimatedCost: 0.5,
        },
      ],
      modelRanking: { items: [modelItem('gpt-5', 'openai', 900)], coverageGap: MODEL_GAP },
      providerStats: {
        items: [{ provider: 'openai', tokenCount: 900, totalCost: 1 }],
        coverageGap: PROVIDER_GAP,
      },
    })
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    // 概览
    await expect(page.getByText('所选范围 Token 合计')).toBeVisible()

    // 统计（模型 / 项目排行 + 缺口行）
    await page.getByRole('button', { name: /统计/ }).click()
    await expect(page.getByText(MODEL_GAP_TEXT)).toBeVisible()
    await expect(page.getByText(PROVIDER_GAP_TEXT)).toBeVisible()

    // 趋势（折线图 + tooltip）
    await page.getByRole('button', { name: /趋势/ }).click()
    const trends = page.getByTestId('trends-panel')
    await expect(trends).toBeVisible()
    const chart = trends.locator('.recharts-wrapper').first()
    await expect(chart).toBeVisible()
    await hoverLastCategoryPoint(page, chart)
    await expect(trends.locator('.recharts-tooltip-wrapper').first()).toBeVisible()

    // 「对比上期」也走一遍（上期区间请求是异步补发的）
    await page.locator('label:has-text("对比上期")').first().locator('input').check()
    await page.waitForTimeout(300)

    expect(errors.consoleErrors, `控制台错误：\n${errors.consoleErrors.join('\n')}`).toEqual([])
    expect(errors.pageErrors, `未捕获异常：\n${errors.pageErrors.join('\n')}`).toEqual([])
  })

  test('E2 设置页与会话浏览页：无控制台错误、无未捕获异常', async ({ page }) => {
    const errors = collectErrors(page)
    await installTauriStub(page, {
      respond: {
        [CH.DATABASE_INFO]: SCHEMA,
        [CH.DATABASE_HEALTH]: HEALTH,
        [CH.SESSIONS_PROJECTS]: [],
        [CH.SESSIONS_LIST]: { data: [], total: 0, page: 1, pageSize: 20 },
      },
      respondRaw: {
        'plugin:app|version': '1.4.0',
        'plugin:path|home_dir': '/Users/tester',
      },
    })

    await page.goto('/#/settings')
    await expect(page.getByTestId('update-section')).toBeVisible()
    await page.waitForTimeout(300)

    await page.goto('/#/sessions')
    await expect(page.getByRole('button', { name: '日期范围' })).toBeVisible()
    await page.waitForTimeout(300)

    expect(errors.consoleErrors, `控制台错误：\n${errors.consoleErrors.join('\n')}`).toEqual([])
    expect(errors.pageErrors, `未捕获异常：\n${errors.pageErrors.join('\n')}`).toEqual([])
  })

  test('E3 768px 窄屏：设置页、仪表盘三个 tab、会话浏览页都不横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 800 })
    await installDashboardStub(page, {
      groupPoints: [
        {
          period: localDate(new Date()),
          inputTokens: 1,
          outputTokens: 2,
          reasoningTokens: 3,
          cacheRead: 4,
          cacheWrite: 5,
          estimatedCost: 0.5,
        },
      ],
      modelRanking: { items: [modelItem('gpt-5', 'openai', 900)], coverageGap: MODEL_GAP },
      providerStats: {
        items: [{ provider: 'openai', tokenCount: 900, totalCost: 1 }],
        coverageGap: PROVIDER_GAP,
      },
    })

    const docOverflow = async (where: string) => {
      const m = await page.evaluate(() => {
        const el = document.scrollingElement as HTMLElement
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
      })
      expect(
        m.scrollWidth,
        `${where} 在 768px 下出现文档级横向滚动：scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth}`,
      ).toBeLessThanOrEqual(m.clientWidth)
    }

    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()
    await docOverflow('仪表盘 · 概览')

    await page.getByRole('button', { name: /统计/ }).click()
    await expect(page.getByText(MODEL_GAP_TEXT)).toBeVisible()
    await docOverflow('仪表盘 · 统计')

    await page.getByRole('button', { name: /趋势/ }).click()
    await expect(page.getByTestId('trends-panel')).toBeVisible()
    await docOverflow('仪表盘 · 趋势')

    await page.goto('/#/sessions')
    await expect(page.getByRole('button', { name: '日期范围' })).toBeVisible()
    await docOverflow('会话浏览')

    await page.goto('/#/settings')
    await expect(page.getByTestId('update-section')).toBeVisible()
    await docOverflow('设置')
  })
})

/**
 * F. 夏令时切换日 —— 预设时间范围必须按**日历日**算。
 *
 * 背景：旧实现用 `Date.now() - (N−1) * 86_400_000`（减毫秒）算起点，
 * 跨过夏令时边界时本地墙钟偏移 ±1 小时 → 本地日期翻转一天：
 *   - 春季跳表落在窗口内 → 区间变成 **8** 天
 *   - 秋季回拨落在窗口内 → 区间变成 **6** 天
 * （复现于 America/New_York：本地 00:30 与 23:30 两个时刻都会翻页。）
 *
 * 为什么必须是**真浏览器**：jsdom / Node 里改 `process.env.TZ` 不改变
 * 已经在跑的页面的时区，而 Playwright 的 `timezoneId` 是给**浏览器上下文**
 * 设的 —— 这正是「用户所在机器的时区」在真实运行时的样子。
 */
test.describe('F. 夏令时切换日（America/New_York）', () => {
  // 有夏令时的时区；期望值因此才是「用户在切换日看到的区间」
  test.use({ timezoneId: 'America/New_York' })

  /** 读出最近一次 dashboard:overview 请求带的时间范围 */
  async function lastOverviewRange(page: Page): Promise<{ startDate?: string; endDate?: string }> {
    return page.evaluate(() => {
      const bridge = (window as unknown as {
        __qa?: { log: Array<{ channel: string; payload: unknown }> }
      }).__qa
      const calls = (bridge?.log ?? []).filter(c => c.channel === 'dashboard_overview')
      return (calls[calls.length - 1]?.payload ?? {}) as {
        startDate?: string
        endDate?: string
      }
    })
  }

  /** 页面里的「今天」（本地日历日）——用来确认固定时钟落在预期的日子 */
  async function localTodayInPage(page: Page): Promise<string> {
    return page.evaluate(() => {
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    })
  }

  test('F1 春季跳表（2026-03-08）落在窗口内：7 天 = 含今日在内的 7 个自然日', async ({ page }) => {
    // 本地 2026-03-14 00:30 (-04:00 EDT) = 2026-03-14T04:30Z
    await page.clock.setFixedTime(new Date('2026-03-14T04:30:00Z'))
    const stub = await installDashboardStub(page)
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    // 前提自检：页面里的「今天」确实是预期的本地日历日
    expect(await localTodayInPage(page), '固定时钟没有落在预期的本地日历日').toBe('2026-03-14')

    const before = await stub.callCount(CH.DASHBOARD_OVERVIEW)
    await page.getByRole('button', { name: '7天' }).click()
    await expect
      .poll(() => stub.callCount(CH.DASHBOARD_OVERVIEW), { timeout: 5_000 })
      .toBeGreaterThan(before)

    const range = await lastOverviewRange(page)

    // 春季跳表落在 [今天−6, 今天] 窗口内 → 起点必须是 3/8（不是 3/7）
    expect(range.startDate, '春季跳表日的 7 天起点差了一天').toBe('2026-03-08')
    expect(range.endDate).toBe('2026-03-14')
    // 端点差恰好 6 天 → 含端点正好 7 个自然日（不是 8 天）
    expect(daysBetween(range.startDate!, range.endDate!)).toBe(6)
    expect(daysBetween(range.startDate!, range.endDate!) + 1).toBe(7)
  })

  test('F2 秋季回拨（2026-11-01）落在窗口内：7 天 = 含今日在内的 7 个自然日', async ({ page }) => {
    // 本地 2026-11-02 23:30 (-05:00 EST) = 2026-11-03T04:30Z
    await page.clock.setFixedTime(new Date('2026-11-03T04:30:00Z'))
    const stub = await installDashboardStub(page)
    await page.goto('/#/')
    await expect(page.getByText('30/0')).toBeVisible()

    expect(await localTodayInPage(page), '固定时钟没有落在预期的本地日历日').toBe('2026-11-02')

    const before = await stub.callCount(CH.DASHBOARD_OVERVIEW)
    await page.getByRole('button', { name: '7天' }).click()
    await expect
      .poll(() => stub.callCount(CH.DASHBOARD_OVERVIEW), { timeout: 5_000 })
      .toBeGreaterThan(before)

    const range = await lastOverviewRange(page)

    // 秋季回拨落在 [今天−6, 今天] 窗口内 → 起点必须是 10/27（不是 10/28）
    expect(range.startDate, '秋季回拨日的 7 天起点差了一天').toBe('2026-10-27')
    expect(range.endDate).toBe('2026-11-02')
    expect(daysBetween(range.startDate!, range.endDate!)).toBe(6)
    expect(daysBetween(range.startDate!, range.endDate!) + 1).toBe(7)
  })

  test('F3 会话页「近一周」：夏令时切换日同样是 7 个自然日', async ({ page }) => {
    // 本地 2026-03-14 00:30 (-04:00 EDT) = 2026-03-14T04:30Z
    await page.clock.setFixedTime(new Date('2026-03-14T04:30:00Z'))
    const stub = await installTauriStub(page, {
      respond: {
        [CH.DATABASE_INFO]: SCHEMA,
        [CH.DATABASE_HEALTH]: HEALTH,
        [CH.SESSIONS_PROJECTS]: [],
        [CH.SESSIONS_LIST]: { data: [], total: 0, page: 1, pageSize: 20 },
      },
    })

    await page.goto('/#/sessions')
    // ⚠️ 触发器的可访问名会随预设变化，按**日历图标**定位，不能按文案定位。
    const dropdown = page.locator('button:has(svg.lucide-calendar)')
    await expect(dropdown).toBeVisible()

    const before = await stub.callCount(CH.SESSIONS_LIST)
    await dropdown.click()
    await page.getByRole('button', { name: '近一周', exact: true }).click()
    await expect
      .poll(() => stub.callCount(CH.SESSIONS_LIST), { timeout: 5_000 })
      .toBeGreaterThan(before)

    const last = (await stub.payloads(CH.SESSIONS_LIST)).pop() as {
      startDate?: string
      endDate?: string
    }

    expect(last?.startDate, '春季跳表日的「近一周」起点差了一天').toBe('2026-03-08')
    expect(last?.endDate).toBe('2026-03-14')
    expect(daysBetween(last!.startDate!, last!.endDate!)).toBe(6)
    expect(daysBetween(last!.startDate!, last!.endDate!) + 1).toBe(7)
  })
})
