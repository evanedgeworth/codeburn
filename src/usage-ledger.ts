import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { DateRange, ProjectSummary, SessionSourceMetadata } from './types.js'

const LEDGER_VERSION = 1
const TRACKED_PROVIDERS = new Set(['claude', 'codex'])

export type UsageLedgerRecord = {
  version: number
  recordedAt: string
  eventId: string
  revisionHash: string
  provider: 'claude' | 'codex'
  model: string
  timestamp: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  webSearchRequests: number
  costUSD: number
  estimated: boolean
  deduplicationKey: string
  sessionId: string
  project: string
  projectPath: string
  sourceId: string
  sourceLabel: string
  sourcePath: string
  sourceKind: 'claude-config' | 'claude-desktop' | 'codex-home'
}

export type UsageLedgerReadResult = {
  records: UsageLedgerRecord[]
  revisions: number
  invalidLines: number
}

export type UsageLedgerSyncResult = {
  appended: number
  revised: number
  totalEvents: number
  path: string
}

type UsageLedgerIndex = {
  version: number
  ledgerSize: number
  ledgerMtimeMs: number
  revisions: number
  entries: Record<string, string>
}

function hash(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

export function getUsageLedgerPath(): string {
  return process.env['CODEBURN_USAGE_LEDGER']
    ?? join(homedir(), '.config', 'codeburn', 'usage-ledger.v1.jsonl')
}

export function getUsageLedgerHash(): string {
  try {
    const info = statSync(getUsageLedgerPath())
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return 'none'
  }
}

function getUsageLedgerIndexPath(): string {
  return `${getUsageLedgerPath()}.index.json`
}

function ledgerStat(): { size: number; mtimeMs: number } | null {
  try {
    const info = statSync(getUsageLedgerPath())
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isUsageLedgerRecord(value: unknown): value is UsageLedgerRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record['version'] === LEDGER_VERSION
    && (record['provider'] === 'claude' || record['provider'] === 'codex')
    && ['recordedAt', 'eventId', 'revisionHash', 'model', 'timestamp', 'deduplicationKey',
      'sessionId', 'project', 'projectPath', 'sourceId', 'sourceLabel', 'sourcePath', 'sourceKind']
      .every(key => typeof record[key] === 'string')
    && ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens',
      'cachedInputTokens', 'reasoningTokens', 'webSearchRequests', 'costUSD']
      .every(key => finiteNonNegative(record[key]))
    && typeof record['estimated'] === 'boolean'
}

/**
 * Read the metadata-only append log and collapse revisions by event id. A
 * truncated final line (for example after a power loss) is ignored while every
 * earlier valid record remains usable.
 */
export async function readUsageLedger(): Promise<UsageLedgerReadResult> {
  let raw: string
  try { raw = await readFile(getUsageLedgerPath(), 'utf8') } catch { return { records: [], revisions: 0, invalidLines: 0 } }
  const latest = new Map<string, UsageLedgerRecord>()
  let revisions = 0
  let invalidLines = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (!isUsageLedgerRecord(parsed)) { invalidLines++; continue }
      if (latest.has(parsed.eventId)) revisions++
      latest.set(parsed.eventId, parsed)
    } catch {
      invalidLines++
    }
  }
  return {
    records: [...latest.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId)),
    revisions,
    invalidLines,
  }
}

async function saveUsageLedgerIndex(entries: Map<string, string>, revisions: number): Promise<void> {
  const info = ledgerStat()
  if (!info) return
  const target = getUsageLedgerIndexPath()
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temp = `${target}.${process.pid}.tmp`
  const index: UsageLedgerIndex = {
    version: LEDGER_VERSION,
    ledgerSize: info.size,
    ledgerMtimeMs: info.mtimeMs,
    revisions,
    entries: Object.fromEntries(entries),
  }
  await writeFile(temp, JSON.stringify(index), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, target)
}

async function readUsageLedgerIndex(): Promise<{ entries: Map<string, string>; revisions: number }> {
  const info = ledgerStat()
  if (!info) return { entries: new Map(), revisions: 0 }
  try {
    const parsed = JSON.parse(await readFile(getUsageLedgerIndexPath(), 'utf8')) as Partial<UsageLedgerIndex>
    if (parsed.version === LEDGER_VERSION
      && parsed.ledgerSize === info.size
      && parsed.ledgerMtimeMs === info.mtimeMs
      && parsed.entries && typeof parsed.entries === 'object') {
      return { entries: new Map(Object.entries(parsed.entries)), revisions: parsed.revisions ?? 0 }
    }
  } catch {
    // Rebuild below from the authoritative append log.
  }
  const ledger = await readUsageLedger()
  const entries = new Map(ledger.records.map(record => [record.eventId, record.revisionHash]))
  await saveUsageLedgerIndex(entries, ledger.revisions)
  return { entries, revisions: ledger.revisions }
}

function codexSource(): { id: string; label: string; path: string; kind: 'codex-home' } {
  const path = resolve(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'))
  return { id: `codex-home:${hash(path, 16)}`, label: 'Default Codex', path, kind: 'codex-home' }
}

function sourceFor(provider: string, source?: SessionSourceMetadata): { id: string; label: string; path: string; kind: UsageLedgerRecord['sourceKind'] } {
  if (provider === 'claude' && source) return { id: source.id, label: source.label, path: source.path, kind: source.kind }
  return codexSource()
}

export function usageLedgerSourceFor(provider: string, source?: SessionSourceMetadata): { id: string; label: string; path: string; kind: UsageLedgerRecord['sourceKind'] } {
  return sourceFor(provider, source)
}

export function usageLedgerEventId(provider: string, sourceId: string, sessionId: string, deduplicationKey: string): string {
  return hash(`${provider}\u0000${sourceId}\u0000${sessionId}\u0000${deduplicationKey}`)
}

function revisionPayload(record: Omit<UsageLedgerRecord, 'recordedAt' | 'revisionHash'>): string {
  return JSON.stringify([
    record.provider, record.model, record.timestamp,
    record.inputTokens, record.outputTokens, record.cacheWriteTokens,
    record.cacheReadTokens, record.cachedInputTokens, record.reasoningTokens,
    record.webSearchRequests, record.costUSD, record.estimated,
    record.project, record.projectPath, record.sourceId, record.sourceLabel, record.sourcePath, record.sourceKind,
  ])
}

function recordsFromProjects(projects: ProjectSummary[]): UsageLedgerRecord[] {
  const recordedAt = new Date().toISOString()
  const candidates: UsageLedgerRecord[] = []
  for (const project of projects) for (const session of project.sessions) {
    for (const turn of session.turns) for (const call of turn.assistantCalls) {
      if (!TRACKED_PROVIDERS.has(call.provider)) continue
      const provider = call.provider as UsageLedgerRecord['provider']
      const source = sourceFor(provider, session.source)
      const eventId = usageLedgerEventId(provider, source.id, session.sessionId, call.deduplicationKey)
      const base: Omit<UsageLedgerRecord, 'recordedAt' | 'revisionHash'> = {
        version: LEDGER_VERSION,
        eventId,
        provider,
        model: call.model,
        timestamp: call.timestamp,
        inputTokens: call.usage.inputTokens,
        outputTokens: call.usage.outputTokens,
        cacheWriteTokens: call.usage.cacheCreationInputTokens,
        cacheReadTokens: call.usage.cacheReadInputTokens,
        cachedInputTokens: call.usage.cachedInputTokens,
        reasoningTokens: call.usage.reasoningTokens,
        webSearchRequests: call.usage.webSearchRequests,
        costUSD: call.costUSD,
        estimated: call.isEstimated === true,
        deduplicationKey: call.deduplicationKey,
        sessionId: session.sessionId,
        project: project.project,
        projectPath: project.projectPath,
        sourceId: source.id,
        sourceLabel: source.label,
        sourcePath: source.path,
        sourceKind: source.kind,
      }
      candidates.push({ ...base, recordedAt, revisionHash: hash(revisionPayload(base), 32) })
    }
  }
  return candidates
}

/** Append new events and corrected revisions without ever rewriting old rows. */
export async function syncUsageLedger(projects: ProjectSummary[]): Promise<UsageLedgerSyncResult> {
  const prior = await readUsageLedgerIndex()
  const latest = new Map(prior.entries)
  const additions: UsageLedgerRecord[] = []
  let revised = 0
  for (const record of recordsFromProjects(projects)) {
    const existing = latest.get(record.eventId)
    if (existing === record.revisionHash) continue
    if (existing) revised++
    latest.set(record.eventId, record.revisionHash)
    additions.push(record)
  }
  if (additions.length > 0) {
    const path = getUsageLedgerPath()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // O_APPEND keeps each chunk behind any concurrent writer's complete chunk.
    // Rows are small and metadata-only; prompts, tool output and commands never
    // enter this file.
    const chunkSize = 100
    for (let i = 0; i < additions.length; i += chunkSize) {
      const chunk = additions.slice(i, i + chunkSize).map(record => JSON.stringify(record)).join('\n') + '\n'
      await appendFile(path, chunk, { encoding: 'utf8', mode: 0o600 })
    }
    await saveUsageLedgerIndex(latest, prior.revisions + revised)
  }
  return { appended: additions.length, revised, totalEvents: latest.size, path: getUsageLedgerPath() }
}

export function recordInRange(record: UsageLedgerRecord, range?: DateRange): boolean {
  if (!range) return true
  const timestamp = Date.parse(record.timestamp)
  return Number.isFinite(timestamp) && timestamp >= range.start.getTime() && timestamp <= range.end.getTime()
}

export function sourceMetadataForRecord(record: UsageLedgerRecord): SessionSourceMetadata | undefined {
  if (record.sourceKind === 'codex-home') return undefined
  return { id: record.sourceId, label: record.sourceLabel, path: record.sourcePath, kind: record.sourceKind }
}
