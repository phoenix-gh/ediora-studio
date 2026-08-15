'use client'

import { useState, useEffect, useRef } from 'react'
import { Plus, Trash2, Pencil, Check, X, Loader2, Power, PowerOff } from 'lucide-react'
import { toast } from 'sonner'
import { FormSection } from '@/components/layout/FormSection'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  PublishAccount,
  PublishAccountInput,
  CoverStyle,
  listPublishAccounts,
  createPublishAccount,
  updatePublishAccount,
  deletePublishAccount,
} from '@/lib/api/publish-accounts'
import { AppSettings, getSettings, updateSettings } from '@/lib/api/settings'
import { CoverStyleEditor, buildCoverStyleFromEditor } from '@/components/features/CoverStyleEditor'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface EditState {
  id: string
  name: string
  platform: string
  positioning: string
  audience: string
  tone: string
  topic_focus_text: string  // newline-separated
  taboo_text: string        // newline-separated
  word_range_json: string   // raw JSON
  image_style: string
  voice_samples_text: string  // blank-line-separated paragraphs
  style_rules_text: string    // newline-separated rules
  cover_style: CoverStyle
  cover_motifs_text: string   // newline-separated
  cover_negative_text: string // newline-separated
  app_id: string
  app_secret: string
  is_active: boolean
}

interface TunnelForm {
  enabled: boolean
  ssh_host: string
  ssh_port: string
  ssh_user: string
  ssh_key_path: string
  local_host: string
  local_port: string
  remote_host: string
  remote_port: string
  extra_args: string
}

type LoadState = 'loading' | 'loaded' | 'error'

const PLATFORM_OPTIONS = [
  { value: 'wechat',   label: '公众号' },
  { value: 'x',        label: 'X / Twitter' },
  { value: 'youtube',  label: 'YouTube' },
  { value: 'red_book', label: '小红书' },
  { value: 'douyin',   label: '抖音 / 视频号' },
  { value: 'other',    label: '其他' },
]

const PLATFORM_LABEL: Record<string, string> = Object.fromEntries(
  PLATFORM_OPTIONS.map(p => [p.value, p.label]),
)

const EMPTY_EDIT: EditState = {
  id: '',
  name: '',
  platform: 'wechat',
  positioning: '',
  audience: '',
  tone: '',
  topic_focus_text: '',
  taboo_text: '',
  word_range_json: '{"min": 1500, "max": 2200}',
  image_style: '',
  voice_samples_text: '',
  style_rules_text: '',
  cover_style: {},
  cover_motifs_text: '',
  cover_negative_text: '',
  app_id: '',
  app_secret: '',
  is_active: true,
}

const EMPTY_TUNNEL: TunnelForm = {
  enabled: false,
  ssh_host: '',
  ssh_port: '22',
  ssh_user: '',
  ssh_key_path: '',
  local_host: '127.0.0.1',
  local_port: '18443',
  remote_host: 'api.weixin.qq.com',
  remote_port: '443',
  extra_args: '',
}

function accountToEdit(p: PublishAccount): EditState {
  return {
    id: p.id,
    name: p.name,
    platform: p.platform,
    positioning: p.positioning,
    audience: p.audience,
    tone: p.tone,
    topic_focus_text: (p.topic_focus ?? []).join('\n'),
    taboo_text: (p.taboo ?? []).join('\n'),
    word_range_json: JSON.stringify(p.word_range ?? {}, null, 0),
    image_style: p.image_style,
    voice_samples_text: (p.voice_samples ?? []).join('\n\n---\n\n'),
    style_rules_text: (p.style_rules ?? []).join('\n'),
    cover_style: p.cover_style ?? {},
    cover_motifs_text: (p.cover_style?.signature_motifs ?? []).join('\n'),
    cover_negative_text: (p.cover_style?.negative ?? []).join('\n'),
    app_id: p.app_id ?? '',
    app_secret: p.app_secret ?? '',
    is_active: p.is_active,
  }
}

function editToInput(form: EditState): PublishAccountInput | { error: string } {
  let word_range: Record<string, number> = {}
  if (form.word_range_json.trim()) {
    try {
      const parsed = JSON.parse(form.word_range_json)
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        return { error: '字数范围必须是 JSON 对象（如 {"min":1500,"max":2200}）' }
      }
      word_range = parsed
    } catch {
      return { error: '字数范围 JSON 格式错误' }
    }
  }
  return {
    id: form.id.trim(),
    name: form.name.trim(),
    platform: form.platform,
    positioning: form.positioning,
    audience: form.audience,
    tone: form.tone,
    topic_focus: form.topic_focus_text.split('\n').map(s => s.trim()).filter(Boolean),
    taboo: form.taboo_text.split('\n').map(s => s.trim()).filter(Boolean),
    word_range,
    image_style: form.image_style,
    voice_samples: form.voice_samples_text.split(/\n\s*---\s*\n/).map(s => s.trim()).filter(Boolean),
    style_rules: form.style_rules_text.split('\n').map(s => s.trim()).filter(Boolean),
    cover_style: buildCoverStyle(form),
    app_id: form.app_id.trim(),
    app_secret: form.app_secret.trim(),
    is_active: form.is_active,
  }
}

function buildCoverStyle(form: EditState): CoverStyle {
  return buildCoverStyleFromEditor(form.cover_style, form.cover_motifs_text, form.cover_negative_text)
}

function settingsToTunnelForm(settings: AppSettings): TunnelForm {
  return {
    enabled: settings.wechat_tunnel_enabled,
    ssh_host: settings.wechat_tunnel_ssh_host,
    ssh_port: String(settings.wechat_tunnel_ssh_port || 22),
    ssh_user: settings.wechat_tunnel_ssh_user,
    ssh_key_path: settings.wechat_tunnel_ssh_key_path,
    local_host: settings.wechat_tunnel_local_host || '127.0.0.1',
    local_port: String(settings.wechat_tunnel_local_port || 18443),
    remote_host: settings.wechat_tunnel_remote_host || 'api.weixin.qq.com',
    remote_port: String(settings.wechat_tunnel_remote_port || 443),
    extra_args: settings.wechat_tunnel_extra_args,
  }
}

export function PublishAccountsSection() {
  const [accounts, setAccounts] = useState<PublishAccount[]>([])
  const [accountsLoadState, setAccountsLoadState] = useState<LoadState>('loading')
  const [tunnelLoadState, setTunnelLoadState] = useState<LoadState>('loading')
  const [tunnelForm, setTunnelForm] = useState<TunnelForm>(EMPTY_TUNNEL)
  const [savingTunnel, setSavingTunnel] = useState(false)
  const [editingId, setEditingId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState<EditState>(EMPTY_EDIT)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const editorSession = useRef(0)
  const [deleteTarget, setDeleteTarget] = useState<PublishAccount | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const accountsLoadGeneration = useRef(0)
  const tunnelLoadGeneration = useRef(0)

  async function loadAccounts() {
    const generation = ++accountsLoadGeneration.current
    try {
      const list = await listPublishAccounts()
      if (accountsLoadGeneration.current !== generation) return
      setAccounts(list)
      setAccountsLoadState('loaded')
    } catch {
      if (accountsLoadGeneration.current === generation) setAccountsLoadState('error')
    }
  }

  async function loadTunnel() {
    const generation = ++tunnelLoadGeneration.current
    try {
      const settings = await getSettings()
      if (tunnelLoadGeneration.current !== generation) return
      setTunnelForm(settingsToTunnelForm(settings))
      setTunnelLoadState('loaded')
    } catch {
      if (tunnelLoadGeneration.current === generation) setTunnelLoadState('error')
    }
  }

  useEffect(() => {
    const accountsGeneration = ++accountsLoadGeneration.current
    void listPublishAccounts()
      .then(list => {
        if (accountsLoadGeneration.current !== accountsGeneration) return
        setAccounts(list)
        setAccountsLoadState('loaded')
      })
      .catch(() => {
        if (accountsLoadGeneration.current === accountsGeneration) {
          setAccountsLoadState('error')
        }
      })

    const tunnelGeneration = ++tunnelLoadGeneration.current
    void getSettings()
      .then(settings => {
        if (tunnelLoadGeneration.current !== tunnelGeneration) return
        setTunnelForm(settingsToTunnelForm(settings))
        setTunnelLoadState('loaded')
      })
      .catch(() => {
        if (tunnelLoadGeneration.current === tunnelGeneration) {
          setTunnelLoadState('error')
        }
      })

    return () => {
      accountsLoadGeneration.current += 1
      tunnelLoadGeneration.current += 1
    }
  }, [])

  function retryAccounts() {
    setAccountsLoadState('loading')
    void loadAccounts()
  }

  function retryTunnel() {
    setTunnelLoadState('loading')
    void loadTunnel()
  }

  function startNew() {
    if (accountsLoadState !== 'loaded') return
    editorSession.current += 1
    savingRef.current = false
    setSaving(false)
    setEditingId('new')
    setForm(EMPTY_EDIT)
  }

  function startEdit(p: PublishAccount) {
    if (accountsLoadState !== 'loaded') return
    editorSession.current += 1
    savingRef.current = false
    setSaving(false)
    setEditingId(p.id)
    setForm(accountToEdit(p))
  }

  function cancelEdit() {
    if (savingRef.current) return
    editorSession.current += 1
    setEditingId(null)
    setForm(EMPTY_EDIT)
  }

  async function handleSave() {
    if (accountsLoadState !== 'loaded' || savingRef.current) return
    const result = editToInput(form)
    if ('error' in result) {
      toast.error(result.error)
      return
    }
    if (!result.id || !result.name) {
      toast.error('ID 和 名称 不能为空')
      return
    }
    if (editingId === 'new' && !/^[a-z0-9_-]+$/i.test(result.id)) {
      toast.error('ID 只能包含字母数字 - _')
      return
    }

    const saveSession = editorSession.current
    const savedEditingId = editingId
    savingRef.current = true
    setSaving(true)
    try {
      if (savedEditingId === 'new') {
        const created = await createPublishAccount(result)
        setAccounts(prev => [...prev, created])
        toast.success('账号已创建')
      } else if (savedEditingId !== null) {
        // PATCH: 不传 id（不可改）
        const { id: omittedId, ...patch } = result
        void omittedId
        const updated = await updatePublishAccount(savedEditingId, patch)
        setAccounts(prev => prev.map(a => a.id === savedEditingId ? updated : a))
        toast.success('账号已更新')
      }
      if (editorSession.current === saveSession) {
        savingRef.current = false
        editorSession.current += 1
        setEditingId(null)
        setForm(EMPTY_EDIT)
      }
    } catch (e) {
      if (editorSession.current === saveSession) {
        toast.error('保存失败：' + (e instanceof Error ? e.message : '未知错误'))
      }
    } finally {
      if (editorSession.current === saveSession) {
        savingRef.current = false
        setSaving(false)
      }
    }
  }

  function requestDelete(account: PublishAccount) {
    if (accountsLoadState !== 'loaded') return
    setDeleteTarget(account)
    setDeleteError('')
  }

  async function confirmDelete() {
    if (accountsLoadState !== 'loaded' || !deleteTarget || deleting) return
    setDeleting(true)
    setDeleteError('')
    try {
      await deletePublishAccount(deleteTarget.id)
      setAccounts(prev => prev.filter(account => account.id !== deleteTarget.id))
      setDeleteTarget(null)
      toast.success('已删除')
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除失败')
      toast.error('删除失败')
    } finally {
      setDeleting(false)
    }
  }

  async function toggleActive(p: PublishAccount) {
    if (accountsLoadState !== 'loaded') return
    try {
      const updated = await updatePublishAccount(p.id, { is_active: !p.is_active })
      setAccounts(prev => prev.map(a => a.id === p.id ? updated : a))
    } catch {
      toast.error('切换状态失败')
    }
  }

  async function saveTunnel() {
    if (tunnelLoadState !== 'loaded' || savingTunnel) return
    if (tunnelForm.enabled && (!tunnelForm.ssh_host.trim() || !tunnelForm.ssh_user.trim())) {
      toast.error('启用隧道时必须填写 SSH Host 和 SSH User')
      return
    }
    setSavingTunnel(true)
    try {
      const saved = await updateSettings({
        wechat_tunnel_enabled: tunnelForm.enabled,
        wechat_tunnel_ssh_host: tunnelForm.ssh_host,
        wechat_tunnel_ssh_port: Number(tunnelForm.ssh_port) || 22,
        wechat_tunnel_ssh_user: tunnelForm.ssh_user,
        wechat_tunnel_ssh_key_path: tunnelForm.ssh_key_path,
        wechat_tunnel_local_host: tunnelForm.local_host || '127.0.0.1',
        wechat_tunnel_local_port: Number(tunnelForm.local_port) || 18443,
        wechat_tunnel_remote_host: tunnelForm.remote_host || 'api.weixin.qq.com',
        wechat_tunnel_remote_port: Number(tunnelForm.remote_port) || 443,
        wechat_tunnel_extra_args: tunnelForm.extra_args,
      })
      setTunnelForm(settingsToTunnelForm(saved))
      toast.success('公众号发布隧道配置已保存')
    } catch (e) {
      toast.error('保存隧道配置失败：' + (e instanceof Error ? e.message : '未知错误'))
    } finally {
      setSavingTunnel(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        发布账号即你运营的对外内容账号（公众号/X 等）。账号画像会被创作任务复用。
        会按任务 metadata 的 <code className="font-mono">account_id</code> 读取该账号画像，
        所有产出都贴合此处填写的定位/调性/受众/禁区。
      </p>

      <FormSection
        title="公众号发布隧道"
        description="发布到公众号草稿箱前先建立 SSH 本地转发，让微信官方 API 请求从跳板机出口访问。"
        actions={(
          <div className="flex items-center gap-2">
            <Label htmlFor="wechat-tunnel-enabled">启用发布隧道</Label>
            <Switch
              id="wechat-tunnel-enabled"
              checked={tunnelForm.enabled}
              disabled={tunnelLoadState !== 'loaded' || savingTunnel}
              onCheckedChange={enabled => setTunnelForm({ ...tunnelForm, enabled })}
            />
          </div>
        )}
      >
        {tunnelLoadState === 'loading' ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 正在加载隧道配置…
          </p>
        ) : null}
        {tunnelLoadState === 'error' ? (
          <div className="flex flex-wrap items-center gap-3">
            <p
              role="alert"
              aria-label="公众号发布隧道配置加载失败"
              className="text-sm text-destructive"
            >
              公众号发布隧道配置加载失败，请稍后重试
            </p>
            <Button type="button" variant="outline" size="sm" onClick={retryTunnel}>
              重试加载隧道配置
            </Button>
          </div>
        ) : null}
        <fieldset
          disabled={tunnelLoadState !== 'loaded' || savingTunnel}
          className="contents"
        >
          <FieldGroup>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="tunnel-ssh-host">SSH Host</FieldLabel>
            <Input
                id="tunnel-ssh-host"
              value={tunnelForm.ssh_host}
              onChange={e => setTunnelForm({ ...tunnelForm, ssh_host: e.target.value })}
              placeholder="jump.example.com"
                className="font-mono"
            />
            </Field>
            <Field>
              <FieldLabel htmlFor="tunnel-ssh-port">SSH Port</FieldLabel>
            <Input
                id="tunnel-ssh-port"
              value={tunnelForm.ssh_port}
              onChange={e => setTunnelForm({ ...tunnelForm, ssh_port: e.target.value })}
              placeholder="22"
                className="font-mono"
            />
            </Field>
            <Field>
              <FieldLabel htmlFor="tunnel-ssh-user">SSH User</FieldLabel>
            <Input
                id="tunnel-ssh-user"
              value={tunnelForm.ssh_user}
              onChange={e => setTunnelForm({ ...tunnelForm, ssh_user: e.target.value })}
              placeholder="ubuntu"
                className="font-mono"
            />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="tunnel-ssh-key-path">SSH Key Path</FieldLabel>
          <Input
              id="tunnel-ssh-key-path"
            value={tunnelForm.ssh_key_path}
            onChange={e => setTunnelForm({ ...tunnelForm, ssh_key_path: e.target.value })}
            placeholder="/home/user/.ssh/id_ed25519"
              className="font-mono"
          />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field>
              <FieldLabel htmlFor="tunnel-local-host">Local Host</FieldLabel>
            <Input
                id="tunnel-local-host"
              value={tunnelForm.local_host}
              onChange={e => setTunnelForm({ ...tunnelForm, local_host: e.target.value })}
                className="font-mono"
            />
            </Field>
            <Field>
              <FieldLabel htmlFor="tunnel-local-port">Local Port</FieldLabel>
            <Input
                id="tunnel-local-port"
              value={tunnelForm.local_port}
              onChange={e => setTunnelForm({ ...tunnelForm, local_port: e.target.value })}
                className="font-mono"
            />
            </Field>
            <Field>
              <FieldLabel htmlFor="tunnel-remote-host">Remote Host</FieldLabel>
            <Input
                id="tunnel-remote-host"
              value={tunnelForm.remote_host}
              onChange={e => setTunnelForm({ ...tunnelForm, remote_host: e.target.value })}
                className="font-mono"
            />
            </Field>
            <Field>
              <FieldLabel htmlFor="tunnel-remote-port">Remote Port</FieldLabel>
            <Input
                id="tunnel-remote-port"
              value={tunnelForm.remote_port}
              onChange={e => setTunnelForm({ ...tunnelForm, remote_port: e.target.value })}
                className="font-mono"
            />
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="tunnel-extra-args">额外 SSH 参数</FieldLabel>
          <Input
              id="tunnel-extra-args"
            value={tunnelForm.extra_args}
            onChange={e => setTunnelForm({ ...tunnelForm, extra_args: e.target.value })}
            placeholder="-o ProxyJump=bastion"
              className="font-mono"
          />
            <FieldDescription>
            发布时执行 <code className="font-mono">ssh -N -T -L local:remote</code>。请确保后端机器可免密登录跳板机。
            </FieldDescription>
          </Field>

          <Button
            variant="outline"
            onClick={saveTunnel}
            disabled={tunnelLoadState !== 'loaded' || savingTunnel}
          >
            {savingTunnel
              ? <Loader2 data-icon="inline-start" className="animate-spin" />
              : <Check data-icon="inline-start" />}
            保存隧道配置
          </Button>
          </FieldGroup>
        </fieldset>
      </FormSection>

      <FormSection
        title="账号画像"
        description="账号画像会被创作任务和发布流程复用。"
        actions={(
          <Button
            variant="outline"
            size="sm"
            onClick={startNew}
            disabled={accountsLoadState !== 'loaded'}
          >
            <Plus data-icon="inline-start" />
            新增发布账号
          </Button>
        )}
      >
        {accountsLoadState === 'loading' ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> 正在加载发布账号…
          </p>
        ) : null}
        {accountsLoadState === 'error' ? (
          <div className="flex flex-wrap items-center gap-3">
            <p
              role="alert"
              aria-label="发布账号加载失败"
              className="text-sm text-destructive"
            >
              发布账号加载失败，请稍后重试
            </p>
            <Button type="button" variant="outline" size="sm" onClick={retryAccounts}>
              重试加载发布账号
            </Button>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          {accounts.map(account => (
            <div key={account.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{account.name}</span>
                    <Badge variant="outline" className="font-mono">{account.id}</Badge>
                    <Badge variant="secondary">{PLATFORM_LABEL[account.platform] ?? account.platform}</Badge>
                    <Badge variant={account.is_active ? 'default' : 'outline'}>
                      {account.is_active ? '启用' : '停用'}
                    </Badge>
                  </div>
                  {account.positioning ? (
                    <p className="mb-2 line-clamp-2 text-sm text-muted-foreground">{account.positioning}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-1.5">
                    {(account.topic_focus ?? []).map(topic => (
                      <Badge key={topic} variant="outline">{topic}</Badge>
                    ))}
                    {(account.taboo ?? []).map(taboo => (
                      <Badge key={`tb-${taboo}`} variant="destructive">⛔ {taboo}</Badge>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`${account.is_active ? '停用' : '启用'} ${account.name}`}
                    disabled={accountsLoadState !== 'loaded'}
                    onClick={() => toggleActive(account)}
                  >
                    {account.is_active ? <Power /> : <PowerOff />}
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`编辑 ${account.name}`}
                    disabled={accountsLoadState !== 'loaded'}
                    onClick={() => startEdit(account)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`删除 ${account.name}`}
                    disabled={accountsLoadState !== 'loaded'}
                    onClick={() => requestDelete(account)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {accountsLoadState === 'loaded' && accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无发布账号。</p>
          ) : null}
        </div>
      </FormSection>

      <Dialog
        open={editingId !== null}
        onOpenChange={open => {
          if (!open && !savingRef.current) cancelEdit()
        }}
      >
        <DialogContent
          size="md"
          className="max-h-[90vh] overflow-y-auto"
          showCloseButton={!saving}
        >
          <DialogHeader>
            <DialogTitle>{editingId === 'new' ? '新增发布账号' : '编辑发布账号'}</DialogTitle>
          </DialogHeader>
          {editingId !== null && (
            <AccountForm
              form={form}
              setForm={setForm}
              onSave={handleSave}
              onCancel={cancelEdit}
              saving={saving}
              isNew={editingId === 'new'}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={open => {
          if (!open && !deleting) {
            setDeleteTarget(null)
            setDeleteError('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除发布账号？</AlertDialogTitle>
            <AlertDialogDescription>
              删除账号 {deleteTarget?.name}（{deleteTarget?.id}）后无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? <p role="alert" className="text-sm text-destructive">{deleteError}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function AccountForm({
  form, setForm, onSave, onCancel, saving, isNew,
}: {
  form: EditState
  setForm: (f: EditState) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  isNew: boolean
}) {
  return (
    <fieldset disabled={saving} className="contents">
    <FieldGroup>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="publish-account-id">ID {isNew ? '*' : '（不可改）'}</FieldLabel>
          <Input
            id="publish-account-id"
            value={form.id}
            disabled={!isNew}
            onChange={e => setForm({ ...form, id: e.target.value })}
            placeholder="pub_tech_gzh"
            className="font-mono"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="publish-account-name">名称 *</FieldLabel>
          <Input
            id="publish-account-name"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="硬核技术派"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="publish-account-platform">平台</FieldLabel>
          <Select
            value={form.platform}
            disabled={saving}
            onValueChange={value => value && setForm({ ...form, platform: value })}
          >
            <SelectTrigger id="publish-account-platform" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {PLATFORM_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>

      {form.platform === 'wechat' && (
        <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="publish-account-app-id">AppID（开发者ID）</FieldLabel>
              <Input
                id="publish-account-app-id"
                value={form.app_id}
                onChange={e => setForm({ ...form, app_id: e.target.value })}
                placeholder="wx1234567890abcdef"
                className="font-mono"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="publish-account-app-secret">AppSecret</FieldLabel>
              <Input
                id="publish-account-app-secret"
                type="password"
                value={form.app_secret}
                onChange={e => setForm({ ...form, app_secret: e.target.value })}
                placeholder="开发者密码"
                className="font-mono"
              />
              <FieldDescription>
                用于「存入公众号草稿箱」。需在公众号后台开启开发者模式，并把运行后端的服务器出口 IP 加入 IP 白名单。
              </FieldDescription>
            </Field>
        </div>
      )}

      <Field>
        <FieldLabel htmlFor="publish-account-positioning">定位（positioning）</FieldLabel>
        <Textarea
          id="publish-account-positioning"
          value={form.positioning}
          onChange={e => setForm({ ...form, positioning: e.target.value })}
          placeholder="面向资深工程师的深度技术分析号"
          rows={2}
        />
        <FieldDescription>一句话说清这个号是什么、面向谁、提供什么价值。</FieldDescription>
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="publish-account-audience">受众（audience）</FieldLabel>
          <Input
            id="publish-account-audience"
            value={form.audience}
            onChange={e => setForm({ ...form, audience: e.target.value })}
            placeholder="5年以上工龄的后端工程师"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="publish-account-tone">调性（tone）</FieldLabel>
          <Input
            id="publish-account-tone"
            value={form.tone}
            onChange={e => setForm({ ...form, tone: e.target.value })}
            placeholder="克制、有结构、不堆砌术语"
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="publish-account-topic-focus">选题方向（topic_focus，一行一个）</FieldLabel>
          <Textarea
            id="publish-account-topic-focus"
            value={form.topic_focus_text}
            onChange={e => setForm({ ...form, topic_focus_text: e.target.value })}
            placeholder={'分布式系统\n数据库内核\n开源项目剖析'}
            rows={4}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="publish-account-taboo">禁区（taboo，一行一个）</FieldLabel>
          <Textarea
            id="publish-account-taboo"
            value={form.taboo_text}
            onChange={e => setForm({ ...form, taboo_text: e.target.value })}
            placeholder={'职场鸡汤\n面试技巧\n培训广告'}
            rows={4}
          />
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor="publish-account-word-range">字数范围（word_range，JSON 对象）</FieldLabel>
        <FieldDescription>
          公众号通常：<code className="font-mono">{`{"min":1500,"max":2200}`}</code>；
          X 短串：<code className="font-mono">{`{"posts_min":8,"posts_max":12,"per_post_max_chars":270}`}</code>
        </FieldDescription>
        <Input
          id="publish-account-word-range"
          value={form.word_range_json}
          onChange={e => setForm({ ...form, word_range_json: e.target.value })}
          placeholder='{"min":1500,"max":2200}'
          className="font-mono"
        />
      </Field>

      <Field>
      </Field>

      <Field>
        <FieldLabel htmlFor="publish-account-image-style">配图风格（image_style）</FieldLabel>
        <Textarea
          id="publish-account-image-style"
          value={form.image_style}
          onChange={e => setForm({ ...form, image_style: e.target.value })}
          placeholder=""
          rows={2}
        />
      </Field>

      <details className="rounded-lg border border-border bg-surface">
        <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium hover:bg-surface-muted">
          封面风格（cover_style）── 锁死封面的 5 维与签名元素
        </summary>
        <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
          <p className="text-sm text-muted-foreground">
            填了之后 illustrator 直接照搬这套参数，不再凭 image_style 现场推断 —— 这是让同账号封面「看起来是一套的」关键。
            留空则回退到旧逻辑（按 image_style 翻译）。
          </p>
          <CoverStyleEditor
            coverStyle={form.cover_style}
            onCoverStyleChange={cs => setForm({ ...form, cover_style: cs })}
            motifsText={form.cover_motifs_text}
            onMotifsTextChange={t => setForm({ ...form, cover_motifs_text: t })}
            negativeText={form.cover_negative_text}
            onNegativeTextChange={t => setForm({ ...form, cover_negative_text: t })}
          />
        </div>
      </details>

      <Field>
        <FieldLabel htmlFor="publish-account-voice-samples">
          声音范文（voice_samples，多段用一行 --- 分隔）
        </FieldLabel>
        <FieldDescription>
          贴 2-3 段你认可的、能代表此账号「该有的样子」的真实文字（自己写的、或目标作者的）。
          writer 会把它当 few-shot 模仿对象，比 tone 字段管用得多。
        </FieldDescription>
        <Textarea
          id="publish-account-voice-samples"
          value={form.voice_samples_text}
          onChange={e => setForm({ ...form, voice_samples_text: e.target.value })}
          placeholder={'范文 1 的段落……\n\n---\n\n范文 2 的段落……'}
          rows={8}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="publish-account-style-rules">账号专属硬规则（style_rules，一行一条）</FieldLabel>
        <FieldDescription>
          覆盖在 SOUL 通用反 AI 规则之上的账号级约束。比如「用第一人称」「禁问句开头」「每段 ≤ 3 行」。
          writer 把它当硬约束逐条遵守。
        </FieldDescription>
        <Textarea
          id="publish-account-style-rules"
          value={form.style_rules_text}
          onChange={e => setForm({ ...form, style_rules_text: e.target.value })}
          placeholder={'用第一人称叙述\n禁用感叹号\n段落不超过 3 行\n允许使用「赛道」「估值」等行业词'}
          rows={4}
        />
      </Field>

      <Field orientation="horizontal">
        <Label htmlFor="pa_is_active">启用（停用后不会出现在派单下拉里）</Label>
        <Switch
          id="pa_is_active"
          checked={form.is_active}
          disabled={saving}
          onCheckedChange={is_active => setForm({ ...form, is_active })}
        />
      </Field>

      <div className="flex items-center gap-2">
        <Button onClick={onSave} disabled={saving}>
          {saving
            ? <Loader2 data-icon="inline-start" className="animate-spin" />
            : <Check data-icon="inline-start" />}
          保存
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          <X data-icon="inline-start" />
          取消
        </Button>
      </div>
    </FieldGroup>
    </fieldset>
  )
}
