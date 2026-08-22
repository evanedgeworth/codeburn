import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { calculateCost } from './models.js'
import type { DateRange } from './types.js'
import type { ParsedProviderCall, ProbeRoot } from './providers/types.js'

const STORE_VERSION = 1
const STORE_FILE = 'claude-history.json'

type ClaudeModelUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
}

type ClaudeDailyModelTokens = {
  date: string
  tokensByModel: Record<string, number>
}

export type ClaudeHistoryStore = {
  version: number
  importedAt: string
  sourceName: string
  sourceHash: string
  firstSessionDate: string
  lastComputedDate: string
  totalSessions: number
  totalMessages: number
  modelUsage: Record<string, ClaudeModelUsage>
  dailyModelTokens: ClaudeDailyModelTokens[]
  sourceId?: string
  sourceLabel?: string
  sourcePath?: string
  generationId?: string
  snapshots?: ClaudeHistorySnapshot[]
}

export type ClaudeHistorySnapshot = Omit<ClaudeHistoryStore, 'version' | 'snapshots'> & {
  sourceId: string
  sourceLabel: string
  sourcePath: string
  generationId: string
}

export type ClaudeHistoryImportResult = {
  sourceName: string
  importedAt: string
  firstSessionDate: string
  lastComputedDate: string
  totalSessions: number
  totalMessages: number
  days: number
  models: number
  totalTokens: number
  storePath: string
  sourceId: string
  sourceLabel: string
  generationId: string
  unchanged: boolean
}

export type ClaudeHistoricalCalls = {
  calls: ParsedProviderCall[]
  exactAggregateTokens: number
  includedTokens: number
  excludedOverlapTokens: number
  excludedOverlapDays: string[]
}

export type ClaudeStatsSource = { id: string; label: string; path: string }

export function getClaudeHistoryStorePath(): string {
  return process.env['CODEBURN_CLAUDE_HISTORY_STORE']
    ?? join(homedir(), '.config', 'codeburn', STORE_FILE)
}

export function getClaudeHistoryProbeRoot(): ProbeRoot {
  return { path: getClaudeHistoryStorePath(), label: 'historical stats' }
}

export function getClaudeHistoryStoreHash(): string {
  try {
    const stat = statSync(getClaudeHistoryStorePath())
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'none'
  }
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null
}

function parseModelUsage(value: unknown): Record<string, ClaudeModelUsage> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('modelUsage is missing')
  const result: Record<string, ClaudeModelUsage> = {}
  for (const [model, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const inputTokens = nonNegativeInteger(entry['inputTokens'])
    const outputTokens = nonNegativeInteger(entry['outputTokens'])
    const cacheReadInputTokens = nonNegativeInteger(entry['cacheReadInputTokens'])
    const cacheCreationInputTokens = nonNegativeInteger(entry['cacheCreationInputTokens'])
    const webSearchRequests = nonNegativeInteger(entry['webSearchRequests']) ?? 0
    if ([inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens].some(v => v === null)) {
      throw new Error(`modelUsage.${model} has invalid token totals`)
    }
    result[model] = {
      inputTokens: inputTokens!,
      outputTokens: outputTokens!,
      cacheReadInputTokens: cacheReadInputTokens!,
      cacheCreationInputTokens: cacheCreationInputTokens!,
      webSearchRequests,
    }
  }
  if (Object.keys(result).length === 0) throw new Error('modelUsage has no valid models')
  return result
}

function parseDailyModelTokens(value: unknown): ClaudeDailyModelTokens[] {
  if (!Array.isArray(value)) throw new Error('dailyModelTokens is missing')
  const result: ClaudeDailyModelTokens[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    if (typeof entry['date'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry['date'])) continue
    const rawTokens = entry['tokensByModel']
    if (!rawTokens || typeof rawTokens !== 'object' || Array.isArray(rawTokens)) continue
    const tokensByModel: Record<string, number> = {}
    for (const [model, tokens] of Object.entries(rawTokens)) {
      const parsed = nonNegativeInteger(tokens)
      if (parsed !== null && parsed > 0) tokensByModel[model] = parsed
    }
    if (Object.keys(tokensByModel).length > 0) result.push({ date: entry['date'], tokensByModel })
  }
  result.sort((a, b) => a.date.localeCompare(b.date))
  if (result.length === 0) throw new Error('dailyModelTokens has no valid days')
  return result
}

function parseStatsCache(raw: string, sourceName: string): ClaudeHistoryStore {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('stats cache is not valid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('stats cache is not an object')
  const input = value as Record<string, unknown>
  if (typeof input['firstSessionDate'] !== 'string' || Number.isNaN(new Date(input['firstSessionDate']).getTime())) {
    throw new Error('firstSessionDate is missing or invalid')
  }
  if (typeof input['lastComputedDate'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input['lastComputedDate'])) {
    throw new Error('lastComputedDate is missing or invalid')
  }
  const totalSessions = nonNegativeInteger(input['totalSessions'])
  const totalMessages = nonNegativeInteger(input['totalMessages'])
  if (totalSessions === null || totalMessages === null) throw new Error('session/message totals are invalid')
  const modelUsage = parseModelUsage(input['modelUsage'])
  const dailyModelTokens = parseDailyModelTokens(input['dailyModelTokens'])

  // Claude's daily series is input + output only. Requiring it to reconcile
  // model-by-model prevents a partial/stale series from silently becoming a
  // misleading allocation of the exact cache totals.
  for (const [model, usage] of Object.entries(modelUsage)) {
    const dailyTotal = dailyModelTokens.reduce((sum, day) => sum + (day.tokensByModel[model] ?? 0), 0)
    if (dailyTotal !== usage.inputTokens + usage.outputTokens) {
      throw new Error(`dailyModelTokens does not reconcile for ${model}: ${dailyTotal} vs ${usage.inputTokens + usage.outputTokens}`)
    }
  }

  return {
    version: STORE_VERSION,
    importedAt: new Date().toISOString(),
    sourceName,
    sourceHash: createHash('sha256').update(raw).digest('hex'),
    firstSessionDate: input['firstSessionDate'],
    lastComputedDate: input['lastComputedDate'],
    totalSessions,
    totalMessages,
    modelUsage,
    dailyModelTokens,
  }
}

async function saveStore(store: ClaudeHistoryStore): Promise<void> {
  const target = getClaudeHistoryStorePath()
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

function snapshotFromStore(store: ClaudeHistoryStore, fallback?: { id: string; label: string; path: string }): ClaudeHistorySnapshot {
  const sourcePath = store.sourcePath ?? fallback?.path ?? dirname(resolve(store.sourceName))
  const sourceId = store.sourceId ?? fallback?.id ?? `claude-history:${createHash('sha256').update(sourcePath).digest('hex').slice(0, 16)}`
  const sourceLabel = store.sourceLabel ?? fallback?.label ?? 'Imported Claude history'
  return {
    importedAt: store.importedAt,
    sourceName: store.sourceName,
    sourceHash: store.sourceHash,
    firstSessionDate: store.firstSessionDate,
    lastComputedDate: store.lastComputedDate,
    totalSessions: store.totalSessions,
    totalMessages: store.totalMessages,
    modelUsage: store.modelUsage,
    dailyModelTokens: store.dailyModelTokens,
    sourceId,
    sourceLabel,
    sourcePath,
    generationId: store.generationId ?? `${sourceId}:g0`,
  }
}

function snapshotIsMonotonic(prior: ClaudeHistorySnapshot, next: ClaudeHistoryStore): boolean {
  if (prior.firstSessionDate !== next.firstSessionDate) return false
  if (next.lastComputedDate < prior.lastComputedDate) return false
  for (const [model, oldUsage] of Object.entries(prior.modelUsage)) {
    const newUsage = next.modelUsage[model]
    if (!newUsage) return false
    if (newUsage.inputTokens < oldUsage.inputTokens
      || newUsage.outputTokens < oldUsage.outputTokens
      || newUsage.cacheReadInputTokens < oldUsage.cacheReadInputTokens
      || newUsage.cacheCreationInputTokens < oldUsage.cacheCreationInputTokens
      || newUsage.webSearchRequests < oldUsage.webSearchRequests) return false
  }
  return true
}

function activeSnapshots(snapshots: ClaudeHistorySnapshot[]): ClaudeHistorySnapshot[] {
  const latest = new Map<string, ClaudeHistorySnapshot>()
  for (const snapshot of snapshots) {
    const current = latest.get(snapshot.generationId)
    if (!current || snapshot.importedAt >= current.importedAt) latest.set(snapshot.generationId, snapshot)
  }
  return [...latest.values()].sort((a, b) => a.firstSessionDate.localeCompare(b.firstSessionDate) || a.generationId.localeCompare(b.generationId))
}

export async function importClaudeStatsCache(
  filePath: string,
  options?: { sourceId?: string; sourceLabel?: string; sourcePath?: string },
): Promise<ClaudeHistoryImportResult> {
  const raw = await readFile(filePath, 'utf8')
  const parsed = parseStatsCache(raw, basename(filePath))
  const sourcePath = resolve(options?.sourcePath ?? dirname(filePath))
  const sourceId = options?.sourceId?.trim()
    || `claude-config:${createHash('sha256').update(sourcePath).digest('hex').slice(0, 16)}`
  const sourceLabel = options?.sourceLabel?.trim() || (sourcePath === resolve(join(homedir(), '.claude')) ? 'Default Claude' : basename(sourcePath))
  const existing = await readClaudeHistoryStore()
  let snapshots = existing?.snapshots?.length
    ? [...existing.snapshots]
    : existing ? [snapshotFromStore(existing, { id: sourceId, label: sourceLabel, path: sourcePath })] : []
  // Early one-snapshot imports did not retain their actual config path and use
  // a claude-history:* fallback identity. When the automatic snapshotter later
  // sees the byte-identical cache, rehome that legacy receipt instead of
  // treating the same cumulative account total as a second account.
  const legacyMatchIndex = snapshots.findIndex(snapshot => snapshot.sourceHash === parsed.sourceHash
    && snapshot.sourceId.startsWith('claude-history:'))
  let migratedLegacyIdentity = false
  if (legacyMatchIndex >= 0 && snapshots[legacyMatchIndex]!.sourceId !== sourceId) {
    const legacy = snapshots[legacyMatchIndex]!
    snapshots[legacyMatchIndex] = {
      ...legacy,
      sourceId,
      sourceLabel,
      sourcePath,
      generationId: `${sourceId}:g0`,
    }
    migratedLegacyIdentity = true
  }
  const sameHash = snapshots.find(snapshot => snapshot.sourceId === sourceId && snapshot.sourceHash === parsed.sourceHash)
  const generations = activeSnapshots(snapshots.filter(snapshot => snapshot.sourceId === sourceId))
  const prior = generations.at(-1)
  const generationId = sameHash?.generationId
    ?? (prior && snapshotIsMonotonic(prior, parsed)
      ? prior.generationId
      : `${sourceId}:g${generations.length}`)
  const snapshot: ClaudeHistorySnapshot = {
    ...snapshotFromStore(parsed, { id: sourceId, label: sourceLabel, path: sourcePath }),
    sourceId,
    sourceLabel,
    sourcePath,
    generationId,
  }
  if (sameHash && existing?.snapshots?.length && !migratedLegacyIdentity) {
    return {
      sourceName: sameHash.sourceName,
      importedAt: sameHash.importedAt,
      firstSessionDate: sameHash.firstSessionDate,
      lastComputedDate: sameHash.lastComputedDate,
      totalSessions: sameHash.totalSessions,
      totalMessages: sameHash.totalMessages,
      days: sameHash.dailyModelTokens.length,
      models: Object.keys(sameHash.modelUsage).length,
      totalTokens: totalStoreTokens({ version: STORE_VERSION, ...sameHash }),
      storePath: getClaudeHistoryStorePath(),
      sourceId,
      sourceLabel,
      generationId: sameHash.generationId,
      unchanged: true,
    }
  }
  const nextSnapshots = sameHash ? snapshots : [...snapshots, snapshot]
  const store: ClaudeHistoryStore = {
    ...parsed,
    importedAt: sameHash?.importedAt ?? parsed.importedAt,
    sourceId,
    sourceLabel,
    sourcePath,
    generationId,
    snapshots: nextSnapshots,
  }
  await saveStore(store)
  return {
    sourceName: store.sourceName,
    importedAt: store.importedAt,
    firstSessionDate: store.firstSessionDate,
    lastComputedDate: store.lastComputedDate,
    totalSessions: store.totalSessions,
    totalMessages: store.totalMessages,
    days: store.dailyModelTokens.length,
    models: Object.keys(store.modelUsage).length,
    totalTokens: totalStoreTokens(store),
    storePath: getClaudeHistoryStorePath(),
    sourceId,
    sourceLabel,
    generationId,
    unchanged: sameHash !== undefined,
  }
}

export async function readClaudeHistoryStore(): Promise<ClaudeHistoryStore | null> {
  try {
    const raw = await readFile(getClaudeHistoryStorePath(), 'utf8')
    const parsed = JSON.parse(raw) as ClaudeHistoryStore
    if (parsed.version !== STORE_VERSION) return null
    // Reuse the strict parser by translating the persisted shape back into the
    // vendor fields; retain the immutable import receipt around it.
    const checked = parseStatsCache(JSON.stringify(parsed), parsed.sourceName)
    const snapshots = Array.isArray(parsed.snapshots)
      ? parsed.snapshots.flatMap(rawSnapshot => {
          try {
            const validated = parseStatsCache(JSON.stringify(rawSnapshot), rawSnapshot.sourceName)
            return [{
              ...snapshotFromStore(validated, { id: rawSnapshot.sourceId, label: rawSnapshot.sourceLabel, path: rawSnapshot.sourcePath }),
              importedAt: rawSnapshot.importedAt,
              sourceHash: rawSnapshot.sourceHash,
              sourceId: rawSnapshot.sourceId,
              sourceLabel: rawSnapshot.sourceLabel,
              sourcePath: rawSnapshot.sourcePath,
              generationId: rawSnapshot.generationId,
            } satisfies ClaudeHistorySnapshot]
          } catch { return [] }
        })
      : undefined
    return {
      ...checked,
      importedAt: parsed.importedAt,
      sourceHash: parsed.sourceHash,
      sourceId: parsed.sourceId,
      sourceLabel: parsed.sourceLabel,
      sourcePath: parsed.sourcePath,
      generationId: parsed.generationId,
      ...(snapshots?.length ? { snapshots } : {}),
    }
  } catch {
    return null
  }
}

export async function readClaudeHistorySnapshots(): Promise<ClaudeHistorySnapshot[]> {
  const store = await readClaudeHistoryStore()
  if (!store) return []
  const snapshots = store.snapshots?.length ? store.snapshots : [snapshotFromStore(store)]
  return activeSnapshots(snapshots)
}

/** Snapshot every configured stats cache. Unchanged hashes are a no-op. */
export async function snapshotClaudeStatsCaches(sources: ClaudeStatsSource[]): Promise<ClaudeHistoryImportResult[]> {
  const results: ClaudeHistoryImportResult[] = []
  for (const source of sources) {
    const statsPath = join(source.path, 'stats-cache.json')
    try {
      results.push(await importClaudeStatsCache(statsPath, {
        sourceId: source.id,
        sourceLabel: source.label,
        sourcePath: source.path,
      }))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'ENOENT') throw error
    }
  }
  return results
}

export function totalStoreTokens(store: ClaudeHistoryStore): number {
  return Object.values(store.modelUsage).reduce((sum, usage) => sum
    + usage.inputTokens
    + usage.outputTokens
    + usage.cacheReadInputTokens
    + usage.cacheCreationInputTokens, 0)
}

function allocateInteger(total: number, weights: number[]): number[] {
  if (weights.length === 0) return []
  const weightTotal = weights.reduce((sum, value) => sum + value, 0)
  const effective = weightTotal > 0 ? weights : weights.map(() => 1)
  const effectiveTotal = effective.reduce((sum, value) => sum + value, 0)
  const raw = effective.map(weight => total * weight / effectiveTotal)
  const result = raw.map(Math.floor)
  let remainder = total - result.reduce((sum, value) => sum + value, 0)
  const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let i = 0; i < remainder; i++) result[order[i % order.length]!.index]! += 1
  return result
}

function inRange(timestamp: string, range?: DateRange): boolean {
  if (!range) return true
  const ms = new Date(timestamp).getTime()
  return ms >= range.start.getTime() && ms <= range.end.getTime()
}

export async function buildClaudeHistoricalCalls(
  range?: DateRange,
  excludedDays: ReadonlySet<string> | ReadonlyMap<string, ReadonlySet<string>> = new Set(),
): Promise<ClaudeHistoricalCalls> {
  const snapshots = await readClaudeHistorySnapshots()
  if (snapshots.length === 0) return { calls: [], exactAggregateTokens: 0, includedTokens: 0, excludedOverlapTokens: 0, excludedOverlapDays: [] }

  const calls: ParsedProviderCall[] = []
  let excludedOverlapTokens = 0
  const excluded = new Set<string>()
  for (const store of snapshots) {
    const sourceExcluded = excludedDays instanceof Map
      ? (excludedDays.get(store.sourceId) ?? new Set<string>())
      : excludedDays
    for (const [model, usage] of Object.entries(store.modelUsage)) {
      const days = store.dailyModelTokens
        .map(day => ({ date: day.date, weight: day.tokensByModel[model] ?? 0 }))
        .filter(day => day.weight > 0)
      const weights = days.map(day => day.weight)
      const input = allocateInteger(usage.inputTokens, weights)
      const output = allocateInteger(usage.outputTokens, weights)
      const cacheRead = allocateInteger(usage.cacheReadInputTokens, weights)
      const cacheWrite = allocateInteger(usage.cacheCreationInputTokens, weights)
      const webSearch = allocateInteger(usage.webSearchRequests, weights)
      for (let index = 0; index < days.length; index++) {
        const day = days[index]!
        const timestamp = `${day.date}T12:00:00.000Z`
        const tokens = input[index]! + output[index]! + cacheRead[index]! + cacheWrite[index]!
        if (sourceExcluded.has(day.date)) {
          excluded.add(day.date)
          excludedOverlapTokens += tokens
          continue
        }
        if (!inRange(timestamp, range)) continue
        calls.push({
          provider: 'claude',
          model,
          inputTokens: input[index]!,
          outputTokens: output[index]!,
          cacheCreationInputTokens: cacheWrite[index]!,
          cacheReadInputTokens: cacheRead[index]!,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          webSearchRequests: webSearch[index]!,
          costUSD: calculateCost(model, input[index]!, output[index]!, cacheWrite[index]!, cacheRead[index]!, webSearch[index]!),
          // Aggregate component totals are exact. Only their day-level allocation
          // is inferred from Claude's exact uncached daily series.
          costIsEstimated: true,
          tools: [],
          bashCommands: [],
          timestamp,
          speed: 'standard',
          deduplicationKey: `claude-history:${store.generationId}:${store.sourceHash}:${day.date}:${model}`,
          userMessage: 'Imported Claude historical aggregate (exact total; daily cache allocation estimated)',
          sessionId: `claude-history:${store.generationId}:${day.date}`,
          project: `Claude historical aggregate (${store.sourceLabel})`,
          projectPath: store.sourcePath,
          sourceId: store.sourceId,
          sourceLabel: store.sourceLabel,
          sourcePath: store.sourcePath,
          sourceKind: 'claude-config',
        })
      }
    }
  }
  const includedTokens = calls.reduce((sum, call) => sum + call.inputTokens + call.outputTokens + call.cacheReadInputTokens + call.cacheCreationInputTokens, 0)
  return {
    calls,
    exactAggregateTokens: snapshots.reduce((sum, snapshot) => sum + totalStoreTokens({ version: STORE_VERSION, ...snapshot }), 0),
    includedTokens,
    excludedOverlapTokens,
    excludedOverlapDays: [...excluded].sort(),
  }
}
