// @vitest-environment jsdom

import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import { describe, expect, it, vi } from 'vitest'

import {
  assetImageImportPluginKey,
  createAssetImageImportPlugin,
  dispatchAssetImageImportAction,
} from './asset-image-import-plugin'


const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
    image: {
      group: 'inline',
      inline: true,
      attrs: {
        src: {},
        alt: { default: '' },
        title: { default: null },
      },
      toDOM: node => ['img', node.attrs],
    },
  },
})

function imageDocument(id: string) {
  return schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('前文'),
      schema.node('image', {
        src: 'https://img.example/original.png',
        alt: '图片',
        title: `wms-import:${id}`,
      }),
    ]),
  ])
}

function createView(id: string, onDocumentChange = vi.fn()) {
  const onRetry = vi.fn()
  const plugin = createAssetImageImportPlugin({ onRetry, onDocumentChange })
  const state = EditorState.create({
    schema,
    doc: imageDocument(id),
    plugins: [plugin],
  })
  const root = document.createElement('div')
  document.body.append(root)
  return {
    onRetry,
    onDocumentChange,
    view: new EditorView(root, { state }),
  }
}

describe('asset image import plugin', () => {
  it('reports document changes without treating metadata-only actions as edits', () => {
    const onDocumentChange = vi.fn()
    const { view } = createView('image-change', onDocumentChange)

    dispatchAssetImageImportAction(view, {
      type: 'register',
      id: 'image-change',
      sourceUrl: 'https://img.example/original.png',
    })
    expect(onDocumentChange).not.toHaveBeenCalled()

    view.dispatch(view.state.tr.insertText('新增', 1))
    expect(onDocumentChange).toHaveBeenCalledTimes(1)
    view.destroy()
  })

  it('maps the image position through edits and updates only the matching node', () => {
    const { view } = createView('image-a')
    dispatchAssetImageImportAction(view, {
      type: 'register',
      id: 'image-a',
      sourceUrl: 'https://img.example/original.png',
    })
    view.dispatch(view.state.tr.insertText('新增', 1))

    dispatchAssetImageImportAction(view, {
      type: 'success',
      id: 'image-a',
      localUrl: '/api/uploads/local.png',
    })

    const images: Array<Record<string, unknown>> = []
    view.state.doc.descendants(node => {
      if (node.type.name === 'image') images.push(node.attrs)
    })
    expect(images).toEqual([expect.objectContaining({
      src: '/api/uploads/local.png',
      title: null,
    })])
    expect(assetImageImportPluginKey.getState(view.state)?.entries.size).toBe(0)
    view.destroy()
  })

  it('keeps the source URL on failure and exposes a retry control', () => {
    const { onRetry, view } = createView('image-b')
    dispatchAssetImageImportAction(view, {
      type: 'register',
      id: 'image-b',
      sourceUrl: 'https://img.example/original.png',
    })

    dispatchAssetImageImportAction(view, {
      type: 'failure',
      id: 'image-b',
      error: '图片下载超时',
    })

    const entry = assetImageImportPluginKey.getState(view.state)?.entries.get('image-b')
    expect(entry).toMatchObject({
      sourceUrl: 'https://img.example/original.png',
      status: 'failed',
      error: '图片下载超时',
    })
    let imageAttrs: Record<string, unknown> | undefined
    view.state.doc.descendants(node => {
      if (node.type.name === 'image') imageAttrs = node.attrs
    })
    expect(imageAttrs).toMatchObject({
      src: 'https://img.example/original.png',
      title: 'wms-import-failed:image-b',
    })

    const retry = view.dom.parentElement?.querySelector<HTMLButtonElement>(
      'button[data-asset-image-retry="image-b"]',
    )
    expect(retry).not.toBeNull()
    retry?.click()
    expect(onRetry).toHaveBeenCalledWith('image-b')
    view.destroy()
  })

  it('drops state safely when the user deletes an image before completion', () => {
    const { view } = createView('image-c')
    dispatchAssetImageImportAction(view, {
      type: 'register',
      id: 'image-c',
      sourceUrl: 'https://img.example/original.png',
    })
    let imagePosition = -1
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image') imagePosition = pos
    })
    view.dispatch(view.state.tr.delete(imagePosition, imagePosition + 1))

    dispatchAssetImageImportAction(view, {
      type: 'success',
      id: 'image-c',
      localUrl: '/api/uploads/late.png',
    })

    expect(view.state.doc.textContent).toBe('前文')
    expect(assetImageImportPluginKey.getState(view.state)?.entries.size).toBe(0)
    view.destroy()
  })
})
