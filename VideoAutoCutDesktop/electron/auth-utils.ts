import { asRecord, type JsonRecord } from './types.js'

function sanitizeAuthUser(value: unknown = {}) {
  const user = asRecord(value)
  if (!Object.keys(user).length) return null

  return {
    id: user.id ?? '',
    email: user.email ?? null,
    username: user.username ?? null,
    phone: user.phone ?? null,
    avatarUrl: user.avatarUrl ?? user.avatar_url ?? null,
    role: user.role ?? '',
    status: user.status ?? '',
    displayName: user.displayName ?? user.display_name ?? user.username ?? user.email ?? user.phone ?? '',
    balance: Number(user.balance ?? 0),
    balanceKnown: user.balanceKnown !== false && user.balance !== null && user.balance !== undefined
      && String(user.balance).trim() !== '' && Number.isFinite(Number(user.balance)),
    totalRecharged: Number(user.total_recharged ?? user.totalRecharged ?? 0),
    concurrency: Number(user.concurrency ?? 0),
    rpmLimit: Number(user.rpm_limit ?? user.rpmLimit ?? 0),
  }
}

function mergeAuthUserDisplay(serviceUser: unknown, displayUser: unknown) {
  const bUser = sanitizeAuthUser(serviceUser)
  const aUser = sanitizeAuthUser(displayUser)
  if (!bUser) return aUser
  if (!aUser) return bUser

  return {
    ...bUser,
    email: aUser.email ?? bUser.email,
    phone: aUser.phone ?? bUser.phone,
    username: aUser.username ?? bUser.username,
    avatarUrl: aUser.avatarUrl ?? bUser.avatarUrl,
    displayName: aUser.displayName ?? bUser.displayName,
  }
}

function normalizeAgentAuthPayload(value: unknown): JsonRecord {
  const data = asRecord(value)
  const nested = asRecord(data.data)
  if (data.user) return data
  if (nested.user) return nested
  return asRecord(data.data || data)
}

export {
  mergeAuthUserDisplay,
  normalizeAgentAuthPayload,
  sanitizeAuthUser,
}
