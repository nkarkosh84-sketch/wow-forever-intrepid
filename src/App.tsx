import { useEffect, useState } from 'react'
import { Shield } from 'lucide-react'
import { canManageRaidData, canManageRoster, type GuildRole } from './security'
import { useGuildData } from './useGuildData'
import { useGuildSession } from './useGuildSession'
import { AccessScreen } from './AccessScreen'
import { isRemovedAward } from './shared/game/completion'
import type { RaidView } from './shared/game/teams'
import type { ModalRenderer, TabContext } from './shared/tabs/types'
import { ErrorBoundary } from './shared/ui/ErrorBoundary'
import { ModalHost, type ActiveModal } from './shell/ModalHost'
import { PageHeading } from './shell/PageHeading'
import { Sidebar } from './shell/Sidebar'
import { StatStrip } from './shell/StatStrip'
import { Topbar } from './shell/Topbar'
import { WorkspacePanel } from './shell/WorkspacePanel'
import { DEFAULT_TAB_ID, FALLBACK_TAB_ID, isTabVisible, tabList, type TabId } from './shell/tabs'
import './App.css'

function App() {
  const session = useGuildSession()
  const actualRole = session.membership?.role === 'Removed' ? null : session.membership?.role ?? null
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return localStorage.getItem('intrepid-theme') === 'dark' ? 'dark' : 'light'
    } catch {
      return 'light'
    }
  })
  const [selectedTab, setActiveTab] = useState<TabId>(DEFAULT_TAB_ID)
  const [raidView, setRaidView] = useState<RaidView>(10)
  const [query, setQuery] = useState('')
  const [navParam, setNavParam] = useState<string | undefined>()
  const [modal, setModal] = useState<ActiveModal | null>(null)
  const [impersonatedRole, setImpersonatedRole] = useState<GuildRole | null>(null)
  const [mutationError, setMutationError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [previousStatus, setPreviousStatus] = useState(session.status)
  const data = useGuildData(session.status === 'active', actualRole, session.user?.uid ?? '')
  const { roster, priorities, awards, dataError } = data
  const effectiveRole = actualRole === 'Guild Leader' ? impersonatedRole ?? actualRole : actualRole
  const selectedDef = tabList.find((entry) => entry.id === selectedTab) ?? tabList[0]
  const tab = isTabVisible(selectedDef, effectiveRole) ? selectedDef : tabList.find((entry) => entry.id === FALLBACK_TAB_ID) ?? tabList[0]
  const canEditRoster = effectiveRole ? canManageRoster(effectiveRole) : false
  const canEditRaidData = effectiveRole ? canManageRaidData(effectiveRole) : false

  if (previousStatus !== session.status) {
    setPreviousStatus(session.status)
    if (session.status !== 'active') {
      setModal(null)
      setImpersonatedRole(null)
      setMutationError('')
      setNotice('')
    }
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('intrepid-theme', theme)
    } catch {
      // Storage can be blocked (private window, site data disabled): the theme still applies for this visit.
    }
  }, [theme])

  useEffect(() => {
    function focusSearch(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        document.getElementById('table-search')?.focus()
      }
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])

  function openModal(render: ModalRenderer) {
    setModal((current) => ({ render, key: (current?.key ?? 0) + 1 }))
  }

  function navigate(id: string, param?: string) {
    const target = tabList.find((entry) => entry.id === id)
    if (target) {
      setActiveTab(target.id)
      setNavParam(param)
    } else if (import.meta.env.DEV) console.warn(`navigate: unknown tab id "${id}"`)
  }

  if (session.status !== 'active' || !session.membership) {
    return <AccessScreen status={session.status} user={session.user} error={session.error} setError={session.setError} offline={session.offline} onRetry={session.retry} theme={theme} onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} />
  }

  const ctx: TabContext = {
    data,
    query,
    identity: { uid: session.user?.uid ?? '', displayName: session.membership.displayName, canEditRoster, canEditRaidData },
    shell: { raidView, setRaidView },
    feedback: { busy, setBusy, setMutationError, setNotice },
    openModal,
    navigate,
    navParam,
  }

  return (
    <div className="app-shell">
      <Sidebar tabs={tabList} activeId={tab.id} effectiveRole={effectiveRole} ctx={ctx} onSelect={(id) => { setActiveTab(id); setNavParam(undefined); setQuery('') }} />

      <main className="main-content" id="top">
        <Topbar title={tab.label} actualRole={actualRole} effectiveRole={effectiveRole} impersonatedRole={impersonatedRole} onImpersonate={setImpersonatedRole} email={session.user?.email ?? ''} displayName={session.membership.displayName} theme={theme} onToggleTheme={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} />
        <div className="page-wrap">
          <PageHeading tab={tab} ctx={ctx} />

          <StatStrip roster={roster.length} priorities={priorities.length} awards={awards.filter((award) => !isRemovedAward(award)).length} councilStatus={data.settings.councilStatus} />

          <ErrorBoundary kind="panel" resetKey={tab.id}><WorkspacePanel tab={tab} ctx={ctx} setQuery={setQuery} error={mutationError || dataError} notice={notice} unreadable={effectiveRole === 'Guild Leader' ? data.unreadable : 0} /></ErrorBoundary>
          <p className="preview-note"><Shield size={14} /> Guild data is shared with authorized guild accounts and protected by Firestore rules.</p>
        </div>
      </main>

      <ErrorBoundary kind="dialog" resetKey={modal?.key ?? 0} onClose={() => setModal(null)}><ModalHost modal={modal} close={() => setModal(null)} live={ctx} /></ErrorBoundary>
    </div>
  )
}

export default App
