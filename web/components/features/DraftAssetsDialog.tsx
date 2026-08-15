"use client"

import { useEffect, useRef, useState } from "react"
import {
  Link2, Images, Upload, X, Plus, Loader2, Sparkles, ImagePlus,
  ExternalLink, ImageIcon,
} from "lucide-react"
import { toast } from "sonner"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { cn } from "@/lib/utils"
import { DraftImage, DraftSource } from "@/lib/api/drafts"
import { CoverStyle, listPublishAccounts, PublishAccount } from "@/lib/api/publish-accounts"
import { regenerateCover, illustrateBody } from "@/lib/api/studio"
import { CoverStyleEditor, buildCoverStyleFromEditor } from "@/components/features/CoverStyleEditor"

type Tab = "sources" | "images"

interface Props {
  open: boolean
  onClose: () => void
  initialTab?: Tab

  draftId: number

  sources: DraftSource[]
  onSourcesChange: (next: DraftSource[]) => void

  images: DraftImage[]
  imagesLoading: boolean
  uploading: boolean
  onUpload: (files: FileList | null) => void
  onDelete: (imageId: number) => void
  onInsert: (img: DraftImage) => void
  onRefreshImages: () => void
}

function isCover(img: DraftImage): boolean {
  const name = (img.original_name || img.filename || "").toLowerCase()
  return name.startsWith("cover")
}

export function DraftAssetsDialog({
  open, onClose, initialTab = "sources",
  draftId,
  sources, onSourcesChange,
  images, imagesLoading, uploading,
  onUpload, onDelete, onInsert, onRefreshImages,
}: Props) {
  const [tab, setTab] = useState<Tab>(initialTab)

  // Sources form state
  const [newUrl, setNewUrl] = useState("")
  const [newTitle, setNewTitle] = useState("")
  const [newNote, setNewNote] = useState("")

  // Image preview state
  const [previewImg, setPreviewImg] = useState<DraftImage | null>(null)

  // Cover regen state
  const [regenOpen, setRegenOpen] = useState(false)
  const [accounts, setAccounts] = useState<PublishAccount[] | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [regenNote, setRegenNote] = useState("")
  const [regenBusy, setRegenBusy] = useState(false)
  const [coverStyle, setCoverStyle] = useState<CoverStyle>({})
  const [coverMotifsText, setCoverMotifsText] = useState("")
  const [coverNegativeText, setCoverNegativeText] = useState("")

  // Inline illustration state
  const [illusOpen, setIllusOpen] = useState(false)
  const [illusMax, setIllusMax] = useState(4)
  const [illusNote, setIllusNote] = useState("")
  const [illusBusy, setIllusBusy] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if ((!regenOpen && !illusOpen) || accounts) return
    listPublishAccounts()
      .then(list => setAccounts(list.filter(a => a.is_active)))
      .catch(() => toast.error("加载发布账号失败"))
  }, [regenOpen, illusOpen, accounts])

  function selectAccount(id: string | null) {
    setAccountId(id)
    if (!id || !accounts) return
    const acc = accounts.find(a => a.id === id)
    const cs: CoverStyle = acc?.cover_style ?? {}
    setCoverStyle({ type: cs.type, palette: cs.palette, rendering: cs.rendering, text: cs.text, mood: cs.mood, aspect_ratio: cs.aspect_ratio })
    setCoverMotifsText((cs.signature_motifs ?? []).join('\n'))
    setCoverNegativeText((cs.negative ?? []).join('\n'))
  }

  const cover = images.filter(isCover).sort((a, b) => b.id - a.id)[0]
  const activePreviewImg = previewImg && images.some(image => image.id === previewImg.id)
    ? previewImg
    : cover ?? images[0] ?? null

  function addSource() {
    const url = newUrl.trim()
    if (!url) return
    onSourcesChange([...sources, { url, title: newTitle.trim(), note: newNote.trim() }])
    setNewUrl(""); setNewTitle(""); setNewNote("")
  }

  function removeSource(i: number) {
    onSourcesChange(sources.filter((_, j) => j !== i))
  }

  async function handleRegen() {
    if (!accountId) { toast.error("请选择发布账号"); return }
    const builtCoverStyle = buildCoverStyleFromEditor(coverStyle, coverMotifsText, coverNegativeText)
    setRegenBusy(true)
    try {
      const res = await regenerateCover({
        draft_id: draftId,
        account_id: accountId,
        note: regenNote,
        cover_style: Object.keys(builtCoverStyle).length ? builtCoverStyle : undefined,
      })
      toast.success(`已派 illustrator 重画 · ${res.task_id}`)
      setRegenOpen(false)
      setRegenNote("")
      setTimeout(onRefreshImages, 3000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "派单失败")
    } finally {
      setRegenBusy(false)
    }
  }

  async function handleIllustrate() {
    if (!accountId) { toast.error("请选择发布账号"); return }
    setIllusBusy(true)
    try {
      const res = await illustrateBody({
        draft_id: draftId,
        account_id: accountId,
        max_images: illusMax,
        note: illusNote || undefined,
      })
      toast.success(`已派 illustrator 正文配图 · ${res.task_id}`)
      setIllusOpen(false)
      setIllusNote("")
      setTimeout(onRefreshImages, 5000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "派单失败")
    } finally {
      setIllusBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>素材</DialogTitle>
          <DialogDescription className="text-xs">
            灵感来源 · 图片素材 · 封面（命名以 <code className="bg-muted px-1 rounded">cover</code> 开头的图自动作为封面）
          </DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex border-b border-border -mx-6 px-6">
          {([
            { key: "sources" as const, label: "灵感来源", icon: Link2, count: sources.length },
            { key: "images"  as const, label: "图片素材", icon: Images, count: images.length },
          ]).map(({ key, label, icon: Icon, count }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                "flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
                tab === key
                  ? "border-indigo-500 text-indigo-600 dark:text-indigo-400"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
              {count > 0 && (
                <span className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                  tab === key
                    ? "bg-indigo-100 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400"
                    : "bg-muted text-muted-foreground",
                )}>
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto -mx-6 px-6 py-3">
          {tab === "sources" ? (
            <div className="space-y-2">
              {sources.length === 0 && (
                <p className="text-center text-xs text-foreground-subtle py-4">还没有添加任何来源</p>
              )}
              {sources.map((s, i) => (
                <div key={i} className="flex items-start gap-2 group text-xs border border-border rounded-md px-2.5 py-2 bg-surface">
                  <ExternalLink className="w-3 h-3 text-indigo-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <a href={s.url} target="_blank" rel="noopener noreferrer"
                      className="text-indigo-500 hover:text-indigo-700 dark:hover:text-indigo-300 hover:underline truncate block">
                      {s.title || s.url}
                    </a>
                    {s.note && <p className="text-foreground-subtle mt-0.5 text-[11px]">{s.note}</p>}
                  </div>
                  <button onClick={() => removeSource(i)}
                    className="opacity-0 group-hover:opacity-100 text-foreground-subtle hover:text-red-500 transition-opacity flex-shrink-0">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <div className="pt-2 border-t border-border space-y-1.5">
                <Input value={newUrl} onChange={e => setNewUrl(e.target.value)}
                  placeholder="来源 URL…" className="h-8 text-xs" />
                <div className="flex gap-1.5">
                  <Input value={newTitle} onChange={e => setNewTitle(e.target.value)}
                    placeholder="标题（可选）" className="h-8 text-xs flex-1" />
                  <Input value={newNote} onChange={e => setNewNote(e.target.value)}
                    placeholder="备注（可选）" className="h-8 text-xs flex-1" />
                  <Button size="sm" onClick={addSource} disabled={!newUrl.trim()} className="gap-1">
                    <Plus className="w-3 h-3" />添加
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Large preview */}
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <ImagePlus className="w-3.5 h-3.5 text-emerald-500" />
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">预览</span>
                  {activePreviewImg && isCover(activePreviewImg) && (
                    <span className="text-[10px] bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 rounded-full font-medium">
                      封面
                    </span>
                  )}
                  <button
                    onClick={() => setRegenOpen(v => !v)}
                    className="ml-auto flex items-center gap-1 text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300 transition-colors"
                  >
                    <Sparkles className="w-3 h-3" />
                    {cover ? "重生成封面" : "AI 生成封面"}
                  </button>
                  <button
                    onClick={() => setIllusOpen(v => !v)}
                    className="flex items-center gap-1 text-xs text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300 transition-colors"
                  >
                    <Sparkles className="w-3 h-3" />
                    自动配图
                  </button>
                </div>

                {activePreviewImg ? (
                  <div className="relative w-full aspect-[16/9] rounded-md overflow-hidden bg-muted ring-1 ring-border">
                    <img src={activePreviewImg.hosted_url} alt={activePreviewImg.original_name} className="w-full h-full object-contain" />
                    <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-2 py-1.5 bg-gradient-to-t from-black/60 to-transparent">
                      <span className="text-white text-[10px] truncate max-w-[60%]">
                        {activePreviewImg.original_name || activePreviewImg.filename}
                      </span>
                      <Button
                        size="sm"
                        className="h-6 text-[11px] px-2 gap-1 bg-white/20 hover:bg-white/30 text-white border-0 backdrop-blur-sm"
                        onClick={() => { onInsert(activePreviewImg); toast.success("已插入图片") }}
                      >
                        <ImageIcon className="w-3 h-3" />
                        插入
                      </Button>
                    </div>
                  </div>
                ) : !imagesLoading ? (
                  <p className="text-[11px] text-foreground-subtle border border-dashed border-border rounded-md py-6 text-center">
                    {cover ? "" : "还没有封面 · "}「AI 生成封面」让 illustrator 出一张，或上传以 cover 开头命名的图
                  </p>
                ) : null}

                {regenOpen && (
                  <div className="mt-2 p-3 border border-border rounded-md bg-surface-muted space-y-2">
                    <div className="text-xs font-medium text-foreground">
                      让 illustrator 按账号画像出一张
                    </div>
                    <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1.5">发布账号</div>
                      <div className="max-h-32 overflow-y-auto border border-border rounded-md bg-surface">
                        {accounts === null ? (
                          <div className="p-3 text-center text-xs text-foreground-subtle flex items-center justify-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin" /> 加载中
                          </div>
                        ) : accounts.length === 0 ? (
                          <div className="p-3 text-center text-xs text-foreground-subtle">
                            暂无启用账号 · 去「设置 → 发布账号」配置
                          </div>
                        ) : accounts.map(a => (
                          <button
                            key={a.id}
                            type="button"
                            onClick={() => selectAccount(a.id)}
                            className={cn(
                              "w-full text-left px-2 py-1.5 text-xs hover:bg-muted transition-colors",
                              accountId === a.id && "bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300",
                            )}
                          >
                            <div className="font-medium truncate">{a.name}</div>
                            <div className="text-[10px] text-foreground-subtle truncate">
                              {a.platform} · {a.image_style || a.positioning || "（无画像描述）"}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                    {accountId && (
                      <details className="rounded-lg border border-border bg-surface">
                        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-surface-muted">
                          封面风格覆盖（cover_style）
                        </summary>
                        <div className="px-3 py-3 border-t border-border">
                          <CoverStyleEditor
                            coverStyle={coverStyle}
                            onCoverStyleChange={setCoverStyle}
                            motifsText={coverMotifsText}
                            onMotifsTextChange={setCoverMotifsText}
                            negativeText={coverNegativeText}
                            onNegativeTextChange={setCoverNegativeText}
                          />
                        </div>
                      </details>
                    )}
                    <Input value={regenNote} onChange={e => setRegenNote(e.target.value)}
                      placeholder="额外指令（如「换冷色调」「不要文字」）" className="h-8 text-xs" />
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setRegenOpen(false)} disabled={regenBusy}>取消</Button>
                      <Button size="sm" onClick={handleRegen} disabled={regenBusy || !accountId}>
                        {regenBusy && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                        派单
                      </Button>
                    </div>
                  </div>
                )}

                {illusOpen && (
                  <div className="mt-2 p-3 border border-border rounded-md bg-surface-muted space-y-2">
                    <div className="text-xs font-medium text-foreground">
                      让 illustrator 分析章节，给正文插图（重跑会先清掉上一轮自动插图）
                    </div>
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1.5">发布账号</div>
                      <NativeSelect
                        value={accountId ?? ""}
                        onChange={e => selectAccount(e.target.value || null)}
                        className="h-8 w-full cursor-pointer rounded-md px-2 py-1.5 text-xs"
                      >
                        <option value="">（选择账号）</option>
                        {(accounts ?? []).map(a => (
                          <option key={a.id} value={a.id}>{a.name}（{a.platform}）</option>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">最多插图</span>
                      <input
                        type="number" min={1} max={12} value={illusMax}
                        onChange={e => setIllusMax(Math.max(1, Math.min(12, Number(e.target.value) || 1)))}
                        className="w-16 text-xs px-2 py-1 border border-input rounded bg-control outline-none focus:border-violet-400"
                      />
                      <span className="text-[10px] text-foreground-subtle">张（护栏，agent 在此上限内按内容决定）</span>
                    </div>
                    <Input
                      placeholder="额外指令（可选），比如「偏插画、少用照片」"
                      value={illusNote}
                      onChange={e => setIllusNote(e.target.value)}
                      className="h-8 text-xs"
                    />
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setIllusOpen(false)} disabled={illusBusy}>取消</Button>
                      <Button size="sm" onClick={handleIllustrate} disabled={illusBusy || !accountId}>
                        {illusBusy && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                        开始配图
                      </Button>
                    </div>
                  </div>
                )}
              </section>

              {/* Image thumbnails */}
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <Images className="w-3.5 h-3.5 text-violet-500" />
                  <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">图片素材</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={e => onUpload(e.target.files)}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="ml-auto flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600 disabled:opacity-40 transition-colors"
                  >
                    {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
                    上传
                  </button>
                  {imagesLoading && <Loader2 className="w-3 h-3 animate-spin text-foreground-subtle" />}
                </div>

                {images.length === 0 && !imagesLoading ? (
                  <p className="text-[11px] text-foreground-subtle py-3 text-center border border-dashed border-border rounded-md">
                    暂无图片，上传后可插入编辑器
                  </p>
                ) : (
                  <div className="grid grid-cols-5 gap-1.5">
                    {images.map(img => {
                      const selected = activePreviewImg?.id === img.id
                      return (
                        <div key={img.id}
                          className={cn(
                            "group relative aspect-square rounded overflow-hidden bg-muted cursor-pointer border-2 transition-colors",
                            isCover(img)
                              ? selected ? "border-emerald-500" : "border-emerald-300"
                              : selected ? "border-indigo-500" : "border-transparent hover:border-indigo-300",
                          )}
                          onClick={() => setPreviewImg(img)}
                          title={img.original_name || img.filename}
                        >
                          <img src={img.hosted_url} alt={img.original_name} className="w-full h-full object-cover" />
                          {isCover(img) && (
                            <span className="absolute top-0.5 left-0.5 bg-emerald-500 text-white text-[9px] px-1 py-0.5 rounded font-medium">封</span>
                          )}
                          {/* Insert button */}
                          <button
                            onClick={e => { e.stopPropagation(); onInsert(img); toast.success("已插入图片") }}
                            className="absolute bottom-0.5 right-0.5 opacity-0 group-hover:opacity-100 bg-indigo-600/90 hover:bg-indigo-700 text-white text-[9px] px-1.5 py-0.5 rounded font-medium transition-opacity leading-tight"
                          >
                            插入
                          </button>
                          {/* Delete button */}
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              const name = img.original_name || img.filename
                              if (!confirm(`删除「${name}」？此操作不可撤销。`)) return
                              if (activePreviewImg?.id === img.id) setPreviewImg(null)
                              onDelete(img.id)
                            }}
                            className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 bg-black/60 hover:bg-red-600/90 text-white rounded-full p-0.5 transition-colors transition-opacity"
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
