'use client'

import { useEffect, useState } from 'react'
import { FlaskConicalIcon, LoaderCircleIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  createXCredentialAccount,
  deleteXCredentialAccount,
  listXCredentialAccounts,
  patchXCredentialAccount,
  testXCredentialAccount,
  type XCredentialAccount,
  type XCredentialPool,
  type XCredentialTestStatus,
} from '@/lib/api/x-accounts'

type FormState = {
  id: number | null
  name: string
  auth_token: string
  ct0: string
  enabled: boolean
}

type ActionName = 'save' | 'toggle' | 'test' | 'delete' | null

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  auth_token: '',
  ct0: '',
  enabled: true,
}

const STATUS: Record<XCredentialTestStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  untested: { label: '未测试', variant: 'outline' },
  available: { label: '可用', variant: 'default' },
  expired: { label: '已失效', variant: 'destructive' },
  rate_limited: { label: '被限流', variant: 'secondary' },
  failed: { label: '测试失败', variant: 'destructive' },
}

function safeErrorMessage(error: unknown, credentials: string[] = []) {
  const message = error instanceof Error ? error.message : '未知错误'
  return credentials.reduce(
    (safeMessage, credential) => credential ? safeMessage.replaceAll(credential, '[已隐藏]') : safeMessage,
    message,
  )
}

export function XCredentialAccountsCard() {
  const [pool, setPool] = useState<XCredentialPool | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [formOpen, setFormOpen] = useState(false)
  const [formError, setFormError] = useState('')
  const [actingId, setActingId] = useState<number | null>(null)
  const [actingAction, setActingAction] = useState<ActionName>(null)
  const [actionError, setActionError] = useState<{ action: Exclude<ActionName, null>; message: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<XCredentialAccount | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadPool() {
      try {
        const nextPool = await listXCredentialAccounts()
        if (!cancelled) setPool(nextPool)
      } catch (error) {
        if (!cancelled) setLoadError(`加载账号池失败：${safeErrorMessage(error)}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadPool()
    return () => { cancelled = true }
  }, [])

  const trimmedName = form.name.trim()
  const trimmedAuthToken = form.auth_token.trim()
  const trimmedCt0 = form.ct0.trim()
  const hasAuthToken = Boolean(trimmedAuthToken)
  const hasCt0 = Boolean(trimmedCt0)
  const hasPartialCredentials = hasAuthToken !== hasCt0
  const hasCompleteCredentials = hasAuthToken && hasCt0
  const hasBlankCredentials = !hasAuthToken && !hasCt0
  const isActing = actingAction !== null
  const canSave = Boolean(trimmedName)
    && !hasPartialCredentials
    && (form.id === null ? hasCompleteCredentials : hasCompleteCredentials || hasBlankCredentials)
    && !isActing

  function resetForm() {
    setForm(EMPTY_FORM)
    setFormError('')
  }

  function openCreateForm() {
    if (isActing) return
    resetForm()
    setFormOpen(true)
  }

  function openEditForm(account: XCredentialAccount) {
    if (isActing) return
    setForm({
      id: account.id,
      name: account.name,
      auth_token: '',
      ct0: '',
      enabled: account.enabled,
    })
    setFormError('')
    setFormOpen(true)
  }

  function handleFormOpenChange(open: boolean) {
    setFormOpen(open)
    if (!open) resetForm()
  }

  function openDeleteDialog(account: XCredentialAccount) {
    if (isActing) return
    setActionError(null)
    setDeleteTarget(account)
  }

  function handleDeleteOpenChange(open: boolean) {
    if (!open && !isActing) {
      setActionError(null)
      setDeleteTarget(null)
    }
  }

  function beginAction(id: number | null, action: Exclude<ActionName, null>) {
    setActionError(null)
    setActingId(id)
    setActingAction(action)
  }

  function finishAction() {
    setActingId(null)
    setActingAction(null)
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSave || isActing) return

    beginAction(form.id, 'save')
    setFormError('')
    const credentials = [...new Set([
      form.auth_token,
      form.ct0,
      trimmedAuthToken,
      trimmedCt0,
    ].filter(Boolean))]
    try {
      let nextPool: XCredentialPool
      if (form.id === null) {
        nextPool = await createXCredentialAccount({
          name: form.name.trim(),
          auth_token: trimmedAuthToken,
          ct0: trimmedCt0,
          enabled: form.enabled,
        })
      } else {
        nextPool = await patchXCredentialAccount(form.id, {
          name: form.name.trim(),
          enabled: form.enabled,
          ...(hasCompleteCredentials ? { auth_token: trimmedAuthToken, ct0: trimmedCt0 } : {}),
        })
      }
      setPool(nextPool)
      resetForm()
      setFormOpen(false)
    } catch (error) {
      setFormError(`保存账号失败：${safeErrorMessage(error, credentials)}`)
    } finally {
      finishAction()
    }
  }

  async function handleToggle(account: XCredentialAccount, enabled: boolean) {
    if (isActing) return
    beginAction(account.id, 'toggle')
    try {
      setPool(await patchXCredentialAccount(account.id, { enabled }))
    } catch (error) {
      setActionError({ action: 'toggle', message: `更新账号失败：${safeErrorMessage(error)}` })
    } finally {
      finishAction()
    }
  }

  async function handleTest(account: XCredentialAccount) {
    if (isActing) return
    beginAction(account.id, 'test')
    try {
      setPool(await testXCredentialAccount(account.id))
    } catch (error) {
      setActionError({ action: 'test', message: `测试账号失败：${safeErrorMessage(error)}` })
    } finally {
      finishAction()
    }
  }

  async function handleDelete() {
    if (!deleteTarget || isActing) return
    beginAction(deleteTarget.id, 'delete')
    try {
      setPool(await deleteXCredentialAccount(deleteTarget.id))
      setDeleteTarget(null)
    } catch (error) {
      setActionError({ action: 'delete', message: `删除账号失败：${safeErrorMessage(error)}` })
    } finally {
      finishAction()
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>X 采集账号池</CardTitle>
        <CardDescription>为 feedgrab 管理多个轮换采集凭据；页面只展示后端返回的脱敏预览。</CardDescription>
        <CardAction>
          <Dialog open={formOpen} onOpenChange={handleFormOpenChange}>
            <DialogTrigger render={<Button type="button" disabled={isActing} onClick={openCreateForm} />}>
              <PlusIcon data-icon="inline-start" />
              添加账号
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{form.id === null ? '添加采集账号' : '编辑采集账号'}</DialogTitle>
                <DialogDescription>
                  {form.id === null
                    ? '新增账号必须填写 auth_token 和 ct0；编辑时留空可保留已有凭据。'
                    : '凭据仅在保存时提交；留空可保留已有凭据。'}
                </DialogDescription>
              </DialogHeader>
              <form className="flex flex-col gap-4" onSubmit={handleSave}>
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="x-account-name">账号名称</FieldLabel>
                    <Input
                      id="x-account-name"
                      value={form.name}
                      onChange={event => setForm(current => ({ ...current, name: event.target.value }))}
                      placeholder="例如：采集账号 A"
                    />
                  </Field>
                  <Field data-invalid={hasPartialCredentials || undefined}>
                    <FieldLabel htmlFor="x-account-auth-token">auth_token</FieldLabel>
                    <Input
                      id="x-account-auth-token"
                      type="password"
                      autoComplete="new-password"
                      value={form.auth_token}
                      onChange={event => setForm(current => ({ ...current, auth_token: event.target.value }))}
                      aria-invalid={hasPartialCredentials || undefined}
                      placeholder={form.id === null ? '输入 auth_token' : '留空则保留当前凭据'}
                    />
                  </Field>
                  <Field data-invalid={hasPartialCredentials || undefined}>
                    <FieldLabel htmlFor="x-account-ct0">ct0</FieldLabel>
                    <Input
                      id="x-account-ct0"
                      type="password"
                      autoComplete="new-password"
                      value={form.ct0}
                      onChange={event => setForm(current => ({ ...current, ct0: event.target.value }))}
                      aria-invalid={hasPartialCredentials || undefined}
                      placeholder={form.id === null ? '输入 ct0' : '留空则保留当前凭据'}
                    />
                  </Field>
                  {hasPartialCredentials && <FieldError>auth_token 和 ct0 需要同时填写。</FieldError>}
                  <Field orientation="horizontal">
                    <FieldLabel htmlFor="x-account-enabled">启用采集</FieldLabel>
                    <Switch
                      id="x-account-enabled"
                      checked={form.enabled}
                      onCheckedChange={enabled => setForm(current => ({ ...current, enabled }))}
                    />
                  </Field>
                </FieldGroup>
                {formError && <FieldError>{formError}</FieldError>}
                <DialogFooter>
                  <Button type="submit" disabled={!canSave}>
                    {actingAction === 'save' && <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />}
                    保存账号
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2" aria-label="账号池统计">
          <Badge variant="secondary">账号总数：{pool?.total_accounts ?? 0}</Badge>
          <Badge variant="secondary">托管账号：{pool?.managed_enabled ?? 0}</Badge>
          <Badge variant="outline">可用账号：{pool?.available_accounts ?? 0}</Badge>
          <Badge variant="outline">外部 session：{pool?.external_sessions.length ?? 0}</Badge>
        </div>
        {loadError && <FieldError>{loadError}</FieldError>}
        {actionError?.action !== 'delete' && actionError && <FieldError>{actionError.message}</FieldError>}
        {loading && <p className="text-sm text-muted-foreground">正在加载采集账号…</p>}
        {!loading && pool?.accounts.length === 0 && <p className="text-sm text-muted-foreground">还没有托管采集账号。</p>}
        <AlertDialog open={Boolean(deleteTarget)} onOpenChange={handleDeleteOpenChange}>
          <div className="flex flex-col gap-3">
            {pool?.accounts.map(account => {
              const status = STATUS[account.test_status]
              return (
                <div key={account.id} className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{account.name}</span>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">auth_token：{account.auth_token_preview} · ct0：{account.ct0_preview}</p>
                    {account.last_test_error && <p className="text-xs text-destructive">{account.last_test_error}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Switch
                      checked={account.enabled}
                      disabled={isActing}
                      aria-label={`启用${account.name}`}
                      onCheckedChange={enabled => void handleToggle(account, enabled)}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isActing}
                      aria-label={`编辑${account.name}`}
                      onClick={() => openEditForm(account)}
                    >
                      <PencilIcon data-icon="inline-start" />
                      编辑
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isActing}
                      aria-label={actingId === account.id && actingAction === 'test' ? '测试中…' : `测试${account.name}`}
                      onClick={() => void handleTest(account)}
                    >
                      {actingId === account.id && actingAction === 'test'
                        ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
                        : <FlaskConicalIcon data-icon="inline-start" />}
                      {actingId === account.id && actingAction === 'test' ? '测试中…' : '测试'}
                    </Button>
                    <AlertDialogTrigger
                      render={<Button type="button" size="sm" variant="destructive" disabled={isActing} aria-label={`删除${account.name}`} />}
                      onClick={() => openDeleteDialog(account)}
                    >
                      <Trash2Icon data-icon="inline-start" />
                      删除
                    </AlertDialogTrigger>
                  </div>
                </div>
              )
            })}
          </div>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除采集账号</AlertDialogTitle>
              <AlertDialogDescription>删除后该托管账号将不能再参与采集轮换。</AlertDialogDescription>
              {actionError?.action === 'delete' && <FieldError>{actionError.message}</FieldError>}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isActing}>取消</AlertDialogCancel>
              <AlertDialogAction onClick={() => void handleDelete()} disabled={isActing}>
                {actingAction === 'delete' && <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />}
                确认删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        外部 session 请继续通过 feedgrab 的登录流程管理；本页不会显示或回填原始凭据。
      </CardFooter>
    </Card>
  )
}
