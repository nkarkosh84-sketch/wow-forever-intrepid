import { useState } from 'react'
import type { TabContext } from '../../shared/tabs/types'
import { AllRaidsTab } from './AllRaidsTab'
import { AuditInfoTab } from './AuditInfoTab'
import './RaidHistory.css'

// Two sections. All raids (RAID-019) is the one shown first; Audit Info is the published start snapshots, as before. Both stay mounted and the other is hidden, so Audit
// Info loads its snapshots when the tab opens, exactly as it did, and keeps its selection and what it has read when the viewer switches back. All raids is added after
// Audit Info, so no existing element changes position.
type Section = 'audit' | 'raids'

export function RaidHistoryTab({ ctx }: { ctx: TabContext }) {
  const [section, setSection] = useState<Section>('raids')
  const tabClass = (id: Section) => section === id ? 'raid-history-subtab selected' : 'raid-history-subtab'
  return <div className="raid-history-feature">
    <nav className="raid-history-subtabs" role="tablist" aria-label="Raid history sections">
      <button type="button" className={tabClass('audit')} role="tab" id="raid-history-audit-tab" aria-selected={section === 'audit'} aria-controls="raid-history-audit-panel" onClick={() => setSection('audit')}>Audit Info</button>
      <button type="button" className={tabClass('raids')} role="tab" id="raid-history-raids-tab" aria-selected={section === 'raids'} aria-controls="raid-history-raids-panel" onClick={() => setSection('raids')}>All raids</button>
    </nav>
    <section id="raid-history-audit-panel" role="tabpanel" aria-labelledby="raid-history-audit-tab" hidden={section !== 'audit'}>
      <AuditInfoTab ctx={ctx} />
    </section>
    <section id="raid-history-raids-panel" role="tabpanel" aria-labelledby="raid-history-raids-tab" hidden={section !== 'raids'}>
      <AllRaidsTab ctx={ctx} />
    </section>
  </div>
}
