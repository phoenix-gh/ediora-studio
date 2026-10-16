import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const paths = vi.hoisted(() => ({ workspace: '' }))
vi.mock('@/lib/ai/codex-app-server', () => ({ get CODEX_THREAD_CWD() { return paths.workspace } }))

import { GET } from './route'

let directory: string
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3xkAAAAASUVORK5CYII=', 'base64')
const requestImage = (path: string) => GET(new Request(`http://localhost/api/chat/workspace-image?path=${encodeURIComponent(path)}`))

describe('workspace images', () => {
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ediora-chat-image-'))
    paths.workspace = join(directory, 'workspace')
    await mkdir(join(paths.workspace, 'cover-image'), { recursive: true })
    await writeFile(join(paths.workspace, 'cover-image', '封面.png'), png)
  })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('serves image bytes from the workspace with the correct media type', async () => {
    const response = await requestImage('cover-image/封面.png')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(join(paths.workspace, 'cover-image', '封面.png')))
  })

  it('rejects traversal and absolute paths', async () => {
    await writeFile(join(directory, 'outside.png'), png)
    expect((await requestImage('../outside.png')).status).toBe(403)
    expect((await requestImage(join(directory, 'outside.png'))).status).toBe(403)
  })

  it('rejects symlinks that point outside the workspace', async () => {
    await writeFile(join(directory, 'outside.png'), png)
    await symlink(join(directory, 'outside.png'), join(paths.workspace, 'link.png'))
    expect((await requestImage('link.png')).status).toBe(403)
  })

  it('does not serve arbitrary files or missing images', async () => {
    await writeFile(join(paths.workspace, 'config.toml'), 'private')
    expect((await requestImage('config.toml')).status).toBe(415)
    expect((await requestImage('missing.png')).status).toBe(404)
  })
})
