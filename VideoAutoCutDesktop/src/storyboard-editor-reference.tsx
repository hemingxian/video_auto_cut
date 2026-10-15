import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { StoryboardEditorReferencePage } from './pages/material-workflow-reference/StoryboardEditorReferencePage'
import './pages/material-workflow-reference/reference-pages.css'
import './styles/material-workflow-task-center-theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoryboardEditorReferencePage />
  </StrictMode>,
)
