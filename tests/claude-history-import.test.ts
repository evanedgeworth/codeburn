import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildClaudeHistoricalCalls,
  importClaudeStatsCache,
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
})
