// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CreativeAsset } from '@/lib/api/assets'

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  uploadCreativeAsset: vi.fn(),
}))

vi.mock('@/lib/api/assets', () => ({
  uploadCreativeAsset: mocks.uploadCreativeAsset,
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess },
}))

import { MediaUploadDialog } from './MediaUploadDialog'

function mediaAsset(id: number, file: File): CreativeAsset {
  const kind = file.type.split('/')[0] as 'image' | 'video' | 'audio'
  return {
    id,
    asset_type: 'media',
    media_kind: kind,
    title: file.name,
    content: '',
    url: `/api/uploads/${file.name}`,
    media_type: file.type,
    filename: file.name,
    directory: '人物参考',
    tags: [],
    source: 'upload',
    created_at: '',
    updated_at: '',
  }
}

function deferred<T>() {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, reject, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
    revokeObjectURL: vi.fn(),
  })
})

describe('MediaUploadDialog', () => {
  it('queues multiple selected files, rejects unsupported files, and ignores duplicates', async () => {
    const user = userEvent.setup({ applyAccept: false })
    render(<MediaUploadDialog directory="人物参考" onAssetUploaded={vi.fn()} onClose={vi.fn()} open />)
    const image = new File(['image'], 'portrait.png', { type: 'image/png', lastModified: 10 })
    const video = new File(['video'], 'walk.mp4', { type: 'video/mp4', lastModified: 11 })
    const text = new File(['text'], 'notes.txt', { type: 'text/plain', lastModified: 12 })

    await user.upload(screen.getByLabelText('选择多媒体文件'), [image, video, text])
    fireEvent.drop(screen.getByTestId('media-upload-dropzone'), { dataTransfer: { files: [image] } })

    expect(screen.getByText('portrait.png')).toBeVisible()
    expect(screen.getByText('walk.mp4')).toBeVisible()
    expect(screen.queryByText('notes.txt')).toBeNull()
    expect(screen.getByRole('button', { name: '上传 2 个文件' })).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('仅支持图片、视频和音频文件；已忽略 1 个重复文件')
  })

  it('accepts dropped and pasted media only inside the dialog', () => {
    render(<MediaUploadDialog directory="" onAssetUploaded={vi.fn()} onClose={vi.fn()} open />)
    const image = new File(['image'], 'drop.png', { type: 'image/png' })
    const audio = new File(['audio'], 'paste.mp3', { type: 'audio/mpeg' })
    const dropzone = screen.getByTestId('media-upload-dropzone')

    fireEvent.drop(dropzone, { dataTransfer: { files: [image] } })
    fireEvent.paste(dropzone, { clipboardData: { files: [audio], items: [] } })
    fireEvent.paste(document.body, { clipboardData: { files: [new File(['x'], 'outside.png', { type: 'image/png' })], items: [] } })

    expect(screen.getByText('drop.png')).toBeVisible()
    expect(screen.getByText('paste.mp3')).toBeVisible()
    expect(screen.queryByText('outside.png')).toBeNull()
    expect(screen.getByText('上传到：未分类')).toBeVisible()
  })

  it('uploads at most three files concurrently into the captured directory', async () => {
    const user = userEvent.setup()
    const requests = Array.from({ length: 4 }, () => deferred<CreativeAsset>())
    mocks.uploadCreativeAsset.mockImplementation(() => requests[mocks.uploadCreativeAsset.mock.calls.length - 1].promise)
    const onAssetUploaded = vi.fn()
    const onClose = vi.fn()
    render(<MediaUploadDialog directory="人物参考" onAssetUploaded={onAssetUploaded} onClose={onClose} open />)
    const files = Array.from({ length: 4 }, (_, index) => new File(
      [`image-${index}`],
      `image-${index}.png`,
      { type: 'image/png', lastModified: index },
    ))
    await user.upload(screen.getByLabelText('选择多媒体文件'), files)

    await user.click(screen.getByRole('button', { name: '上传 4 个文件' }))
    expect(mocks.uploadCreativeAsset).toHaveBeenCalledTimes(3)
    expect(mocks.uploadCreativeAsset).toHaveBeenCalledWith('image', files[0], '人物参考')

    requests[0].resolve(mediaAsset(1, files[0]))
    await waitFor(() => expect(mocks.uploadCreativeAsset).toHaveBeenCalledTimes(4))
    requests[1].resolve(mediaAsset(2, files[1]))
    requests[2].resolve(mediaAsset(3, files[2]))
    requests[3].resolve(mediaAsset(4, files[3]))

    await waitFor(() => expect(onAssetUploaded).toHaveBeenCalledTimes(4))
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('已上传 4 个文件'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('retains a failed item and retries only that file', async () => {
    const user = userEvent.setup()
    const file = new File(['image'], 'retry.png', { type: 'image/png' })
    mocks.uploadCreativeAsset
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValueOnce(mediaAsset(5, file))
    const onAssetUploaded = vi.fn()
    const onClose = vi.fn()
    render(<MediaUploadDialog directory="人物参考" onAssetUploaded={onAssetUploaded} onClose={onClose} open />)
    await user.upload(screen.getByLabelText('选择多媒体文件'), file)

    await user.click(screen.getByRole('button', { name: '上传 1 个文件' }))
    expect(await screen.findByText('网络中断')).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '重试 retry.png' }))
    await waitFor(() => expect(mocks.uploadCreativeAsset).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(onAssetUploaded).toHaveBeenCalledWith(expect.objectContaining({ id: 5 })))
  })

  it('confirms before closing a queue with unfinished items', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<MediaUploadDialog directory="" onAssetUploaded={vi.fn()} onClose={onClose} open />)
    await user.upload(
      screen.getByLabelText('选择多媒体文件'),
      new File(['image'], 'pending.png', { type: 'image/png' }),
    )

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    const alert = await screen.findByRole('alertdialog')
    expect(alert).toHaveTextContent('还有未完成的上传，确定关闭？')
    await user.click(within(alert).getByRole('button', { name: '继续上传' }))
    expect(onClose).not.toHaveBeenCalled()

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '确定关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
