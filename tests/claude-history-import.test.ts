import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildClaudeHistoricalCalls,
  importClaudeStatsCache,
  readClaudeHistorySnapshots,
  readClaudeHistoryStore,
} from '../src/claude-history-import.js'

const tempDirs: string[] = []

async function fixture(): Promise<{ dir: string; source: string; store: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codeburn-claude-history-'))
  tempDirs.push(dir)
  const source = join(dir, 'stats-cache.json')
  const store = join(dir, 'claude-history.json')
  process.env['CODEBURN_CLAUDE_HISTORY_STORE'] = store
  await writeFile(source, JSON.stringify({
    version: 3,
    firstSessionDate: '2026-04-27T10:00:00.000Z',
    lastComputedDate: '2026-04-28',
    totalSessions: 12,
    totalMessages: 34,
    modelUsage: {
      'claude-opus-test': {
        inputTokens: 30,
        outputTokens: 70,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 100,
        webSearchRequests: 2,
      },
    },
    dailyModelTokens: [
      { date: '2026-04-27', tokensByModel: { 'claude-opus-test': 25 } },
      { date: '2026-04-28', tokensByModel: { 'claude-opus-test': 75 } },
    ],
  }))
  return { dir, source, store }
}

afterEach(async () => {
  delete process.env['CODEBURN_CLAUDE_HISTORY_STORE']
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('Claude historical stats import', () => {
  it('persists exact aggregate components and reconstructs exact lifetime tokens', async () => {
    const { source, store } = await fixture()
    const result = await importClaudeStatsCache(source)
    expect(result.totalTokens).toBe(1100)
    expect(JSON.parse(await readFile(store, 'utf8')).sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect((await readClaudeHistoryStore())?.totalSessions).toBe(12)

    const historical = await buildClaudeHistoricalCalls()
    expect(historical.exactAggregateTokens).toBe(1100)
    expect(historical.includedTokens).toBe(1100)
    expect(historical.calls).toHaveLength(2)
    expect(historical.calls.every(call => call.provider === 'claude' && call.costIsEstimated)).toBe(true)
  })

  it('excludes complete overlap days rather than double-counting', async () => {
    const { source } = await fixture()
    await importClaudeStatsCache(source)
    const historical = await buildClaudeHistoricalCalls(undefined, new Set(['2026-04-28']))
    expect(historical.excludedOverlapDays).toEqual(['2026-04-28'])
    expect(historical.calls.map(call => call.timestamp.slice(0, 10))).toEqual(['2026-04-27'])
    expect(historical.includedTokens + historical.excludedOverlapTokens).toBe(1100)
  })

  it('rejects a daily series that cannot reconcile to model input plus output', async () => {
    const { source } = await fixture()
    const parsed = JSON.parse(await readFile(source, 'utf8'))
    parsed.dailyModelTokens[1].tokensByModel['claude-opus-test'] = 74
    await writeFile(source, JSON.stringify(parsed))
    await expect(importClaudeStatsCache(source)).rejects.toThrow('does not reconcile')
  })

  it('updates a growing stats cache within one generation without double-counting', async () => {
    const { source } = await fixture()
    const first = await importClaudeStatsCache(source)
    const parsed = JSON.parse(await readFile(source, 'utf8'))
    parsed.totalSessions = 13
    parsed.totalMessages = 36
    parsed.modelUsage['claude-opus-test'].inputTokens += 10
    parsed.modelUsage['claude-opus-test'].cacheReadInputTokens += 50
    parsed.dailyModelTokens[1].tokensByModel['claude-opus-test'] += 10
    await writeFile(source, JSON.stringify(parsed))

    const second = await importClaudeStatsCache(source)
    const active = await readClaudeHistorySnapshots()
    expect(second.generationId).toBe(first.generationId)
    expect(active).toHaveLength(1)
    expect((await buildClaudeHistoricalCalls()).exactAggregateTokens).toBe(1160)
  })

  it('preserves a reset stats cache as a new generation', async () => {
    const { source } = await fixture()
    const first = await importClaudeStatsCache(source)
    const parsed = JSON.parse(await readFile(source, 'utf8'))
    parsed.firstSessionDate = '2026-05-01T10:00:00.000Z'
    parsed.lastComputedDate = '2026-05-01'
    parsed.totalSessions = 1
    parsed.totalMessages = 2
    parsed.modelUsage['claude-opus-test'] = {
      inputTokens: 5,
      outputTokens: 5,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
    }
    parsed.dailyModelTokens = [{ date: '2026-05-01', tokensByModel: { 'claude-opus-test': 10 } }]
    await writeFile(source, JSON.stringify(parsed))

    const second = await importClaudeStatsCache(source)
    expect(second.generationId).not.toBe(first.generationId)
    expect(await readClaudeHistorySnapshots()).toHaveLength(2)
    expect((await buildClaudeHistoricalCalls()).exactAggregateTokens).toBe(1120)
  })

  it('applies overlap exclusions only to the matching Claude source', async () => {
    const { source } = await fixture()
    await importClaudeStatsCache(source, { sourceId: 'claude-account:1', sourceLabel: 'Claude 1' })
    await importClaudeStatsCache(source, { sourceId: 'claude-account:2', sourceLabel: 'Claude 2' })

    const historical = await buildClaudeHistoricalCalls(undefined, new Map([
      ['claude-account:1', new Set(['2026-04-28'])],
    ]))
    const matchingDay = historical.calls.filter(call => call.timestamp.startsWith('2026-04-28'))
    expect(matchingDay).toHaveLength(1)
    expect(matchingDay[0]?.sourceId).toBe('claude-account:2')
  })
})
