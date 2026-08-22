import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { readUsageLedger, syncUsageLedger } from '../src/usage-ledger.js'
import type { ProjectSummary } from '../src/types.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codeburn-ledger-'))
  process.env['CODEBURN_USAGE_LEDGER'] = join(root, 'usage-ledger.jsonl')
})

afterEach(async () => {
  delete process.env['CODEBURN_USAGE_LEDGER']
  await rm(root, { recursive: true, force: true })
})

function projects(inputTokens: number): ProjectSummary[] {
  return [{
    project: 'private-project',
    projectPath: '/private/project',
    sessions: [{
      sessionId: 'session-1',
      project: 'private-project',
      source: { id: 'claude-config:test', label: 'Claude account 1', path: '/private/.claude', kind: 'claude-config' },
      turns: [{
        userMessage: 'SECRET PROMPT MUST NOT BE STORED',
        timestamp: '2026-08-21T12:00:00.000Z',
        sessionId: 'session-1',
        assistantCalls: [{
          provider: 'claude',
          model: 'claude-opus-test',
          usage: {
            inputTokens,
            outputTokens: 20,
            cacheCreationInputTokens: 30,
            cacheReadInputTokens: 40,
            cachedInputTokens: 40,
            reasoningTokens: 0,
            webSearchRequests: 0,
          },
          costUSD: 1.25,
          tools: ['Bash'],
          mcpTools: [],
          skills: [],
          subagentTypes: [],
          hasAgentSpawn: false,
          hasPlanMode: false,
          speed: 'standard',
          timestamp: '2026-08-21T12:00:00.000Z',
          bashCommands: ['echo SECRET COMMAND'],
          deduplicationKey: 'claude:message-1',
        }],
      }],
    }],
  }] as unknown as ProjectSummary[]
}

describe('metadata-only usage ledger', () => {
  it('deduplicates unchanged events, appends revisions, and stores no prompt or command text', async () => {
    expect(await syncUsageLedger(projects(10))).toMatchObject({ appended: 1, revised: 0, totalEvents: 1 })
    expect(await syncUsageLedger(projects(10))).toMatchObject({ appended: 0, revised: 0, totalEvents: 1 })
    expect(await syncUsageLedger(projects(11))).toMatchObject({ appended: 1, revised: 1, totalEvents: 1 })

    const ledger = await readUsageLedger()
    expect(ledger).toMatchObject({ revisions: 1, invalidLines: 0 })
    expect(ledger.records).toHaveLength(1)
    expect(ledger.records[0]).toMatchObject({ provider: 'claude', inputTokens: 11, sourceLabel: 'Claude account 1' })

    const raw = await readFile(process.env['CODEBURN_USAGE_LEDGER']!, 'utf8')
    expect(raw).not.toContain('SECRET PROMPT')
    expect(raw).not.toContain('SECRET COMMAND')
    expect(raw.trim().split('\n')).toHaveLength(2)
  })
})
