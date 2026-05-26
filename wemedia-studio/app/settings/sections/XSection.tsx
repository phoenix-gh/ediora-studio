'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { getXAuthStatus, type XAuthStatus } from '@/lib/api/x'

export function XSection() {
  const [status, setStatus] = useState<XAuthStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getXAuthStatus()
      .then((s) => { if (!cancelled) setStatus(s) })
      .catch(() => { if (!cancelled) setStatus({ ready: false, hint: '无法连接后端 /api/x/auth-status' }) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-medium">X / Twitter (feedgrab)</h2>
        <p className="text-sm text-muted-foreground">
          本项目通过 feedgrab 采集 X 内容，认证完全交由 feedgrab 管理。
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">认证状态：</span>
          {loading ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> 检查中…
            </span>
          ) : status?.ready ? (
            <span className="flex items-center gap-1 text-green-600">
              <CheckCircle2 className="size-4" /> 已就绪
            </span>
          ) : (
            <span className="flex items-center gap-1 text-destructive">
              <XCircle className="size-4" /> 未登录
            </span>
          )}
        </div>
        {status?.hint && (
          <p className="mt-1 text-xs text-muted-foreground">{status.hint}</p>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4">
        <p className="mb-2 text-sm font-medium">如何登录</p>
        <p className="mb-2 text-xs text-muted-foreground">在 backend 启动目录任选其一：</p>
        <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
{`# 方法 1：交互式浏览器登录（推荐）
feedgrab login twitter

# 方法 2：环境变量（在 backend 启动前导出）
export X_AUTH_TOKEN=...
export X_CT0=...`}
        </pre>
      </div>
    </div>
  )
}
