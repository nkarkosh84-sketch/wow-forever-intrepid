import { Timestamp } from 'firebase/firestore'

export const readinessChecks = [
  { key: 'level60', label: 'Reached level 60' },
  { key: 'raidRequirements', label: 'Completed the required raid keys and attunements' },
  { key: 'gear', label: 'I have pre-raid best-in-slot gear, or have spent serious time (multiple hours) working to gear', preparation: true },
  { key: 'professions', label: 'I have made progress in professions that advance my character (300 is not required)', preparation: true },
  { key: 'talentsAndAbilities', label: 'Appropriately talented and have all abilities trained to maximum ranks', preparation: true },
  { key: 'enchants', label: 'I will keep my gear enchanted', acknowledgment: true },
  { key: 'rotation', label: 'I understand my rotation and am comfortable with all abilities in my toolkit', acknowledgment: true },
  { key: 'consumables', label: 'I understand my consumables and will have them ready', acknowledgment: true },
  { key: 'raidKnowledge', label: 'I understand the current raids and make an effort to learn the fights and zones', acknowledgment: true },
] as const

export type ReadinessCheck = typeof readinessChecks[number]['key']
export type ReadinessChecklist = Record<ReadinessCheck, boolean>
export type CharacterReadiness = { id: string; ready: boolean; checklist: ReadinessChecklist | null; updatedBy: string; updatedAt: Timestamp }

export function emptyReadinessChecklist(): ReadinessChecklist {
  return { level60: false, raidRequirements: false, gear: false, enchants: false, professions: false, talentsAndAbilities: false, rotation: false, consumables: false, raidKnowledge: false }
}

export function isReadinessChecklist(value: unknown): value is ReadinessChecklist {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === readinessChecks.length
    && readinessChecks.every(({ key }) => key in value && typeof Reflect.get(value, key) === 'boolean')
}

export function readinessProgress(checklist: ReadinessChecklist) {
  const completed = readinessChecks.filter(({ key }) => checklist[key]).length
  const total = readinessChecks.length
  return { completed, total, percent: Math.round(completed / total * 100), ready: completed === total }
}

export function normalizeReadiness(id: string, data: Record<string, unknown>): CharacterReadiness | null {
  if (typeof data.ready !== 'boolean' || typeof data.updatedBy !== 'string' || !data.updatedBy || !(data.updatedAt instanceof Timestamp)) return null
  if (data.schemaVersion === undefined && data.checklist === undefined) {
    return { id, ready: false, checklist: null, updatedBy: data.updatedBy, updatedAt: data.updatedAt }
  }
  if (data.schemaVersion !== 1 || !isReadinessChecklist(data.checklist) || data.ready !== readinessProgress(data.checklist).ready) return null
  return { id, ready: data.ready, checklist: data.checklist, updatedBy: data.updatedBy, updatedAt: data.updatedAt }
}
