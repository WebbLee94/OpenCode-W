import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

export default function CompactionBubble({ part }: { part: PartDTO }) {
  const isAuto = part.compactionAuto === true
  const isOverflow = part.compactionOverflow === true
  return (
    <PartBubbleShell
      icon="🗜"
      title={isAuto ? '自动上下文压缩' : '手动上下文压缩'}
      meta={isOverflow ? '溢出' : '正常'}
      variant="event"
      collapsible={false}
    />
  )
}
