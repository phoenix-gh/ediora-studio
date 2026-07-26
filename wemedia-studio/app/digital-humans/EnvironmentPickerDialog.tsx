'use client'

import { useEffect, useState } from 'react'
import { ImagePlus, Loader2, Sparkles, Upload } from 'lucide-react'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  creativeAssetUrl,
  listCreativeAssets,
  uploadCreativeAsset,
  type CreativeAsset,
} from '@/lib/api/assets'
import { createJob, getJob } from '@/lib/api/jobs'


type Props = {
  open: boolean
  onClose: () => void
  onSelect: (asset: CreativeAsset) => void
}


function validateEnvironmentFile(file: File) {
  if (!['image/png', 'image/jpeg'].includes(file.type)) {
    throw new Error('环境图仅支持 PNG 或 JPEG')
  }
  if (file.size > 32 * 1024 * 1024) {
    throw new Error('环境图不能超过 32MB')
  }
}


export function EnvironmentPickerDialog({
  open,
  onClose,
  onSelect,
}: Props) {
  const [assets, setAssets] = useState<CreativeAsset[]>([])
  const [prompt, setPrompt] = useState('')
  const [uploading, setUploading] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    if (!open) return
    void listCreativeAssets('media').then(items => {
      setAssets(items.filter(item => (
        item.media_kind === 'image'
        && ['image/png', 'image/jpeg'].includes(item.media_type)
      )))
    })
  }, [open])

  function choose(asset: CreativeAsset) {
    onSelect(asset)
    onClose()
  }

  async function handleUpload(file: File | undefined) {
    if (!file) return
    try {
      validateEnvironmentFile(file)
      setUploading(true)
      choose(await uploadCreativeAsset('image', file))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  async function handleGenerate() {
    if (!prompt.trim()) return
    setGenerating(true)
    try {
      const job = await createJob({
        flow: 'standalone_image',
        title: `生成数字人口播环境图 · ${prompt.trim().slice(0, 30)}`,
        input: { prompt: prompt.trim(), title: prompt.trim().slice(0, 80) },
        idempotency_key: `talking-environment:${crypto.randomUUID()}`,
      })
      let finished = job
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (finished.status === 'succeeded' || finished.status === 'failed') break
        await new Promise(resolve => setTimeout(resolve, 1_500))
        finished = await getJob(job.id)
      }
      if (finished.status !== 'succeeded') {
        throw new Error('环境图生成失败，请到创作任务查看详情')
      }
      const assetId = finished.steps
        .map(step => step.output.asset_id)
        .find((value): value is number => typeof value === 'number')
      if (!assetId) throw new Error('生成任务未返回创作资产')
      const latest = await listCreativeAssets('media')
      const asset = latest.find(item => item.id === assetId)
      if (!asset) throw new Error('生成的环境图资产不存在')
      choose(asset)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={value => !value && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>选择环境图</DialogTitle>
          <DialogDescription>
            为数字人选择默认演播环境，项目中仍可单独替换。
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="assets">
          <TabsList>
            <TabsTrigger value="upload">
              <Upload data-icon="inline-start" />
              上传图片
            </TabsTrigger>
            <TabsTrigger value="assets">
              <ImagePlus data-icon="inline-start" />
              创作资产
            </TabsTrigger>
            <TabsTrigger value="ai">
              <Sparkles data-icon="inline-start" />
              AI 生成
            </TabsTrigger>
          </TabsList>
          <TabsContent value="upload">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="environment-upload">环境图片</FieldLabel>
                <Input
                  id="environment-upload"
                  type="file"
                  accept="image/png,image/jpeg"
                  disabled={uploading}
                  onChange={event => void handleUpload(event.target.files?.[0])}
                />
                <FieldDescription>PNG/JPEG，最大 32MB。</FieldDescription>
              </Field>
            </FieldGroup>
          </TabsContent>
          <TabsContent value="assets">
            <div className="grid max-h-[48vh] grid-cols-2 gap-3 overflow-y-auto md:grid-cols-4">
              {assets.map(asset => (
                <button
                  key={asset.id}
                  type="button"
                  aria-label={asset.title}
                  className="overflow-hidden rounded-lg border bg-card text-left hover:bg-muted"
                  onClick={() => choose(asset)}
                >
                  <img
                    src={creativeAssetUrl(asset.url)}
                    alt=""
                    className="aspect-video w-full object-cover"
                  />
                  <span className="block truncate p-2 text-sm">{asset.title}</span>
                </button>
              ))}
            </div>
          </TabsContent>
          <TabsContent value="ai">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="environment-prompt">环境描述</FieldLabel>
                <Textarea
                  id="environment-prompt"
                  value={prompt}
                  onChange={event => setPrompt(event.target.value)}
                  placeholder="例如：明亮简洁的科技演播室，柔和侧光，16:9"
                />
              </Field>
              <Button
                onClick={handleGenerate}
                disabled={generating || !prompt.trim()}
              >
                {generating
                  ? <Loader2 data-icon="inline-start" />
                  : <Sparkles data-icon="inline-start" />}
                生成并使用
              </Button>
            </FieldGroup>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
