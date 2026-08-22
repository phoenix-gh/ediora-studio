'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

import { ChatWorkspace } from './ChatWorkspace'
import {
  DEFAULT_FLOATING_CHAT_SIZE,
  clampFloatingChatSize,
  readFloatingChatSize,
  writeFloatingChatSize,
  type FloatingChatSize,
} from './floating-chat-size'

type Viewport = {
  width: number
  height: number
}

function currentViewport(): Viewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  }
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function initialPanelSize() {
  if (typeof window === 'undefined') return DEFAULT_FLOATING_CHAT_SIZE
  return readFloatingChatSize(browserStorage(), currentViewport())
}

export function GlobalChatWidget() {
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState<FloatingChatSize>(initialPanelSize)
  const sizeRef = useRef<FloatingChatSize>(size)
  const resizeRef = useRef<{ startX: number; startY: number; startSize: FloatingChatSize; pointerId: number } | null>(null)

  function updateSize(nextSize: FloatingChatSize) {
    sizeRef.current = nextSize
    setSize(nextSize)
  }

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    const handleViewportResize = () => {
      updateSize(clampFloatingChatSize(sizeRef.current, currentViewport()))
    }
    window.addEventListener('resize', handleViewportResize)
    return () => window.removeEventListener('resize', handleViewportResize)
  }, [])

  function resetSize() {
    const nextSize = clampFloatingChatSize(DEFAULT_FLOATING_CHAT_SIZE, currentViewport())
    updateSize(nextSize)
    writeFloatingChatSize(browserStorage(), nextSize)
  }

  function handleResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    resizeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startSize: sizeRef.current,
      pointerId: event.pointerId,
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const resize = resizeRef.current
      if (!resize || moveEvent.pointerId !== resize.pointerId) return
      updateSize(clampFloatingChatSize({
        width: resize.startSize.width + moveEvent.clientX - resize.startX,
        height: resize.startSize.height + moveEvent.clientY - resize.startY,
      }, currentViewport()))
    }

    const handlePointerEnd = (endEvent: PointerEvent) => {
      const resize = resizeRef.current
      if (!resize || endEvent.pointerId !== resize.pointerId) return
      resizeRef.current = null
      writeFloatingChatSize(browserStorage(), sizeRef.current)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
  }

  const panelStyle = {
    width: `${size.width}px`,
    height: `${size.height}px`,
    maxWidth: 'calc(100vw - 2rem)',
    maxHeight: 'calc(100dvh - 2rem)',
  }

  return (
    <Dialog open={open} onOpenChange={setOpen} modal={false}>
      <DialogTrigger
        render={(
          <button
            type="button"
            data-testid="global-chat-trigger"
            aria-label="打开 AI 助手"
            title="打开 AI 助手"
            className="fixed right-5 bottom-5 z-40 flex size-14 items-center justify-center rounded-full border border-indigo-200 bg-white p-2 shadow-lg shadow-indigo-950/15 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-indigo-400 dark:border-indigo-800 dark:bg-indigo-950"
          />
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/ediora-mark.svg" alt="" aria-hidden="true" className="size-full" />
      </DialogTrigger>

      <DialogContent
        data-testid="global-chat-panel"
        showOverlay={false}
        showCloseButton={false}
        style={panelStyle}
        className="!top-auto !right-4 !bottom-4 !left-auto !m-0 !translate-x-0 !translate-y-0 !grid-rows-[auto_minmax(0,1fr)] !gap-0 !overflow-hidden !p-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>AI 助手</DialogTitle>
          <DialogDescription>全局浮动聊天助手</DialogDescription>
        </DialogHeader>
        <ChatWorkspace variant="floating" onClose={() => setOpen(false)} />
        <button
          type="button"
          data-testid="floating-chat-reset-size"
          aria-label="恢复聊天窗口默认大小"
          title="恢复默认大小"
          onClick={resetSize}
          className="absolute top-2 right-10 z-10 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          默认大小
        </button>
        <button
          type="button"
          data-testid="floating-chat-resize-handle"
          aria-label="调整聊天窗口大小"
          title="调整窗口大小"
          onPointerDown={handleResizeStart}
          className="absolute right-1 bottom-1 z-10 size-4 cursor-se-resize rounded-sm text-foreground-subtle after:absolute after:right-0 after:bottom-0 after:size-2 after:border-r-2 after:border-b-2 after:border-current"
        />
      </DialogContent>
    </Dialog>
  )
}
