import { lazy, Suspense, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

import { AccountPopover } from './components/AccountPopover'
import { AppOperationToaster } from './components/AppOperationToaster'
import { AppToast } from './components/AppToast'
import { AppTooltip } from './components/AppTooltip'
import { AuthDialog } from './components/AuthDialog'
import { Sidebar } from './components/layout/Sidebar'
import { RechargeDialog } from './components/RechargeDialog'
import { RuntimeGate } from './components/RuntimeGate'
import { UpdatePrompt } from './components/UpdatePrompt'
import { useStartupUpdateGate } from './components/updates/useStartupUpdateGate'
import { useAppShellState } from './hooks/useAppShellState'
import { useStartTaskController, type StartTaskController } from './pages/start/useStartTaskController'
import type { AppInfo, Page } from './types/app'

const StartPage = lazy(() => import('./pages/StartPage').then((module) => ({ default: module.StartPage })))
const RunsPage = lazy(() => import('./pages/RunsPage').then((module) => ({ default: module.RunsPage })))
const MaterialsPage = lazy(() => import('./pages/MaterialsPage').then((module) => ({ default: module.MaterialsPage })))
const VoicePage = lazy(() => import('./pages/VoicePage').then((module) => ({ default: module.VoicePage })))
const ConfigPage = lazy(() => import('./pages/ConfigPage').then((module) => ({ default: module.ConfigPage })))

const pageComponents: Record<Page, (props: { appInfo: AppInfo | null; startTask: StartTaskController }) => React.ReactNode> = {
  start: ({ startTask }) => <StartPage task={startTask} />,
  runs: () => <RunsPage />,
  materials: ({ appInfo }) => <MaterialsPage appInfo={appInfo} />,
  voice: () => <VoicePage />,
  config: ({ appInfo }) => <ConfigPage appInfo={appInfo} />,
}

function PageLoadingFallback() {
  return <div className="loading-line" role="status" aria-live="polite">正在加载页面...</div>
}

function AuthenticatedApp({ shell }: { shell: ReturnType<typeof useAppShellState> }) {
  const {
    accountOpen,
    appInfo,
    auth,
    closeAccount,
    closeRecharge,
    handleRuntimeReady,
    logout,
    openAccount,
    openRecharge,
    page,
    rechargeOpen,
    refreshAuthAfterRecharge,
    setPage,
    toast,
  } = shell
  const startTask = useStartTaskController()
  const runtimeInstallRequired = Boolean(appInfo?.runtime && !appInfo.runtime.ready)
  const updateGate = useStartupUpdateGate(Boolean(auth?.loggedIn), runtimeInstallRequired)
  const CurrentPage = pageComponents[page]
  const [materialsVisited, setMaterialsVisited] = useState(false)
  useEffect(() => { if (page === 'materials') setMaterialsVisited(true) }, [page])

  if (!auth?.loggedIn) return null

  return <div className="app-shell">
    <AppToast message={toast} />
    <AppOperationToaster />
    <AppTooltip />
    <Sidebar
      activePage={page}
      appInfo={appInfo}
      auth={auth}
      onNavigate={setPage}
      onAccount={openAccount}
    />

    <main className="main-area">
      {(materialsVisited || page === 'materials') ? <div className="page-view" style={{ display: page === 'materials' ? undefined : 'none' }}>
        <Suspense fallback={<PageLoadingFallback />}><MaterialsPage appInfo={appInfo} /></Suspense>
      </div> : null}
      <AnimatePresence mode="wait">
        {page !== 'materials' ? <motion.div
          key={page}
          className="page-view"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.16 }}
        >
          <Suspense fallback={<PageLoadingFallback />}>
            {page === 'runs' ? <RunsPage busy={startTask.materialStrategyDisabled} protectedTasks={startTask.protectedRunTargets} onDeleted={startTask.forgetRun} onRestore={async (run) => {
              if (await startTask.restoreRun(run)) setPage('start')
            }} /> : <CurrentPage appInfo={appInfo} startTask={startTask} />}
          </Suspense>
        </motion.div> : null}
      </AnimatePresence>
    </main>

    {updateGate.allowRuntimeGate ? <RuntimeGate onReady={handleRuntimeReady} /> : null}
    {updateGate.allowUpdatePrompt ? <UpdatePrompt onDismissed={updateGate.dismissUpdate} /> : null}
    <AccountPopover
      open={accountOpen}
      auth={auth}
      onClose={closeAccount}
      onRecharge={openRecharge}
      onLogout={logout}
    />
    <RechargeDialog open={rechargeOpen} onClose={closeRecharge} onPaid={refreshAuthAfterRecharge} />
  </div>
}

function App() {
  const shell = useAppShellState()
  const { auth, appInfo, setAuth } = shell
  if (!auth) {
    return <div className="app-shell auth-boot-shell">
      <AppTooltip />
      <div className="auth-boot-loading">正在加载...</div>
    </div>
  }
  if (!auth.loggedIn) {
    return <div className="app-shell auth-locked-shell">
      <AppTooltip />
      <AuthDialog open locked appInfo={appInfo} onClose={() => undefined} onAuthed={setAuth} />
    </div>
  }
  // The workbench queue, bindings, and material caches belong to this account.
  return <AuthenticatedApp key={String(auth.user?.id || '')} shell={shell} />
}

export default App
