import { HelpCircle } from 'lucide-react'

interface TooltipHintProps {
  text: string
}

function TooltipHint({ text }: TooltipHintProps) {
  return (
    <span className="relative group inline-flex items-center ml-1">
      <HelpCircle size={14} className="text-gray-400 cursor-help" />
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-gray-800 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-pre-line z-50 w-64 text-center shadow-lg">
        {text}
        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-800 rotate-45" />
      </div>
    </span>
  )
}

export default TooltipHint
