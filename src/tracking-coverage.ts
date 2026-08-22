import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { readClaudeHistorySnapshots, totalStoreTokens } from './claude-history-import.js'
import { readCursorUsageStore } from './cursor-server-import.js'
import { getUsageLedgerPath, readUsageLedger } from './usage-ledger.js'

export type TrackingGap = {
  start: string
  end: string
  kind: 'unobserved'
}

export type TrackingSourceCoverage = {
  id: string
  label: string
  kind: string
  eventCount: number
  tokens: number
  firstSeen: string | null
  lastSeen: string | null
  lastRefresh: string | null
  gaps: TrackingGap[]
}

export type ProviderTrackingCoverage = {
  provider: 'claude' | 'codex' | 'cursor'
  label: string
  quality: 'exact' | 'mixed' | 'estimated'
  eventCount: number
  exactTokens: number
  estimatedTokens: number
  firstSeen: string | null
  lastSeen: string | null
  lastRefresh: string | null
  sources: TrackingSourceCoverage[]
  warnings: string[]
}

export type TrackingCoverage = {
  targetStart: string
  targetEnd: string
  confidence: 'complete' | 'verified-minimum'
  ledger: {
    path: string
    events: number
    revisions: number
    invalidLines: number
  }
  providers: ProviderTrackingCoverage[]
  warnings: string[]
}

type TrackingCoverageCache = {
  version: 1
  writtenAt: string
  targetStart: string
  targetEnd: string
  coverage: TrackingCoverage
}

const COVERAGE_CACHE_MS = 5 * 60 * 1000

function coverageCachePath(): string {
  return process.env['CODEBURN_TRACKING_COVERAGE_CACHE'] ?? `${getUsageLedgerPath()}.coverage.json`
}

async function readCoverageCache(targetStart: string, targetEnd: string, now: Date): Promise<TrackingCoverage | null> {
  try {
    const parsed = JSON.parse(await readFile(coverageCachePath(), 'utf8')) as TrackingCoverageCache
    if (parsed.version !== 1 || parsed.targetStart !== targetStart || parsed.targetEnd !== targetEnd) return null
    if (now.getTime() - Date.parse(parsed.writtenAt) > COVERAGE_CACHE_MS) return null
    return parsed.coverage
  } catch {
    return null
  }
}

async function saveCoverageCache(coverage: TrackingCoverage, now: Date): Promise<void> {
  const target = coverageCachePath()
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.${process.pid}.tmp`
  const cache: TrackingCoverageCache = {
    version: 1,
    writtenAt: now.toISOString(),
    targetStart: coverage.targetStart,
    targetEnd: coverage.targetEnd,
    coverage,
  }
  await writeFile(temp, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, target)
}

function day(value: string): string {
  return value.slice(0, 10)
}

function localDay(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const date = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${date}`
}

function tokens(record: {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  reasoningTokens?: number
}): number {
  return record.inputTokens + record.outputTokens + record.cacheWriteTokens + record.cacheReadTokens + (record.reasoningTokens ?? 0)
}

function dayBefore(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

function dayAfter(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

function gapsForIntervals(targetStart: string, intervals: Array<{ start: string; end: string }>): TrackingGap[] {
  const normalized = intervals
    .filter(interval => interval.start && interval.end)
    .map(interval => ({ start: day(interval.start), end: day(interval.end) }))
    .sort((a, b) => a.start.localeCompare(b.start))
  if (normalized.length === 0) return [{ start: targetStart, end: targetStart, kind: 'unobserved' }]
  const gaps: TrackingGap[] = []
  let coveredThrough = targetStart < normalized[0]!.start ? dayBefore(normalized[0]!.start) : targetStart
  if (targetStart < normalized[0]!.start) gaps.push({ start: targetStart, end: dayBefore(normalized[0]!.start), kind: 'unobserved' })
  coveredThrough = normalized[0]!.end
  for (const interval of normalized.slice(1)) {
    if (interval.start > dayAfter(coveredThrough)) {
      gaps.push({ start: dayAfter(coveredThrough), end: dayBefore(interval.start), kind: 'unobserved' })
    }
    if (interval.end > coveredThrough) coveredThrough = interval.end
  }
  return gaps
}

function extrema(values: string[]): { first: string | null; last: string | null } {
  const sorted = values.filter(Boolean).sort()
  return { first: sorted[0] ?? null, last: sorted.at(-1) ?? null }
}

/**
 * Build a source/account coverage ledger. "Unobserved" never claims that usage
 * occurred; it says only that CodeBurn has no token-bearing evidence for that
 * date span, which keeps the headline honest without inventing missing spend.
 */
export async function buildTrackingCoverage(targetStart?: string, now = new Date(), fresh = false): Promise<TrackingCoverage> {
  const targetEnd = localDay(now)
  const start = targetStart ?? `${now.getFullYear()}-01-01`
  if (!fresh) {
    const cached = await readCoverageCache(start, targetEnd, now)
    if (cached) return cached
  }
  const [ledger, cursor, claudeSnapshots] = await Promise.all([
    readUsageLedger(),
    readCursorUsageStore(),
    readClaudeHistorySnapshots(),
  ])

  const providers: ProviderTrackingCoverage[] = []
  for (const provider of ['claude', 'codex'] as const) {
    const records = ledger.records.filter(record => record.provider === provider)
    const bySource = new Map<string, typeof records>()
    for (const record of records) {
      const group = bySource.get(record.sourceId) ?? []
      group.push(record)
      bySource.set(record.sourceId, group)
    }
    const sources: TrackingSourceCoverage[] = [...bySource.entries()].map(([id, sourceRecords]) => {
      const range = extrema(sourceRecords.map(record => record.timestamp))
      const imported = provider === 'claude'
        ? claudeSnapshots.filter(snapshot => snapshot.sourceId === id)
        : []
      const intervals = [
        ...(range.first && range.last ? [{ start: range.first, end: range.last }] : []),
        ...imported.map(snapshot => ({ start: snapshot.firstSessionDate, end: snapshot.lastComputedDate })),
      ]
      const latestReceipt = extrema(sourceRecords.map(record => record.recordedAt)).last
      const exemplar = sourceRecords[0]!
      const legacyClaudeSource = provider === 'claude' && exemplar.sourceKind === 'codex-home'
      return {
        id,
        label: legacyClaudeSource ? 'Legacy Claude (source identity unavailable)' : exemplar.sourceLabel,
        kind: legacyClaudeSource ? 'legacy-unknown' : exemplar.sourceKind,
        eventCount: sourceRecords.length,
        tokens: sourceRecords.reduce((sum, record) => sum + tokens(record), 0),
        firstSeen: range.first,
        lastSeen: range.last,
        lastRefresh: latestReceipt,
        gaps: gapsForIntervals(start, intervals),
      }
    })

    // A historical stats cache may exist before the first ledger hydration.
    if (provider === 'claude') for (const snapshot of claudeSnapshots) {
      if (sources.some(source => source.id === snapshot.sourceId)) continue
      sources.push({
        id: snapshot.sourceId,
        label: snapshot.sourceLabel,
        kind: 'claude-config',
        eventCount: snapshot.totalSessions,
        tokens: totalStoreTokens({ version: 1, ...snapshot }),
        firstSeen: snapshot.firstSessionDate,
        lastSeen: snapshot.lastComputedDate,
        lastRefresh: snapshot.importedAt,
        gaps: gapsForIntervals(start, [{ start: snapshot.firstSessionDate, end: snapshot.lastComputedDate }]),
      })
    }

    const range = extrema(records.map(record => record.timestamp))
    const exactTokens = records.filter(record => !record.estimated).reduce((sum, record) => sum + tokens(record), 0)
    const estimatedTokens = records.filter(record => record.estimated).reduce((sum, record) => sum + tokens(record), 0)
    const warnings: string[] = []
    if (sources.length === 0 || sources.some(source => source.gaps.length > 0)) warnings.push(`No token-bearing source covers every date from ${start}.`)
    if (provider === 'claude' && claudeSnapshots.length > 0) warnings.push('Imported Claude aggregate totals are exact; their cache-token allocation by day is estimated.')
    if (provider === 'claude' && sources.some(source => source.kind === 'legacy-unknown')) warnings.push('Some older Claude rows predate source identity capture; their tokens are preserved but cannot be assigned to a Claude account.')
    providers.push({
      provider,
      label: provider === 'claude' ? 'Claude Code' : 'Codex',
      quality: estimatedTokens > 0 && exactTokens > 0 ? 'mixed' : estimatedTokens > 0 ? 'estimated' : 'exact',
      eventCount: records.length,
      exactTokens,
      estimatedTokens,
      firstSeen: range.first,
      lastSeen: range.last,
      lastRefresh: extrema(records.map(record => record.recordedAt)).last,
      sources: sources.sort((a, b) => a.label.localeCompare(b.label)),
      warnings,
    })
  }

  const cursorByAccount = new Map<string, typeof cursor.events>()
  for (const event of cursor.events) {
    const account = event.account ?? 'unlabeled'
    const group = cursorByAccount.get(account) ?? []
    group.push(event)
    cursorByAccount.set(account, group)
  }
  const cursorSources: TrackingSourceCoverage[] = [...cursorByAccount.entries()].map(([account, events]) => {
    const range = extrema(events.map(event => event.timestamp))
    const importedAt = cursor.imports.filter(receipt => (receipt.account ?? 'unlabeled') === account).map(receipt => receipt.importedAt).sort().at(-1) ?? null
    return {
      id: `cursor:${account}`,
      label: account,
      kind: 'server-export',
      eventCount: events.length,
      tokens: events.reduce((sum, event) => sum + tokens(event), 0),
      firstSeen: range.first,
      lastSeen: range.last,
      lastRefresh: importedAt,
      gaps: range.first && range.last ? gapsForIntervals(start, [{ start: range.first, end: range.last }]) : gapsForIntervals(start, []),
    }
  })
  const cursorRange = extrema(cursor.events.map(event => event.timestamp))
  const cursorWarnings: string[] = []
  if (cursorSources.length < 3) cursorWarnings.push(`Only ${cursorSources.length} stable Cursor account label(s) are present; expected 3.`)
  if (cursorSources.some(source => source.gaps.length > 0)) cursorWarnings.push(`No Cursor export covers every date from ${start}.`)
  const cursorStale = cursorSources.some(source => !source.lastRefresh || Date.parse(source.lastRefresh) < now.getTime() - 7 * 24 * 60 * 60 * 1000)
  if (cursorStale) cursorWarnings.push('At least one Cursor account export is more than 7 days old.')
  cursorWarnings.push('Cursor Agent is kept separate from dashboard exports because neither source exposes a stable shared event ID; possible overlap is reported instead of silently deleting usage.')
  providers.push({
    provider: 'cursor',
    label: 'Cursor',
    quality: 'exact',
    eventCount: cursor.events.length,
    exactTokens: cursor.events.reduce((sum, event) => sum + tokens(event), 0),
    estimatedTokens: 0,
    firstSeen: cursorRange.first,
    lastSeen: cursorRange.last,
    lastRefresh: cursor.updatedAt || null,
    sources: cursorSources.sort((a, b) => a.label.localeCompare(b.label)),
    warnings: cursorWarnings,
  })

  const warnings = providers.flatMap(provider => provider.warnings.map(warning => `${provider.label}: ${warning}`))
  const coverage: TrackingCoverage = {
    targetStart: start,
    targetEnd,
    confidence: warnings.length > 0 ? 'verified-minimum' : 'complete',
    ledger: {
      path: getUsageLedgerPath(),
      events: ledger.records.length,
      revisions: ledger.revisions,
      invalidLines: ledger.invalidLines,
    },
    providers,
    warnings,
  }
  await saveCoverageCache(coverage, now)
  return coverage
}
