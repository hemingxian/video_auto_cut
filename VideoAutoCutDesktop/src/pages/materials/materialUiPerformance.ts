export const MATERIAL_UI_RESPONSE_BUDGET_MS = 200

export type MaterialUiResponseMeasurement = {
  interaction: string
  duration: number
  budget: number
  withinBudget: boolean
}

export function materialUiResponseMeasurement(
  interaction: string,
  startedAt: number,
  completedAt: number,
  budget = MATERIAL_UI_RESPONSE_BUDGET_MS,
): MaterialUiResponseMeasurement {
  const duration = Math.max(0, completedAt - startedAt)
  return {
    interaction,
    duration,
    budget,
    withinBudget: duration <= budget,
  }
}

export function measureMaterialUiResponse(interaction: string, action: () => void) {
  const startedAt = performance.now()
  action()

  if (typeof window === 'undefined') return

  const afterFrame = (callback: () => void) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(callback)
      return
    }
    window.setTimeout(callback, 0)
  }

  afterFrame(() => afterFrame(() => {
    const measurement = materialUiResponseMeasurement(interaction, startedAt, performance.now())
    window.document.documentElement.dataset.materialUiLastResponse = JSON.stringify(measurement)
    window.dispatchEvent(new CustomEvent('videoauto:material-ui-response', {
      detail: measurement,
    }))
    if (!measurement.withinBudget) {
      console.warn(
        `[素材库性能] ${interaction} 响应 ${measurement.duration.toFixed(1)}ms，超过 ${measurement.budget}ms 预算`,
      )
    }
  }))
}
