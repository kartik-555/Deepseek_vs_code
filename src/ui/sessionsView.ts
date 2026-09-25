/**
 * The session list beside the chat.
 *
 * Sessions live in the repository, so this view is the record of what has been
 * asked in this workspace and the way back into an earlier conversation. With
 * several folders open the sessions group per repository.
 */

import { EventEmitter, ThemeIcon, TreeItem, TreeItemCollapsibleState, type Disposable, type TreeDataProvider } from 'vscode'
import type { HarnessService } from '../harnessService'
import type { SessionSummary } from '../sessionStore'
import type { ServiceRegistry } from '../services'

export type SessionNode =
  | { kind: 'folder'; service: HarnessService }
  | { kind: 'session'; service: HarnessService; summary: SessionSummary; grouped: boolean }
  | { kind: 'message'; service: HarnessService; text: string }

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(timestamp).toLocaleDateString()
}

export class SessionsView implements TreeDataProvider<SessionNode>, Disposable {
  readonly #changeEmitter = new EventEmitter<SessionNode | undefined>()
  readonly #subscriptions: Disposable[] = []
  readonly #perService = new Map<string, Disposable>()

  readonly onDidChangeTreeData = this.#changeEmitter.event

  constructor(private readonly registry: ServiceRegistry) {
    this.#subscribe()
    this.#subscriptions.push(
      registry.onDidChangeActive(() => {
        this.#subscribe()
        this.#changeEmitter.fire(undefined)
      }),
    )
  }

  getTreeItem(node: SessionNode): TreeItem {
    switch (node.kind) {
      case 'folder': {
        const item = new TreeItem(node.service.folder.name, TreeItemCollapsibleState.Expanded)
        item.description = node.service.runtimeState === 'ready' ? '' : node.service.runtimeState
        item.iconPath = new ThemeIcon('repo')
        item.contextValue = 'dshFolder'
        return item
      }
      case 'message': {
        const item = new TreeItem(node.text, TreeItemCollapsibleState.None)
        item.iconPath = new ThemeIcon('info')
        return item
      }
      case 'session': {
        const item = new TreeItem(node.summary.title || 'Session', TreeItemCollapsibleState.None)
        item.description = `${relativeTime(node.summary.updatedAt)} · ${node.summary.itemCount} items`
        item.iconPath = new ThemeIcon(
          node.summary.id === node.service.snapshot().id ? 'comment-discussion' : 'history',
        )
        item.contextValue = 'dshSession'
        item.tooltip = `${node.summary.title}\n${node.summary.id}\nupdated ${new Date(node.summary.updatedAt).toLocaleString()}`
        item.command = {
          command: 'dshVscode.openSession',
          title: 'Open Session',
          arguments: [node.service, node.summary.id] as unknown[],
        }
        return item
      }
      default:
        return new TreeItem('unknown')
    }
  }

  getChildren(node?: SessionNode): SessionNode[] {
    const services = this.registry.list()
    if (!node) {
      if (services.length === 0) return []
      if (services.length === 1) return this.#sessionsOf(services[0]!, false)
      return services.map((service) => ({ kind: 'folder', service }) as SessionNode)
    }
    if (node.kind === 'folder') return this.#sessionsOf(node.service, true)
    return []
  }

  #sessionsOf(service: HarnessService, grouped: boolean): SessionNode[] {
    const sessions = service.sessions
    if (sessions.length === 0) {
      return [
        {
          kind: 'message',
          service,
          text: grouped ? 'No sessions yet in this repository' : 'No sessions yet — send a message in Chat',
        },
      ]
    }
    return sessions.map((summary) => ({ kind: 'session', service, summary, grouped }) as SessionNode)
  }

  /** Refresh the whole tree and keep following each service's session list. */
  refresh(): void {
    this.#subscribe()
    this.#changeEmitter.fire(undefined)
  }

  #subscribe(): void {
    for (const service of this.registry.list()) {
      const key = service.folder.uri.toString()
      if (this.#perService.has(key)) continue
      this.#perService.set(
        key,
        service.onEvent((event) => {
          if (event.type === 'sessions' || event.type === 'title' || event.type === 'runtime') {
            this.#changeEmitter.fire(undefined)
          }
        }),
      )
    }
    for (const [key, subscription] of [...this.#perService]) {
      if (this.registry.list().some((service) => service.folder.uri.toString() === key)) continue
      subscription.dispose()
      this.#perService.delete(key)
    }
  }

  dispose(): void {
    this.#changeEmitter.dispose()
    for (const subscription of this.#perService.values()) subscription.dispose()
    for (const subscription of this.#subscriptions) subscription.dispose()
  }
}
