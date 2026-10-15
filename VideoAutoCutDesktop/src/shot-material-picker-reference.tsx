import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { ShotMaterialPickerReferencePage } from './pages/material-workflow-reference/ShotMaterialPickerReferencePage'
import './pages/material-workflow-reference/reference-pages.css'
import './styles/material-workflow-task-center-theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ShotMaterialPickerReferencePage />
  </StrictMode>,
)
