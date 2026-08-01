'use client'

import { useEffect, useRef, useState } from 'react'
import { PackageOpen, Trash2, Upload } from 'lucide-react'

import { FormSection } from '@/components/layout/FormSection'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { deleteSkill, fetchSkills, type ManagedSkill, updateSkillEnabled, uploadSkillArchive } from '@/lib/api/skills'

export function SkillsSection() {
  const [skills, setSkills] = useState<ManagedSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function refresh(showLoading = false) {
    if (showLoading) setLoading(true)
    try {
      const next = await fetchSkills()
      setSkills(next)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '加载 Skill 列表失败')
    } finally {
      if (showLoading) setLoading(false)
    }
  }

  useEffect(() => {
    void refresh(true)
  }, [])

  async function handleToggle(skill: ManagedSkill, enabled: boolean) {
    const previous = skills
    setBusyName(skill.name)
    setError(null)
    setSkills(current => current.map(item => item.name === skill.name ? { ...item, enabled } : item))
    try {
      const updated = await updateSkillEnabled(skill.name, enabled)
      setSkills(current => current.map(item => item.name === updated.name ? updated : item))
    } catch (cause) {
      setSkills(previous)
      setError(cause instanceof Error ? cause.message : `更新 ${skill.name} 失败`)
    } finally {
      setBusyName(null)
    }
  }

  async function handleUpload(file: File | undefined) {
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      await uploadSkillArchive(file)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '上传 Skill 失败')
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleDelete(skill: ManagedSkill) {
    if (!window.confirm(`确定删除已上传的 Skill「${skill.name}」吗？`)) return
    setBusyName(skill.name)
    setError(null)
    try {
      await deleteSkill(skill.name)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `删除 ${skill.name} 失败`)
    } finally {
      setBusyName(null)
    }
  }

  return (
    <FormSection
      title="技能管理"
      description="控制 AI 助手和自动创作流程可使用的 Skill；禁用后不会出现在选择器中。"
      actions={(
        <>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            aria-label="上传 Skill ZIP"
            className="sr-only"
            disabled={uploading}
            onChange={event => void handleUpload(event.target.files?.[0])}
          />
          <Button type="button" variant="outline" disabled={uploading} onClick={() => inputRef.current?.click()}>
            <Upload data-icon="inline-start" />
            {uploading ? '上传中…' : '上传 ZIP'}
          </Button>
        </>
      )}
    >
      {error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">正在加载 Skill…</p> : null}
      {!loading && skills.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          <PackageOpen className="mx-auto mb-2 size-5" />
          暂无可管理的 Skill
        </div>
      ) : null}
      <div className="space-y-3" data-testid="skills-list">
        {skills.map(skill => (
          <div key={skill.name} data-testid={`skill-card-${skill.name}`} className="rounded-lg border border-border px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-medium">{skill.name}</h3>
                  <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {skill.source === 'builtin' ? '预制' : '已上传'}
                  </span>
                  {skill.version ? <span className="text-xs text-muted-foreground">v{skill.version}</span> : null}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{skill.description || '未提供描述'}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  启用
                  <Switch
                    aria-label={`启用 ${skill.name}`}
                    checked={skill.enabled}
                    disabled={busyName === skill.name || uploading}
                    onCheckedChange={checked => void handleToggle(skill, checked)}
                  />
                </div>
                {skill.source === 'uploaded' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`删除 ${skill.name}`}
                    disabled={busyName === skill.name || uploading}
                    onClick={() => void handleDelete(skill)}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </FormSection>
  )
}
