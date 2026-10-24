/**
 * 下载进度单测 —— 锁定「真实进度」而不是硬编码的 0 → 50 → 100。
 */
import { describe, it, expect } from 'vitest'
import type { DownloadEvent } from '@tauri-apps/plugin-updater'
import { createDownloadProgressTracker } from './downloadProgress'

describe('createDownloadProgressTracker', () => {
  it('Started 事件记录总长度', () => {
    const tracker = createDownloadProgressTracker()
    tracker.handleEvent({ event: 'Started', data: { contentLength: 1000 } })
    expect(tracker.snapshot().total).toBe(1000)
    expect(tracker.snapshot().transferred).toBe(0)
    expect(tracker.snapshot().percent).toBe(0)
  })

  it('Progress 事件累加分片长度并换算百分比', () => {
    const tracker = createDownloadProgressTracker()
    tracker.handleEvent({ event: 'Started', data: { contentLength: 1000 } })
    tracker.handleEvent({ event: 'Progress', data: { chunkLength: 250 } })
    expect(tracker.snapshot().transferred).toBe(250)
    expect(tracker.snapshot().percent).toBe(25)

    tracker.handleEvent({ event: 'Progress', data: { chunkLength: 250 } })
    expect(tracker.snapshot().transferred).toBe(500)
    expect(tracker.snapshot().percent).toBe(50)
  })

  it('没有 Content-Length 时不编造百分比（保持 0，UI 只显示字节数）', () => {
    const tracker = createDownloadProgressTracker()
    tracker.handleEvent({ event: 'Started', data: {} })
    tracker.handleEvent({ event: 'Progress', data: { chunkLength: 512 } })
    const snap = tracker.snapshot()
    expect(snap.total).toBe(0)
    expect(snap.percent).toBe(0)
    expect(snap.transferred).toBe(512)
  })

  it('Finished 事件后进度为 100%', () => {
    const tracker = createDownloadProgressTracker()
    tracker.handleEvent({ event: 'Started', data: { contentLength: 1000 } })
    tracker.handleEvent({ event: 'Progress', data: { chunkLength: 1000 } })
    tracker.handleEvent({ event: 'Finished' })
    expect(tracker.snapshot().percent).toBe(100)
  })

  it('Finished 时缺少总长度，用实际字节数兜底', () => {
    const tracker = createDownloadProgressTracker()
    tracker.handleEvent({ event: 'Started', data: {} })
    tracker.handleEvent({ event: 'Progress', data: { chunkLength: 800 } })
    tracker.handleEvent({ event: 'Finished' })
    const snap = tracker.snapshot()
    expect(snap.total).toBe(800)
    expect(snap.percent).toBe(100)
  })

  it('进度不会超过 100%', () => {
    const tracker = createDownloadProgressTracker()
    tracker.handleEvent({ event: 'Started', data: { contentLength: 100 } })
    tracker.handleEvent({ event: 'Progress', data: { chunkLength: 500 } })
    expect(tracker.snapshot().percent).toBe(100)
  })

  it('事件类型与插件一致', () => {
    const tracker = createDownloadProgressTracker()
    const events: DownloadEvent[] = [
      { event: 'Started', data: { contentLength: 10 } },
      { event: 'Progress', data: { chunkLength: 10 } },
      { event: 'Finished' },
    ]
    for (const e of events) tracker.handleEvent(e)
    expect(tracker.snapshot().percent).toBe(100)
  })
})
