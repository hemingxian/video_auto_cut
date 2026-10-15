import { Toaster } from 'sonner'

export function AppOperationToaster() {
  return <Toaster
    closeButton
    expand={false}
    offset={72}
    position="top-right"
    richColors
    theme="dark"
    toastOptions={{
      classNames: {
        toast: 'app-operation-toast',
        title: 'app-operation-toast-title',
        description: 'app-operation-toast-description',
        actionButton: 'app-operation-toast-action',
        cancelButton: 'app-operation-toast-cancel',
      },
    }}
  />
}
