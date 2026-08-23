import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'

import { DELETE, PATCH } from './[name]/route'
import { POST } from './upload/route'
import { GET } from './route'

let bundledDir = ''
let runtimeDir = ''

async function writeSkill(root: string, directory: string, name: string) {
  const skillDir = join(root, directory)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\nversion: 1.0.0\n---\n\n# ${name}\n`)
}

function archive(name: string) {
  return zipSync({ 'SKILL.md': strToU8(`---\nname: ${name}\ndescription: uploaded\nversion: 1.0.0\n---\n\n# ${name}\n`) })
}

function uploadRequest(bytes: Uint8Array) {
  const form = new FormData()
  form.append('file', new File([new Blob([bytes.buffer as ArrayBuffer])], 'skills.zip', { type: 'application/zip' }))
  return new Request('http://localhost/api/skills/upload', { method: 'POST', body: form })
}

describe('Skill management API', () => {
  beforeEach(async () => {
    bundledDir = await mkdtemp(join(tmpdir(), 'wms-api-skill-bundled-'))
    runtimeDir = await mkdtemp(join(tmpdir(), 'wms-api-skill-runtime-'))
    process.env.SKILLS_BUNDLED_DIR = bundledDir
    process.env.SKILLS_RUNTIME_DIR = runtimeDir
    process.env.SKILLS_STATE_FILE = join(runtimeDir, 'skills-state.json')
    await writeSkill(bundledDir, 'alpha', 'alpha')
  })

  afterEach(async () => {
    delete process.env.SKILLS_BUNDLED_DIR
    delete process.env.SKILLS_RUNTIME_DIR
    delete process.env.SKILLS_STATE_FILE
    delete process.env.SKILLS_MAX_UNPACKED_BYTES
    await Promise.all([
      rm(bundledDir, { recursive: true, force: true }),
      rm(runtimeDir, { recursive: true, force: true }),
    ])
  })

  it('lists metadata without exposing instructions and toggles a Skill', async () => {
    const listed = await GET()
    expect(listed.status).toBe(200)
    const listedSkills = await listed.json()
    expect(listedSkills).toEqual([expect.objectContaining({
      name: 'alpha',
      description: 'alpha description',
      version: '1.0.0',
      source: 'builtin',
      enabled: true,
      reviewState: 'approved',
      standardCompatible: true,
      diagnostics: [],
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })])
    expect(Object.keys(listedSkills[0])).not.toEqual(expect.arrayContaining([
      'instructions',
      'content',
      'directory',
      'requestedAllowedTools',
    ]))

    const updated = await PATCH(
      new Request('http://localhost/api/skills/alpha', { method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
      { params: Promise.resolve({ name: 'alpha' }) },
    )
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ name: 'alpha', enabled: false })
  })

  it('uploads a Skill, rejects a conflict, and maps invalid limits', async () => {
    const uploaded = await POST(uploadRequest(archive('custom')))
    expect(uploaded.status).toBe(201)
    expect(await uploaded.json()).toEqual([expect.objectContaining({
      name: 'custom',
      source: 'uploaded',
      enabled: false,
      reviewState: 'pending',
      standardCompatible: true,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })])

    const conflict = await POST(uploadRequest(archive('alpha')))
    expect(conflict.status).toBe(409)

    process.env.SKILLS_MAX_UNPACKED_BYTES = '10'
    const tooLarge = await POST(uploadRequest(archive('large')))
    expect(tooLarge.status).toBe(413)
  })

  it('protects bundled deletion and deletes uploaded Skills', async () => {
    const forbidden = await DELETE(new Request('http://localhost/api/skills/alpha', { method: 'DELETE' }), {
      params: Promise.resolve({ name: 'alpha' }),
    })
    expect(forbidden.status).toBe(409)

    await POST(uploadRequest(archive('custom')))
    const deleted = await DELETE(new Request('http://localhost/api/skills/custom', { method: 'DELETE' }), {
      params: Promise.resolve({ name: 'custom' }),
    })
    expect(deleted.status).toBe(204)
  })
})
