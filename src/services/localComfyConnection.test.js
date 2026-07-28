import { describe, it, expect } from 'vitest'
import {
  DEFAULT_COMFY_PORT,
  parseLocalComfyPortInput,
  isLoopbackHttpUrl,
  parseCloudHttpBase,
  deriveWsBase,
} from './localComfyConnection.js'

describe('parseLocalComfyPortInput', () => {
  it('defaults to the standard port on empty input', () => {
    expect(parseLocalComfyPortInput('')).toEqual({ success: true, port: DEFAULT_COMFY_PORT })
    expect(parseLocalComfyPortInput(null)).toEqual({ success: true, port: DEFAULT_COMFY_PORT })
  })

  it('accepts a bare port number', () => {
    expect(parseLocalComfyPortInput('8000')).toEqual({ success: true, port: 8000 })
    expect(parseLocalComfyPortInput(' 8188 ')).toEqual({ success: true, port: 8188 })
  })

  it('rejects out-of-range ports', () => {
    expect(parseLocalComfyPortInput('0').success).toBe(false)
    expect(parseLocalComfyPortInput('70000').success).toBe(false)
  })

  it('accepts loopback URLs and extracts the port', () => {
    expect(parseLocalComfyPortInput('http://127.0.0.1:8000')).toEqual({ success: true, port: 8000 })
    expect(parseLocalComfyPortInput('localhost:8188')).toEqual({ success: true, port: 8188 })
  })

  it('falls back to the default port for a loopback URL without a port', () => {
    expect(parseLocalComfyPortInput('http://localhost')).toEqual({ success: true, port: DEFAULT_COMFY_PORT })
  })

  it('rejects remote hosts', () => {
    expect(parseLocalComfyPortInput('http://example.com:8188').success).toBe(false)
    expect(parseLocalComfyPortInput('192.168.1.10:8188').success).toBe(false)
  })

  it('rejects non-http protocols', () => {
    expect(parseLocalComfyPortInput('ftp://127.0.0.1:8188').success).toBe(false)
  })
})

describe('isLoopbackHttpUrl', () => {
  it('accepts localhost and 127.x addresses', () => {
    expect(isLoopbackHttpUrl('http://localhost:8188')).toBe(true)
    expect(isLoopbackHttpUrl('http://127.0.0.1:8000')).toBe(true)
    expect(isLoopbackHttpUrl('https://127.1.2.3')).toBe(true)
  })

  it('rejects remote and malformed URLs', () => {
    expect(isLoopbackHttpUrl('https://cloud.comfy.org')).toBe(false)
    expect(isLoopbackHttpUrl('not a url')).toBe(false)
    expect(isLoopbackHttpUrl('ws://127.0.0.1:8188')).toBe(false)
  })
})

describe('parseCloudHttpBase', () => {
  it('requires a value', () => {
    expect(parseCloudHttpBase('').ok).toBe(false)
  })

  it('assumes https for bare hostnames', () => {
    expect(parseCloudHttpBase('cloud.comfy.org')).toEqual({ ok: true, httpBase: 'https://cloud.comfy.org' })
  })

  it('strips paths, query, hash and trailing slashes', () => {
    expect(parseCloudHttpBase('https://cloud.comfy.org/ws?x=1#y')).toEqual({ ok: true, httpBase: 'https://cloud.comfy.org' })
    expect(parseCloudHttpBase('https://cloud.comfy.org/')).toEqual({ ok: true, httpBase: 'https://cloud.comfy.org' })
  })

  it('rejects non-http protocols', () => {
    expect(parseCloudHttpBase('ftp://cloud.comfy.org').ok).toBe(false)
  })
})

describe('deriveWsBase', () => {
  it('maps http to ws and https to wss', () => {
    expect(deriveWsBase('http://127.0.0.1:8188')).toBe('ws://127.0.0.1:8188')
    expect(deriveWsBase('https://cloud.comfy.org')).toBe('wss://cloud.comfy.org')
  })

  it('returns empty for empty input', () => {
    expect(deriveWsBase('')).toBe('')
  })
})
