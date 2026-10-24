import { expect, type Page } from '@playwright/test'

/**
 * 真实浏览器里的**对比度测量**（WCAG 相对亮度公式）。
 *
 * 为什么要有这个 helper：
 *   - 「再弱化一档」在肉眼看来毫无差别，却可能直接跌破 WCAG 1.4.11 的 3:1
 *     （非文本图形）。只有**量**出来才知道 —— 靠 class 名推是推不出来的。
 *   - 颜色不是从 class 名推的，而是从**真实渲染**出来的 computed style 读；
 *     Tailwind v4 的调色板是 oklch()，浏览器的 computed style 也可能保留
 *     oklch 写法，只有 canvas 能把它解析成 8bit sRGB。
 *   - 背景要**合成**：按钮自身通常没有背景色，真正的背景在祖先卡片上，
 *     半透明层要逐层向下合成。
 *
 * 适用范围：图标按钮（图标是按钮**唯一**的视觉标识，无文字、无边框）→
 * WCAG 1.4.11 要求 ≥ 3:1。
 */

export interface ContrastResult {
  /** WCAG 相对亮度公式算出的对比度（保留两位小数） */
  ratio: number
  /** 前景色（合成后的 sRGB，`rgb(r, g, b)`） */
  fg: string
  /** 有效背景色（合成后的 sRGB，`rgb(r, g, b)`） */
  bg: string
}

/**
 * 量出某个元素的实际对比度（前景 color vs 有效背景）。
 *
 * @param page Playwright page
 * @param selector 目标元素的 CSS 选择器（必须在页面里唯一命中）
 */
export async function measureContrast(page: Page, selector: string): Promise<ContrastResult> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null
    if (!el) throw new Error(`对比度测量失败：找不到 ${sel}`)

    // 用 canvas 把任意 CSS 颜色（oklch / color() / color-mix() …）解析成 sRGB 的 RGBA
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    const resolve = (css: string) => {
      if (!CSS.supports('color', css)) return null
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }
    }
    const over = (
      fg: { r: number; g: number; b: number; a: number },
      bg: { r: number; g: number; b: number },
    ) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    })

    // 前景：元素的 color（Lucide 图标用 currentColor 描边）
    const fgRaw = resolve(getComputedStyle(el).color)
    if (!fgRaw) {
      throw new Error(`读不到 ${sel} 的前景色：${getComputedStyle(el).color}`)
    }

    // 背景：从元素往上找第一个不透明背景层，逐层向下合成
    const layers: Array<{ r: number; g: number; b: number; a: number }> = []
    let node: HTMLElement | null = el
    while (node) {
      const c = resolve(getComputedStyle(node).backgroundColor)
      if (c && c.a > 0) {
        layers.push(c)
        if (c.a >= 1) break
      }
      node = node.parentElement
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 } // 页面底色兜底：白
    for (let i = layers.length - 1; i >= 0; i -= 1) bg = over(layers[i], bg)

    const fg = over(fgRaw, bg)
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }
    const l1 = lum(fg)
    const l2 = lum(bg)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    const rgb = (c: { r: number; g: number; b: number }) =>
      `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`
    return { ratio: Math.round(ratio * 100) / 100, fg: rgb(fg), bg: rgb(bg) }
  }, selector)
}

/**
 * 量出对比度并断言不低于阈值（WCAG 1.4.11 非文本内容 = 3:1）。
 *
 * 断言失败时把实测值、前景色、背景色一起带进消息 ——
 * 只说「对比度不够」没法定位是哪一档颜色弱了。
 *
 * @param label 元素的人话名称（写进失败消息）
 */
export async function expectContrastAtLeast(
  page: Page,
  selector: string,
  min: number,
  label: string,
): Promise<ContrastResult> {
  const result = await measureContrast(page, selector)
  expect(
    result.ratio,
    `${label} 的对比度只有 ${result.ratio}:1（前景 ${result.fg} / 背景 ${result.bg}），低于 WCAG 1.4.11 的 ${min}:1`,
  ).toBeGreaterThanOrEqual(min)
  return result
}
