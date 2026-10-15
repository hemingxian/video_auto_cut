/** Prevent an unmounted account workspace from submitting the next asynchronous step. */
export function activeSessionApi<T extends object>(api: T, isActive: () => boolean): T {
  const assertActive = () => {
    if (!isActive()) throw new Error('账号已切换，已取消旧工作区操作')
  }
  // Electron's contextBridge freezes its exposed object. A proxy of that object
  // cannot substitute wrappers for its non-configurable, read-only methods.
  // Keep the immutable bridge as the receiver and use an independent facade.
  return new Proxy({} as T, {
    get(_target, property) {
      const member: unknown = Reflect.get(api, property, api)
      if (typeof member !== 'function') return member
      return (...args: unknown[]) => {
        assertActive()
        const result: unknown = Reflect.apply(member, api, args)
        if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
          return Promise.resolve(result).then((value) => {
            assertActive()
            return value
          })
        }
        return result
      }
    },
  })
}
