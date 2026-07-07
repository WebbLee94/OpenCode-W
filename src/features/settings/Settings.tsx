import PageHeader from '@/components/PageHeader'
import { Settings as SettingsIcon } from 'lucide-react'
import { UpdateSection } from './UpdateSection'
import { DataSourceSection } from './DataSourceSection'

export default function Settings() {
  return (
    <div className="p-6 h-full flex flex-col">
      <PageHeader
        icon={<SettingsIcon size={24} />}
        title="设置"
      />
      <div className="space-y-4">
        <DataSourceSection />
        <UpdateSection />
      </div>
    </div>
  )
}
