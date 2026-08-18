import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  importCursorUsageCsv,
  readCursorUsageStore,
  reconcileCursorCalls,
} from '../src/cursor-server-import.js'
import type { ParsedProviderCall } from '../src/providers/types.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-cursor-import-'))
  process.env['CODEBURN_CURSOR_USAGE_STORE'] = join(root, 'cursor-usage.json')
})

afterEach(async () => {
  delete process.env['CODEBURN_CURSOR_USAGE_STORE']
  await rm(root, { recursive: true, force: true })
})

function localCall(overrides: Partial<ParsedProviderCall>): ParsedProviderCall {
  return {
    provider: 'cursor',
    model: 'claude-4.6-sonnet',
    inputTokens: 100,
    outputTokens: 10,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.1,
    costIsEstimated: true,
    tools: ['Read'],
    bashCommands: [],
    timestamp: '2026-08-17T10:01:00.000Z',
    speed: 'standard',
    deduplicationKey: 'cursor:local:1',
    userMessage: 'test',
    sessionId: 'composer-1',
    ...overrides,
  }
}

describe('Cursor server usage CSV import', () => {
  it('parses quoted rows, cache tokens, cents, and deduplicates overlapping imports', async () => {
    const fixture = join(import.meta.dirname, 'fixtures/cursor-usage/usage-events.csv')
    const first = await importCursorUsageCsv(fixture)
    const second = await importCursorUsageCsv(fixture)

    expect(first).toMatchObject({ importedRows: 3, duplicateRows: 0, skippedRows: 0, totalEvents: 3 })
    expect(second).toMatchObject({ importedRows: 0, duplicateRows: 3, totalEvents: 3 })

    const store = await readCursorUsageStore()
    expect(store.events).toHaveLength(3)
    expect(store.events[0]).toMatchObject({
      model: 'claude-4.6-sonnet',
      kind: 'Included, Ultra',
      inputTokens: 1000,
      outputTokens: 100,
      cacheWriteTokens: 200,
      cacheReadTokens: 3000,
      costUSD: 1.25,
    })
    const mode = (await stat(process.env['CODEBURN_CURSOR_USAGE_STORE']!)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('replaces matching local estimates with exact server totals while preserving attribution', async () => {
    const fixture = join(import.meta.dirname, 'fixtures/cursor-usage/usage-events.csv')
    await importCursorUsageCsv(fixture)
    const calls = [
      localCall({ deduplicationKey: 'cursor:local:1', inputTokens: 100, outputTokens: 10, tools: ['Read'] }),
      localCall({ deduplicationKey: 'cursor:local:2', inputTokens: 300, outputTokens: 30, tools: ['Bash'] }),
    ]

    const reconciled = await reconcileCursorCalls(calls)
    const attributed = reconciled.filter(call => call.sessionId === 'composer-1')
    expect(attributed).toHaveLength(2)
    expect(attributed.flatMap(call => call.tools)).toEqual(['Read', 'Bash'])
    expect(attributed.reduce((sum, call) => sum + call.inputTokens, 0)).toBe(4000)
    expect(attributed.reduce((sum, call) => sum + call.outputTokens, 0)).toBe(400)
    expect(attributed.reduce((sum, call) => sum + call.cacheCreationInputTokens, 0)).toBe(600)
    expect(attributed.reduce((sum, call) => sum + call.cacheReadInputTokens, 0)).toBe(10000)
    expect(attributed.reduce((sum, call) => sum + call.costUSD, 0)).toBeCloseTo(5)
    expect(attributed.every(call => call.costIsEstimated === false)).toBe(true)

    const unmatched = reconciled.find(call => call.model === 'gpt-5.6-sol')
    expect(unmatched).toMatchObject({
      provider: 'cursor',
      inputTokens: 500,
      outputTokens: 50,
      cacheCreationInputTokens: 25,
      cacheReadInputTokens: 750,
      costUSD: 0.5,
      costIsEstimated: false,
    })
    expect(unmatched?.deduplicationKey).toMatch(/^cursor:server:/)
  })

  it('keeps local work after the latest export as estimated', async () => {
    const fixture = join(import.meta.dirname, 'fixtures/cursor-usage/usage-events.csv')
    await importCursorUsageCsv(fixture)
    const afterExport = localCall({
      timestamp: '2026-08-17T13:00:00.000Z',
      deduplicationKey: 'cursor:local:later',
    })

    const reconciled = await reconcileCursorCalls([afterExport])
    const later = reconciled.find(call => call.deduplicationKey === 'cursor:local:later')
    expect(later).toMatchObject({ inputTokens: 100, outputTokens: 10, costIsEstimated: true })
  })
})
