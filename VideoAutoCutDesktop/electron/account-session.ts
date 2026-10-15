import { asRecord, stringValue } from './types.js'

export interface AccountIdentity { serviceUrl: string; userId: string }

export function materialAccountIdentity(authValue: unknown, serviceUrl: string): AccountIdentity | undefined {
  const auth = asRecord(authValue)
  const userId = stringValue(asRecord(auth.user).id || auth.agentUserId).trim()
  if (!userId || !stringValue(auth.accessToken || auth.token).trim()) return undefined
  return { serviceUrl: serviceUrl.replace(/\/+$/, ''), userId }
}

export class AccountSessionChanged extends Error {
  constructor() { super('账号已切换，旧账号的操作已停止，请在当前账号重新操作'); this.name = 'AccountSessionChanged' }
}

interface ScopedStore {
  captureScope(): string
  runInScope<T>(scope: string, operation: () => T): T
}

export interface AccountSession {
  readonly identity: AccountIdentity | undefined
  readonly scope: string
  readonly signal: AbortSignal
  active(): boolean
  assertActive(): void
  run<T>(operation: () => T): T
  bindStore<T extends object>(store: T): T
  get<T>(factory: (session: AccountSession) => T): T
  onDispose(dispose: () => unknown): void
  send(send: (channel: string, payload?: unknown) => void, channel: string, payload?: unknown): void
  fetch(request: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response>
  waitForPrevious(): Promise<void>
  track<T>(operation: Promise<T>): Promise<T>
}

/** Every async operation retains its original database and session epoch, including A -> B -> A. */
export function createAccountSessions(readIdentity: () => AccountIdentity | undefined, store: ScopedStore) {
  let current: AccountSession | undefined
  let currentKey = ''
  let disposeCurrent: (() => void) | undefined
  let previousDisposals: Promise<unknown> = Promise.resolve()
  let closed = false

  function refresh(): AccountSession {
    if (closed) throw new AccountSessionChanged()
    const identity = readIdentity()
    const key = JSON.stringify(identity || null)
    if (current && key === currentKey) return current
    disposeCurrent?.()
    const pendingDisposals = previousDisposals
    const controller = new AbortController()
    const scope = store.captureScope()
    const instances = new Map<unknown, unknown>()
    const disposals: Array<() => unknown> = []
    const pending = new Set<Promise<unknown>>()
    const session: AccountSession = {
      identity, scope, signal: controller.signal,
      active: () => current === session && !controller.signal.aborted && JSON.stringify(readIdentity() || null) === key,
      assertActive() { if (!session.active()) throw new AccountSessionChanged() },
      run<T>(operation: () => T): T { session.assertActive(); return store.runInScope(scope, operation) },
      bindStore<T extends object>(target: T): T {
        // Cleanup of an interrupted transfer may still update its own queue, never the new account's.
        return new Proxy(target, { get(_target, property) {
          const value = Reflect.get(target, property)
          return typeof value === 'function'
            ? (...args: unknown[]) => store.runInScope(scope, () => Reflect.apply(value, target, args)) : value
        } })
      },
      get<T>(factory: (context: AccountSession) => T): T {
        session.assertActive()
        if (!instances.has(factory)) instances.set(factory, session.run(() => factory(session)))
        return instances.get(factory) as T
      },
      onDispose(dispose) { disposals.push(dispose) },
      send(send, channel, payload) { if (session.active()) send(channel, payload) },
      async fetch(request, input, init = {}) {
        return session.track((async () => {
          await session.waitForPrevious()
          const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
          const response = await request(input, { ...init, signal })
          // Read the API response under the same epoch; a delayed body must not reach a different account.
          const body = await response.arrayBuffer()
          session.assertActive()
          return new Response([101, 204, 205, 304].includes(response.status) ? null : body, {
            status: response.status, statusText: response.statusText, headers: response.headers,
          })
        })())
      },
      async waitForPrevious() { await pendingDisposals; session.assertActive() },
      track<T>(operation: Promise<T>): Promise<T> {
        pending.add(operation)
        void operation.then(() => pending.delete(operation), () => pending.delete(operation))
        return operation
      },
    }
    current = session
    currentKey = key
    disposeCurrent = () => {
      controller.abort(new AccountSessionChanged())
      const results = disposals.map(dispose => {
        try { return store.runInScope(scope, dispose) } catch { return undefined }
      })
      previousDisposals = Promise.allSettled([previousDisposals, ...results, ...pending])
    }
    return session
  }

  function proxy<T extends object>(factory: (session: AccountSession) => T): T {
    return new Proxy({} as T, { get(_target, property) {
      if (property === 'then' || typeof property === 'symbol') return undefined
      // Resolve on invocation, not property capture: IPC handlers retain method references across logins.
      return (...args: unknown[]) => {
        const session = refresh()
        const instance = session.get(factory)
        const value = Reflect.get(instance, property)
        if (typeof value !== 'function') return value
        const result = session.run(() => Reflect.apply(value, instance, args))
        if (result && typeof result.then === 'function') {
          // Only cancellable transports/file handles are tracked by the disposal barrier.
          // A slow old model analysis must not block the next account's unrelated cloud requests.
          return Promise.resolve(result).then(value => { session.assertActive(); return value })
        }
        return result
      }
    } })
  }
  return { refresh, proxy, close(): Promise<void> {
    closed = true
    disposeCurrent?.()
    current = undefined
    disposeCurrent = undefined
    return previousDisposals.then(() => undefined)
  } }
}
