import { describe, it, expect, vi } from 'vitest'
import {
  isCloudComfyUrl,
  _comfyHeaders,
  _comfyApiPath,
  _sniffCompletedJobBody,
  createComfyClient,
  DEFAULT_LOCAL_COMFY_URL,
} from './client.js'

const LOCAL = 'http://127.0.0.1:8188'
const CLOUD = 'https://cloud.comfy.org'

describe('isCloudComfyUrl', () => {
  it('treats loopback as local', () => {
    expect(isCloudComfyUrl('http://127.0.0.1:8188')).toBe(false)
    expect(isCloudComfyUrl('http://localhost:8000')).toBe(false)
    expect(isCloudComfyUrl('http://[::1]:8188')).toBe(false)
    expect(isCloudComfyUrl('http://127.9.9.9')).toBe(false)
  })

  it('treats real hosts as cloud', () => {
    expect(isCloudComfyUrl(CLOUD)).toBe(true)
    expect(isCloudComfyUrl('http://192.168.1.20:8188')).toBe(true)
  })

  it('is false for garbage', () => {
    expect(isCloudComfyUrl('not a url')).toBe(false)
    expect(isCloudComfyUrl('')).toBe(false)
  })
})

describe('_comfyHeaders', () => {
  it('sends no auth on loopback', () => {
    expect(_comfyHeaders(LOCAL, 'secret')).toEqual({})
  })

  it('sends X-API-Key and Bearer on cloud', () => {
    expect(_comfyHeaders(CLOUD, 'secret')).toEqual({
      'X-API-Key': 'secret',
      Authorization: 'Bearer secret',
    })
  })

  it('sends nothing when the key is empty', () => {
    expect(_comfyHeaders(CLOUD, '  ')).toEqual({})
  })
})

describe('_comfyApiPath', () => {
  it('keeps root routes on local', () => {
    expect(_comfyApiPath(LOCAL, '/prompt')).toBe('/prompt')
    expect(_comfyApiPath(LOCAL, 'prompt')).toBe('/prompt')
  })

  it('prefixes /api on cloud, idempotently', () => {
    expect(_comfyApiPath(CLOUD, '/prompt')).toBe('/api/prompt')
    expect(_comfyApiPath(CLOUD, '/api/prompt')).toBe('/api/prompt')
  })
})

describe('_sniffCompletedJobBody', () => {
  const outputs = { 9: { images: [{ filename: 'x.mp4' }] } }

  it('accepts top-level outputs', () => {
    expect(_sniffCompletedJobBody({ outputs })).toMatchObject({ outputs })
  })

  it('accepts job.outputs / result.outputs / results.outputs', () => {
    expect(_sniffCompletedJobBody({ job: { outputs } })).toMatchObject({ outputs })
    expect(_sniffCompletedJobBody({ result: { outputs } })).toMatchObject({ outputs })
    expect(_sniffCompletedJobBody({ results: { outputs } })).toMatchObject({ outputs })
  })

  it('rejects bodies with empty or missing outputs', () => {
    expect(_sniffCompletedJobBody({ outputs: {} })).toBeNull()
    expect(_sniffCompletedJobBody({ status: 'running' })).toBeNull()
    expect(_sniffCompletedJobBody(null)).toBeNull()
  })
})

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

describe('queuePromptToComfy', () => {
  it('POSTs the workflow and returns prompt_id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ prompt_id: 'p-1' }))
    const client = createComfyClient({ fetchImpl })
    const id = await client.queuePromptToComfy({ comfyUrl: LOCAL, workflow: { 1: {} } })
    expect(id).toBe('p-1')
    const [url, opts] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${LOCAL}/prompt`)
    expect(JSON.parse(opts.body)).toEqual({ prompt: { 1: {} } })
  })

  it('adds extra_data.api_key_comfy_org only for cloud partner jobs', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ prompt_id: 'p-2' }))
    const client = createComfyClient({ fetchImpl })
    await client.queuePromptToComfy({ comfyUrl: CLOUD, apiKey: 'k', workflow: {}, includeComfyOrgKey: true })
    const cloudBody = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(cloudBody.extra_data).toEqual({ api_key_comfy_org: 'k' })

    await client.queuePromptToComfy({ comfyUrl: LOCAL, apiKey: 'k', workflow: {}, includeComfyOrgKey: true })
    const localBody = JSON.parse(fetchImpl.mock.calls[1][1].body)
    expect(localBody.extra_data).toBeUndefined()
  })

  it('throws with the server detail on a rejected workflow', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad node' }, 400))
    const client = createComfyClient({ fetchImpl })
    await expect(client.queuePromptToComfy({ comfyUrl: LOCAL, workflow: {} }))
      .rejects.toThrow(/rejected the workflow \(400\)/)
  })

  it('throws a reachability error when fetch fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const client = createComfyClient({ fetchImpl })
    await expect(client.queuePromptToComfy({ comfyUrl: DEFAULT_LOCAL_COMFY_URL, workflow: {} }))
      .rejects.toThrow(/Could not reach ComfyUI at http:\/\/127\.0\.0\.1:8188/)
  })
})

describe('waitForComfyJob', () => {
  it('resolves a local job from /history once completed', async () => {
    const outputs = { 9: { gifs: [{ filename: 'out.mp4' }] } }
    let calls = 0
    const fetchImpl = vi.fn(async (url) => {
      expect(url).toBe(`${LOCAL}/history/p-1`)
      calls += 1
      if (calls < 2) return jsonResponse({})
      return jsonResponse({ 'p-1': { status: { completed: true }, outputs } })
    })
    const client = createComfyClient({ fetchImpl })
    const result = await client.waitForComfyJob({ comfyUrl: LOCAL, promptId: 'p-1', pollMs: 1 })
    expect(result.outputs).toEqual(outputs)
  })

  it('throws on a local error status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ 'p-1': { status: { completed: false, status_str: 'error' } } }))
    const client = createComfyClient({ fetchImpl })
    await expect(client.waitForComfyJob({ comfyUrl: LOCAL, promptId: 'p-1', pollMs: 1 }))
      .rejects.toThrow(/failed/)
  })

  it('resolves a cloud job via /status → /api/jobs', async () => {
    const outputs = { 3: { images: [{ filename: 'f.png' }] } }
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/api/job/p-9/status')) return jsonResponse({ status: 'completed' })
      if (url.includes('/api/jobs/p-9')) return jsonResponse({ outputs })
      throw new Error(`unexpected ${url}`)
    })
    const client = createComfyClient({ fetchImpl })
    const result = await client.waitForComfyJob({ comfyUrl: CLOUD, apiKey: 'k', promptId: 'p-9', pollMs: 1 })
    expect(result.outputs).toEqual(outputs)
  })

  it('surfaces the detailed error body on a failed cloud job', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/status')) return jsonResponse({ status: 'failed' })
      return jsonResponse({ error: 'OOM on worker' })
    })
    const client = createComfyClient({ fetchImpl })
    await expect(client.waitForComfyJob({ comfyUrl: CLOUD, apiKey: 'k', promptId: 'p-9', pollMs: 1 }))
      .rejects.toThrow(/OOM on worker/)
  })

  it('rescues a job whose /status is stuck but /api/jobs has outputs (5-tick poke)', async () => {
    const outputs = { 1: { images: [] , gifs: [{ filename: 'v.mp4' }] } }
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/status')) return jsonResponse({ status: 'running' })
      if (url.includes('/api/jobs/')) return jsonResponse({ outputs })
      throw new Error(`unexpected ${url}`)
    })
    const client = createComfyClient({ fetchImpl })
    const result = await client.waitForComfyJob({ comfyUrl: CLOUD, apiKey: 'k', promptId: 'p-9', pollMs: 1 })
    expect(result.outputs).toEqual(outputs)
  })

  it('falls back to /api/jobs when /status 404s after job retirement', async () => {
    const outputs = { 1: { gifs: [{ filename: 'v.mp4' }] } }
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/status')) return jsonResponse({}, 404)
      if (url.includes('/api/jobs/')) return jsonResponse({ outputs })
      throw new Error(`unexpected ${url}`)
    })
    const client = createComfyClient({ fetchImpl })
    const result = await client.waitForComfyJob({ comfyUrl: CLOUD, apiKey: 'k', promptId: 'p-9', pollMs: 1 })
    expect(result.outputs).toEqual(outputs)
  })

  it('times out with a clear message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    const client = createComfyClient({ fetchImpl })
    await expect(client.waitForComfyJob({ comfyUrl: LOCAL, promptId: 'p-1', pollMs: 1, timeoutMs: 5 }))
      .rejects.toThrow(/timed out/)
  })
})
