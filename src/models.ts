/**
 * Model selection data.
 *
 * The harness resolves a provider/model route at `initialize` and rejects a
 * route it cannot serve, but the SDK wire exposes no "list models" request. So
 * this module holds a small, curated candidate list for the shipped route, and
 * the extension treats it as *suggestions to be verified*, never as truth:
 *
 * - every candidate can be checked against the live runtime
 *   (`HarnessService.probeRoute`), which is what the picker's "verified" state
 *   means;
 * - any other model id can be typed in, because the harness ships adapters
 *   whose catalogs move faster than an editor extension can;
 * - the route that is actually running is read from the session's own
 *   `request/header` event, not guessed.
 *
 * The DeepSeek entries mirror the harness's default catalog
 * (`packages/llm/llm-deepseek/src/models.ts` at harness 0.1.7), including its
 * context window and image support.
 */

export interface ModelCandidate {
  /** Model id handed to the runtime. */
  id: string
  /** Display name, when the harness catalog has one. */
  name: string
  description?: string
  contextWindow?: number
  inputModalities?: readonly string[]
}

/** A provider route the picker suggests; free text is always allowed. */
export interface ProviderCandidate {
  id: string
  description: string
}

const DEEPSEEK_CONTEXT_WINDOW = 1_000_000

/** Suggested routes for shipped provider shapes. */
export const PROVIDER_CANDIDATES: readonly ProviderCandidate[] = [
  {
    id: 'deepseek-official',
    description: 'Bundled DeepSeek adapter; the key is the DEEPSEEK_API_KEY credential',
  },
  {
    id: 'anthropic',
    description: 'Third-party route: configure it and its key in the DSH web UI (Settings → Models)',
  },
  {
    id: 'openai',
    description: 'Third-party route: configure it and its key in the DSH web UI (Settings → Models)',
  },
  {
    id: 'moonshotai',
    description: 'Third-party route (Kimi): configure it in the DSH web UI',
  },
  {
    id: 'zai',
    description: 'Third-party route (GLM): configure it in the DSH web UI',
  },
]

/** Suggested models per provider route. An unknown provider has no suggestions. */
const CATALOGS: Record<string, readonly ModelCandidate[]> = {
  'deepseek-official': [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek-V41-Flash',
      description: 'Fast default route; text and image input',
      contextWindow: DEEPSEEK_CONTEXT_WINDOW,
      inputModalities: ['text', 'image'],
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      description: 'Stronger agentic coding and difficult reasoning, at higher cost',
      contextWindow: DEEPSEEK_CONTEXT_WINDOW,
      inputModalities: ['text'],
    },
  ],
}

/** Reasoning effort values the DeepSeek adapter accepts, weakest first. */
export const REASONING_EFFORTS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'max']

/** Suggested models for a provider route; empty when the route is unknown. */
export function candidatesFor(provider: string): readonly ModelCandidate[] {
  return CATALOGS[provider.trim()] ?? []
}

/** Human-readable name for a model id, falling back to the id itself. */
export function displayNameFor(provider: string, model: string): string {
  const found = candidatesFor(provider).find((candidate) => candidate.id === model)
  return found?.name ?? model
}

/** `1M` / `256k` style rendering of a context window. */
export function formatContextWindow(tokens: number | undefined): string | undefined {
  if (!tokens || tokens <= 0) return undefined
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

/** Input modalities rendered for a tooltip. */
export function formatModalities(modalities: readonly string[] | undefined): string | undefined {
  if (!modalities || modalities.length === 0) return undefined
  return modalities.join(', ')
}

/**
 * Model ids a provider itself named in an error message.
 *
 * DeepSeek answers an unknown model with
 * `The supported API model names are deepseek-flash, deepseek-v4-pro, but you
 * passed …`, so a *refused* probe can still teach the picker the real catalog.
 * Only messages that explicitly introduce the list are read, and the result is
 * always presented as "reported by the provider" rather than as a suggestion
 * this extension invented.
 */
export function parseSupportedModels(detail: string): string[] {
  const patterns = [
    /supported\s+(?:api\s+)?model(?:\s+names?)?\s*(?:are|is|:)\s*([^.;\n]+)/i,
    /available\s+models?\s*(?:are|is|:)\s*([^.;\n]+)/i,
    /model(?:\s+names?)?\s+must\s+be\s+one\s+of\s*:?\s*([^.;\n]+)/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(detail)
    if (!match?.[1]) continue
    const ids = match[1]
      .split(/[,\s]+|\bor\b/)
      .map((value) => value.trim().replace(/^["'`]|["'`]$/g, ''))
      .filter((value) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,63}$/.test(value))
      .filter((value) => !/^(and|the|but|you|passed|are|is)$/i.test(value))
    const unique = [...new Set(ids)]
    if (unique.length > 0) return unique.slice(0, 24)
  }
  return []
}

/** Stable cache key for one route, including the effort that was validated. */
export function routeKey(provider: string, model: string, reasoningEffort: string): string {
  return `${provider.trim()}|${model.trim()}|${reasoningEffort.trim()}`
}
