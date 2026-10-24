import {
  collection,
  deleteField,
  deleteDoc,
  doc,
  FieldPath,
  getDoc,
  getDocFromServer,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  where,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  Timestamp,
  type Firestore,
} from 'firebase/firestore'
import { deleteObject, getDownloadURL, getMetadata, listAll, ref as storageRef, uploadBytes, type StorageReference } from 'firebase/storage'
import { auth, db, functions, guildId, storage, storageBucket } from './firebase'
import { httpsCallable } from 'firebase/functions'
import type { GuildRole } from './security'
import { nextPhaseRev } from './shared/game/phases'
import type { TableWrite } from './shared/game/guildTables'
import { isHexColor, isZoneKey } from './shared/game/zoneColors'
import { EMPTY_ZONE_ART, ZONE_IMAGE_LIMIT, fullPath, isImageName, newImageId, readZoneArt, thumbPath, zonesUsing, type ZoneArt, type ZoneImage } from './shared/game/zoneArt'
import { awardCreateFields, awardEditFields, describeCreate, describeDelete, describeEdit, phaseAuditFields, priorityAuditFields, readAuditEntry, tableAuditFields, type AuditEntry } from './shared/game/lootAudit'
import { normalizeDocs, type Normalizer } from './shared/lib/normalize'
import { raidStartDate } from './shared/lib/raidStart'
import { sameRaidZones } from './shared/raids/zoneSnapshots'
import { setMembershipRemoved as writeMembershipRemoved } from './shared/members/access'
import { normalizeCharacterRequest, type CharacterProposal, type CharacterRequest } from './shared/characters/requests'
export type { PlayerRecord } from './shared/game/players'

export type TenManTeam = 'blue' | 'yellow' | 'red' | 'white'
export type RaidGroup = 'green' | 'pink' | 'brown'
export type StandingTeam = TenManTeam | RaidGroup
// itemId, zoneId and npcId are set when a priority was added from the drop lists (Browse drops): the Wowhead item id, the dungeon
// in data/loot and the creature that drops it. A priority typed by hand has none of them.
// phaseNo is the phase the priority belongs to (see shared/game/phases.ts); none means the first phase. carriedFrom is the id of the
// priority an item was carried over from, in an earlier phase. rankedIds says what each of the rankedPlayers lines is (a roster id, '' for an
// open note, '!' for a finished one); a priority written before roster ids has none (see shared/game/candidates.ts).
export type PriorityRecord = { id: string; item: string; encounter: string; rankedPlayers: string[]; rankedIds?: string[]; councilNote: string; itemId?: number; zoneId?: number; npcId?: number; phaseNo?: number; carriedFrom?: string; rev?: number; hidden?: true }
export type AwardRecord = {
  id: string
  priorityId: string
  item: string
  encounter: string
  recipient: string
  // The roster character who received it; an award made before roster ids has only the name.
  recipientId?: string
  awardedAt: string
  prioritySnapshot: string[]
  // What each line of prioritySnapshot was (see PriorityRecord.rankedIds); none on an award made before roster ids.
  prioritySnapshotIds?: string[]
  councilNoteSnapshot: string
  awardNote: string
  // The phase the award was recorded in; none means the first phase.
  phaseNo?: number
  // Awards made since the Log began have a revision (1 or more); one without is older and has no entry in the Log.
  rev?: number
  // Who recorded it, and when (server time); none on an award from before the Log began (they stay none after a fix, so such an award can still be told).
  createdBy?: string
  createdAt?: unknown
  // How a manual award (no priority) was decided.
  decision?: AwardDecision
  // A removed award is kept, marked, with the reason (never deleted): it stops counting everywhere and stays in the Log. None means active.
  status?: AwardStatus
  removedReason?: string
}
export type AwardStatus = 'active' | 'removed'
export type AwardDecision = 'roll' | 'council' | 'other'
export type AfkEntryRecord = { id: string; userId: string; displayName: string; startDate: string; endDate: string; createdAt?: unknown }
export type CommentKind = 'public' | 'leadership'
export const COMMENT_MAX_LENGTH = 300
export type RaiderType = 'casual' | 'hardcore'
export type RaidStatus = 'scheduled' | 'cancelled'
export type RaidSize = 10 | 20 | 40
export type RaidZoneRecord = { id: string; name: string; size: RaidSize }
export type RaidRecord = {
  id: string
  date: string
  time?: string
  startsAt?: Timestamp
  name: string
  size: 10 | 20 | 40
  zones?: RaidZoneRecord[]
  description?: string
  createdBy: string
  createdAt?: unknown
  rev?: number
  status?: RaidStatus
  cancelReason?: string
}
export type RaidEdit = Partial<Pick<RaidRecord, 'name' | 'date' | 'time' | 'size' | 'description' | 'zones'>>
export type MembershipRole = GuildRole | 'Removed'
export type MembershipRecord = { id: string; email: string; displayName: string; role: MembershipRole; playerId?: string | null }
export type JoinRequestRecord = { id: string; userId: string; email: string; displayName: string; status: 'pending' | 'approved' | 'rejected' }
export type TeamAssignmentRecord = { id: string; team: TenManTeam }
export type StatusTone = 'active' | 'preparing' | 'paused'
export type CouncilStatus = 'deliberating' | 'live'
export type GuildSettings = {
  currentPhase: string
  nextPhase: string
  currentStatusLabel: string
  currentStatusTone: StatusTone
  nextStatusLabel: string
  nextStatusTone: StatusTone
  councilStatus: CouncilStatus
  teamNames: Record<TenManTeam, string>
  groupNames: Record<RaidGroup, string>
  // The names of the finished phases, oldest first. Its length is the number of the current phase. Absent until a phase has been closed.
  phaseHistory?: string[]
  // How many times a phase has been started or reopened (each one is in the Log). Absent until the first.
  phaseRev?: number
}
export type GuildSettingsRecord = GuildSettings & { id: string }

function requireDb(): Firestore {
  if (!db || !guildId) throw new Error('Firebase is not configured for this guild.')
  return db
}

function guildCollection(name: string) {
  return collection(requireDb(), 'guilds', guildId, name)
}

// `normalize` (see shared/lib/normalize.ts) checks each document's shape and may drop it; without one a
// document is read as `{ ...data, id }`. `dropped` is how many documents in this snapshot were skipped.
export function subscribeGuildCollection<T extends { id: string }>(
  name: string,
  onData: (records: T[], dropped: number) => void,
  onError: (error: Error) => void,
  normalize: Normalizer<T> = (id, data) => ({ ...data, id }) as T,
  confirmedOnly = false,
) {
  return onSnapshot(guildCollection(name), { includeMetadataChanges: confirmedOnly }, (snapshot) => {
    if (confirmedOnly && snapshot.metadata.hasPendingWrites) return
    const { records, droppedIds } = normalizeDocs(snapshot.docs, normalize)
    if (droppedIds.length) console.warn(`${name}: skipped ${droppedIds.length} unreadable document(s), ids: ${droppedIds.join(', ')}`)
    onData(records, droppedIds.length)
  }, onError)
}

export function subscribeCharacterRequests(uid: string, leader: boolean, onData: (records: CharacterRequest[]) => void, onError: (error: Error) => void) {
  const records = guildCollection('characterRequests')
  return onSnapshot(leader ? records : query(records, where('userId', '==', uid)), (snapshot) => {
    const { records, droppedIds } = normalizeDocs(snapshot.docs, normalizeCharacterRequest)
    if (droppedIds.length) {
      console.error(`characterRequests: unreadable document(s): ${droppedIds.join(', ')}`)
      onError(new Error('Some character requests could not be read. Ask a Guild Leader to check the records.'))
    }
    onData(records.sort((a, b) => b.requestedAt.toMillis() - a.requestedAt.toMillis() || a.id.localeCompare(b.id)))
  }, onError)
}

export async function submitCharacterRequest(requestId: string, proposal: CharacterProposal, note: string) {
  if (!functions || !auth?.currentUser) throw new Error('Sign in to request a character change.')
  await httpsCallable(functions, 'submitCharacterRequest')({ guildId, requestId, ...proposal, note })
}

export async function setCharacterReadiness(characterId: string, ready: boolean) {
  if (!auth?.currentUser) throw new Error('Sign in to update raid readiness.')
  await setDoc(doc(requireDb(), 'guilds', guildId, 'characterReadiness', characterId), {
    ready, updatedBy: auth.currentUser.uid, updatedAt: serverTimestamp(),
  })
}

export async function resolveCharacterRequest(requestId: string, action: 'approve' | 'reject' | 'withdraw', note: string) {
  if (!functions || !auth?.currentUser) throw new Error('Sign in to manage character requests.')
  await httpsCallable(functions, 'resolveCharacterRequest')({ guildId, requestId, action, note })
}

export async function getMembership(uid: string) {
  const snapshot = await getDoc(doc(requireDb(), 'guilds', guildId, 'members', uid))
  return snapshot.exists() ? ({ ...snapshot.data(), id: snapshot.id } as MembershipRecord) : null
}

export async function getJoinRequest(uid: string) {
  const snapshot = await getDoc(doc(requireDb(), 'guilds', guildId, 'joinRequests', uid))
  return snapshot.exists() ? ({ ...snapshot.data(), id: snapshot.id } as JoinRequestRecord) : null
}

export async function submitJoinRequest(uid: string, email: string, displayName: string) {
  await setDoc(doc(requireDb(), 'guilds', guildId, 'joinRequests', uid), {
    userId: uid,
    email,
    displayName,
    status: 'pending',
    requestedAt: serverTimestamp(),
  })
}

// A field set to undefined is removed from the stored document (the write merges, so it would otherwise stay). Roster characters only: loot
// priorities and awards are written through the audited helpers below, and the rules refuse any other write to them.
export async function saveGuildRecord(collectionName: 'roster', id: string, data: Record<string, unknown>) {
  const fields = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value === undefined ? deleteField() : value]))
  await setDoc(doc(requireDb(), 'guilds', guildId, collectionName, id), fields, { merge: true })
}

export async function setTeamAssignment(playerId: string, team: StandingTeam | null, size: RaidSize = 10) {
  if (!functions || !auth?.currentUser) throw new Error('Sign in to update standing teams.')
  await httpsCallable(functions, 'changeStandingTeamAssignment')({ guildId, size, characterId: playerId, team })
}

export async function saveRaidZone(zone: Omit<RaidZoneRecord, 'id'>, id: string = crypto.randomUUID()) {
  await setDoc(doc(requireDb(), 'guilds', guildId, 'raidZones', id), zone)
  return id
}

export async function deleteRaidZone(id: string) {
  await deleteDoc(doc(requireDb(), 'guilds', guildId, 'raidZones', id))
}

export function subscribeRaidZones(onData: (zones: RaidZoneRecord[]) => void, onError: (error: Error) => void) {
  return subscribeGuildCollection<RaidZoneRecord>('raidZones', onData, onError, (id, data) => {
    if (typeof data.name !== 'string' || ![10, 20, 40].includes(data.size as number)) return null
    return { id, name: data.name, size: data.size as RaidSize }
  })
}

// Guild Leaders only: the rules refuse everyone else, and refuse a document that is not exactly this shape.
export async function saveGuildSettings(settings: GuildSettings) {
  await setDoc(doc(requireDb(), 'guilds', guildId, 'settings', 'general'), settings)
}

// A Guild Leader sets the color of a zone (#rrggbb), or takes the choice away (null) so the zone has its default again. All the colors are one document, written
// by merging, so a change touches only this zone and two leaders changing two zones do not undo each other. The rules refuse anyone else.
export async function saveZoneColor(zone: number | string, color: string | null, who: { uid: string }) {
  const key = String(zone)
  if (!isZoneKey(key)) throw new Error('That is not a zone.')
  if (color !== null && !isHexColor(color)) throw new Error('Choose a color like #278794.')
  await setDoc(doc(requireDb(), 'guilds', guildId, 'settings', 'zoneColors'), { colors: { [key]: color === null ? deleteField() : color.toLowerCase() }, updatedBy: who.uid, updatedAt: serverTimestamp() }, { merge: true })
}

// Several zones' colors in one write (a zone made with its color, or every zone without a choice given its own color); every key has to be a zone and every color valid.
export async function saveZoneColors(colors: Record<string, string>, who: { uid: string }) {
  const entries = Object.entries(colors)
  if (!entries.length) return
  if (entries.some(([key, color]) => !isZoneKey(key) || !isHexColor(color))) throw new Error('Choose colors like #278794 for zones.')
  await setDoc(doc(requireDb(), 'guilds', guildId, 'settings', 'zoneColors'), { colors: Object.fromEntries(entries.map(([key, color]) => [key, color.toLowerCase()])), updatedBy: who.uid, updatedAt: serverTimestamp() }, { merge: true })
}

// Every zone back to its default color.
export async function clearZoneColors(who: { uid: string }) {
  await setDoc(doc(requireDb(), 'guilds', guildId, 'settings', 'zoneColors'), { colors: {}, updatedBy: who.uid, updatedAt: serverTimestamp() })
}

// ---- The artwork of the zones (settings/zoneArt and the files in Cloud Storage; see shared/game/zoneArt.ts). Every change goes through a transaction that reads the
// document first, so a picture removed, replaced or renamed by another leader in the meantime is noticed instead of half-recreated. The files are never overwritten
// (a replaced picture is the next rev, a new file with a new address) and are told to be cached for a year, so a browser fetches each picture once.
const IMAGE_CACHE = 'public, max-age=31536000, immutable'

/** A picture ready to upload: the file as chosen, a small JPEG copy of it, and its size. Made in the browser by the Settings page. */
export type PreparedImage = { blob: Blob; type: string; extension: 'jpg' | 'png' | 'webp'; thumb: Blob; width: number; height: number }

const artRef = () => doc(requireDb(), 'guilds', guildId, 'settings', 'zoneArt')

function requireStorage() {
  if (!storage) throw new Error('File storage is not set up for this app.')
  return storage
}

// What a person should read when Cloud Storage says no.
function storageProblem(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'storage/unauthorized' || code === 'storage/unauthenticated') return new Error('Cloud Storage refused that. Only a Guild Leader can change pictures, and the storage rules have to be deployed on this Firebase project.')
  if (code === 'storage/bucket-not-found' || code === 'storage/project-not-found' || code === 'storage/no-default-bucket') return new Error('Cloud Storage is not turned on for this Firebase project yet. Open Build > Storage in the Firebase console and click Get started.')
  if (code === 'storage/quota-exceeded') return new Error('The Cloud Storage quota is used up.')
  if (code === 'storage/retry-limit-exceeded' || code === 'storage/canceled') return new Error('The upload did not finish. Check the connection and try again.')
  return error instanceof Error ? error : new Error('Could not upload the picture.')
}

// A file is only ever created, never overwritten (storage.rules), so what this call uploaded is what it may delete if the change fails: a refused upload to a name another
// leader just took must not take that leader's files with it.
async function uploadImageFiles(id: string, rev: number, prepared: PreparedImage) {
  const bucket = requireStorage()
  const full = fullPath(guildId, id, rev, prepared.extension)
  const thumb = thumbPath(guildId, id, rev)
  const fullRef = storageRef(bucket, full)
  const thumbRef = storageRef(bucket, thumb)
  const created: StorageReference[] = []
  try {
    await uploadBytes(fullRef, prepared.blob, { contentType: prepared.type, cacheControl: IMAGE_CACHE })
    created.push(fullRef)
    await uploadBytes(thumbRef, prepared.thumb, { contentType: 'image/jpeg', cacheControl: IMAGE_CACHE })
    created.push(thumbRef)
    const [fullUrl, thumbUrl] = await Promise.all([getDownloadURL(fullRef), getDownloadURL(thumbRef)])
    return { full, fullUrl, thumb, thumbUrl }
  } catch (error) {
    await Promise.allSettled(created.map((file) => deleteObject(file)))
    // Refused although the person may add pictures: the name is taken, so someone else is changing this very picture.
    const taken = (await Promise.all([fullRef, thumbRef].map((file) => getMetadata(file).then(() => true, () => false)))).some(Boolean)
    if (taken && (error as { code?: unknown } | null)?.code === 'storage/unauthorized') throw new Error('Someone else changed this picture just now. Reload the page and try again.')
    throw storageProblem(error)
  }
}

// Whether a change that reported a failure actually went through (a commit whose answer was lost on the way back): the picture is in the document with these very files.
async function landed(id: string, full: string): Promise<boolean> {
  try {
    return currentArt((await getDocFromServer(artRef())).data()).images.some((entry) => entry.id === id && entry.full === full)
  } catch {
    return false
  }
}

// Files nobody points at any more are removed without failing the change that made them useless: a leftover file is harmless (and a later removal of the picture sweeps its folder).
async function dropFiles(paths: string[]) {
  if (!storage) return
  const bucket = storage
  await Promise.allSettled(paths.map((path) => deleteObject(storageRef(bucket, path))))
}

const artStamps = (who: { uid: string }) => ['updatedBy', who.uid, 'updatedAt', serverTimestamp()] as const
const currentArt = (data: { images?: unknown; art?: unknown } | undefined): ZoneArt => (data ? readZoneArt(data.images, data.art, { guildId, bucket: storageBucket }) : EMPTY_ZONE_ART)

/** Add a picture to the library. Returns its id. */
export async function addZoneImage(name: string, prepared: PreparedImage, who: { uid: string }): Promise<string> {
  const title = name.trim()
  if (!isImageName(title)) throw new Error(`Give the picture a name of 1 to 60 characters.`)
  const id = newImageId()
  const files = await uploadImageFiles(id, 1, prepared)
  const entry = { name: title, rev: 1, bytes: prepared.blob.size, width: prepared.width, height: prepared.height, ...files }
  try {
    await runTransaction(requireDb(), async (transaction) => {
      const snapshot = await transaction.get(artRef())
      if (currentArt(snapshot.data()).images.length >= ZONE_IMAGE_LIMIT) throw new Error(`The guild can keep ${ZONE_IMAGE_LIMIT} pictures. Remove one first.`)
      if (snapshot.exists()) transaction.update(artRef(), new FieldPath('images', id), entry, ...artStamps(who))
      else transaction.set(artRef(), { images: { [id]: entry }, art: {}, updatedBy: who.uid, updatedAt: serverTimestamp() })
    })
  } catch (error) {
    if (await landed(id, files.full)) return id
    await dropFiles([files.full, files.thumb])
    throw error
  }
  return id
}

/** Put a new file in place of a picture: the next rev, the same name, the same zones. */
export async function replaceZoneImage(image: ZoneImage, prepared: PreparedImage, who: { uid: string }): Promise<void> {
  const rev = image.rev + 1
  const files = await uploadImageFiles(image.id, rev, prepared)
  let before: ZoneImage | undefined
  try {
    await runTransaction(requireDb(), async (transaction) => {
      const snapshot = await transaction.get(artRef())
      before = currentArt(snapshot.data()).images.find((entry) => entry.id === image.id)
      if (!before) throw new Error('That picture was removed by someone else. Reload the page.')
      if (before.rev !== image.rev) throw new Error('That picture was replaced by someone else just now. Reload the page and try again.')
      transaction.update(artRef(), new FieldPath('images', image.id), { name: before.name, rev, bytes: prepared.blob.size, width: prepared.width, height: prepared.height, ...files }, ...artStamps(who))
    })
  } catch (error) {
    if (!(await landed(image.id, files.full))) {
      await dropFiles([files.full, files.thumb])
      throw error
    }
  }
  const old = before ?? image
  await dropFiles([old.full, old.thumb])
}

export async function renameZoneImage(image: ZoneImage, name: string, who: { uid: string }): Promise<void> {
  const title = name.trim()
  if (!isImageName(title)) throw new Error('Give the picture a name of 1 to 60 characters.')
  await runTransaction(requireDb(), async (transaction) => {
    const snapshot = await transaction.get(artRef())
    if (!currentArt(snapshot.data()).images.some((entry) => entry.id === image.id)) throw new Error('That picture was removed by someone else. Reload the page.')
    transaction.update(artRef(), new FieldPath('images', image.id, 'name'), title, ...artStamps(who))
  })
}

/** Remove a picture: its entry, the choice of every zone that used it (those zones have no artwork again), and its files. */
export async function removeZoneImage(image: ZoneImage, who: { uid: string }): Promise<void> {
  let known: ZoneImage | undefined
  await runTransaction(requireDb(), async (transaction) => {
    const snapshot = await transaction.get(artRef())
    const art = currentArt(snapshot.data())
    const raw = (snapshot.data()?.images ?? {}) as Record<string, unknown>
    if (!(image.id in raw)) return // already gone
    known = art.images.find((entry) => entry.id === image.id)
    const zones = zonesUsing(art, image.id)
    transaction.update(artRef(), new FieldPath('images', image.id), deleteField(), ...zones.flatMap((zone) => [new FieldPath('art', zone), deleteField()] as const), ...artStamps(who))
  })
  if (!storage) return
  const bucket = storage
  // The files the document names are removed by their paths; then the picture's whole folder is swept for anything an interrupted upload or replace left behind.
  if (known) await dropFiles([known.full, known.thumb])
  try {
    const listing = await listAll(storageRef(bucket, `guilds/${guildId}/zone-art/${image.id}`))
    await Promise.allSettled(listing.items.map((item) => deleteObject(item)))
  } catch {
    // A leftover file is harmless; the picture is already gone from the library.
  }
}

/** Several zones' pictures in one write (zone key to picture id). Each has to be a zone and a picture that is there; one a zone already has is left out. */
export async function pickZoneArts(picks: Record<string, string>, who: { uid: string }): Promise<number> {
  const entries = Object.entries(picks)
  if (entries.some(([zone]) => !isZoneKey(zone))) throw new Error('That is not a zone.')
  let written = 0
  await runTransaction(requireDb(), async (transaction) => {
    const snapshot = await transaction.get(artRef())
    const art = currentArt(snapshot.data())
    const changes = entries.filter(([zone, imageId]) => art.art[zone] !== imageId)
    if (changes.some(([, imageId]) => !art.images.some((entry) => entry.id === imageId))) throw new Error('A picture was removed by someone else. Reload the page.')
    written = changes.length
    if (!changes.length || !snapshot.exists()) { written = 0; return }
    const [[firstZone, firstId], ...others] = changes
    transaction.update(artRef(), new FieldPath('art', firstZone), firstId, ...others.flatMap(([zone, imageId]) => [new FieldPath('art', zone), imageId]), ...artStamps(who))
  })
  return written
}

/** Choose the picture of a zone, or none (`null`). Choosing what the zone already has writes nothing. */
export async function pickZoneArt(zoneKey: string, imageId: string | null, who: { uid: string }): Promise<void> {
  if (!isZoneKey(zoneKey)) throw new Error('That is not a zone.')
  await runTransaction(requireDb(), async (transaction) => {
    const snapshot = await transaction.get(artRef())
    const art = currentArt(snapshot.data())
    if (imageId !== null && !art.images.some((entry) => entry.id === imageId)) throw new Error('That picture was removed by someone else. Reload the page.')
    if ((art.art[zoneKey] ?? null) === imageId) return
    if (!snapshot.exists()) return // nothing to take away from a guild that has no artwork yet
    transaction.update(artRef(), new FieldPath('art', zoneKey), imageId === null ? deleteField() : imageId, ...artStamps(who))
  })
}

// Starting a phase or reopening one saves the settings together with its Log entry (`phase_settings_{n}`, n counting every start and reopen),
// which the rules require, so nobody can move the phase without it showing. The entry says what the phase fields were before: what is stored now
// (nothing on a guild's first save, which is why the stored document is read here), not what this browser last showed.
export async function changePhase(next: GuildSettings, action: 'start' | 'reopen', who: AuditWho) {
  const database = requireDb()
  const ref = doc(database, 'guilds', guildId, 'settings', 'general')
  const stored = (await getDoc(ref)).data() ?? {}
  const rev = nextPhaseRev(stored)
  const description = describeEdit(stored, { currentPhase: next.currentPhase, nextPhase: next.nextPhase, phaseHistory: next.phaseHistory }, phaseAuditFields)
  if (!description) throw new Error('Nothing was changed.')
  const batch = writeBatch(database)
  batch.set(ref, { ...next, phaseRev: rev })
  batch.set(doc(database, 'guilds', guildId, 'auditLog', `phase_settings_${rev}`), auditEntry(who, 'phase', 'settings', rev, action, next.currentPhase, description))
  await batch.commit()
}

export async function createAfkEntry(data: Omit<AfkEntryRecord, 'id' | 'createdAt'>) {
  if (!functions || !auth?.currentUser || data.userId !== auth.currentUser.uid) throw new Error('Sign in as the owner to add unavailable dates.')
  await httpsCallable(functions, 'addUnavailableDates')({ guildId, startDate: data.startDate, endDate: data.endDate })
}

export async function deleteAfkEntry(id: string) {
  if (!functions || !auth?.currentUser) throw new Error('Sign in to remove unavailable dates.')
  await httpsCallable(functions, 'removeUnavailableDates')({ guildId, entryId: id })
}

export async function updateAfkEntry(entryId: string, dates: Pick<AfkEntryRecord, 'startDate' | 'endDate'>) {
  if (!functions || !auth?.currentUser) throw new Error('Sign in to edit unavailable dates.')
  await httpsCallable(functions, 'updateUnavailableDates')({ guildId, entryId, startDate: dates.startDate, endDate: dates.endDate })
}

export async function synchronizeRaidAbsences() {
  if (!functions || !auth?.currentUser) throw new Error('Sign in to synchronize raid absences.')
  const result = await httpsCallable<{ guildId: string }, { checkedRaids: number }>(functions, 'synchronizeRaidAbsences', { timeout: 540000 })({ guildId })
  return result.data.checkedRaids
}

const commentCollection = (kind: CommentKind) => (kind === 'public' ? 'publicComments' : 'leaderComments')

// A member's own comment of one kind (one document per author, id = uid). null when there is none.
export function subscribeMyComment(kind: CommentKind, uid: string, onText: (text: string | null) => void, onError: (error: Error) => void) {
  return onSnapshot(doc(requireDb(), 'guilds', guildId, commentCollection(kind), uid), (snapshot) => {
    const text = snapshot.exists() ? snapshot.data().text : null
    onText(typeof text === 'string' ? text : null)
  }, onError)
}

export async function saveMyComment(kind: CommentKind, uid: string, displayName: string, text: string) {
  await setDoc(doc(requireDb(), 'guilds', guildId, commentCollection(kind), uid), { userId: uid, displayName, text, updatedAt: serverTimestamp() })
}

export async function deleteMyComment(kind: CommentKind, uid: string) {
  await deleteDoc(doc(requireDb(), 'guilds', guildId, commentCollection(kind), uid))
}

export function subscribeMyRaiderType(uid: string, onType: (type: RaiderType | null) => void, onError: (error: Error) => void) {
  return onSnapshot(doc(requireDb(), 'guilds', guildId, 'raiderTypes', uid), (snapshot) => {
    const type = snapshot.exists() ? snapshot.data().type : null
    onType(type === 'casual' || type === 'hardcore' ? type : null)
  }, onError)
}

export async function saveMyRaiderType(uid: string, type: RaiderType) {
  await setDoc(doc(requireDb(), 'guilds', guildId, 'raiderTypes', uid), { userId: uid, type, updatedAt: serverTimestamp() })
}

export async function createRaidEvent(data: Omit<RaidRecord, 'id' | 'createdBy' | 'createdAt'>, uid: string) {
  if (!functions || !auth?.currentUser || uid !== auth.currentUser.uid) throw new Error('Sign in to schedule a raid.')
  await httpsCallable(functions, 'createScheduledRaid')({
    guildId, raidId: crypto.randomUUID(), name: data.name, date: data.date, time: raidTimeOf(data),
    zones: data.zones, ...(data.description ? { description: data.description } : {}),
  })
}

export const RAID_REASON_MAX_LENGTH = 300
export const RAID_DESCRIPTION_MAX_LENGTH = 500
// Raid times are 24-hour HH:MM in Eastern Time. A raid saved without one starts at the usual time.
export const DEFAULT_RAID_TIME = '21:00'
export const raidTimeOf = (raid: Pick<RaidRecord, 'time'>) => raid.time ?? DEFAULT_RAID_TIME
export function formatRaidTime(time: string) {
  const [hours, minutes] = time.split(':').map(Number)
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'} ET`
}
export const isRaidCancelled = (raid: Pick<RaidRecord, 'status'>) => raid.status === 'cancelled'

// Who is making a change that is logged: the signed-in leader. The name has to be the one on their guild account (the rules check it).
export type AuditWho = { uid: string; displayName: string }
type RaidWho = AuditWho
const REMOVE_FIELD = deleteField()

// Every raid change is one batch: the raid update and its audit entry (raid_{id}_{rev}). The rules accept
// neither without the other, and check that the entry tells the truth about what changed.
async function writeRaidChange(raid: RaidRecord, changes: Record<string, unknown>, action: 'edit' | 'cancel', who: RaidWho, reason?: string) {
  const database = requireDb()
  const rev = (raid.rev ?? 0) + 1
  const current = raid as unknown as Record<string, unknown>
  const changed = Object.keys(changes).filter((key) => (changes[key] === REMOVE_FIELD ? current[key] !== undefined : changes[key] !== current[key]))
  if (!changed.length) throw new Error('Nothing was changed.')
  const batch = writeBatch(database)
  batch.update(doc(database, 'guilds', guildId, 'raids', raid.id), { ...changes, rev, updatedBy: who.uid, updatedAt: serverTimestamp() })
  batch.set(doc(database, 'guilds', guildId, 'auditLog', `raid_${raid.id}_${rev}`), {
    at: serverTimestamp(),
    by: who.uid,
    byName: who.displayName,
    targetType: 'raid',
    targetId: raid.id,
    rev,
    action,
    item: raid.name,
    changed,
    before: Object.fromEntries(changed.map((key) => [key, current[key] ?? null])),
    after: Object.fromEntries(changed.map((key) => [key, changes[key] === REMOVE_FIELD ? null : changes[key]])),
    ...(reason ? { reason } : {}),
  })
  await batch.commit()
}

export async function updateRaidEvent(raid: RaidRecord, edit: RaidEdit, who: RaidWho) {
  const changes: Record<string, unknown> = {}
  const startsAt = Timestamp.fromDate(raidStartDate(edit.date ?? raid.date, edit.time ?? raidTimeOf(raid)))
  if (!raid.startsAt?.isEqual(startsAt)) changes.startsAt = startsAt
  for (const key of ['name', 'date', 'size'] as const) if (edit[key] !== undefined && edit[key] !== raid[key]) changes[key] = edit[key]
  if (edit.zones !== undefined && !sameRaidZones(edit.zones, raid.zones ?? [])) changes.zones = edit.zones
  if (edit.time !== undefined && edit.time !== raidTimeOf(raid)) changes.time = edit.time
  if (edit.description !== undefined) {
    const text = edit.description.trim()
    if (text !== (raid.description ?? '')) changes.description = text || REMOVE_FIELD
  }
  await writeRaidChange(raid, changes, 'edit', who)
}

export async function cancelRaidEvent(raid: RaidRecord, reason: string, who: RaidWho) {
  const text = reason.trim()
  if (!text) throw new Error('Enter a reason for cancelling the raid.')
  if (isRaidCancelled(raid)) throw new Error('This raid is already cancelled.')
  await writeRaidChange(raid, { status: 'cancelled', cancelReason: text }, 'cancel', who, text)
}

export async function restoreRaidEvent(raid: RaidRecord, who: RaidWho) {
  if (!isRaidCancelled(raid)) throw new Error('This raid is not cancelled.')
  await writeRaidChange(raid, { status: 'scheduled', cancelReason: REMOVE_FIELD }, 'edit', who)
}

// ---- Loot priorities and awards. Every change is one batch of the change and its audit entry (`priority_{id}_{rev}` or `award_{id}_1`).
// The rules accept neither without the other and check that the entry tells the truth (docs/design/audit-first-loot.md), so nothing here can
// skip the log. A batch has a limit on the document lookups the rules may make, so a long list is written in batches of AUDITED_BATCH_SIZE;
// each batch is all or nothing, and `onWritten` is told which ids a batch wrote, so a caller can show progress and report where it stopped.
export const AUDITED_BATCH_SIZE = 10

export type NewPriority = { item: string; encounter: string; rankedPlayers: string[]; rankedIds?: string[]; councilNote: string; phaseNo: number; itemId?: number; zoneId?: number; npcId?: number; carriedFrom?: string }
// A field set to undefined is taken away.
export type PriorityChanges = Partial<Pick<PriorityRecord, 'item' | 'encounter' | 'rankedPlayers' | 'rankedIds' | 'councilNote' | 'itemId' | 'zoneId' | 'npcId' | 'hidden'>>
export type NewAward = { priorityId: string; item: string; encounter: string; recipient: string; recipientId?: string; awardedAt: string; prioritySnapshot: string[]; prioritySnapshotIds?: string[]; councilNoteSnapshot: string; awardNote: string; phaseNo: number }

// A fresh id for every new priority: an entry id (`priority_{id}_{rev}`) can be used only once, so the id of a deleted priority cannot be created again.
export const newPriorityId = () => crypto.randomUUID()

function auditEntry(who: AuditWho, targetType: 'priority' | 'award' | 'phase' | 'table', targetId: string, rev: number, action: string, item: string, description: Record<string, unknown>) {
  return { at: serverTimestamp(), by: who.uid, byName: who.displayName, targetType, targetId, rev, action, item, ...description }
}

function inBatches<T>(items: T[]): T[][] {
  const groups: T[][] = []
  for (let start = 0; start < items.length; start += AUDITED_BATCH_SIZE) groups.push(items.slice(start, start + AUDITED_BATCH_SIZE))
  return groups
}

export async function createPriorities(items: { id: string; fields: NewPriority }[], who: AuditWho, onWritten?: (ids: string[]) => void) {
  const database = requireDb()
  for (const group of inBatches(items)) {
    const batch = writeBatch(database)
    for (const { id, fields } of group) {
      const record = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
      batch.set(doc(database, 'guilds', guildId, 'lootPriorities', id), { ...record, rev: 1, updatedBy: who.uid, updatedAt: serverTimestamp() })
      batch.set(doc(database, 'guilds', guildId, 'auditLog', `priority_${id}_1`), auditEntry(who, 'priority', id, 1, 'create', fields.item, describeCreate(record, priorityAuditFields)))
    }
    await batch.commit()
    onWritten?.(group.map((entry) => entry.id))
  }
}

/** Changes a priority and logs it. Returns false, writing nothing, when no field would differ. `reorder` is for a change of the order of the lines alone (`rankedPlayers` with `rankedIds`). */
export async function editPriority(existing: PriorityRecord, changes: PriorityChanges, who: AuditWho, action: 'edit' | 'reorder' = 'edit') {
  const description = describeEdit(existing as unknown as Record<string, unknown>, changes, priorityAuditFields)
  if (!description) return false
  const database = requireDb()
  const rev = (existing.rev ?? 0) + 1
  const update = Object.fromEntries(description.changed.map((key) => [key, changes[key as keyof PriorityChanges] === undefined ? deleteField() : changes[key as keyof PriorityChanges]]))
  const batch = writeBatch(database)
  batch.update(doc(database, 'guilds', guildId, 'lootPriorities', existing.id), { ...update, rev, updatedBy: who.uid, updatedAt: serverTimestamp() })
  batch.set(doc(database, 'guilds', guildId, 'auditLog', `priority_${existing.id}_${rev}`), auditEntry(who, 'priority', existing.id, rev, action, existing.item, description))
  await batch.commit()
  return true
}

// Takes priorities off the list without losing them (hidden: true), or puts them back. A hidden priority keeps its candidates and the awards
// recorded from it, and is left out of every list and count; ticking its item again in Browse drops brings it back as it was. In batches like the rest.
export async function setPrioritiesHidden(priorities: PriorityRecord[], hidden: boolean, who: AuditWho, onDone?: (ids: string[]) => void) {
  const database = requireDb()
  for (const group of inBatches(priorities)) {
    const batch = writeBatch(database)
    const written: string[] = []
    for (const priority of group) {
      const description = describeEdit(priority as unknown as Record<string, unknown>, { hidden: hidden ? true : undefined }, priorityAuditFields)
      if (!description) continue
      const rev = (priority.rev ?? 0) + 1
      batch.update(doc(database, 'guilds', guildId, 'lootPriorities', priority.id), { hidden: hidden ? true : deleteField(), rev, updatedBy: who.uid, updatedAt: serverTimestamp() })
      batch.set(doc(database, 'guilds', guildId, 'auditLog', `priority_${priority.id}_${rev}`), auditEntry(who, 'priority', priority.id, rev, 'edit', priority.item, description))
      written.push(priority.id)
    }
    if (written.length) await batch.commit()
    onDone?.(group.map((priority) => priority.id))
  }
}

// Removes priorities. The awards that were recorded from one keep their own copy of the candidate order, so history is not touched.
export async function deletePriorities(priorities: PriorityRecord[], who: AuditWho, onDeleted?: (ids: string[]) => void) {
  const database = requireDb()
  for (const group of inBatches(priorities)) {
    const batch = writeBatch(database)
    for (const priority of group) {
      const rev = (priority.rev ?? 0) + 1
      batch.delete(doc(database, 'guilds', guildId, 'lootPriorities', priority.id))
      batch.set(doc(database, 'guilds', guildId, 'auditLog', `priority_${priority.id}_${rev}`), auditEntry(who, 'priority', priority.id, rev, 'delete', priority.item, describeDelete(priority as unknown as Record<string, unknown>, priorityAuditFields)))
    }
    await batch.commit()
    onDeleted?.(group.map((priority) => priority.id))
  }
}

// The guild's own loot tables (the lootTables collection, see shared/game/guildTables.ts): each write is a new document (revision 1) or an edit of
// one that exists, with its entry (`table_{id}_{rev}`) in the same batch. A table is never deleted; taking one away sets `removed`. The rules check
// the entry like any other (docs/design/audit-first-loot.md). `onWritten` is told which ids a batch wrote, as for priorities.
export async function writeLootTables(writes: TableWrite[], who: AuditWho, onWritten?: (ids: string[]) => void) {
  const database = requireDb()
  for (const group of inBatches(writes)) {
    const batch = writeBatch(database)
    const written: string[] = []
    for (const write of group) {
      if ('create' in write) {
        const record = Object.fromEntries(Object.entries(write.create).filter(([, value]) => value !== undefined))
        batch.set(doc(database, 'guilds', guildId, 'lootTables', write.id), { ...record, rev: 1, updatedBy: who.uid, updatedAt: serverTimestamp() })
        batch.set(doc(database, 'guilds', guildId, 'auditLog', `table_${write.id}_1`), auditEntry(who, 'table', write.id, 1, 'create', String(record.name ?? ''), describeCreate(record, tableAuditFields)))
      } else {
        const description = describeEdit(write.existing as unknown as Record<string, unknown>, write.changes, tableAuditFields)
        if (!description) continue
        const rev = write.existing.rev + 1
        const update = Object.fromEntries(description.changed.map((key) => [key, write.changes[key as keyof typeof write.changes] === undefined ? deleteField() : write.changes[key as keyof typeof write.changes]]))
        batch.update(doc(database, 'guilds', guildId, 'lootTables', write.id), { ...update, rev, updatedBy: who.uid, updatedAt: serverTimestamp() })
        batch.set(doc(database, 'guilds', guildId, 'auditLog', `table_${write.id}_${rev}`), auditEntry(who, 'table', write.id, rev, 'edit', ('name' in write.existing ? write.existing.name : undefined) ?? '', description))
      }
      written.push(write.id)
    }
    if (written.length) await batch.commit()
    onWritten?.(written)
  }
}

const withoutUndefined = <T extends object>(values: T) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as T

/** Records an award made from a priority, with its entry. Returns the new award's id. */
export async function recordAward(award: NewAward, who: AuditWho) {
  const database = requireDb()
  const ref = doc(guildCollection('awards'))
  const batch = writeBatch(database)
  batch.set(ref, { ...withoutUndefined(award), rev: 1, createdBy: who.uid, createdAt: serverTimestamp() })
  batch.set(doc(database, 'guilds', guildId, 'auditLog', `award_${ref.id}_1`), auditEntry(who, 'award', ref.id, 1, 'create', award.item, describeCreate(award, awardCreateFields)))
  await batch.commit()
  return ref.id
}

/**
 * Records an award to someone the list names only through an open note, and puts the winner on a character line at the note's place (`next` is the
 * priority's lines after that, see receiveThroughNote), in one batch with an entry for each. The award's snapshot is the priority as the council saw
 * it, note included: the rules read the priority as it was before the batch. Returns the new award's id.
 */
export async function recordAwardThroughNote(award: NewAward, priority: PriorityRecord, next: { rankedPlayers: string[]; rankedIds?: string[] }, who: AuditWho) {
  const database = requireDb()
  const changes: PriorityChanges = { rankedPlayers: next.rankedPlayers, rankedIds: next.rankedIds }
  const description = describeEdit(priority as unknown as Record<string, unknown>, changes, priorityAuditFields)
  if (!description) throw new Error('Nothing was changed.')
  const rev = (priority.rev ?? 0) + 1
  const update = Object.fromEntries(description.changed.map((key) => [key, changes[key as keyof PriorityChanges] === undefined ? deleteField() : changes[key as keyof PriorityChanges]]))
  const ref = doc(guildCollection('awards'))
  const batch = writeBatch(database)
  batch.set(ref, { ...withoutUndefined(award), rev: 1, createdBy: who.uid, createdAt: serverTimestamp() })
  batch.set(doc(database, 'guilds', guildId, 'auditLog', `award_${ref.id}_1`), auditEntry(who, 'award', ref.id, 1, 'create', award.item, describeCreate(award, awardCreateFields)))
  batch.update(doc(database, 'guilds', guildId, 'lootPriorities', priority.id), { ...update, rev, updatedBy: who.uid, updatedAt: serverTimestamp() })
  batch.set(doc(database, 'guilds', guildId, 'auditLog', `priority_${priority.id}_${rev}`), auditEntry(who, 'priority', priority.id, rev, 'edit', priority.item, description))
  await batch.commit()
  return ref.id
}

// What a leader can change on an award (LOOT-004). A field set to undefined is taken away. The candidate order and council note at decision time
// (`prioritySnapshot`, `councilNoteSnapshot`) never change, and an award is never deleted: removing one is an edit that marks it removed, with a reason.
export type AwardChanges = Partial<Pick<AwardRecord, 'recipient' | 'recipientId' | 'awardedAt' | 'awardNote' | 'decision' | 'phaseNo' | 'status' | 'removedReason'>>

// One batch: the award's next revision and its entry (`award_{id}_{rev}`). An award from before the Log began has no revision, so its first edit is
// revision 1, and its entry is the first the Log holds for it. The rules check that the entry tells the truth, and accept neither without the other.
async function writeAwardChange(award: AwardRecord, changes: AwardChanges, action: 'edit' | 'remove', who: AuditWho, reason?: string) {
  const database = requireDb()
  const description = describeEdit(award as unknown as Record<string, unknown>, changes, awardEditFields)
  if (!description) throw new Error('Nothing was changed.')
  const rev = (award.rev ?? 0) + 1
  const update = Object.fromEntries(description.changed.map((key) => [key, changes[key as keyof AwardChanges] === undefined ? deleteField() : changes[key as keyof AwardChanges]]))
  const batch = writeBatch(database)
  batch.update(doc(database, 'guilds', guildId, 'awards', award.id), { ...update, rev, updatedBy: who.uid, updatedAt: serverTimestamp() })
  batch.set(doc(database, 'guilds', guildId, 'auditLog', `award_${award.id}_${rev}`), { ...auditEntry(who, 'award', award.id, rev, action, award.item, description), ...(reason ? { reason } : {}) })
  await batch.commit()
}

/** Moves a receipt to someone else, or corrects another field of an award. One entry says what it was and what it is now. The reason is optional. */
export async function correctAward(award: AwardRecord, changes: AwardChanges, who: AuditWho, reason?: string) {
  await writeAwardChange(award, changes, 'edit', who, reason?.trim() || undefined)
}

/** Removes an award that was a mistake: it is kept, marked removed, and stops counting. A reason is required. */
export async function removeAward(award: AwardRecord, reason: string, who: AuditWho) {
  const why = reason.trim()
  if (!why) throw new Error('Give a reason for removing the award.')
  await writeAwardChange(award, { status: 'removed', removedReason: why }, 'remove', who, why)
}

/** The newest `max` entries of the audit log, live. Every guild member can read it; nobody can change or delete an entry. */
export function subscribeAuditLog(max: number, onData: (entries: AuditEntry[]) => void, onError: (error: Error) => void) {
  return onSnapshot(
    query(guildCollection('auditLog'), orderBy('at', 'desc'), limit(max)),
    (snapshot) => onData(snapshot.docs.flatMap((entry) => { const read = readAuditEntry(entry.id, entry.data({ serverTimestamps: 'estimate' })); return read ? [read] : [] })),
    (error) => onError(error),
  )
}

export async function updateMembershipRole(uid: string, role: GuildRole) {
  await updateDoc(doc(requireDb(), 'guilds', guildId, 'members', uid), { role })
}

export async function updateMembershipAccess(uid: string, role: GuildRole, playerId: string | null) {
  const database = requireDb()
  const membershipRef = doc(database, 'guilds', guildId, 'members', uid)
  const membership = await getDoc(membershipRef)
  if (!membership.exists()) throw new Error('Guild account no longer exists.')
  const previousPlayerId = typeof membership.data().playerId === 'string' ? membership.data().playerId as string : null
  const batch = writeBatch(database)

  if (previousPlayerId && previousPlayerId !== playerId) {
    batch.update(doc(database, 'guilds', guildId, 'roster', previousPlayerId), { linkedUid: deleteField() })
  }
  if (playerId && previousPlayerId !== playerId) {
    batch.update(doc(database, 'guilds', guildId, 'roster', playerId), { linkedUid: uid })
  }
  batch.update(membershipRef, { role, playerId })
  await batch.commit()
}

export async function setMembershipRemoved(uid: string, removed: boolean) {
  await writeMembershipRemoved(requireDb(), guildId, uid, removed)
}

export async function approveJoinRequest(request: JoinRequestRecord, role: GuildRole, playerId: string | null = null) {
  const database = requireDb()
  // Approving writes the whole members doc, so approving someone who is already a member would overwrite their role.
  // The rules refuse it too; this check only gives a readable message.
  if ((await getDoc(doc(database, 'guilds', guildId, 'members', request.userId))).exists()) {
    throw new Error('This person is already a guild member. Decline the request to dismiss it.')
  }
  const batch = writeBatch(database)
  batch.set(doc(database, 'guilds', guildId, 'members', request.userId), {
    email: request.email,
    displayName: request.displayName,
    role,
    playerId,
    joinedAt: serverTimestamp(),
  })
  if (playerId) batch.update(doc(database, 'guilds', guildId, 'roster', playerId), { linkedUid: request.userId })
  batch.update(doc(database, 'guilds', guildId, 'joinRequests', request.userId), { status: 'approved', assignedRole: role, linkedPlayerId: playerId })
  await batch.commit()
}

export async function rejectJoinRequest(uid: string) {
  await updateDoc(doc(requireDb(), 'guilds', guildId, 'joinRequests', uid), { status: 'rejected' })
}

export function currentAuthUser() {
  return auth?.currentUser ?? null
}
