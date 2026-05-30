'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import '@xterm/xterm/css/xterm.css'
import { Loader2, MessageSquare, X } from 'lucide-react'
import { resolveRetroSessions, retroTermUrl, type SessionCandidate } from '@/lib/api/retro'

type Phase = 'resolving' | 'connecting' | 'live' | 'empty' | 'error'

/**
 * Retro terminal — resumes the Hermes session that executed a kanban task and
 * bridges the agent's native interactive chat into an in-browser xterm. The
 * agent is the one who did the task, so it already has full context; the user
 * talks to it and tells it what to remember (it writes its own memory).
 *
 * Rendered as a self-contained modal portaled to <body> (NOT a nested shadcn
 * Dialog): the opener (TaskDrawer) is itself a custom fixed modal, and nesting
 * a base-ui Dialog inside it broke centering + left its header showing. The box
 * is absolutely positioned at center-minus-half-size so it opens centered yet
 * `resize: both` tracks the cursor (no re-centering on drag). Default 4:3.
 */
export function RetroTerminalDialog({
  open, onClose, taskId, profile, agentLabel,
}: {
  open: boolean
  onClose: () => void
  taskId: string | null
  profile: string
  agentLabel: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<Phase>('resolving')
  const [errMsg, setErrMsg] = useState('')
  const [candidates, setCandidates] = useState<SessionCandidate[]>([])
  const [picked, setPicked] = useState<string | null>(null)

  // 1) Resolve task → resumable sessions whenever the dialog opens.
  useEffect(() => {
    if (!open || !taskId) return
    let cancelled = false
    setPhase('resolving'); setErrMsg(''); setCandidates([]); setPicked(null)
    resolveRetroSessions(taskId, profile).then(
      (res) => {
        if (cancelled) return
        if (!res.candidates.length) { setPhase('empty'); return }
        setCandidates(res.candidates)
        setPicked(res.candidates[0].session_id)  // newest run
      },
      (e) => {
        if (cancelled) return
        setPhase('error')
        setErrMsg(e instanceof Error ? e.message : String(e))
      },
    )
    return () => { cancelled = true }
  }, [open, taskId, profile])

  // 2) Spin up xterm + websocket once we have a session to resume.
  useEffect(() => {
    if (!open || !picked) return
    let disposed = false
    let term: import('@xterm/xterm').Terminal | null = null
    let ws: WebSocket | null = null
    let ro: ResizeObserver | null = null

    setPhase('connecting')
    void (async () => {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      if (disposed || !hostRef.current) return

      const enc = new TextEncoder()
      term = new Terminal({
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        cursorBlink: true,
        allowProposedApi: true,   // hermes --tui uses proposed terminal APIs
        theme: { background: '#0a0a0a', foreground: '#e4e4e7' },
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(hostRef.current)
      try { fit.fit() } catch { /* container may be mid-animation */ }

      ws = new WebSocket(retroTermUrl(profile, picked))
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => {
        if (disposed || !term) return
        setPhase('live')
        ws!.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }))
        term.focus()
      }
      ws.onmessage = (ev) => {
        if (!term) return
        if (typeof ev.data === 'string') term.write(ev.data)
        else term.write(new Uint8Array(ev.data as ArrayBuffer))
      }
      ws.onerror = () => {
        if (!disposed) { setPhase('error'); setErrMsg('WebSocket 连接失败') }
      }
      ws.onclose = () => {
        if (!disposed) term?.write('\r\n\x1b[2m— 复盘会话已结束 —\x1b[0m\r\n')
      }

      // keystrokes → binary frames (text frames are reserved for control msgs)
      term.onData((d) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(enc.encode(d))
      })

      // when the modal is dragged/resized, refit and tell the PTY the new size
      ro = new ResizeObserver(() => {
        if (!term) return
        try { fit.fit() } catch { /* noop */ }
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }))
        }
      })
      ro.observe(hostRef.current)
    })()

    return () => {
      disposed = true
      ro?.disconnect()
      try { ws?.close() } catch { /* noop */ }
      try { term?.dispose() } catch { /* noop */ }
    }
  }, [open, picked, profile])

  const overlay =
    phase === 'resolving' ? <><Loader2 className="w-4 h-4 animate-spin" /> 正在定位这次任务的会话…</>
    : phase === 'empty' ? <span>没找到这个任务的可恢复会话。<br />（可能在重建 kanban 之前就执行了，session 已不在该 agent 的记录里。）</span>
    : phase === 'error' ? <span>出错了：{errMsg}</span>
    : null

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 z-[70]">
      {/* backdrop — covers the opener (TaskDrawer) so its header doesn't show through */}
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm animate-in fade-in duration-150"
        onClick={onClose}
      />
      {/* dialog — absolute, anchored at center-minus-half so it opens centered
          yet `resize: both` tracks the cursor (no re-centering on drag) */}
      <div
        role="dialog"
        aria-modal="true"
        className="absolute flex flex-col rounded-xl bg-zinc-950 border border-zinc-800 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        style={{
          top: 'max(2vh, calc(50% - 330px))',
          left: 'max(2vw, calc(50% - 440px))',
          width: 'min(92vw, 880px)',
          height: 'min(86vh, 660px)',
          minWidth: 360,
          minHeight: 280,
          maxWidth: '96vw',
          maxHeight: '92vh',
          resize: 'both',
        }}
      >
        <header className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 shrink-0 text-zinc-200">
          <MessageSquare className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-medium">复盘 · {agentLabel}</span>
          {candidates.length > 1 && picked && (
            <select
              className="text-xs bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-zinc-300"
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              title="该任务有多次执行，选择要复盘的那一次"
            >
              {candidates.map((c) => (
                <option key={c.session_id} value={c.session_id}>{c.session_id}</option>
              ))}
            </select>
          )}
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="relative flex-1 min-h-0 bg-[#0a0a0a]">
          <div
            ref={hostRef}
            className="absolute inset-0 p-1"
            style={{ visibility: picked ? 'visible' : 'hidden' }}
          />
          {overlay && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-center text-sm text-zinc-400 px-6">
              {overlay}
            </div>
          )}
        </div>

        <footer className="shrink-0 px-3 py-1 border-t border-zinc-800 text-[11px] text-zinc-500">
          续聊原会话 · 说「把这条记进记忆」让它沉淀 · 拖右下角调整大小
        </footer>
      </div>
    </div>,
    document.body,
  )
}
