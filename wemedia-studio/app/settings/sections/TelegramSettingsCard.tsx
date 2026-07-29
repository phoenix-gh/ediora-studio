'use client'

import { useState } from 'react'
import { BotIcon, LoaderCircleIcon, SaveIcon, SendIcon, Trash2Icon } from 'lucide-react'
import { toast } from 'sonner'

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
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { fmtDateTime } from '@/lib/format'
import {
  type AppSettings,
  clearTelegramSettings,
  getSettings,
  testTelegramSettings,
  updateSettings,
} from '@/lib/api/settings'

type PendingAction = 'save' | 'test' | 'clear' | null

function safeErrorMessage(error: unknown, token: string) {
  const message = error instanceof Error && error.message ? error.message : '操作失败'
  const candidates = [...new Set([token, token.trim()].filter(Boolean))]
  return candidates.reduce(
    (safeMessage, candidate) => safeMessage.replaceAll(candidate, '[已隐藏]'),
    message,
  )
}

export function TelegramSettingsCard({
  settings,
  onSaved,
}: {
  settings: AppSettings | null
  onSaved: (settings: AppSettings) => void
}) {
  const initialChatId = settings?.telegram_chat_id ?? ''
  const [serverSettings, setServerSettings] = useState<AppSettings | null>(settings)
  const [token, setToken] = useState('')
  const [chatId, setChatId] = useState(initialChatId)
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const [actionError, setActionError] = useState('')
  const [clearOpen, setClearOpen] = useState(false)
  const [clearError, setClearError] = useState('')
  const [previousSettings, setPreviousSettings] = useState(settings)

  if (settings !== previousSettings) {
    const nextChatId = settings?.telegram_chat_id ?? ''
    const savedChatId = previousSettings?.telegram_chat_id ?? ''
    const hasDirtyDraft = token.trim().length > 0
      || chatId.trim() !== savedChatId

    setPreviousSettings(settings)
    setServerSettings(settings)
    if (!hasDirtyDraft) setChatId(nextChatId)
  }

  const trimmedToken = token.trim()
  const trimmedChatId = chatId.trim()
  const dirty = trimmedToken.length > 0
    || trimmedChatId !== (serverSettings?.telegram_chat_id ?? '')
  const busy = pendingAction !== null
  const savedConfigurationReady = Boolean(
    serverSettings?.telegram_bot_token_set
    && serverSettings.telegram_chat_id.trim(),
  )
  const canSave = dirty && Boolean(trimmedChatId) && !busy
  const canTest = savedConfigurationReady && !dirty && !busy
  const canClear = Boolean(
    serverSettings?.telegram_bot_token_set
    || serverSettings?.telegram_chat_id
    || serverSettings?.telegram_test_status,
  ) && !busy

  function applyReturnedSettings(nextSettings: AppSettings, clearToken: boolean) {
    setServerSettings(nextSettings)
    setChatId(nextSettings.telegram_chat_id)
    if (clearToken) {
      setToken('')
    }
    onSaved(nextSettings)
  }

  function showActionError(prefix: string, error: unknown, currentToken: string) {
    const safeMessage = `${prefix}：${safeErrorMessage(error, currentToken)}`
    setActionError(safeMessage)
    toast.error(safeMessage)
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSave || busy) return

    const submittedToken = trimmedToken
    setPendingAction('save')
    setActionError('')
    try {
      const nextSettings = await updateSettings({
        ...(submittedToken ? { telegram_bot_token: submittedToken } : {}),
        telegram_chat_id: trimmedChatId,
      })
      applyReturnedSettings(nextSettings, true)
      toast.success('Telegram 配置已保存')
    } catch (error) {
      showActionError('保存失败', error, token)
    } finally {
      setPendingAction(null)
    }
  }

  async function handleTest() {
    if (!canTest || busy || dirty || !savedConfigurationReady) return

    setPendingAction('test')
    setActionError('')
    try {
      const nextSettings = await testTelegramSettings()
      applyReturnedSettings(nextSettings, false)
      toast.success('Telegram 测试消息已发送')
    } catch (error) {
      showActionError('测试失败', error, token)
      try {
        applyReturnedSettings(await getSettings(), false)
      } catch {
        // Keep the original test failure visible if refreshing persisted
        // backend metadata is temporarily unavailable.
      }
    } finally {
      setPendingAction(null)
    }
  }

  function handleClearOpenChange(open: boolean) {
    if (!open && pendingAction === 'clear') return
    setClearOpen(open)
    if (!open) setClearError('')
  }

  async function handleClear() {
    if (!canClear || busy) return

    setPendingAction('clear')
    setActionError('')
    setClearError('')
    try {
      const nextSettings = await clearTelegramSettings()
      applyReturnedSettings(nextSettings, true)
      setClearOpen(false)
      toast.success('Telegram 配置已清除')
    } catch (error) {
      const safeMessage = `清除失败：${safeErrorMessage(error, token)}`
      setClearError(safeMessage)
      toast.error(safeMessage)
    } finally {
      setPendingAction(null)
    }
  }

  const testStatus = serverSettings?.telegram_test_status ?? ''
  const safeLastTestError = serverSettings?.telegram_last_test_error
    ? safeErrorMessage(new Error(serverSettings.telegram_last_test_error), token)
    : ''

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BotIcon className="size-4" />
          Telegram Bot
        </CardTitle>
        <CardDescription>
          保存一个机器人和目标会话，用于即时建议与每日汇总推送。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-5" onSubmit={handleSave}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={serverSettings?.telegram_bot_token_set ? 'secondary' : 'outline'}>
              {serverSettings?.telegram_bot_token_set
                ? `Token 已配置 ${serverSettings.telegram_bot_token_preview}`
                : 'Token 未配置'}
            </Badge>
            <Badge
              variant={testStatus === 'success'
                ? 'default'
                : testStatus === 'failed'
                  ? 'destructive'
                  : 'outline'}
            >
              {testStatus === 'success' ? '测试成功' : testStatus === 'failed' ? '测试失败' : '尚未测试'}
            </Badge>
          </div>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="telegram-bot-token">Telegram Bot Token</FieldLabel>
              <Input
                id="telegram-bot-token"
                type="password"
                autoComplete="new-password"
                value={token}
                disabled={busy}
                onChange={event => setToken(event.target.value)}
                placeholder={serverSettings?.telegram_bot_token_set ? '留空则保留当前 Token' : '123456:ABC…'}
              />
              <FieldDescription>Token 只写不回显；页面只展示后端返回的末四位预览。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="telegram-chat-id">Telegram Chat ID</FieldLabel>
              <Input
                id="telegram-chat-id"
                value={chatId}
                disabled={busy}
                onChange={event => setChatId(event.target.value)}
                placeholder="-1001234567890"
              />
              <FieldDescription>群组或频道通常使用负数 Chat ID。</FieldDescription>
            </Field>
          </FieldGroup>

          {dirty && <p className="text-xs text-muted-foreground">请先保存当前修改</p>}
          {serverSettings?.telegram_last_tested_at && (
            <p className="text-xs text-muted-foreground">
              上次测试：{fmtDateTime(serverSettings.telegram_last_tested_at)}（Asia/Shanghai）
            </p>
          )}
          {safeLastTestError && <FieldError>上次测试失败：{safeLastTestError}</FieldError>}
          {actionError && <FieldError>{actionError}</FieldError>}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!canSave}>
              {pendingAction === 'save'
                ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
                : <SaveIcon data-icon="inline-start" />}
              {pendingAction === 'save' ? '保存中…' : '保存 Telegram 配置'}
            </Button>
            <Button type="button" variant="outline" disabled={!canTest} onClick={() => void handleTest()}>
              {pendingAction === 'test'
                ? <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
                : <SendIcon data-icon="inline-start" />}
              {pendingAction === 'test' ? '发送中…' : '发送测试消息'}
            </Button>
            <AlertDialog open={clearOpen} onOpenChange={handleClearOpenChange}>
              <AlertDialogTrigger
                render={<Button type="button" variant="destructive" disabled={!canClear} />}
              >
                <Trash2Icon data-icon="inline-start" />
                清除 Telegram 配置
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>清除 Telegram 配置</AlertDialogTitle>
                  <AlertDialogDescription>
                    清除 Telegram Bot Token、Chat ID 和测试记录？历史响应记录不会被删除。
                  </AlertDialogDescription>
                  {clearError && <FieldError>{clearError}</FieldError>}
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={pendingAction === 'clear'}>取消</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={pendingAction === 'clear'}
                    onClick={() => void handleClear()}
                  >
                    {pendingAction === 'clear' && (
                      <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
                    )}
                    {pendingAction === 'clear' ? '清除中…' : '确认清除'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </form>
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        测试只使用已保存配置，并发送一条固定中文消息；不会创建或修改 X 响应记录。
      </CardFooter>
    </Card>
  )
}
