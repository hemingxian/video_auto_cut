type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

const PLAN_ONLY_STEPS = new Map([
  ['parse_script', 'ParseScript'],
  ['plan_storyboard', 'PlanStoryboard'],
])

export function isCompletedPlanOnlyRun(jobPlanValue: unknown, checkpointValue: unknown) {
  const jobPlan = record(jobPlanValue)
  const checkpoint = record(checkpointValue)
  if (!jobPlan || !checkpoint || checkpoint.version !== 1) return false
  if (typeof checkpoint.signature !== 'string' || checkpoint.signature.length === 0) return false
  if (typeof checkpoint.plan_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(checkpoint.plan_hash)) return false
  if (checkpoint.final_path !== null) return false
  if (!Array.isArray(jobPlan.steps) || !Array.isArray(checkpoint.steps)) return false

  const planned = jobPlan.steps.map(record)
  const completed = checkpoint.steps.map(record)
  if (planned.some((step) => !step) || completed.some((step) => !step || !record(step.files))) return false
  if (planned.length !== PLAN_ONLY_STEPS.size || completed.length !== planned.length) return false

  const plannedCapabilities = planned.map((step) => step?.capability)
  return new Set(plannedCapabilities).size === PLAN_ONLY_STEPS.size && planned.every((step, index) => {
    const capability = typeof step?.capability === 'string' ? step.capability : ''
    const id = typeof step?.id === 'string' ? step.id : ''
    const checkpointName = PLAN_ONLY_STEPS.get(capability)
    return id === capability && Boolean(checkpointName) && completed[index]?.name === checkpointName
  })
}
