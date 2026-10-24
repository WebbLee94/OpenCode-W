/**
 * 下载进度跟踪
 *
 * tauri-plugin-updater 的 `downloadAndInstall(onEvent)` 会推送三种事件：
 *   - Started  { contentLength }  总长度（可能缺失）
 *   - Progress { chunkLength }    本次收到的分片长度
 *   - Finished
 *
 * 旧实现没有传 onEvent，进度是硬编码的 0 → 50 → 100，属于**假进度**。
 * 这里把事件累加换算成真实进度；拿不到 Content-Length 时 percent 保持 0，
 * UI 只展示已下载字节数，不展示百分比。
 */
import type { DownloadEvent } from '@tauri-apps/plugin-updater'
import type { UpdateProgress } from '@shared/types'

export interface DownloadProgressTracker {
  /** 传给 update.downloadAndInstall(onEvent) */
  handleEvent: (event: DownloadEvent) => void
  /** 当前进度快照 */
  snapshot: () => UpdateProgress
}

export function createDownloadProgressTracker(startedAt: number = Date.now()): DownloadProgressTracker {
  let transferred = 0
  let total = 0
  let finished = false

  return {
    handleEvent(event: DownloadEvent) {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0
        transferred = 0
        finished = false
      } else if (event.event === 'Progress') {
        transferred += event.data.chunkLength
      } else {
        finished = true
        // 没有 Content-Length 时，用实际收到的字节数兜底
        if (total === 0) total = transferred
      }
    },
    snapshot(): UpdateProgress {
      const elapsed = Math.max(1, Date.now() - startedAt) / 1000
      const percent = finished
        ? 100
        : (total > 0 ? Math.min(100, (transferred / total) * 100) : 0)
      return {
        bytesPerSecond: transferred / elapsed,
        percent,
        transferred,
        total,
      }
    },
  }
}
