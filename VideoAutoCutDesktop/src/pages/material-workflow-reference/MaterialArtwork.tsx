import type { CSSProperties } from 'react'

import spriteA from '../../assets/material-thumbnails-industrial-a.png'
import spriteB from '../../assets/material-thumbnails-industrial-b.png'
import type { ReferenceMaterial } from './model'

export function MaterialArtwork({
  material,
  className = '',
}: {
  material: ReferenceMaterial
  className?: string
}) {
  const style = {
    '--vac-ref-art': `url("${material.sprite === 'a' ? spriteA : spriteB}")`,
    '--vac-ref-position': material.spritePosition,
  } as CSSProperties

  return <span className={`vac-ref-artwork ${className}`.trim()} style={style} aria-hidden="true" />
}
