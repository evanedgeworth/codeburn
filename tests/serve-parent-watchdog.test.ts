import { describe, expect, it } from 'vitest'

import { parentProcessChanged, parentProcessIsGone } from '../src/serve.js'

describe('serve parent watchdog', () => {
  it('keeps serving while the original app remains the parent', () => {
    expect(parentProcessChanged(42, 42)).toBe(false)
  })

  it('detects reparenting after the app exits', () => {
    expect(parentProcessChanged(42, 1)).toBe(true)
    expect(parentProcessChanged(42, 99)).toBe(true)
  })

  it('leaves detached-start policy to the server bootstrap', () => {
    expect(parentProcessChanged(1, 1)).toBe(false)
  })

  it('detects a dead parent even when the Node runtime caches process.ppid', () => {
    const missing = Object.assign(new Error('missing'), { code: 'ESRCH' })
    expect(parentProcessIsGone(42, 42, () => { throw missing })).toBe(true)
  })

  it('keeps serving when the original parent PID still exists', () => {
    expect(parentProcessIsGone(42, 42, () => undefined)).toBe(false)
  })

  it('does not exit on a non-missing probe error', () => {
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' })
    expect(parentProcessIsGone(42, 42, () => { throw denied })).toBe(false)
  })
})
