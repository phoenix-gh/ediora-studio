import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { chatComposerColumn, chatContentColumn, chatConversationColumn } from './chat-layout'

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
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source.match(/chatConversationColumn/g)).toHaveLength(3)
  expect(source.match(/chatComposerColumn/g)).toHaveLength(2)
})

it('does not render message avatars', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).not.toContain('<span className="text-xs font-semibold">我</span>')
  expect(source).not.toContain('<Bot className="h-4 w-4" />')
})

it('renders assistant replies at the full message-column width', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).toContain("isUser ? 'min-w-0 max-w-3xl space-y-2' : 'w-full min-w-0 space-y-2'")
})

it('uses a white workspace and borderless assistant replies', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).toContain('flex h-full min-h-0 bg-white dark:bg-zinc-950')
  expect(source).toContain("? 'rounded-tr-sm bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'\n              : 'text-zinc-800 dark:text-zinc-100'")
})

it('keeps message and composer padding compact and aligned', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).toContain("'break-words rounded-2xl px-3 py-2 text-sm leading-6'")
  expect(source).toContain('rounded-xl border border-zinc-200 bg-white p-3')
})

it('collapses assistant tool activity and hides audit-only messages', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).toContain('return `已检索本地资料，并阅读 ${reads} 条相关内容`')
  expect(source).toContain("if (message.role === 'tool') {\n    return null\n  }")
  expect(source).toContain('<ToolActivityGroup parts={toolParts} onApproval=')
  expect(source).toContain('function ImageJobPreview({ jobId }: { jobId: number })')
  expect(source).toContain('<ImageJobPreview key={jobId} jobId={jobId} />')
  expect(source).toContain("import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'")
  expect(source).toContain('const [selectedImage, setSelectedImage] = useState<string | null>(null)')
  expect(source).toContain('<button type="button" onClick={() => setSelectedImage(url)}')
  expect(source).toContain('<Dialog open={selectedImage !== null} onOpenChange={open => !open && setSelectedImage(null)}>')
})

it('uses lazy new conversations and deletes selected persisted sessions', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).toContain('function startNewConversation()')
  expect(source).toContain('onClick={startNewConversation}')
  expect(source).toContain('await deleteChatSession(session.id)')
  expect(source).toContain('<Trash2')
})

it('opens the most recently used persisted session when the assistant loads', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).toContain('if (nextSessions[0]) void openSession(nextSessions[0].id)')
})

it('uses one context picker instead of permanent select controls', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).toContain('Promise.all([listChatSkills(), listChatDrafts()])')
  expect(source).toContain('<ChatContextPicker')
  expect(source).toContain("onSkillNameChange={skill => setSkillName(skill ?? '')}")
  expect(source).toContain("onDraftIdChange={draft => setDraftId(draft ? String(draft) : '')}")
  expect(source).toContain('skillName: skillName || undefined')
  expect(source).toContain('draftId: draftId ? Number(draftId) : undefined')
  expect(source).not.toContain('<select value={skillName}')
  expect(source).not.toContain('<select value={draftId}')
  expect(source).toContain('flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-3')
  expect(source.indexOf('<ChatContextPicker')).toBeGreaterThan(source.indexOf('<textarea'))
  expect(source.indexOf('<ChatContextPicker')).toBeLessThan(source.indexOf('<Button type="submit"'))
  expect(source).toContain('setSkillName(\'\')')
  expect(source).toContain('setDraftId(\'\')')
})

it('renders approval controls for pending global tool calls', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).toContain('批准')
  expect(source).toContain('拒绝')
  expect(source).toContain('<details open={hasPendingApproval}')
  expect(source).toContain('等待你确认')
  expect(source).toContain('approval: { messageId')
})

it('submits on Enter while preserving Shift+Enter newlines', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')

  expect(source).toContain("import { shouldSubmitChatComposerKey } from './chat-composer'")
  expect(source).toContain('shouldSubmitChatComposerKey({')
  expect(source).toContain('event.currentTarget.form?.requestSubmit()')
})
