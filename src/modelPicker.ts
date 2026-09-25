/**
 * In-editor model selection.
 *
 * The SDK wire cannot list models, so this picker combines three sources and is
 * explicit about which one each row came from:
 *
 * 1. the route the live runtime actually resolved, read from the session's own
 *    `request/header` event — truth, once a turn has run;
 * 2. curated suggestions for the current provider ({@link candidatesFor});
 * 3. anything the user types, because harness catalogs move faster than an
 *    editor extension.
 *
 * Because a route is only accepted or refused by the runtime, "verified" here
 * always means *this* machine spawned a runtime and completed the handshake
 * with that route. Nothing is claimed without that handshake.
 */

import { ProgressLocation, QuickPickItemKind, window, workspace, type QuickPickItem } from 'vscode'
import { log, reportError } from './log'
import {
  candidatesFor,
  parseSupportedModels,
  displayNameFor,
  formatContextWindow,
  formatModalities,
  PROVIDER_CANDIDATES,
  REASONING_EFFORTS,
  routeKey,
  type ModelCandidate,
} from './models'
import type { HarnessService } from './harnessService'

/**
 * Verification results, keyed by route. Module-level so a picker reopened in the
 * same window shows what a previous picker already proved. A route is only
 * marked verified after it answered a real (minimal) request: the initialize
 * handshake alone accepts any model id, so it proves nothing about the model.
 */
type RouteState = 'verified' | 'accepted' | 'refused'

/**
 * What is known about a route on this machine.
 *
 * `verified` — a real (minimal) request completed on it.
 * `accepted` — the runtime restarted on it, so the provider adapter resolved,
 *   but no request has been made yet: the handshake does not validate a model id.
 * `refused` — it failed, with the adapter's reason in `detail`.
 */
const verified = new Map<string, { state: RouteState; detail: string }>()

/**
 * Model ids a provider reported in a refusal, per provider route. A rejected
 * probe is still information: the adapter says which models it does serve.
 */
const providerReported = new Map<string, string[]>()

interface ModelPickItem extends QuickPickItem {
  action: 'select' | 'verify' | 'custom' | 'provider' | 'effort' | 'current'
  model?: string
}

function verificationLabel(key: string): string {
  const result = verified.get(key)
  if (!result) return 'not checked'
  return result.state === 'verified' ? 'verified' : result.state === 'accepted' ? 'accepted' : 'refused'
}

function verificationIcon(state: RouteState | undefined): string {
  if (state === 'verified') return '$(pass-filled)'
  if (state === 'accepted') return '$(circle-outline)'
  if (state === 'refused') return '$(error)'
  return '$(question)'
}

function candidateItem(service: HarnessService, candidate: ModelCandidate, currentModel: string): ModelPickItem {
  const settings = service.settings
  const key = routeKey(settings.provider, candidate.id, settings.reasoningEffort)
  const context = formatContextWindow(candidate.contextWindow)
  const modalities = formatModalities(candidate.inputModalities)
  const description = [candidate.description, context ? `${context} context` : undefined, modalities]
    .filter(Boolean)
    .join(' · ')
  const result = verified.get(key)
  return {
    action: 'select',
    model: candidate.id,
    label: `${verificationIcon(result?.state)} ${candidate.name}${candidate.id === currentModel ? '  $(check)' : ''}`,
    description: candidate.id,
    detail: [description, result ? `Verification: ${result.detail}` : undefined].filter(Boolean).join('\n'),
  }
}

function currentItem(service: HarnessService): ModelPickItem | undefined {
  const route = service.resolvedRoute
  if (!route) return undefined
  const context = formatContextWindow(route.contextWindow)
  return {
    action: 'current',
    label: `$(radio-tower) Running now: ${displayNameFor(route.provider, route.model)}`,
    description: route.model,
    detail: [
      `provider ${route.provider}`,
      route.reasoningEffort ? `reasoning effort ${route.reasoningEffort}` : 'reasoning effort: model default',
      route.maxTokens ? `output cap ${route.maxTokens} tokens` : undefined,
      context ? `context window ${context}` : undefined,
      'Reported by the runtime on this session\'s last request.',
    ]
      .filter(Boolean)
      .join(' · '),
  }
}

/**
 * Run the picker until the user settles on a route or dismisses it. Returns
 * true when a setting changed.
 */
export async function selectModel(service: HarnessService, onChange?: () => void): Promise<boolean> {
  for (;;) {
    const settings = service.settings
    const currentModel = settings.model
    const items: ModelPickItem[] = []
    const running = currentItem(service)
    if (running) items.push(running)
    if (items.length > 0) items.push({ action: 'current', label: 'Suggested models', kind: QuickPickItemKind.Separator })

    const suggested = candidatesFor(settings.provider)
    for (const candidate of suggested) {
      items.push(candidateItem(service, candidate, currentModel))
    }
    // Models the provider named itself, which this extension could not know.
    const reported = (providerReported.get(settings.provider) ?? []).filter(
      (id) => !suggested.some((candidate) => candidate.id === id),
    )
    for (const id of reported) {
      items.push({
        action: 'select',
        model: id,
        label: `$(verified) ${id}`,
        description: 'reported by the provider',
        detail: `The provider named this model when it refused another route. Verification: ${(
          verified.get(routeKey(settings.provider, id, settings.reasoningEffort))?.detail ?? 'not checked'
        )}`,
      })
    }
    if (suggested.length === 0 && reported.length === 0) {
      items.push({
        action: 'custom',
        label: `$(edit) Enter a model id for ${settings.provider}`,
        description: 'no suggestions are known for this provider route',
      })
    }

    items.push(
      { action: 'custom', label: '$(edit) Enter a model id…', description: `currently ${currentModel}` },
      { action: 'provider', label: '$(server) Change provider route…', description: `currently ${settings.provider}` },
      {
        action: 'effort',
        label: '$(settings-gear) Change reasoning effort…',
        description: settings.reasoningEffort.length > 0 ? `currently ${settings.reasoningEffort}` : 'currently the model default',
      },
      {
        action: 'verify',
        label: '$(beaker) Verify suggested models…',
        description: 'sends one minimal request (64 output tokens) per model and reports what the runtime did',
      },
    )

    const picked = await window.showQuickPick(items, {
      title: `DeepSeek Harness: model for ${service.folder.name}`,
      placeHolder: `${settings.provider} / ${currentModel}${settings.reasoningEffort ? ` · ${settings.reasoningEffort}` : ''}`,
      matchOnDescription: true,
      matchOnDetail: true,
    })
    if (!picked) return false

    switch (picked.action) {
      case 'current':
        continue
      case 'verify': {
        await verifySuggested(service, onChange)
        continue
      }
      case 'effort': {
        const changed = await pickEffort(service, onChange)
        if (changed) return true
        continue
      }
      case 'provider': {
        const changed = await pickProvider(service, onChange)
        if (changed) return true
        continue
      }
      case 'custom': {
        const model = await window.showInputBox({
          title: 'Model id',
          value: currentModel,
          prompt: 'The runtime validates this route when it restarts; an unsupported id is rejected with the adapter\'s reason.',
          ignoreFocusOut: true,
        })
        if (!model || model.trim().length === 0) continue
        return applyRoute(service, { model: model.trim() }, onChange)
      }
      case 'select':
      default: {
        if (!picked.model) continue
        if (picked.model === currentModel) return false
        return applyRoute(service, { model: picked.model }, onChange)
      }
    }
  }
}

async function pickEffort(service: HarnessService, onChange?: () => void): Promise<boolean> {
  const items = [
    { label: '$(circle-slash) Model default', description: 'send no effort and let the adapter choose', value: '' },
    ...REASONING_EFFORTS.map((effort) => ({
      label: effort === service.settings.reasoningEffort ? `$(check) ${effort}` : effort,
      description: 'adapter-owned reasoning effort',
      value: effort,
    })),
  ]
  const picked = await window.showQuickPick(items, {
    title: 'DeepSeek Harness: reasoning effort',
    placeHolder: service.settings.reasoningEffort || 'model default',
  })
  if (!picked) return false
  if (picked.value === service.settings.reasoningEffort) return false
  return applyRoute(service, { reasoningEffort: picked.value }, onChange)
}

async function pickProvider(service: HarnessService, onChange?: () => void): Promise<boolean> {
  const settings = service.settings
  const items = [
    ...PROVIDER_CANDIDATES.map((provider) => ({
      label: provider.id === settings.provider ? `$(check) ${provider.id}` : provider.id,
      description: provider.description,
      value: provider.id,
    })),
    { label: '$(edit) Enter a provider route…', description: 'a pi-ai profile name, a gateway route, or a bundled adapter id', value: '' },
  ]
  const picked = await window.showQuickPick(items, {
    title: 'DeepSeek Harness: provider route',
    placeHolder: settings.provider,
    matchOnDescription: true,
  })
  if (!picked) return false
  if (picked.value === '') {
    const provider = await window.showInputBox({
      title: 'Provider route',
      value: settings.provider,
      prompt: 'Provider routes are declared by the harness composition (or a pi-ai profile), not by this extension.',
      ignoreFocusOut: true,
    })
    if (!provider || provider.trim().length === 0) return false
    return applyRoute(service, { provider: provider.trim() }, onChange)
  }
  if (picked.value === settings.provider) return false
  return applyRoute(service, { provider: picked.value }, onChange)
}

/**
 * Write the route, restart the runtime so the harness validates it, and offer to
 * put the previous route back when it is refused.
 */
async function applyRoute(
  service: HarnessService,
  change: { provider?: string; model?: string; reasoningEffort?: string },
  onChange?: () => void,
): Promise<boolean> {
  const previous = {
    provider: service.settings.provider,
    model: service.settings.model,
    reasoningEffort: service.settings.reasoningEffort,
  }
  const configuration = workspace.getConfiguration('dshVscode', service.folder.uri)
  const target = {
    provider: change.provider ?? previous.provider,
    model: change.model ?? previous.model,
    reasoningEffort: change.reasoningEffort ?? previous.reasoningEffort,
  }

  log(`model route: ${previous.provider}/${previous.model} -> ${target.provider}/${target.model} (effort ${target.reasoningEffort || 'default'})`)
  await configuration.update('provider', target.provider, true)
  await configuration.update('model', target.model, true)
  await configuration.update('reasoningEffort', target.reasoningEffort, true)
  onChange?.()

  try {
    await service.restart()
    const detail = `${target.provider}/${target.model}`
    verified.set(routeKey(target.provider, target.model, target.reasoningEffort), {
      state: 'accepted',
      detail: 'the runtime restarted on this route; send a message or verify it to prove it answers',
    })
    void window.showInformationMessage(
      `DeepSeek Harness now runs ${detail}. The runtime accepted the route; use "Verify suggested models…" to prove it answers.`,
    )
    return true
  } catch (error) {
    verified.set(routeKey(target.provider, target.model, target.reasoningEffort), {
      state: 'refused',
      detail: error instanceof Error ? error.message : String(error),
    })
    const message = error instanceof Error ? error.message : String(error)
    rememberReported(target.provider, message)
    const revert = await window.showErrorMessage(
      `DeepSeek Harness could not start ${target.provider}/${target.model}: ${message}`,
      'Revert to previous model',
      'Keep',
    )
    if (revert === 'Revert to previous model') {
      await configuration.update('provider', previous.provider, true)
      await configuration.update('model', previous.model, true)
      await configuration.update('reasoningEffort', previous.reasoningEffort, true)
      onChange?.()
      try {
        await service.restart()
      } catch (revertError) {
        reportError('could not restore the previous model route', revertError)
      }
      return false
    }
    return true
  }
}

/** Fold any model ids the provider named in a refusal into the picker. */
function rememberReported(provider: string, detail: string): void {
  const ids = parseSupportedModels(detail)
  if (ids.length === 0) return
  const merged = [...new Set([...(providerReported.get(provider) ?? []), ...ids])]
  providerReported.set(provider, merged)
  log(`provider ${provider} reported supported models: ${merged.join(', ')}`)
}

/** Verify each suggested model for the current provider, one runtime at a time. */
async function verifySuggested(service: HarnessService, onChange?: () => void): Promise<void> {
  const settings = service.settings
  const candidates = candidatesFor(settings.provider)
  if (candidates.length === 0) {
    void window.showInformationMessage(
      `No suggested models are known for ${settings.provider}; enter a model id to check it directly.`,
    )
    return
  }
  await window.withProgress(
    {
      location: ProgressLocation.Notification,
      title: 'DeepSeek Harness: verifying model routes',
      cancellable: false,
    },
    async (progress) => {
      for (const candidate of candidates) {
        progress.report({ message: `${candidate.id}…` })
        const result = await service.probeRoute({
          provider: settings.provider,
          model: candidate.id,
          reasoningEffort: settings.reasoningEffort,
        })
        verified.set(routeKey(settings.provider, candidate.id, settings.reasoningEffort), {
          state: result.ok ? 'verified' : 'refused',
          detail: result.detail,
        })
        if (!result.ok) rememberReported(settings.provider, result.detail)
        log(`route probe ${settings.provider}/${candidate.id}: ${result.ok ? 'answered' : `refused: ${result.detail}`}`)
      }
    },
  )
  onChange?.()
  const summary = candidates
    .map(
      (candidate) =>
        `${candidate.id} ${verificationLabel(routeKey(settings.provider, candidate.id, settings.reasoningEffort))}`,
    )
    .join(', ')
  const reported = providerReported.get(settings.provider) ?? []
  const reportedNote = reported.length > 0 ? ` The provider also named: ${reported.join(', ')}.` : ''
  void window.showInformationMessage(`Checked ${settings.provider}: ${summary}.${reportedNote}`)
}
