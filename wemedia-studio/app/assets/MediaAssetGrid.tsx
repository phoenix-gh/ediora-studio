import { Image as ImageIcon, Music, Video } from 'lucide-react'

import { cn } from '@/lib/utils'
import { creativeAssetUrl, type CreativeAsset } from '@/lib/api/assets'

type MediaAssetGridProps = {
  assets: CreativeAsset[]
  selectedId: number | null
  onSelect: (id: number) => void
  onPreview: (asset: CreativeAsset) => void
}

export function MediaAssetGrid({ assets, selectedId, onSelect, onPreview }: MediaAssetGridProps) {
  return <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-3 content-start gap-3 overflow-y-auto p-4 md:grid-cols-6 xl:grid-cols-8" data-slot="media-asset-grid">
    {assets.map(asset => <button key={asset.id} className={cn('overflow-hidden rounded-xl border border-border bg-surface text-left transition-colors hover:border-primary/50', selectedId === asset.id && 'border-primary ring-1 ring-primary')} onClick={() => onSelect(asset.id)} onDoubleClick={() => onPreview(asset)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onPreview(asset) } }} title="双击预览，按 Enter 预览" type="button">
      <MediaThumbnail asset={asset} />
      <div className="p-2.5"><p className="truncate text-xs font-medium">{asset.title}</p><p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground"><MediaIcon kind={asset.media_kind} /><span>{asset.media_kind === 'image' ? '图片' : asset.media_kind === 'video' ? '视频' : '音频'}</span></p></div>
    </button>)}
  </div>
}

function MediaThumbnail({ asset }: { asset: CreativeAsset }) {
  if (asset.media_kind === 'image') return <div className="aspect-[4/3] overflow-hidden bg-muted"><img alt={asset.title} className="h-full w-full object-cover" src={creativeAssetUrl(asset.url)} /></div>
  if (asset.media_kind === 'video') return <div className="relative aspect-[4/3] overflow-hidden bg-muted"><video className="h-full w-full object-cover" muted preload="metadata" src={creativeAssetUrl(asset.url)} /><span className="absolute inset-0 grid place-items-center"><Video className="rounded-full bg-black/55 p-1.5 text-white" /></span></div>
  return <div className="flex aspect-[4/3] flex-col items-center justify-center gap-1 bg-muted text-muted-foreground"><Music /><span className="text-[10px]">音频</span></div>
}

function MediaIcon({ kind }: { kind: CreativeAsset['media_kind'] }) {
  if (kind === 'image') return <ImageIcon className="size-3" />
  if (kind === 'video') return <Video className="size-3" />
  return <Music className="size-3" />
}
