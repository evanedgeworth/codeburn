// Renderer-only token budget setting (localStorage `codeburn.dailyBudget`).
// Cash budgets cannot be evaluated from the renderer's API-equivalent history,
// so only input+output token caps are accepted.

export type DailyBudget = { kind: 'tokens'; value: number }

/** Parse the persisted budget, returning null when absent or malformed. */
export function readDailyBudget(): DailyBudget | null {
  let raw: string | null = null
  try { raw = globalThis.localStorage?.getItem('codeburn.dailyBudget') ?? null } catch { return null }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DailyBudget>
    if (parsed.kind === 'tokens' && typeof parsed.value === 'number' && Number.isFinite(parsed.value) && parsed.value > 0) {
      return { kind: 'tokens', value: parsed.value }
    }
  } catch { /* malformed JSON */ }
  return null
}
