import PageHeader from '@/components/PageHeader'
import { Settings as SettingsIcon } from 'lucide-react'
import { UpdateSection } from './UpdateSection'

export default function Settings() {
  return (
    <div className="p-6 max-w-3xl mx-auto">
      <PageHeader
        icon={<SettingsIcon size={24} />}
        title="设置"
        description="配置 OpenCode-W 的应用行为"
      />
      <div className="space-y-4">
        <UpdateSection />
      </div>
    </div>
  )
}
