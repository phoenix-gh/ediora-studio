import * as React from 'react'

import { cn } from '@/lib/utils'

const nativeSelectClass =
  'h-9 w-full min-w-0 rounded-lg border border-input bg-control px-3 text-sm text-foreground transition-colors outline-none [color-scheme:light] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-control-hover disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:[color-scheme:dark] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40'

function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      data-slot="native-select"
      className={cn(nativeSelectClass, className)}
      {...props}
    />
  )
}

export { NativeSelect, nativeSelectClass }
