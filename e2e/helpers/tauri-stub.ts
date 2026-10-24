import type { Page } from '@playwright/test'

/**
 * 在真实 Chromium 里伪造 Tauri IPC —— 让「加载 / 失败保留 / 乱序 / 保活」
 * 这些状态机行为可以在浏览器 e2e 里触达，而不需要 Tauri 运行时。
 *
 * 依据（2026-10 实测，勿凭记忆改）：
 *   - `isTauri()` 检查 `'__TAURI_INTERNALS__' in window || '__TAURI__' in window`
 *     （`src/lib/ipc.ts:19-22`）；
 *   - `@tauri-apps/api/core` 的 `invoke()` 直接调用
 *     `window.__TAURI_INTERNALS__.invoke(cmd, args, options)`
 *     （`node_modules/@tauri-apps/api/core.cjs:203-205`）。
 *   因此在页面脚本运行前注入 `__TAURI_INTERNALS__` 即可接管全部 IPC。
 *
 * 两类命令的返回形态不同，必须区分，否则插件调用会拿到错形状：
 *   - 应用命令（`dashboard:overview` 等）→ `IpcResult` 包裹 `{success, data|error}`
 *   - 插件命令（`plugin:path|home_dir` 等）→ **裸值**
 *
 * channel → 命令名的转换必须与 `src/lib/ipc.ts` 逐字一致（冒号 / 驼峰 /
 * 连字符 → 下划线再小写），否则 handler 永远匹配不上。
 */

export function toCommandName(channel: string): string {
  return channel
    .replace(/:/g, '_')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

export interface StubPlan {
  /** 文档一创建就生效的固定响应（键为 IPC channel） */
  respond?: Record<string, unknown>
  /** 文档一创建就挂起的通道（用于「首屏 loading」这类必须在导航前就挂起的场景） */
  hold?: string[]
  /** 插件命令的裸值响应（键为完整命令名，如 `plugin:path|home_dir`） */
  respondRaw?: Record<string, unknown>
}

/** 页面里 `window.__qa` 的形状（由 PAGE_SETUP 注入） */
export interface QaBridge {
  log: Array<{ channel: string; payload: unknown }>
  respond(channel: string, data: unknown): void
  respondRaw(name: string, data: unknown): void
  hold(channel: string): number
  release(index: number, data: unknown): void
  fail(index: number, message: string): void
  resetCalls(): void
}

export interface TauriStub {
  /** 设置 / 覆盖某通道的固定响应（导航之后调用） */
  respond(channel: string, data: unknown): Promise<void>
  /** 插件命令的裸值响应 */
  respondRaw(commandName: string, data: unknown): Promise<void>
  /** 让该通道的下一次调用挂起（FIFO），返回全局门索引 */
  hold(channel: string): Promise<number>
  /** 放行第 index 个门，返回成功响应 */
  release(index: number, data: unknown): Promise<void>
  /** 让第 index 个门以失败告终（前端表现为 invokeSafe throw） */
  fail(index: number, message: string): Promise<void>
  /** 清空调用记录（不影响已设置的响应） */
  resetCalls(): Promise<void>
  /** 某通道被调用的次数 */
  callCount(channel: string): Promise<number>
  /** 某通道每次调用的 payload（按调用顺序） */
  payloads(channel: string): Promise<unknown[]>
  /**
   * 等到某通道的调用次数连续 ~300ms 不再增长后返回当前次数。
   *
   * 用途：趋势页会异步补发「对比上期」的请求，直接在读数当下断言会跟
   * 迟到的请求竞态。轮询到稳定再取值，断言才是「没有新增请求」。
   */
  stableCount(channel: string, samples?: number, intervalMs?: number): Promise<number>
}

const PAGE_SETUP = (plan: StubPlan) => {
  const log: Array<{ channel: string; payload: unknown }> = []
  const handlers: Record<string, (payload: unknown) => unknown> = {}
  const gates: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []
  const queues: Record<string, Array<{ promise: Promise<unknown> }>> = {}

  // 与 src/lib/ipc.ts 的 channel → 命令名转换逐字一致
  const toCommand = (channel: string): string =>
    channel
      .replace(/:/g, '_')
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/-/g, '_')
      .toLowerCase()

  const w = window as unknown as Record<string, unknown>

  for (const [channel, data] of Object.entries(plan.respond ?? {})) {
    handlers[toCommand(channel)] = () => ({ success: true, data })
  }
  for (const [name, data] of Object.entries(plan.respondRaw ?? {})) {
    handlers[name] = () => data
  }
  for (const channel of plan.hold ?? []) {
    let resolve!: (v: unknown) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })
    gates.push({ resolve, reject })
    const cmd = toCommand(channel)
    queues[cmd] = queues[cmd] ?? []
    queues[cmd].push({ promise })
    handlers[cmd] = () => {
      const next = (queues[cmd] ?? []).shift()
      return next ? next.promise : { success: true, data: [] }
    }
  }

  w.__qa = {
    log,
    respond(channel: string, data: unknown) {
      handlers[toCommand(channel)] = () => ({ success: true, data })
    },
    respondRaw(name: string, data: unknown) {
      handlers[name] = () => data
    },
    hold(channel: string) {
      let resolve!: (v: unknown) => void
      let reject!: (e: unknown) => void
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res
        reject = rej
      })
      const index = gates.length
      gates.push({ resolve, reject })
      const cmd = toCommand(channel)
      queues[cmd] = queues[cmd] ?? []
      queues[cmd].push({ promise })
      handlers[cmd] = () => {
        const next = (queues[cmd] ?? []).shift()
        return next ? next.promise : { success: true, data: [] }
      }
      return index
    },
    release(index: number, data: unknown) {
      gates[index].resolve({ success: true, data })
    },
    fail(index: number, message: string) {
      gates[index].reject({ success: false, error: message })
    },
    resetCalls() {
      log.length = 0
    },
  }

  w.__TAURI_INTERNALS__ = {
    invoke(commandName: string, payload?: unknown) {
      log.push({ channel: commandName, payload })
      const handler = handlers[commandName]
      const isPlugin = commandName.startsWith('plugin:')
      if (!handler) return Promise.resolve(isPlugin ? null : { success: true, data: [] })
      // 门 reject 时传入的是 IpcResult 形状（{success:false,error}），
      // 转成 resolved 值后 invokeSafe 会照常 throw —— 与真实后端失败等价。
      return Promise.resolve()
        .then(() => handler(payload))
        .catch((e: unknown) => e)
    },
  }
}

export async function installTauriStub(page: Page, plan: StubPlan = {}): Promise<TauriStub> {
  await page.addInitScript(PAGE_SETUP, plan)

  return {
    respond: (channel, data) =>
      page.evaluate((payload) => {
        const bridge = (window as unknown as { __qa?: QaBridge }).__qa
        if (!bridge) throw new Error('Tauri stub 尚未安装：Node 侧 API 需在 page.goto 之后调用')
        bridge.respond(payload.channel, payload.data)
      }, { channel, data }),
    respondRaw: (name, data) =>
      page.evaluate((payload) => {
        const bridge = (window as unknown as { __qa?: QaBridge }).__qa
        if (!bridge) throw new Error('Tauri stub 尚未安装：Node 侧 API 需在 page.goto 之后调用')
        bridge.respondRaw(payload.name, payload.data)
      }, { name, data }),
    hold: (channel) =>
      page.evaluate((c) => {
        const bridge = (window as unknown as { __qa?: QaBridge }).__qa
        if (!bridge) throw new Error('Tauri stub 尚未安装：Node 侧 API 需在 page.goto 之后调用')
        return bridge.hold(c)
      }, channel),
    release: (index, data) =>
      page.evaluate((payload) => {
        const bridge = (window as unknown as { __qa?: QaBridge }).__qa
        if (!bridge) throw new Error('Tauri stub 尚未安装：Node 侧 API 需在 page.goto 之后调用')
        bridge.release(payload.index, payload.data)
      }, { index, data }),
    fail: (index, message) =>
      page.evaluate((payload) => {
        const bridge = (window as unknown as { __qa?: QaBridge }).__qa
        if (!bridge) throw new Error('Tauri stub 尚未安装：Node 侧 API 需在 page.goto 之后调用')
        bridge.fail(payload.index, payload.message)
      }, { index, message }),
    resetCalls: () =>
      page.evaluate(() => {
        const bridge = (window as unknown as { __qa?: QaBridge }).__qa
        if (!bridge) throw new Error('Tauri stub 尚未安装：Node 侧 API 需在 page.goto 之后调用')
        bridge.resetCalls()
      }),
    callCount: (channel) =>
      page.evaluate(
        (name) => {
          const bridge = (window as unknown as { __qa?: QaBridge }).__qa
          return bridge ? bridge.log.filter((c) => c.channel === name).length : 0
        },
        toCommandName(channel),
      ),
    payloads: (channel) =>
      page.evaluate(
        (name) => {
          const bridge = (window as unknown as { __qa?: QaBridge }).__qa
          return bridge ? bridge.log.filter((c) => c.channel === name).map((c) => c.payload) : []
        },
        toCommandName(channel),
      ),
    stableCount: async (channel, samples = 3, intervalMs = 100) => {
      const name = toCommandName(channel)
      let last = -1
      let stable = 0
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const n = await page.evaluate(
          (cmd) => {
            const bridge = (window as unknown as { __qa?: QaBridge }).__qa
            return bridge ? bridge.log.filter((c) => c.channel === cmd).length : 0
          },
          name,
        )
        if (n === last) {
          stable += 1
          if (stable >= samples) return n
        } else {
          stable = 0
          last = n
        }
        await page.waitForTimeout(intervalMs)
      }
      return last
    },
  }
}
