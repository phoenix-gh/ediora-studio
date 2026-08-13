import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { EditorState, Transaction } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'

export type AssetImageImportAction = {
  type: 'register' | 'success' | 'failure' | 'remove'
  id: string
  sourceUrl?: string
  localUrl?: string
  error?: string
}

export type AssetImageImportEntry = {
  id: string
  pos: number
  sourceUrl: string
  status: 'processing' | 'failed'
  error: string
}

export type AssetImageImportPluginState = {
  entries: Map<string, AssetImageImportEntry>
}

export const assetImageImportPluginKey = new PluginKey<AssetImageImportPluginState>(
  'asset-image-import',
)

function markerFor(id: string, failed = false) {
  return `wms-import${failed ? '-failed' : ''}:${id}`
}

function isImageNode(node: ProseMirrorNode | null | undefined) {
  return node?.type.name === 'image' || node?.type.name === 'image-block'
}

function imageMarker(node: ProseMirrorNode) {
  return String(
    node.type.name === 'image-block'
      ? node.attrs.caption ?? ''
      : node.attrs.title ?? '',
  )
}

function withImageMarker(
  node: ProseMirrorNode,
  marker: string | null,
) {
  return node.type.name === 'image-block'
    ? { ...node.attrs, caption: marker ?? '' }
    : { ...node.attrs, title: marker }
}

function findMarkedImage(
  document: ProseMirrorNode,
  id: string,
): { node: ProseMirrorNode; pos: number } | null {
  const markers = new Set([markerFor(id), markerFor(id, true)])
  let match: { node: ProseMirrorNode; pos: number } | null = null
  document.descendants((node, pos) => {
    if (!match && isImageNode(node) && markers.has(imageMarker(node))) {
      match = { node, pos }
      return false
    }
    return !match
  })
  return match
}

function mapEntries(
  transaction: Transaction,
  entries: Map<string, AssetImageImportEntry>,
) {
  const mapped = new Map<string, AssetImageImportEntry>()
  for (const [id, entry] of entries) {
    const result = transaction.mapping.mapResult(entry.pos)
    if (!result.deleted) mapped.set(id, { ...entry, pos: result.pos })
  }
  return mapped
}

function applyAction(
  action: AssetImageImportAction,
  entries: Map<string, AssetImageImportEntry>,
  state: EditorState,
) {
  if (action.type === 'success' || action.type === 'remove') {
    entries.delete(action.id)
    return
  }
  const marked = findMarkedImage(state.doc, action.id)
  if (!marked) {
    entries.delete(action.id)
    return
  }
  const previous = entries.get(action.id)
  entries.set(action.id, {
    id: action.id,
    pos: marked.pos,
    sourceUrl: action.sourceUrl ?? previous?.sourceUrl ?? String(marked.node.attrs.src ?? ''),
    status: action.type === 'failure' ? 'failed' : 'processing',
    error: action.type === 'failure' ? action.error ?? '图片本地化失败' : '',
  })
}

function importDecorations(
  state: EditorState,
  pluginState: AssetImageImportPluginState,
  onRetry: (id: string) => void,
) {
  const decorations: Decoration[] = []
  for (const entry of pluginState.entries.values()) {
    const node = state.doc.nodeAt(entry.pos)
    if (!isImageNode(node)) continue
    decorations.push(Decoration.node(
      entry.pos,
      entry.pos + (node?.nodeSize ?? 1),
      {
        class: entry.status === 'failed'
          ? 'asset-image-import-failed'
          : 'asset-image-import-processing',
      },
    ))
    decorations.push(Decoration.widget(
      entry.pos + (node?.nodeSize ?? 1),
      () => {
        if (entry.status === 'processing') {
          const status = document.createElement('span')
          status.className = 'asset-image-import-status'
          status.textContent = '正在保存图片'
          return status
        }
        const retry = document.createElement('button')
        retry.type = 'button'
        retry.className = 'asset-image-import-retry'
        retry.dataset.assetImageRetry = entry.id
        retry.textContent = '图片本地化失败，重试'
        retry.title = entry.error
        retry.addEventListener('click', event => {
          event.preventDefault()
          event.stopPropagation()
          onRetry(entry.id)
        })
        return retry
      },
      { key: `${entry.id}:${entry.status}` },
    ))
  }
  return DecorationSet.create(state.doc, decorations)
}

export function createAssetImageImportPlugin({
  onRetry,
  onDocumentChange,
}: {
  onRetry: (id: string) => void
  onDocumentChange?: () => void
}) {
  return new Plugin<AssetImageImportPluginState>({
    key: assetImageImportPluginKey,
    state: {
      init: () => ({ entries: new Map() }),
      apply(transaction, previous, _oldState, newState) {
        if (transaction.docChanged) onDocumentChange?.()
        const entries = mapEntries(transaction, previous.entries)
        const action = transaction.getMeta(assetImageImportPluginKey) as AssetImageImportAction | undefined
        if (action) applyAction(action, entries, newState)
        return { entries }
      },
    },
    props: {
      decorations(state) {
        const pluginState = assetImageImportPluginKey.getState(state)
        return pluginState
          ? importDecorations(state, pluginState, onRetry)
          : DecorationSet.empty
      },
    },
  })
}

export function dispatchAssetImageImportAction(
  view: EditorView,
  action: AssetImageImportAction,
) {
  const marked = findMarkedImage(view.state.doc, action.id)
  let transaction = view.state.tr
  if (marked && action.type === 'success' && action.localUrl) {
    transaction = transaction.setNodeMarkup(marked.pos, undefined, {
      ...withImageMarker(marked.node, null),
      src: action.localUrl,
    })
  } else if (marked && action.type === 'failure') {
    transaction = transaction.setNodeMarkup(
      marked.pos,
      undefined,
      withImageMarker(marked.node, markerFor(action.id, true)),
    )
  } else if (!marked && action.type !== 'register') {
    action = { type: 'remove', id: action.id }
  }
  view.dispatch(transaction.setMeta(assetImageImportPluginKey, action))
}
