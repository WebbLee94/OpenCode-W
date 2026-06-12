import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

export default function PatchBubble({ part }: { part: PartDTO }) {
  const fileCount = part.patchFiles?.length ?? 0
  return (
    <PartBubbleShell
      icon="📝"
      title={`Patch: ${fileCount} 个文件`}
      meta={part.patchHash?.slice(0, 12)}
      variant="change"
    >
      {part.patchFiles && part.patchFiles.length > 0 && (
        <ul className="text-xs space-y-0.5">
          {part.patchFiles.map((f, i) => (
            <li key={i} className="text-gray-700 truncate">
              · {f}
            </li>
          ))}
        </ul>
      )}
    </PartBubbleShell>
  )
}
