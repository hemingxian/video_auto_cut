import { normalizeMaterialBindings, normalizeShots } from './shotPlan.ts'
import { selectionsToMaterialBindings, type ShotMaterialSelection } from './shotMaterialSelectionModel.ts'
import type { ShotMaterialBinding, ShotPlanRoot } from './types'

export type ScriptMaterialSelections = Record<string, ShotMaterialSelection[]>

export function scriptMaterialKey(scriptPath: string): string {
  return scriptPath.trim().replace(/\\/g, '/').toLowerCase()
}

export function retainScriptMaterialSelections(selections: ScriptMaterialSelections, paths: string[]): ScriptMaterialSelections {
  const keys = new Set(paths.map(scriptMaterialKey))
  return Object.fromEntries(Object.entries(selections).filter(([key]) => keys.has(key)))
}

export function scriptMaterialBindingsByPath(selections: ScriptMaterialSelections): Record<string, ShotMaterialBinding[]> {
  return Object.fromEntries(Object.entries(selections).map(([key, items]) => [key, selectionsToMaterialBindings(items)]))
}

export function applyScriptMaterialScope(root: ShotPlanRoot, scope: ShotMaterialBinding[] = []): ShotPlanRoot {
  const bindings = normalizeMaterialBindings(scope)
  if (!bindings.length || root.script_material_scope_applied === true) return root
  const shots = normalizeShots(root.shots)
  if (!shots.length) return root
  return {
    ...root,
    script_material_scope_applied: true,
    script_material_bindings: bindings,
    shots: shots.map((shot) => shot.material_bindings.length && shot.material_resolution?.strategy !== 'library'
      ? shot
      : {
          ...shot,
          download_material: false,
          material_bindings: bindings.map((binding) => ({ ...binding })),
          material_resolution: undefined,
        }),
  }
}
