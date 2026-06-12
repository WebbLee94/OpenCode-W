import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

type Tokens = NonNullable<PartDTO['tokens']>

function getCacheRead(tokens: Tokens): number {
  return tokens.cache_read ?? 0
}

function getCacheWrite(tokens: Tokens): number {
  return tokens.cache_write ?? 0
}

export default function StepFinishBubble({ part }: { part: PartDTO }) {
  if (!part.tokens && part.cost === undefined) return null

  const items: string[] = []
  if (part.tokens) {
    const input = part.tokens.input ?? 0
    const output = part.tokens.output ?? 0
    const reasoning = part.tokens.reasoning ?? 0
    const cacheRead = getCacheRead(part.tokens)
    const cacheWrite = getCacheWrite(part.tokens)

    if (input) items.push(`${input.toLocaleString()} in`)
    if (output) items.push(`${output.toLocaleString()} out`)
    if (reasoning) items.push(`${reasoning.toLocaleString()} reasoning`)
    if (cacheRead) items.push(`${cacheRead.toLocaleString()} cache_read`)
    if (cacheWrite) items.push(`${cacheWrite.toLocaleString()} cache_write`)
  }

  return (
    <PartBubbleShell
      icon="🏁"
      title={`Step finished: ${part.reason || 'completed'}`}
      meta={part.cost !== undefined ? `$${part.cost.toFixed(4)}` : undefined}
      variant="action"
      collapsible={items.length > 0}
      defaultExpanded={true}
    >
      {items.length > 0 && (
        <div className="text-xs text-gray-700">Token: {items.join(' / ')}</div>
      )}
    </PartBubbleShell>
  )
}
