import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { calculateCost } from './models.js'
import type { DateRange, ProjectSummary } from './types.js'
import type { ParsedProviderCall, ProbeRoot } from './providers/types.js'

const STORE_VERSION = 1
const STORE_FILE = 'cursor-usage.json'

export type CursorServerUsageEvent = {
  id: string
  account?: string
  timestamp: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  costUSD: number
  kind?: string
}

type CursorImportReceipt = {
  sourceName: string
  account?: string
  importedAt: string
  rows: number
}

export type CursorUsageStore = {
  version: number
  updatedAt: string
  events: CursorServerUsageEvent[]
  imports: CursorImportReceipt[]
}

export type CursorImportResult = {
  sourceName: string
  account: string | null
  parsedRows: number
  importedRows: number
  duplicateRows: number
  skippedRows: number
  totalEvents: number
  coverageStart: string | null
  coverageEnd: string | null
  storePath: string
}

export type CursorTrackingCoverage = {
  source: 'server-export' | 'local-estimate'
  importedAt: string | null
  coverageStart: string | null
  coverageEnd: string | null
  measuredCostUSD: number
  estimatedCostUSD: number
  measuredTokens: number
  estimatedTokens: number
  measuredPercent: number
}

export function getCursorUsageStorePath(): string {
  return process.env['CODEBURN_CURSOR_USAGE_STORE']
    ?? join(homedir(), '.config', 'codeburn', STORE_FILE)
}

export function getCursorUsageProbeRoot(): ProbeRoot {
  return { path: dirname(getCursorUsageStorePath()), label: 'server exports' }
}

export function getCursorUsageStoreHash(): string {
  try {
    const path = getCursorUsageStorePath()
    const stat = statSync(path)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'none'
  }
}

export async function readCursorUsageStore(): Promise<CursorUsageStore> {
  try {
    const parsed = JSON.parse(await readFile(getCursorUsageStorePath(), 'utf8')) as Partial<CursorUsageStore>
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.events)) return emptyStore()
    return {
      version: STORE_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      events: parsed.events.filter(isStoredEvent),
      imports: Array.isArray(parsed.imports) ? parsed.imports.filter(isImportReceipt) : [],
    }
  } catch {
    return emptyStore()
  }
}

function emptyStore(): CursorUsageStore {
  return { version: STORE_VERSION, updatedAt: '', events: [], imports: [] }
}

function isStoredEvent(value: unknown): value is CursorServerUsageEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Record<string, unknown>
  return typeof event.id === 'string'
    && (event.account === undefined || typeof event.account === 'string')
    && typeof event.timestamp === 'string'
    && typeof event.model === 'string'
    && ['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'costUSD']
      .every(key => typeof event[key] === 'number' && Number.isFinite(event[key]))
}

function isImportReceipt(value: unknown): value is CursorImportReceipt {
  if (!value || typeof value !== 'object') return false
  const receipt = value as Record<string, unknown>
  return typeof receipt.sourceName === 'string'
    && (receipt.account === undefined || typeof receipt.account === 'string')
    && typeof receipt.importedAt === 'string'
    && typeof receipt.rows === 'number'
}

async function saveCursorUsageStore(store: CursorUsageStore): Promise<void> {
  const target = getCursorUsageStorePath()
  const dir = dirname(target)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = `${target}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(temp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

function parseCsv(raw: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!
    if (quoted) {
      if (char === '"' && raw[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''))
      if (row.some(value => value.trim() !== '')) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  row.push(cell.replace(/\r$/, ''))
  if (row.some(value => value.trim() !== '')) rows.push(row)
  return rows
}

function headerKey(value: string): string {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function findColumn(headers: string[], aliases: string[]): number {
  const keys = headers.map(headerKey)
  for (const alias of aliases) {
    const index = keys.indexOf(alias)
    if (index >= 0) return index
  }
  return -1
}

function parseNonNegative(value: string | undefined): number {
  if (!value) return 0
  const normalized = value.trim().replace(/[$,\s]/g, '')
  if (!normalized) return 0
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function parseTimestamp(value: string | undefined): string | null {
  if (!value?.trim()) return null
  const trimmed = value.trim()
  const numeric = Number(trimmed)
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(trimmed)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeCursorModel(model: string): string {
  const normalized = model.trim().toLowerCase()
    .replace(/[()]/g, '')
    .replace(/[\s_/]+/g, '-')
    .replace(/-+/g, '-')
  if (!normalized || normalized === 'auto' || normalized === 'cursor-auto') return 'cursor-auto'
  return normalized
}

function eventId(event: Omit<CursorServerUsageEvent, 'id'>, occurrence: number): string {
  const stable = [
    event.account ?? '',
    event.timestamp,
    normalizeCursorModel(event.model),
    event.inputTokens,
    event.outputTokens,
    event.cacheWriteTokens,
    event.cacheReadTokens,
    event.costUSD.toFixed(8),
    event.kind ?? '',
    occurrence,
  ].join('\u0000')
  return createHash('sha256').update(stable).digest('hex').slice(0, 24)
}

function parseCursorCsv(raw: string, account?: string): { events: CursorServerUsageEvent[]; parsedRows: number; skippedRows: number } {
  const rows = parseCsv(raw)
  if (rows.length === 0) throw new Error('CSV is empty')
  const headers = rows[0]!
  const timestampCol = findColumn(headers, ['timestamp', 'date', 'datetime', 'createdat', 'time'])
  const modelCol = findColumn(headers, ['model', 'modelname', 'modelintent'])
  const inputCol = findColumn(headers, ['inputtokens', 'inputtoken', 'input', 'inputwocachewrite', 'inputwithoutcachewrite'])
  const outputCol = findColumn(headers, ['outputtokens', 'outputtoken', 'output'])
  const cacheWriteCol = findColumn(headers, ['cachewritetokens', 'cachecreationtokens', 'cachecreatetokens', 'cachewrite', 'inputwcachewrite', 'inputwithcachewrite'])
  const cacheReadCol = findColumn(headers, ['cachereadtokens', 'cachedinputtokens', 'cacheread'])
  const totalTokensCol = findColumn(headers, ['totaltokens', 'total'])
  const totalCentsCol = findColumn(headers, ['totalcents'])
  const costCol = findColumn(headers, ['costusd', 'totalcostusd', 'totalcost', 'cost', 'amountusd', 'apicost'])
  const kindCol = findColumn(headers, ['kind', 'usagetype', 'type'])

  if (timestampCol < 0 || modelCol < 0) {
    throw new Error(`Cursor usage CSV needs timestamp/date and model columns; found: ${headers.join(', ')}`)
  }
  if ([inputCol, outputCol, cacheWriteCol, cacheReadCol, totalTokensCol, totalCentsCol, costCol].every(index => index < 0)) {
    throw new Error('Cursor usage CSV has no token or cost columns')
  }

  const events: CursorServerUsageEvent[] = []
  const occurrences = new Map<string, number>()
  let skippedRows = 0
  for (const row of rows.slice(1)) {
    const timestamp = parseTimestamp(row[timestampCol])
    const model = row[modelCol]?.trim() ?? ''
    if (!timestamp || !model) {
      skippedRows += 1
      continue
    }
    let inputTokens = parseNonNegative(row[inputCol])
    const outputTokens = parseNonNegative(row[outputCol])
    const cacheWriteTokens = parseNonNegative(row[cacheWriteCol])
    const cacheReadTokens = parseNonNegative(row[cacheReadCol])
    const detailedTokens = inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens
    if (detailedTokens === 0) inputTokens = parseNonNegative(row[totalTokensCol])
    const explicitCost = totalCentsCol >= 0
      ? parseNonNegative(row[totalCentsCol]) / 100
      : parseNonNegative(row[costCol])
    const costUSD = explicitCost || calculateCost(
      normalizeCursorModel(model), inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, 0,
    )
    if (inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens === 0 && costUSD === 0) {
      skippedRows += 1
      continue
    }
    const withoutId = {
      ...(account ? { account } : {}),
      timestamp,
      model,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      costUSD,
      ...(kindCol >= 0 && row[kindCol]?.trim() ? { kind: row[kindCol]!.trim() } : {}),
    }
    const contentKey = eventId(withoutId, 0)
    const occurrence = occurrences.get(contentKey) ?? 0
    occurrences.set(contentKey, occurrence + 1)
    events.push({ id: eventId(withoutId, occurrence), ...withoutId })
  }
  return { events, parsedRows: Math.max(0, rows.length - 1), skippedRows }
}

export async function importCursorUsageCsv(filePath: string, options?: { account?: string }): Promise<CursorImportResult> {
  const raw = await readFile(filePath, 'utf8')
  const account = options?.account?.trim() || undefined
  const parsed = parseCursorCsv(raw, account)
  const current = await readCursorUsageStore()
  const byId = new Map(current.events.map(event => [event.id, event]))
  let duplicateRows = 0
  for (const event of parsed.events) {
    if (byId.has(event.id)) duplicateRows += 1
    byId.set(event.id, event)
  }
  const importedAt = new Date().toISOString()
  const events = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))
  const sourceName = basename(filePath)
  const imports = [...current.imports, {
    sourceName,
    ...(account ? { account } : {}),
    importedAt,
    rows: parsed.events.length,
  }].slice(-50)
  await saveCursorUsageStore({ version: STORE_VERSION, updatedAt: importedAt, events, imports })
  return {
    sourceName,
    account: account ?? null,
    parsedRows: parsed.parsedRows,
    importedRows: parsed.events.length - duplicateRows,
    duplicateRows,
    skippedRows: parsed.skippedRows,
    totalEvents: events.length,
    coverageStart: events[0]?.timestamp ?? null,
    coverageEnd: events.at(-1)?.timestamp ?? null,
    storePath: getCursorUsageStorePath(),
  }
}

function localDateKey(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function groupKey(timestamp: string, model: string): string {
  return `${localDateKey(timestamp)}\u0000${normalizeCursorModel(model)}`
}

function allocateInteger(total: number, weights: number[]): number[] {
  const safeTotal = Math.max(0, Math.round(total))
  if (weights.length === 0) return []
  const safeWeights = weights.map(weight => Number.isFinite(weight) && weight > 0 ? weight : 0)
  const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0)
  const effective = weightTotal > 0 ? safeWeights : safeWeights.map(() => 1)
  const effectiveTotal = effective.reduce((sum, weight) => sum + weight, 0)
  const raw = effective.map(weight => safeTotal * weight / effectiveTotal)
  const out = raw.map(Math.floor)
  let remainder = safeTotal - out.reduce((sum, value) => sum + value, 0)
  const order = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let i = 0; i < remainder; i++) out[order[i % order.length]!.index]! += 1
  return out
}

function allocateFloat(total: number, weights: number[]): number[] {
  if (weights.length === 0) return []
  const safeWeights = weights.map(weight => Number.isFinite(weight) && weight > 0 ? weight : 0)
  const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0)
  const effective = weightTotal > 0 ? safeWeights : safeWeights.map(() => 1)
  const effectiveTotal = effective.reduce((sum, weight) => sum + weight, 0)
  const out = effective.map(weight => total * weight / effectiveTotal)
  out[out.length - 1] = total - out.slice(0, -1).reduce((sum, value) => sum + value, 0)
  return out
}

export async function reconcileCursorCalls(localCalls: ParsedProviderCall[]): Promise<ParsedProviderCall[]> {
  const store = await readCursorUsageStore()
  if (store.events.length === 0) return localCalls

  const serverGroups = new Map<string, CursorServerUsageEvent[]>()
  for (const event of store.events) {
    const key = groupKey(event.timestamp, event.model)
    const group = serverGroups.get(key) ?? []
    group.push(event)
    serverGroups.set(key, group)
  }

  const latestServerMs = Math.max(...store.events.map(event => Date.parse(event.timestamp)).filter(Number.isFinite))
  if (!Number.isFinite(latestServerMs)) return localCalls
  // Cursor exports are complete through their last event. Give the matching
  // local response a small completion window, while keeping later live work as
  // a local estimate until the next export is imported.
  const coveredThroughMs = latestServerMs + 15 * 60 * 1000
  const eligibleByGroup = new Map<string, number[]>()
  for (let index = 0; index < localCalls.length; index++) {
    const call = localCalls[index]!
    const callMs = Date.parse(call.timestamp)
    if (!Number.isFinite(callMs) || callMs > coveredThroughMs) continue
    const key = groupKey(call.timestamp, call.model)
    if (!serverGroups.has(key)) continue
    const indices = eligibleByGroup.get(key) ?? []
    indices.push(index)
    eligibleByGroup.set(key, indices)
  }

  const reconciled = localCalls.map(call => ({ ...call }))
  for (const [key, events] of serverGroups) {
    const indices = eligibleByGroup.get(key) ?? []
    if (indices.length === 0) {
      for (const event of events) {
        reconciled.push({
          provider: 'cursor',
          model: normalizeCursorModel(event.model),
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheCreationInputTokens: event.cacheWriteTokens,
          cacheReadInputTokens: event.cacheReadTokens,
          cachedInputTokens: event.cacheReadTokens,
          reasoningTokens: 0,
          webSearchRequests: 0,
          costUSD: event.costUSD,
          costIsEstimated: false,
          tools: [],
          bashCommands: [],
          timestamp: event.timestamp,
          speed: 'standard',
          deduplicationKey: `cursor:server:${event.id}`,
          userMessage: '',
          sessionId: `cursor-server:${localDateKey(event.timestamp)}:${normalizeCursorModel(event.model)}`,
        })
      }
      continue
    }

    const totals = events.reduce((sum, event) => ({
      input: sum.input + event.inputTokens,
      output: sum.output + event.outputTokens,
      cacheWrite: sum.cacheWrite + event.cacheWriteTokens,
      cacheRead: sum.cacheRead + event.cacheReadTokens,
      cost: sum.cost + event.costUSD,
    }), { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 })
    const inputWeights = indices.map(index => localCalls[index]!.inputTokens)
    const outputWeights = indices.map(index => localCalls[index]!.outputTokens)
    const costWeights = indices.map(index => localCalls[index]!.costUSD)
    const inputs = allocateInteger(totals.input, inputWeights)
    const outputs = allocateInteger(totals.output, outputWeights)
    const cacheWrites = allocateInteger(totals.cacheWrite, inputWeights)
    const cacheReads = allocateInteger(totals.cacheRead, inputWeights)
    const costs = allocateFloat(totals.cost, costWeights)
    indices.forEach((callIndex, groupIndex) => {
      reconciled[callIndex] = {
        ...reconciled[callIndex]!,
        inputTokens: inputs[groupIndex]!,
        outputTokens: outputs[groupIndex]!,
        cacheCreationInputTokens: cacheWrites[groupIndex]!,
        cacheReadInputTokens: cacheReads[groupIndex]!,
        cachedInputTokens: cacheReads[groupIndex]!,
        costUSD: costs[groupIndex]!,
        costIsEstimated: false,
      }
    })
  }
  return reconciled
}

function inRange(timestamp: string, range: DateRange): boolean {
  const ms = Date.parse(timestamp)
  return Number.isFinite(ms) && ms >= range.start.getTime() && ms <= range.end.getTime()
}

export async function buildCursorTrackingCoverage(
  projects: ProjectSummary[],
  range: DateRange,
): Promise<CursorTrackingCoverage | undefined> {
  let measuredCostUSD = 0
  let estimatedCostUSD = 0
  let measuredTokens = 0
  let estimatedTokens = 0
  let cursorCalls = 0
  for (const call of projects.flatMap(project => project.sessions).flatMap(session => session.turns).flatMap(turn => turn.assistantCalls)) {
    if (call.provider !== 'cursor') continue
    cursorCalls += 1
    const tokens = call.usage.inputTokens + call.usage.outputTokens
      + call.usage.cacheCreationInputTokens + call.usage.cacheReadInputTokens
    if (call.isEstimated) {
      estimatedCostUSD += call.costUSD
      estimatedTokens += tokens
    } else {
      measuredCostUSD += call.costUSD
      measuredTokens += tokens
    }
  }
  const store = await readCursorUsageStore()
  const events = store.events.filter(event => inRange(event.timestamp, range))
  if (cursorCalls === 0 && events.length === 0) return undefined
  const measuredDenominator = measuredTokens + estimatedTokens
  const costDenominator = measuredCostUSD + estimatedCostUSD
  const measuredPercent = measuredDenominator > 0
    ? measuredTokens / measuredDenominator
    : costDenominator > 0 ? measuredCostUSD / costDenominator : 0
  return {
    source: events.length > 0 ? 'server-export' : 'local-estimate',
    importedAt: store.updatedAt || null,
    coverageStart: events[0]?.timestamp ?? null,
    coverageEnd: events.at(-1)?.timestamp ?? null,
    measuredCostUSD,
    estimatedCostUSD,
    measuredTokens,
    estimatedTokens,
    measuredPercent,
  }
}
