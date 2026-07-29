'use client'

import { useEffect, useState } from 'react'
import { Image, Loader2, Mic, Save } from 'lucide-react'
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
  listCreativeAssets,
  uploadCreativeAsset,
  type CreativeAsset,
} from '@/lib/api/assets'
import {
  createDigitalHuman,
  updateDigitalHuman,
  type DigitalHuman,
} from '@/lib/api/digital-humans'

import { EnvironmentPickerDialog } from './EnvironmentPickerDialog'


type PickerKind = 'portrait' | 'voice' | null


function validateFile(kind: Exclude<PickerKind, null>, file: File) {
  const accepted = kind === 'portrait'
    ? ['image/png', 'image/jpeg']
    : ['audio/mpeg', 'audio/wav', 'audio/x-wav']
  if (!accepted.includes(file.type)) {
    throw new Error(kind === 'portrait'
      ? '人物形象仅支持 PNG 或 JPEG'
      : '声音样本仅支持 MP3 或 WAV')
  }
  if (file.size > 32 * 1024 * 1024) throw new Error('文件不能超过 32MB')
}


function MediaPickerDialog({
  kind,
  onClose,
  onSelect,
}: {
  kind: PickerKind
  onClose: () => void
  onSelect: (asset: CreativeAsset) => void
}) {
  const [assets, setAssets] = useState<CreativeAsset[]>([])
  const [uploading, setUploading] = useState(false)
  useEffect(() => {
    if (!kind) return
    void listCreativeAssets('media').then(items => {
      setAssets(items.filter(item => (
        item.media_kind === (kind === 'portrait' ? 'image' : 'audio')
      )))
    })
  }, [kind])

  async function handleUpload(file: File | undefined) {
    if (!kind || !file) return
    try {
      validateFile(kind, file)
      setUploading(true)
      onSelect(await uploadCreativeAsset(
        kind === 'portrait' ? 'image' : 'audio',
        file,
      ))
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog open={kind !== null} onOpenChange={value => !value && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === 'portrait' ? '选择人物形象' : '选择声音样本'}
          </DialogTitle>
          <DialogDescription>
            可从创作资产选择，也可上传新素材。
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="role-media-upload">上传新素材</FieldLabel>
          <Input
            id="role-media-upload"
            type="file"
            disabled={uploading}
            accept={kind === 'portrait'
              ? 'image/png,image/jpeg'
              : 'audio/mpeg,audio/wav,audio/x-wav'}
            onChange={event => void handleUpload(event.target.files?.[0])}
          />
        </Field>
        <div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto">
          {assets.map(asset => (
            <Button
              key={asset.id}
              type="button"
              variant="outline"
              aria-label={asset.title}
              className="justify-start"
              onClick={() => {
                onSelect(asset)
                onClose()
              }}
            >
              {kind === 'portrait'
                ? <Image data-icon="inline-start" />
                : <Mic data-icon="inline-start" />}
              {asset.title}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}


export function RoleEditorDialog({
  open,
  role = null,
  onClose,
  onCreated,
}: {
  open: boolean
  role?: DigitalHuman | null
  onClose: () => void
  onCreated: (role: DigitalHuman) => void
}) {
  const [name, setName] = useState(role?.name ?? '')
  const [portrait, setPortrait] = useState<CreativeAsset | null>(role?.portrait ?? null)
  const [voice, setVoice] = useState<CreativeAsset | null>(role?.voice_sample ?? null)
  const [environment, setEnvironment] = useState<CreativeAsset | null>(
    role?.default_environment ?? null,
  )
  const [picker, setPicker] = useState<PickerKind>(null)
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!name.trim() || !portrait || !voice || !environment) return
    setSaving(true)
    try {
      const input = {
        name: name.trim(),
        portrait_asset_id: portrait.id,
        voice_sample_asset_id: voice.id,
        default_environment_asset_id: environment.id,
      }
      const saved = role
        ? await updateDigitalHuman(role.id, input)
        : await createDigitalHuman(input)
      onCreated(saved)
      onClose()
      toast.success(role
        ? '数字人角色已保存'
        : '数字人已创建，正在处理形象和声音')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={value => !value && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {role ? '编辑数字人角色' : '创建数字人角色'}
            </DialogTitle>
            <DialogDescription>
              {role
                ? '更换人物形象或声音后，HeyGen 会重新处理对应资源。'
                : '上传一张正面照和一段清晰录音，HeyGen 将创建可复用形象与克隆声音。'}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="role-name">角色名称</FieldLabel>
              <Input
                id="role-name"
                value={name}
                onChange={event => setName(event.target.value)}
                placeholder="例如：林晓"
              />
            </Field>
            <Field>
              <FieldLabel>人物形象</FieldLabel>
              <Button
                variant="outline"
                onClick={() => setPicker('portrait')}
              >
                <Image data-icon="inline-start" />
                {portrait?.title || '选择人物形象'}
              </Button>
              <FieldDescription>正面、光线均匀、无遮挡，PNG/JPEG。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>声音样本</FieldLabel>
              <Button
                variant="outline"
                onClick={() => setPicker('voice')}
              >
                <Mic data-icon="inline-start" />
                {voice?.title || '选择声音样本'}
              </Button>
              <FieldDescription>安静环境中的单人录音，MP3/WAV。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>默认环境</FieldLabel>
              <Button
                variant="outline"
                onClick={() => setEnvironmentOpen(true)}
              >
                <Image data-icon="inline-start" />
                {environment?.title || '选择默认环境'}
              </Button>
            </Field>
            <Button
              onClick={handleSave}
              disabled={saving || !name.trim() || !portrait || !voice || !environment}
            >
              {saving
                ? <Loader2 data-icon="inline-start" />
                : <Save data-icon="inline-start" />}
              {role ? '保存角色' : '保存并开始处理'}
            </Button>
          </FieldGroup>
        </DialogContent>
      </Dialog>
      <MediaPickerDialog
        kind={picker}
        onClose={() => setPicker(null)}
        onSelect={asset => {
          if (picker === 'portrait') setPortrait(asset)
          if (picker === 'voice') setVoice(asset)
        }}
      />
      <EnvironmentPickerDialog
        open={environmentOpen}
        onClose={() => setEnvironmentOpen(false)}
        onSelect={setEnvironment}
      />
    </>
  )
}
