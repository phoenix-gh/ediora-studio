'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Grip } from 'lucide-react'

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

type FloatingChatPosition = {
  left: number
  top: number
}

function currentViewport(): Viewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  }
}

function renderViewport(): Viewport {
  return typeof window === 'undefined' ? { width: 1440, height: 900 } : currentViewport()
}

function defaultPosition(size: FloatingChatSize, viewport: Viewport): FloatingChatPosition {
  return {
    left: Math.max(16, viewport.width - size.width - 16),
    top: Math.max(16, viewport.height - size.height - 16),
  }
}

function clampPosition(position: FloatingChatPosition, size: FloatingChatSize, viewport: Viewport): FloatingChatPosition {
  const maxLeft = Math.max(16, viewport.width - size.width - 16)
  const maxTop = Math.max(16, viewport.height - size.height - 16)
  return {
    left: Math.min(maxLeft, Math.max(16, position.left)),
    top: Math.min(maxTop, Math.max(16, position.top)),
  }
}

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('button, a, input, textarea, select, [role="button"]'))
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
  const [position, setPosition] = useState<FloatingChatPosition | null>(null)
  const sizeRef = useRef<FloatingChatSize>(size)
  const positionRef = useRef<FloatingChatPosition | null>(position)
  const resizeRef = useRef<{
    startX: number
    startY: number
    startSize: FloatingChatSize
    startPosition: FloatingChatPosition
    pointerId: number
  } | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; startPosition: FloatingChatPosition; pointerId: number } | null>(null)

  function updateSize(nextSize: FloatingChatSize) {
    sizeRef.current = nextSize
    setSize(nextSize)
  }

  function updatePosition(nextPosition: FloatingChatPosition | null) {
    positionRef.current = nextPosition
    setPosition(nextPosition)
  }

  useEffect(() => {
    sizeRef.current = size
  }, [size])

  useEffect(() => {
    const handleViewportResize = () => {
      const viewport = currentViewport()
      const nextSize = clampFloatingChatSize(sizeRef.current, viewport)
      updateSize(nextSize)
      if (positionRef.current) updatePosition(clampPosition(positionRef.current, nextSize, viewport))
    }
    window.addEventListener('resize', handleViewportResize)
    return () => window.removeEventListener('resize', handleViewportResize)
  }, [])

  function resetSize() {
    const viewport = currentViewport()
    const nextSize = clampFloatingChatSize(DEFAULT_FLOATING_CHAT_SIZE, viewport)
    updateSize(nextSize)
    if (positionRef.current) updatePosition(clampPosition(positionRef.current, nextSize, viewport))
    writeFloatingChatSize(browserStorage(), nextSize)
  }

  function handleResizeStart(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 && event.pointerType !== 'touch') return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const viewport = currentViewport()
    resizeRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startSize: sizeRef.current,
      startPosition: positionRef.current ?? defaultPosition(sizeRef.current, viewport),
      pointerId: event.pointerId,
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const resize = resizeRef.current
      if (!resize || moveEvent.pointerId !== resize.pointerId) return
      const viewport = currentViewport()
      const deltaX = moveEvent.clientX - resize.startX
      const deltaY = moveEvent.clientY - resize.startY
      const nextSize = clampFloatingChatSize({
        width: resize.startSize.width - deltaX,
        height: resize.startSize.height - deltaY,
      }, viewport)
      updateSize(nextSize)
      updatePosition(clampPosition({
        left: resize.startPosition.left + deltaX,
        top: resize.startPosition.top + deltaY,
      }, nextSize, viewport))
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

  function handleDragStart(event: ReactPointerEvent<HTMLElement>) {
    if ((event.button !== 0 && event.pointerType !== 'touch') || isInteractiveTarget(event.target)) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const viewport = currentViewport()
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startPosition: positionRef.current ?? defaultPosition(sizeRef.current, viewport),
      pointerId: event.pointerId,
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || moveEvent.pointerId !== drag.pointerId) return
      const nextPosition = clampPosition({
        left: drag.startPosition.left + moveEvent.clientX - drag.startX,
        top: drag.startPosition.top + moveEvent.clientY - drag.startY,
      }, sizeRef.current, currentViewport())
      updatePosition(nextPosition)
    }

    const handlePointerEnd = (endEvent: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || endEvent.pointerId !== drag.pointerId) return
      dragRef.current = null
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerEnd)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerEnd)
  }

  const viewport = renderViewport()
  const panelPosition = position ?? defaultPosition(size, viewport)
  const panelStyle = {
    width: `${size.width}px`,
    height: `${size.height}px`,
    left: `${panelPosition.left}px`,
    top: `${panelPosition.top}px`,
    maxWidth: 'calc(100vw - 2rem)',
    maxHeight: 'calc(100dvh - 2rem)',
  }

  return (
    <Dialog open={open} onOpenChange={setOpen} modal={false} disablePointerDismissal>
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
        className="!m-0 !translate-x-0 !translate-y-0 !grid-rows-[auto_minmax(0,1fr)] !gap-0 !overflow-hidden !p-0"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>AI 助手</DialogTitle>
          <DialogDescription>全局浮动聊天助手</DialogDescription>
        </DialogHeader>
        <ChatWorkspace variant="floating" onClose={() => setOpen(false)} onHeaderPointerDown={handleDragStart} />
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
          aria-label="拖动调整聊天窗口大小"
          title="拖动调整聊天窗口大小"
          onPointerDown={handleResizeStart}
          className="absolute top-1 left-1 z-10 flex size-5 cursor-nwse-resize touch-none select-none items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-muted hover:text-foreground"
        >
          <Grip aria-hidden="true" className="size-3.5 rotate-45" />
        </button>
      </DialogContent>
    </Dialog>
  )
}
