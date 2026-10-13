'use client'

import { useEffect, useState } from 'react'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Textarea } from '@/components/ui/textarea'
import {
  addComfyUIWorkflow,
  deleteComfyUIWorkflow,
  listComfyUIWorkflows,
  updateComfyUIWorkflow,
  type ComfyUIWorkflow,
  type ComfyUIWorkflowType,
} from '@/lib/api/settings'

const WORKFLOW_TYPES: { value: ComfyUIWorkflowType; label: string }[] = [
  { value: 'text_to_image', label: '文生图' },
]

function NodeField({
  id,
  label,
  value,
  onChange,
  example,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  example: string
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={example}
        autoComplete="off"
      />
    </Field>
  )
}

function typeLabel(type: string) {
  return WORKFLOW_TYPES.find(item => item.value === type)?.label ?? type
}

function nodeMapping(value: string, label: string) {
  const text = value.trim()
  const colon = text.indexOf(':')
  if (colon <= 0 || colon === text.length - 1) {
    throw new Error(`${label}格式是“节点:输入名”`)
  }
  return text
}

export function ComfyUIWorkflows() {
  const [workflows, setWorkflows] = useState<ComfyUIWorkflow[]>([])
  const [name, setName] = useState('')
  const [type, setType] = useState<ComfyUIWorkflowType>('text_to_image')
  const [jsonText, setJsonText] = useState('')
  const [promptNode, setPromptNode] = useState('')
  const [widthNode, setWidthNode] = useState('')
  const [heightNode, setHeightNode] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState('')
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let cancelled = false
    listComfyUIWorkflows()
      .then(result => {
        if (!cancelled) setWorkflows(result.workflows)
      })
      .catch(error => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : '工作流读取失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const activeTextToImageId = [...workflows].reverse().find(item => item.type === 'text_to_image')?.id
  const dialogOpen = editingId !== null

  function closeEditor() {
    if (saving) return
    setEditingId(null)
  }

  function openCreate() {
    setEditingId('')
    setName('')
    setType('text_to_image')
    setJsonText('')
    setPromptNode('')
    setWidthNode('')
    setHeightNode('')
  }

  function handleEdit(workflow: ComfyUIWorkflow) {
    setEditingId(workflow.id)
    setName(workflow.name)
    setType(workflow.type)
    setJsonText(JSON.stringify(workflow.workflow, null, 2))
    setPromptNode(workflow.inputs?.prompt ?? '')
    setWidthNode(workflow.inputs?.width ?? '')
    setHeightNode(workflow.inputs?.height ?? '')
  }

  async function handleSave() {
    const workflowName = name.trim()
    if (!workflowName) {
      toast.error('请填写工作流名字')
      return
    }
    let workflow: Record<string, unknown>
    try {
      const parsed = JSON.parse(jsonText) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('工作流 JSON 必须是对象')
      }
      workflow = parsed as Record<string, unknown>
    } catch (error) {
      toast.error(error instanceof SyntaxError ? '工作流 JSON 无法解析' : (
        error instanceof Error ? error.message : '工作流 JSON 无法解析'
      ))
      return
    }
    let inputs = { prompt: '', width: '', height: '' }
    if (type === 'text_to_image') {
      try {
        inputs = {
          prompt: nodeMapping(promptNode, '提示词节点'),
          width: nodeMapping(widthNode, '宽度节点'),
          height: nodeMapping(heightNode, '高度节点'),
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '请填写节点')
        return
      }
    }
    const body = { name: workflowName, type, workflow, inputs }
    setSaving(true)
    try {
      const saved = editingId
        ? await updateComfyUIWorkflow(editingId, body)
        : await addComfyUIWorkflow(body)
      setWorkflows(saved.workflows)
      setEditingId(null)
      toast.success(editingId ? '已保存工作流' : '已添加工作流')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (editingId ? '工作流保存失败' : '工作流添加失败'))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(workflow: ComfyUIWorkflow) {
    setDeletingId(workflow.id)
    try {
      const saved = await deleteComfyUIWorkflow(workflow.id)
      setWorkflows(saved.workflows)
      if (editingId === workflow.id) setEditingId(null)
      toast.success('已删除工作流')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '工作流删除失败')
    } finally {
      setDeletingId('')
    }
  }

  return (
    <FormSection
      title="工作流"
      description="保存工作流名字、类型和 ComfyUI 导出的 API JSON。可以新建、编辑和删除。文生图工具使用最近添加的一条。"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {loadError ? <p className="text-sm text-destructive">{loadError}</p> : null}
            {loading ? <p className="text-sm text-muted-foreground">正在读取工作流</p> : null}
            {!loading && !loadError && workflows.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有工作流</p>
            ) : null}
          </div>
          <Button type="button" className="shrink-0" onClick={openCreate}>
            <Plus data-icon="inline-start" />
            新建工作流
          </Button>
        </div>
        {workflows.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {workflows.map(workflow => (
              <li
                key={workflow.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{workflow.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {typeLabel(workflow.type)}
                    {workflow.inputs
                      ? ` · 提示词 ${workflow.inputs.prompt} · 宽度 ${workflow.inputs.width} · 高度 ${workflow.inputs.height}`
                      : ''}
                    {workflow.id === activeTextToImageId ? ' · 文生图工具使用这条' : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`编辑 ${workflow.name}`}
                    onClick={() => handleEdit(workflow)}
                  >
                    <Pencil data-icon="inline-start" />
                    编辑
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    aria-label={`删除 ${workflow.name}`}
                    disabled={deletingId === workflow.id}
                    onClick={() => void handleDelete(workflow)}
                  >
                    {deletingId === workflow.id
                      ? <Loader2 data-icon="inline-start" />
                      : <Trash2 data-icon="inline-start" />}
                    删除
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={open => {
          if (!open) closeEditor()
        }}
      >
        <DialogContent size="lg" className="max-h-[90vh] overflow-y-auto" showCloseButton={!saving}>
          <DialogHeader>
            <DialogTitle>{editingId ? '编辑工作流' : '新建工作流'}</DialogTitle>
            <DialogDescription>
              粘贴 ComfyUI 导出的 API JSON。文生图运行时把提示词和生图大小写到指定节点。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="comfyui-workflow-name">工作流名字</FieldLabel>
              <Input
                id="comfyui-workflow-name"
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder="例如：街拍文生图"
                autoComplete="off"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="comfyui-workflow-type">工作流类型</FieldLabel>
              <Select
                value={type}
                onValueChange={value => {
                  if (value === 'text_to_image') setType(value)
                }}
              >
                <SelectTrigger id="comfyui-workflow-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {WORKFLOW_TYPES.map(item => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="comfyui-workflow-json">工作流 JSON</FieldLabel>
              <Textarea
                id="comfyui-workflow-json"
                value={jsonText}
                onChange={event => setJsonText(event.target.value)}
                className="min-h-40 font-mono text-xs"
                spellCheck={false}
                placeholder={'{\n  "6": {\n    "class_type": "CLIPTextEncode",\n    "inputs": { "text": "a portrait", "clip": ["4", 1] }\n  },\n  "5": {\n    "class_type": "EmptyLatentImage",\n    "inputs": { "width": 1024, "height": 1024, "batch_size": 1 }\n  }\n}'}
              />
              <FieldDescription>
                直接粘贴 ComfyUI 的 API 格式。不要改里面的提示词和尺寸，下面指定写入哪个节点。
              </FieldDescription>
            </Field>
            {type === 'text_to_image' ? (
              <>
                <NodeField id="comfyui-workflow-prompt-node" label="提示词节点" value={promptNode} onChange={setPromptNode} example="6:text" />
                <NodeField id="comfyui-workflow-width-node" label="宽度节点" value={widthNode} onChange={setWidthNode} example="5:width" />
                <NodeField id="comfyui-workflow-height-node" label="高度节点" value={heightNode} onChange={setHeightNode} example="5:height" />
              </>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeEditor} disabled={saving}>
              取消
            </Button>
            <Button type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving
                ? <Loader2 data-icon="inline-start" />
                : editingId
                  ? <Pencil data-icon="inline-start" />
                  : <Plus data-icon="inline-start" />}
              {editingId ? '保存修改' : '添加工作流'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </FormSection>
  )
}
