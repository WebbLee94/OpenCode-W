import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

export default function StepStartBubble({ part }: { part: PartDTO }) {
  return (
    <PartBubbleShell
      icon="▶"
      title={part.stepSnapshot || part.summary || 'Step Start'}
      meta="开始新步骤"
      variant="action"
      collapsible={false}
    />
  )
}
