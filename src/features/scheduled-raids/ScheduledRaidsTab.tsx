import { useEffect, useState } from 'react'
import { raidTimeOf } from '../../guildApi'
import type { TabContext } from '../../shared/tabs/types'
import './ScheduledRaids.css'
import { isClosedRaid, listedRaids, nextChangeAfter, raidRowId } from './groupRaids'
import { RaidRow } from './RaidRow'

const MINUTE = 60_000

export function ScheduledRaidsTab({ ctx }: { ctx: TabContext }) {
  const [now, setNow] = useState(Date.now)
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set())
  const [seenParam, setSeenParam] = useState<string | undefined>()
  const loaded = ctx.data.raidPlanningLoaded
  const raids = [...ctx.data.raids].sort((a, b) => a.date.localeCompare(b.date) || raidTimeOf(a).localeCompare(raidTimeOf(b)) || a.id.localeCompare(b.id))
  const listed = listedRaids(raids, now)
  const nextChange = nextChangeAfter(raids, now)
  // The clock only has to move when a raid starts (its row then says so and goes read-only) or leaves the list, so wait for that moment rather than re-rendering every open row
  // each second.
  useEffect(() => {
    const wait = nextChange === undefined ? MINUTE : Math.min(MINUTE, Math.max(nextChange - Date.now() + 250, 250))
    const timer = window.setTimeout(() => setNow(Date.now()), wait)
    return () => window.clearTimeout(timer)
  }, [now, nextChange])
  // A raid named by the navigation (the sign-up dialog's "Open Scheduled Raids") opens its row. An id that matches no raid opens nothing.
  if (loaded && ctx.navParam !== seenParam) {
    setSeenParam(ctx.navParam)
    const target = ctx.navParam === undefined ? undefined : listed.find((raid) => raid.id === ctx.navParam)
    if (target) setOpenIds((current) => new Set(current).add(target.id))
  }
  useEffect(() => {
    if (loaded && ctx.navParam) document.getElementById(raidRowId(ctx.navParam))?.scrollIntoView({ block: 'start' })
  }, [loaded, ctx.navParam])
  if (ctx.data.dataError) return <p role="alert">Scheduled raids could not be loaded: {ctx.data.dataError}. Reload to retry.</p>
  if (!loaded) return <p role="status">Loading scheduled raids...</p>
  if (ctx.data.unreadable) return <p role="alert">Some guild records are unreadable. Correct them before viewing scheduled raids.</p>
  const toggle = (raidId: string, open: boolean) => setOpenIds((current) => {
    if (current.has(raidId) === open) return current
    const next = new Set(current)
    if (open) next.add(raidId)
    else next.delete(raidId)
    return next
  })
  // A link to a raid that is no longer listed (it started more than 5 hours ago) says where its record is, rather than showing a list with nothing opened.
  const gone = ctx.navParam !== undefined && raids.some((raid) => raid.id === ctx.navParam) && !listed.some((raid) => raid.id === ctx.navParam)
  return <div className="scheduled-raids-tool">
    {gone && <p role="status" className="scheduled-raids-gone">That raid is no longer in Scheduled Raids, which keeps a raid until 5 hours after it starts. Its record is in Raid History. <button className="button button-secondary" onClick={() => ctx.navigate('raid-history')}>Open Raid History</button></p>}
    {listed.length
      ? <div className="scheduled-raids-list">{listed.map((raid) => <RaidRow key={raid.id} raid={raid} ctx={ctx} now={now} closed={isClosedRaid(raid, now)} open={openIds.has(raid.id)} onToggle={toggle} />)}</div>
      : <p>No scheduled raids right now. A raid is listed from the moment it is scheduled until 5 hours after it starts; Raid History keeps the rest. <button className="button button-secondary" onClick={() => ctx.navigate('afk')}>Open Guild Calendar</button></p>}
  </div>
}
