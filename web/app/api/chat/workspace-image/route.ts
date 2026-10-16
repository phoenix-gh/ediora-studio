import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

import { CODEX_THREAD_CWD } from '@/lib/ai/codex-app-server'

export const runtime = 'nodejs'

const imageTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
}

function contained(root: string, path: string) {
  const subpath = relative(root, path)
  return subpath !== '..' && !subpath.startsWith(`..${sep}`) && !isAbsolute(subpath)
}

export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get('path')
  if (!path) return new Response('Missing image path', { status: 400 })
  const candidate = resolve(CODEX_THREAD_CWD, path)
  if (isAbsolute(path) || !contained(CODEX_THREAD_CWD, candidate)) {
    return new Response('Forbidden', { status: 403 })
  }
  const contentType = imageTypes[extname(candidate).toLowerCase()]
  if (!contentType) return new Response('Unsupported image type', { status: 415 })
  try {
    const [root, image] = await Promise.all([realpath(CODEX_THREAD_CWD), realpath(candidate)])
    if (!contained(root, image)) return new Response('Forbidden', { status: 403 })
    const info = await stat(image)
    if (!info.isFile()) return new Response('Not found', { status: 404 })
    if (info.size > 32 * 1024 * 1024) return new Response('Image too large', { status: 413 })
    return new Response(new Uint8Array(await readFile(image)), {
      headers: {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-cache',
      },
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return new Response(code === 'ENOENT' || code === 'ENOTDIR' ? 'Not found' : 'Image unavailable', {
      status: code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 500,
    })
  }
}
