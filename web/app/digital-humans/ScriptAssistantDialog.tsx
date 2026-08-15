'use client'

import { useEffect, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { getDrafts, type Draft } from '@/lib/api/drafts'
import {
  generateTalkingScript,
  type TalkingVideoProject,
} from '@/lib/api/digital-humans'


type Mode = 'generate' | 'convert_draft' | 'rewrite'


export function ScriptAssistantDialog({
  open,
  project,
  onClose,
  onUse,
}: {
  open: boolean
  project: TalkingVideoProject
  onClose: () => void
  onUse: (
    script: string,
    source: 'ai' | 'draft',
    sourceDraftId: number | null,
  ) => void
}) {
  const [mode, setMode] = useState<Mode>('generate')
  const [topic, setTopic] = useState('')
  const [instructions, setInstructions] = useState('')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [draftId, setDraftId] = useState('')
  const [candidate, setCandidate] = useState('')
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    if (!open) return
    void getDrafts().then(setDrafts).catch(() => setDrafts([]))
  }, [open])

  async function generate() {
    setGenerating(true)
    setCandidate('')
    try {
      const result = mode === 'generate'
        ? await generateTalkingScript({
            mode,
            topic,
            instructions: instructions || undefined,
          })
        : mode === 'convert_draft'
          ? await generateTalkingScript({
              mode,
              draftId: Number(draftId),
              instructions: instructions || undefined,
            })
          : await generateTalkingScript({
              mode,
              script: project.script,
              instructions,
            })
      setCandidate(result.script)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '脚本生成失败')
    } finally {
      setGenerating(false)
    }
  }

  const canGenerate = mode === 'generate'
    ? Boolean(topic.trim())
    : mode === 'convert_draft'
      ? Boolean(draftId)
      : Boolean(project.script.trim() && instructions.trim())

  return (
    <Dialog open={open} onOpenChange={value => !value && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>AI 脚本助手</DialogTitle>
          <DialogDescription>
            AI 只生成候选文本，确认使用后才会替换当前项目脚本。
          </DialogDescription>
        </DialogHeader>
        <Tabs value={mode} onValueChange={value => setMode(value as Mode)}>
          <TabsList>
            <TabsTrigger value="generate">根据主题生成</TabsTrigger>
            <TabsTrigger value="convert_draft">从草稿转换</TabsTrigger>
            <TabsTrigger value="rewrite">改写当前脚本</TabsTrigger>
          </TabsList>
          <TabsContent value="generate">
            <Field>
              <FieldLabel htmlFor="script-topic">口播主题</FieldLabel>
              <Input
                id="script-topic"
                value={topic}
                onChange={event => setTopic(event.target.value)}
              />
            </Field>
          </TabsContent>
          <TabsContent value="convert_draft">
            <Field>
              <FieldLabel>选择草稿</FieldLabel>
              <Select value={draftId} onValueChange={value => value && setDraftId(value)}>
                <SelectTrigger>
                  <SelectValue placeholder="选择已有草稿">
                    {value => {
                      const draft = drafts.find(
                        item => String(item.id) === value,
                      )
                      return draft?.title || (
                        draft ? `草稿 ${draft.id}` : '选择已有草稿'
                      )
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {drafts.map(draft => (
                      <SelectItem key={draft.id} value={String(draft.id)}>
                        {draft.title || `草稿 ${draft.id}`}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </TabsContent>
          <TabsContent value="rewrite">
            <FieldDescription>
              将基于当前编辑器内的脚本进行改写。
            </FieldDescription>
          </TabsContent>
        </Tabs>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="script-instructions">
              {mode === 'rewrite' ? '改写要求' : '额外要求（可选）'}
            </FieldLabel>
            <Textarea
              id="script-instructions"
              value={instructions}
              onChange={event => setInstructions(event.target.value)}
              placeholder="例如：控制在 90 秒内，语气更有亲和力"
            />
          </Field>
          <Button onClick={generate} disabled={generating || !canGenerate}>
            {generating
              ? <Loader2 data-icon="inline-start" />
              : <Sparkles data-icon="inline-start" />}
            生成候选脚本
          </Button>
          {candidate ? (
            <Field>
              <FieldLabel htmlFor="script-candidate">候选脚本</FieldLabel>
              <Textarea
                id="script-candidate"
                value={candidate}
                onChange={event => setCandidate(event.target.value)}
                className="min-h-48"
              />
              <Button
                onClick={() => {
                  onUse(
                    candidate,
                    mode === 'convert_draft' ? 'draft' : 'ai',
                    mode === 'convert_draft' ? Number(draftId) : null,
                  )
                  onClose()
                }}
              >
                使用这个脚本
              </Button>
            </Field>
          ) : null}
        </FieldGroup>
      </DialogContent>
    </Dialog>
  )
}
