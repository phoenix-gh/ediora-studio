import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { chatComposerColumn, chatContentColumn, chatConversationColumn } from './chat-layout'

function readFeatureSource(path: string) {
  return readFileSync(new URL(`../../components/features/chat/${path}`, import.meta.url), 'utf8')
}

it('uses one centered responsive column for chat content', () => {
  expect(chatContentColumn).toContain('mx-auto')
  expect(chatContentColumn).toContain('max-w-4xl')
  expect(chatConversationColumn).toContain('px-4')
  expect(chatConversationColumn).toContain('sm:px-6')
})

it('uses the same column for messages and the avatar-free composer', () => {
  expect(chatConversationColumn).toContain('px-4')
  expect(chatConversationColumn).toContain('sm:px-6')
  expect(chatComposerColumn).toBe(chatConversationColumn)
})

it('uses the shared column in both conversation and composer regions', () => {
  const workspace = readFeatureSource('ChatWorkspace.tsx')
  const composer = readFeatureSource('ChatComposer.tsx')

  expect(workspace.match(/chatConversationColumn/g)).not.toBeNull()
  expect(composer).toContain('chatComposerColumn')
})

it('does not render message avatars', () => {
  const source = readFeatureSource('ChatMessageView.tsx')

  expect(source).not.toContain('<span className="text-xs font-semibold">我</span>')
  expect(source).not.toContain('<Bot className="h-4 w-4" />')
})

it('renders assistant replies at the full message-column width', () => {
  const source = readFeatureSource('ChatMessageView.tsx')

  expect(source).toContain("isUser ? 'min-w-0 max-w-3xl space-y-2' : 'w-full min-w-0 space-y-2'")
})

it('uses the shared workspace surface and borderless assistant replies', () => {
  const workspace = readFeatureSource('ChatWorkspace.tsx')
  const sessions = readFeatureSource('ChatSessionList.tsx')
  const message = readFeatureSource('ChatMessageView.tsx')

  expect(workspace).toContain('flex h-full min-h-0 bg-surface')
  expect(workspace).toContain('h-[var(--app-header-height)] min-h-[var(--app-header-height)]')
  expect(message).toContain("isUser ? 'rounded-tr-sm bg-primary text-primary-foreground' : 'text-foreground'")
  expect(sessions).toContain('border-r border-border')
})

it('keeps message and composer padding compact and aligned', () => {
  const message = readFeatureSource('ChatMessageView.tsx')
  const composer = readFeatureSource('ChatComposer.tsx')

  expect(message).toContain("'break-words rounded-2xl px-3 py-2 text-sm leading-6'")
  expect(composer).toContain('rounded-xl border border-border bg-control p-3')
})

it('collapses assistant tool activity and hides audit-only messages', () => {
  const source = readFeatureSource('ChatMessageView.tsx')

  expect(source).toContain("return '已检索本地资料，并阅读 ' + reads + ' 条相关内容'")
  expect(source).toContain("if (message.role === 'tool') return null")
  expect(source).toContain('<ToolActivityGroup')
  expect(source).toContain('function GeneratedImagePreview({ urls }: { urls: string[] })')
  expect(source).toContain('<GeneratedImagePreview urls={imageUrls} />')
  expect(source).toContain('function ImageJobPreview({ jobId }: { jobId: number })')
  expect(source).toContain('<ImageJobPreview key={jobId} jobId={jobId} />')
  expect(source).toContain("import {\n  Dialog,\n  DialogContent,\n  DialogDescription,\n  DialogHeader,\n  DialogTitle,\n} from '@/components/ui/dialog'")
  expect(source).toContain('const [selectedImage, setSelectedImage] = useState<string | null>(null)')
  expect(source).toContain('onClick={() => setSelectedImage(url)}')
  expect(source).toContain('<Dialog open={selectedImage !== null} onOpenChange={open => !open && setSelectedImage(null)}>')
})

it('uses lazy new conversations and delegates session deletion', () => {
  const workspace = readFeatureSource('ChatWorkspace.tsx')
  const sessions = readFeatureSource('ChatSessionList.tsx')

  expect(workspace).toContain('startNewConversation()')
  expect(sessions).toContain('onNewConversation')
  expect(sessions).toContain('onDeleteSession(session.id)')
})

it('opens the most recently used persisted session when the assistant loads', () => {
  const source = readFeatureSource('ChatWorkspace.tsx')

  expect(source).toContain('if (nextSessions[0])')
  expect(source).toContain('void openSession(nextSessions[0].id)')
})

it('uses one context picker instead of permanent select controls', () => {
  const provider = readFeatureSource('ChatWorkspaceProvider.tsx')
  const composer = readFeatureSource('ChatComposer.tsx')

  expect(provider).toContain('Promise.all([listChatSkills(), listChatDrafts()])')
  expect(composer).toContain('<ChatContextPicker')
  expect(composer).toContain('onSkillNameChange={onSkillNameChange}')
  expect(composer).toContain('onDraftIdChange={onDraftIdChange}')
  expect(provider).toContain('skillName: state.composer.skillName || undefined')
  expect(provider).toContain('draftId: state.composer.draftId ?? undefined')
  expect(composer).not.toContain('<select')
  expect(composer).toContain('flex flex-col gap-2 rounded-xl border border-border bg-control p-3')
})

it('renders approval controls for pending global tool calls', () => {
  const message = readFeatureSource('ChatMessageView.tsx')
  const workspace = readFeatureSource('ChatWorkspace.tsx')

  expect(message).toContain('批准')
  expect(message).toContain('拒绝')
  expect(message).toContain('等待你确认')
  expect(message).toContain('hasPendingApproval')
  expect(workspace).toContain('respondToApproval({')
})

it('submits on Enter while preserving Shift+Enter newlines', () => {
  const source = readFeatureSource('ChatComposer.tsx')

  expect(source).toContain("import { shouldSubmitChatComposerKey } from '@/app/chat/chat-composer'")
  expect(source).toContain('shouldSubmitChatComposerKey({')
  expect(source).toContain('event.currentTarget.form?.requestSubmit()')
})
