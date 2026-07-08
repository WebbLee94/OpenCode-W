import { test, type Page } from '@playwright/test'

/**
 * 控制台错误巡检
 *
 * 目的：在纯浏览器（非 Tauri webview）中跑 vite dev，遍历主要路由，
 * 收集 console.error 与未捕获异常，确保前端在「无 Tauri 环境」下
 * 不会抛出未处理错误。
 *
 * 背景：渲染进程通过 window.__TAURI__ 调用 IPC（见 src/lib/ipc.ts）。
 * isTauri() 守卫已覆盖大部分路径，但任何遗漏的 invoke 都会在此暴露。
 */

interface CollectedErrors {
  consoleErrors: string[]
  pageErrors: string[]
}

function attachErrorCollectors(page: Page): CollectedErrors {
  const errors: CollectedErrors = { consoleErrors: [], pageErrors: [] }

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.consoleErrors.push(msg.text())
    }
  })
  page.on('pageerror', (err) => {
    errors.pageErrors.push(`${err.name}: ${err.message}\n${err.stack ?? ''}`)
  })

  return errors
}

function assertNoErrors(errors: CollectedErrors, route: string) {
  const { consoleErrors, pageErrors } = errors
  const hasErrors = consoleErrors.length > 0 || pageErrors.length > 0

  if (hasErrors) {
    const detail = [
      `路由: ${route}`,
      consoleErrors.length > 0
        ? `--- console.error (${consoleErrors.length}) ---\n${consoleErrors.join('\n')}`
        : null,
      pageErrors.length > 0
        ? `--- pageerror (${pageErrors.length}) ---\n${pageErrors.join('\n\n')}`
        : null,
    ]
      .filter(Boolean)
      .join('\n')
    throw new Error(`检测到控制台错误\n${detail}`)
  }
}

// 主要路由清单（HashRouter → URL 用 #）
const ROUTES = [
  { name: '首页/Dashboard', hash: '#/' },
  { name: '会话浏览', hash: '#/sessions' },
  { name: '清理向导', hash: '#/cleanup' },
  { name: '备份恢复', hash: '#/backup' },
  { name: '设置', hash: '#/settings' },
]

for (const route of ROUTES) {
  test(`无控制台错误: ${route.name}`, async ({ page }) => {
    const errors = attachErrorCollectors(page)

    await page.goto(`/${route.hash}`)
    // 等待 React 挂载 + 任何初始化 IPC 触发
    await page.waitForLoadState('networkidle')
    // 给微任务/异步错误一点缓冲
    await page.waitForTimeout(500)

    assertNoErrors(errors, route.hash)
  })
}
