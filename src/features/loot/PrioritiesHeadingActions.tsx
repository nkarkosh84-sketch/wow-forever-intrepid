import { BookOpen, Copy, History, Plus, Receipt } from 'lucide-react'
import { phaseNoOf } from '../../shared/game/phases'
import type { TabContext } from '../../shared/tabs/types'
import { AuditLogModal } from './AuditLogModal'
import { CarryOverModal } from './CarryOverModal'
import { PhasePicker } from './PhasePicker'
import { DropsModal } from './DropsModal'
import { ManualAwardModal } from './ManualAwardModal'
import { RecentAwardsModal } from './RecentAwardsModal'
import { usePhaseView } from './usePhaseView'

// Recent awards shows on the same terms as Record loot (canAward: a leader looking at the current phase; the VIEW AS preview takes the role away).
export function PrioritiesHeadingActions({ ctx }: { ctx: TabContext }) {
  const { view, canEdit, canAward } = usePhaseView(ctx)
  return <><PhasePicker ctx={ctx} />{canAward && <button className="button button-secondary" onClick={() => ctx.openModal(({ close, live }) => <ManualAwardModal close={close} live={live} />)}><Plus size={16} /> Record loot</button>}{canAward && <button className="button button-secondary" onClick={() => ctx.openModal(({ close, live }) => <RecentAwardsModal close={close} live={live} />)}><Receipt size={16} /> Recent awards</button>}<button className="button button-secondary" onClick={() => ctx.openModal(({ close, live }) => <DropsModal phase={view} close={close} live={live} />)}><BookOpen size={16} /> Browse drops</button>{canEdit && ctx.data.allPriorities.some((priority) => phaseNoOf(priority) < view.no) && <button className="button button-secondary" onClick={() => ctx.openModal(({ close, live }) => <CarryOverModal target={view} close={close} live={live} />)}><Copy size={16} /> Carry over</button>}<button className="button button-secondary" onClick={() => ctx.openModal(({ close, live }) => <AuditLogModal close={close} live={live} />)}><History size={16} /> Log</button></>
}
