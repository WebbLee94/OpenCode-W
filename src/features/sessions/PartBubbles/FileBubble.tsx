import type { PartDTO } from '../../../../shared/types'
import PartBubbleShell from './PartBubbleShell'

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']

export default function FileBubble({ part }: { part: PartDTO }) {
  if (!part.fileUrl) return null
  const mime = part.fileMime || ''
  const isImage = IMAGE_MIMES.includes(mime)
  const fileName = part.fileName || part.fileUrl.split('/').pop() || 'file'

  return (
    <PartBubbleShell
      icon={isImage ? '🖼' : '📎'}
      title={fileName}
      meta={part.fileMime}
      variant="attach"
    >
      {isImage ? (
        <img src={part.fileUrl} alt={part.fileName} className="max-w-full max-h-96 rounded" />
      ) : (
        <div className="text-xs">
          <a
            href={part.fileUrl}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline break-all"
          >
            {part.fileUrl}
          </a>
          {part.fileSource && (
            <div className="text-gray-500 mt-1">
              来源: {part.fileSource.type}
              {part.fileSource.path && ` · ${part.fileSource.path}`}
            </div>
          )}
        </div>
      )}
    </PartBubbleShell>
  )
}
