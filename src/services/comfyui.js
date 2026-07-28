/**
 * ComfyUI API Service
 * Handles communication with the ComfyUI backend
 */
import {
  checkLocalComfyConnection,
  getLocalComfyHttpBaseSync,
  getLocalComfyWsBaseSync,
  hydrateLocalComfyConnection,
  getActiveHttpBaseSync,
  getActiveWsBaseSync,
  getActiveApiKeySync,
  getActiveModeSync,
  hydrateComfyCloudConnection,
  COMFY_MODE_CLOUD,
} from './localComfyConnection'
import {
  isInsufficientCreditsError,
  notifyComfyPartnerCreditsLow,
} from './comfyPartnerAuth'

const COMFY_ORG_API_KEY_SETTING_KEY = 'comfyApiKeyComfyOrg';
const COMFY_ORG_API_KEY_LOCAL_KEY = 'comfystudio-comfy-api-key';

function parseNumericLike(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const normalized = value.replace(/,/g, '').trim()
    if (!normalized) return null
    const parsed = Number(normalized)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function extractCreditBalanceFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null

  const preferredExactKeys = new Set([
    'credits',
    'credit_balance',
    'creditbalance',
    'remaining_credits',
    'remainingcredits',
    'available_credits',
    'availablecredits',
  ])

  const fallbackKeyPattern = /(credit|balance)/i
  const queue = [payload]
  const visited = new Set()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    if (visited.has(current)) continue
    visited.add(current)

    for (const [rawKey, rawValue] of Object.entries(current)) {
      const key = String(rawKey || '').trim()
      const normalizedKey = key.toLowerCase().replace(/[\s-]/g, '')

      if (preferredExactKeys.has(normalizedKey)) {
        const parsed = parseNumericLike(rawValue)
        if (parsed !== null) return parsed
      }

      if (fallbackKeyPattern.test(key)) {
        const parsed = parseNumericLike(rawValue)
        if (parsed !== null) return parsed
      }

      if (rawValue && typeof rawValue === 'object') {
        queue.push(rawValue)
      }
    }
  }

  return null
}

class ComfyUIService {
  constructor() {
    this.ws = null;
    this.clientId = this.generateClientId();
    this.listeners = new Map();
    this.wsFailCount = 0;
    this.lastWsAttempt = 0;
    this.wsBackoffMs = 5000; // Minimum time between reconnection attempts
    // Small rolling cache of promptId -> { [nodeId]: classType }. Consumers
    // (e.g. the launcher log bridge) can use this to label node IDs with
    // their class_type in human-readable log output.
    this._promptNodeMeta = new Map();
    this._promptNodeMetaMax = 32;
    void hydrateLocalComfyConnection()
    void hydrateComfyCloudConnection()
  }

  // Headers added to every HTTP fetch. In cloud mode the API key is
  // injected as `X-API-Key` (Comfy Cloud's documented header) AND
  // `Authorization: Bearer …` as a fallback for proxies that prefer
  // Bearer. Local mode adds nothing (loopback has no auth).
  _authHeaders(extra = {}) {
    if (getActiveModeSync() !== COMFY_MODE_CLOUD) return extra
    const key = getActiveApiKeySync()
    if (!key) return extra
    return { ...extra, 'X-API-Key': key, Authorization: `Bearer ${key}` }
  }

  // Endpoint path mapper. Comfy Cloud documents its API under /api/…
  // while local ComfyUI exposes the same routes at the root. Centralise
  // the prefix decision so every call gets the right path automatically
  // based on the user's active mode.
  _apiPath(path) {
    const p = path.startsWith('/') ? path : `/${path}`
    if (getActiveModeSync() === COMFY_MODE_CLOUD) {
      // Already prefixed? Don't double it.
      return p.startsWith('/api/') ? p : `/api${p}`
    }
    return p
  }

  /**
   * Look up the class_type of a node in a recently-submitted prompt.
   * Returns null if the prompt has aged out of the cache or the node is
   * unknown.
   */
  getNodeClassType(promptId, nodeId) {
    if (!promptId || nodeId == null) return null;
    const meta = this._promptNodeMeta.get(String(promptId));
    if (!meta) return null;
    return meta[String(nodeId)] || null;
  }

  _rememberPromptNodeMeta(promptId, workflow) {
    if (!promptId || !workflow || typeof workflow !== 'object') return;
    try {
      const map = {};
      for (const [nodeId, node] of Object.entries(workflow)) {
        if (node && typeof node === 'object' && typeof node.class_type === 'string') {
          map[String(nodeId)] = node.class_type;
        }
      }
      this._promptNodeMeta.set(String(promptId), map);
      while (this._promptNodeMeta.size > this._promptNodeMetaMax) {
        const firstKey = this._promptNodeMeta.keys().next().value;
        if (firstKey === undefined) break;
        this._promptNodeMeta.delete(firstKey);
      }
    } catch (_) { /* ignore */ }
  }

  generateClientId() {
    return 'comfystudio-' + Math.random().toString(36).substring(2, 15);
  }

  getHttpBase() {
    // Active connection respects the user's mode toggle (local vs cloud).
    // Falls back to the local loopback when cloud isn't configured.
    return getActiveHttpBaseSync() || getLocalComfyHttpBaseSync()
  }

  getWsBase() {
    return getActiveWsBaseSync() || getLocalComfyWsBaseSync()
  }

  /**
   * Connect to ComfyUI WebSocket for progress updates
   * Always connects directly to ComfyUI (bypassing Vite proxy)
   */
  connect() {
    return new Promise((resolve, reject) => {
      // Skip if already connected
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      
      // Rate limit reconnection attempts to avoid spam
      const now = Date.now();
      if (now - this.lastWsAttempt < this.wsBackoffMs) {
        reject(new Error('WebSocket reconnection rate limited'));
        return;
      }
      this.lastWsAttempt = now;
      
      // Close existing connection if in connecting/closing state
      if (this.ws) {
        try {
          this.ws.close();
        } catch (e) {}
        this.ws = null;
      }

      // Always connect directly to ComfyUI (Vite proxy doesn't handle WS well)
      // WebSocket URL: cloud hosts typically accept the API key via
      // ?token=… (no auth headers on a WS upgrade). We append it when
      // we have one; loopback ignores it.
      const cloudKey = getActiveModeSync() === COMFY_MODE_CLOUD ? getActiveApiKeySync() : ''
      const tokenSuffix = cloudKey ? `&token=${encodeURIComponent(cloudKey)}` : ''
      const wsUrl = `${this.getWsBase()}/ws?clientId=${this.clientId}${tokenSuffix}`;
      
      // Only log first attempt
      if (this.wsFailCount === 0) {
        console.log('Connecting to ComfyUI WebSocket:', wsUrl);
      }
      this.ws = new WebSocket(wsUrl);
      
      // Set a timeout for connection
      const timeout = setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
          this.wsFailCount++;
          reject(new Error('WebSocket connection timeout'));
        }
      }, 5000);
      
      this.ws.onopen = () => {
        clearTimeout(timeout);
        console.log('Connected to ComfyUI WebSocket');
        this.wsFailCount = 0;
        resolve();
      };

      this.ws.onerror = (error) => {
        clearTimeout(timeout);
        // Only log first few errors to avoid spam
        if (this.wsFailCount < 3) {
          console.warn('WebSocket connection failed (ComfyUI may not support WebSocket or is blocked)');
        }
        this.wsFailCount++;
        // Increase backoff on repeated failures
        this.wsBackoffMs = Math.min(30000, this.wsBackoffMs * 1.5);
        reject(error);
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleMessage(data);
        } catch (e) {
          console.error('Error parsing WebSocket message:', e);
        }
      };

      this.ws.onclose = () => {
        console.log('WebSocket closed');
        this.ws = null;
      };
    });
  }
  
  /**
   * Check if WebSocket is connected
   */
  isWebSocketConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Handle incoming WebSocket messages
   */
  handleMessage(data) {
    const { type } = data;
    
    if (type === 'progress') {
      this.emit('progress', {
        value: data.data.value,
        max: data.data.max,
        promptId: data.data.prompt_id
      });
    } else if (type === 'executing') {
      if (data.data.node === null) {
        // Execution complete
        this.emit('complete', { promptId: data.data.prompt_id });
      } else {
        this.emit('executing', { 
          node: data.data.node,
          promptId: data.data.prompt_id 
        });
      }
    } else if (type === 'executed') {
      this.emit('executed', {
        node: data.data.node,
        output: data.data.output,
        promptId: data.data.prompt_id
      });
    } else if (type === 'status') {
      this.emit('status', data.data);
    } else if (type === 'execution_start') {
      this.emit('execution_start', {
        promptId: data.data?.prompt_id,
        timestamp: data.data?.timestamp,
      });
    } else if (type === 'execution_cached') {
      this.emit('execution_cached', {
        promptId: data.data?.prompt_id,
        nodes: Array.isArray(data.data?.nodes) ? data.data.nodes : [],
      });
    } else if (type === 'execution_success') {
      this.emit('execution_success', {
        promptId: data.data?.prompt_id,
        timestamp: data.data?.timestamp,
      });
    } else if (type === 'execution_error') {
      this.emit('execution_error', {
        promptId: data.data?.prompt_id,
        nodeId: data.data?.node_id,
        nodeType: data.data?.node_type,
        message: data.data?.exception_message || data.data?.exception_type || 'Execution error',
        traceback: Array.isArray(data.data?.traceback) ? data.data.traceback : undefined,
      });
    } else if (type === 'execution_interrupted') {
      this.emit('execution_interrupted', {
        promptId: data.data?.prompt_id,
        nodeId: data.data?.node_id,
      });
    }
  }

  /**
   * Event emitter methods
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      const callbacks = this.listeners.get(event);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(callback => callback(data));
    }
  }

  /**
   * Check if ComfyUI is running
   */
  async checkConnection() {
    const result = await checkLocalComfyConnection()
    if (!result.ok) {
      console.log('ComfyUI connection check failed:', result.error)
    }
    return result.ok
  }

  /**
   * Get ComfyUI object metadata (available node classes and input schemas).
   * Optionally scopes to a single class when classType is provided.
   */
  async getObjectInfo(classType = null) {
    const suffix = classType
      ? `/object_info/${encodeURIComponent(String(classType).trim())}`
      : '/object_info'
    const response = await fetch(`${this.getHttpBase()}${this._apiPath(suffix)}`, { headers: this._authHeaders() })
    if (!response.ok) {
      throw new Error(`Failed to fetch ComfyUI object info (${response.status})`)
    }
    return response.json()
  }

  /**
   * Queue a prompt for execution
   */
  async queuePrompt(workflow) {
    try {
      const apiKey = await this.getComfyOrgApiKey();
      const payload = {
        prompt: workflow,
        client_id: this.clientId
      };
      if (apiKey) {
        payload.extra_data = {
          api_key_comfy_org: apiKey
        };
      }
      const response = await fetch(`${this.getHttpBase()}${this._apiPath('/prompt')}`, {
        method: 'POST',
        headers: this._authHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        // Try to pull a structured body for better error messages. Some
        // ComfyUI / partner-node failures return JSON, others a plain string.
        let errorBody = null
        try {
          errorBody = await response.json()
        } catch (_) {
          try { errorBody = await response.text() } catch (_) { /* ignore */ }
        }

        // ComfyUI's /prompt validation failures put the real cause in
        // `node_errors` (per-node diagnostics like "value_not_in_list",
        // "required_input_missing", or custom validators) and extra context
        // in `error.details` / `error.extra_info`. The top-level
        // `error.message` is usually just the generic label
        // ("Prompt outputs failed validation"), so we synthesise a richer
        // message that callers (and users) can actually act on.
        const topMessage =
          (errorBody && typeof errorBody === 'object' && (errorBody.error?.message || errorBody.message)) ||
          (typeof errorBody === 'string' && errorBody) ||
          `Failed to queue prompt (${response.status})`

        const nodeErrorLines = []
        if (errorBody && typeof errorBody === 'object' && errorBody.node_errors && typeof errorBody.node_errors === 'object') {
          for (const [nodeId, nodeInfo] of Object.entries(errorBody.node_errors)) {
            const classType = nodeInfo?.class_type || 'unknown'
            const errs = Array.isArray(nodeInfo?.errors) ? nodeInfo.errors : []
            for (const nodeErr of errs) {
              const parts = [
                `Node ${nodeId} (${classType})`,
                nodeErr?.type ? `[${nodeErr.type}]` : null,
                nodeErr?.message || null,
                nodeErr?.details ? `— ${nodeErr.details}` : null,
              ].filter(Boolean)
              nodeErrorLines.push(parts.join(' '))
            }
          }
        }

        const extraDetails =
          errorBody && typeof errorBody === 'object'
            ? errorBody.error?.details || errorBody.details || null
            : null

        const message = [
          topMessage,
          nodeErrorLines.length ? nodeErrorLines.join('\n') : null,
          extraDetails && typeof extraDetails === 'string' && !nodeErrorLines.length ? extraDetails : null,
        ]
          .filter(Boolean)
          .join('\n')

        // Detect Comfy partner credit exhaustion at the earliest possible
        // point. Dispatching the event here means any chip/banner anywhere
        // in the UI can flip into the actionable "out of credits" state
        // regardless of which code path triggered the submission.
        const insufficient =
          response.status === 402 ||
          isInsufficientCreditsError({ status: response.status, message, error: errorBody })
        if (insufficient) {
          notifyComfyPartnerCreditsLow({
            status: response.status,
            message,
          })
        }

        try { console.error('[ComfyUI] /prompt error body:', errorBody) } catch (_) { /* ignore */ }

        const err = new Error(message)
        err.status = response.status
        err.insufficientCredits = insufficient
        err.rawBody = errorBody
        err.nodeErrors = (errorBody && typeof errorBody === 'object' && errorBody.node_errors) || null
        throw err
      }

      const result = await response.json();
      this._rememberPromptNodeMeta(result?.prompt_id, workflow);
      return result.prompt_id;
    } catch (error) {
      console.error('Error queuing prompt:', error);
      // Also catch cases where the error string surfaced from deeper in the
      // stack already signalled insufficient funds (e.g. partner node threw
      // after the initial /prompt queue accepted the request).
      if (!error?.insufficientCredits && isInsufficientCreditsError(error)) {
        notifyComfyPartnerCreditsLow({
          status: error?.status ?? null,
          message: error?.message ?? String(error),
        })
      }
      throw error;
    }
  }

  /**
   * Resolve optional Comfy account API key for paid API nodes.
   *
   * Lookup order:
   *   1. Dedicated setting `comfyApiKeyComfyOrg` (Electron store).
   *   2. localStorage fallback under `comfystudio-comfy-api-key`.
   *   3. The active Cloud connection's API key (when the user is in
   *      Cloud mode). The Comfy Cloud connection key and the Partner
   *      Nodes key are issued by the same comfy.org account and are
   *      the same string — so if the user only filled the Cloud
   *      connection settings, that key authorises API Nodes too.
   *      Without this fallback the Seedance / Kling / Grok requests
   *      hit "Unauthorized: Please login first to use this node" even
   *      though the user is logged in and has credits.
   */
  async getComfyOrgApiKey() {
    try {
      if (typeof window !== 'undefined' && window?.electronAPI?.getSetting) {
        const stored = await window.electronAPI.getSetting(COMFY_ORG_API_KEY_SETTING_KEY)
        const normalized = String(stored || '').trim()
        if (normalized) return normalized
      }
    } catch (_) {
      // Ignore and fall back to localStorage.
    }

    try {
      if (typeof localStorage !== 'undefined') {
        const local = String(localStorage.getItem(COMFY_ORG_API_KEY_LOCAL_KEY) || '').trim()
        if (local) return local
      }
    } catch (_) {
      // Ignore storage access errors.
    }

    // Fall back to the active Cloud connection's key.
    try {
      if (getActiveModeSync() === COMFY_MODE_CLOUD) {
        const cloudKey = String(getActiveApiKeySync() || '').trim()
        if (cloudKey) return cloudKey
      }
    } catch (_) {
      // Ignore — leave empty.
    }
    return ''
  }

  /**
   * Best-effort credit balance lookup for Comfy partner credits.
   * Returns status + optional numeric credits when exposed by backend/API.
   */
  async getComfyOrgCreditBalance() {
    const apiKey = await this.getComfyOrgApiKey()
    if (!apiKey) {
      return {
        status: 'missing-key',
        credits: null,
        source: '',
        error: 'Comfy Partner API key not configured.',
        payload: null,
      }
    }

    const localBase = this.getHttpBase()
    const candidateUrls = [
      `${localBase}/api/user`,
      `${localBase}/api/account`,
      'https://api.comfy.org/api/user',
    ]

    const failures = []
    for (const url of candidateUrls) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 6000)
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'X-API-Key': apiKey,
          },
          signal: controller.signal,
        })
        clearTimeout(timeout)

        if (!response.ok) {
          failures.push({ url, status: response.status, message: `${response.status}` })
          continue
        }

        const payload = await response.json()
        const credits = extractCreditBalanceFromPayload(payload)
        return {
          status: credits === null ? 'available-no-credit-field' : 'ok',
          credits,
          source: url,
          error: '',
          payload,
        }
      } catch (error) {
        failures.push({
          url,
          status: null,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const statusCodes = failures
      .map((failure) => Number(failure?.status))
      .filter((code) => Number.isFinite(code))
    const hasAuthFailure = statusCodes.some((code) => code === 401 || code === 403)
    const hasNotSupported = statusCodes.length > 0 && statusCodes.every((code) => code === 404 || code === 405)

    if (hasAuthFailure) {
      return {
        status: 'auth-failed',
        credits: null,
        source: '',
        error: 'Credit endpoints rejected the current API key.',
        payload: null,
      }
    }

    if (hasNotSupported) {
      return {
        status: 'not-supported',
        credits: null,
        source: '',
        error: 'Credit balance endpoint is not exposed by this ComfyUI server.',
        payload: null,
      }
    }

    const firstFailure = failures[0] || null
    return {
      status: 'unavailable',
      credits: null,
      source: '',
      error: firstFailure?.message || 'No supported credit endpoint responded.',
      payload: null,
    }
  }

  /**
   * Get history/output for a prompt (or full history if no promptId)
   */
  async getHistory(promptId) {
    try {
      // Cloud and local diverge here:
      //   - Local ComfyUI:  GET /history/<id>  or  GET /history (all jobs)
      //   - Comfy Cloud:    GET /api/jobs/<id> (returns outputs by node id)
      //                     `/api/jobs` plural for one job is intentional;
      //                     there is no documented "full history" endpoint.
      // We always return a map keyed by promptId to keep the shape stable
      // for callers, even if the cloud response itself isn't wrapped that way.
      const isCloud = getActiveModeSync() === COMFY_MODE_CLOUD
      let url
      if (isCloud) {
        if (!promptId) {
          // No documented "all jobs" listing on cloud — return empty map.
          return {}
        }
        url = `${this.getHttpBase()}/api/jobs/${encodeURIComponent(promptId)}`
      } else {
        url = promptId
          ? `${this.getHttpBase()}/history/${promptId}`
          : `${this.getHttpBase()}/history`
      }
      const response = await fetch(url, { headers: this._authHeaders() });
      const data = await response.json();
      // Cloud returns the job object directly. Local returns
      // { [promptId]: { outputs, status, ... } }. Wrap the cloud
      // response into the same shape so polling code stays uniform.
      if (isCloud && promptId) {
        return { [promptId]: data }
      }
      return data
    } catch (error) {
      console.error('Error getting history:', error);
      throw error;
    }
  }

  // Lightweight status poll — only available on Cloud. Returns the
  // documented status enum ('pending' | 'in_progress' | 'completed' |
  // 'failed' | 'cancelled'). Cheaper than getHistory() because it
  // doesn't return the outputs blob.
  async getJobStatus(promptId) {
    if (!promptId) return null
    if (getActiveModeSync() !== COMFY_MODE_CLOUD) return null
    try {
      const url = `${this.getHttpBase()}/api/job/${encodeURIComponent(promptId)}/status`
      const response = await fetch(url, { headers: this._authHeaders() })
      if (!response.ok) return null
      return await response.json()  // { status: '...' }
    } catch (error) {
      console.error('Error getting job status:', error)
      return null
    }
  }

  /**
   * Get an image/video from ComfyUI output
   */
  getMediaUrl(filename, subfolder = '', type = 'output') {
    const params = new URLSearchParams({
      filename,
      subfolder,
      type
    });
    return `${this.getHttpBase()}${this._apiPath('/view')}?${params}`;
  }

  /**
   * Download a video from ComfyUI and return as a File object
   * @param {string} filename - The filename on ComfyUI
   * @param {string} subfolder - The subfolder (usually 'video')
   * @param {string} type - The type (usually 'output')
   * @returns {Promise<File>} - The video as a File object
   */
  async downloadVideo(filename, subfolder = '', type = 'output') {
    const url = this.getMediaUrl(filename, subfolder, type);

    try {
      const response = await fetch(url, { headers: this._authHeaders() });
      if (!response.ok) {
        throw new Error(`Failed to download video: ${response.status}`);
      }
      
      const blob = await response.blob();
      const mimeType = blob.type || 'video/mp4';
      
      // Create a File object from the blob
      return new File([blob], filename, { type: mimeType });
    } catch (error) {
      console.error('Error downloading video from ComfyUI:', error);
      throw error;
    }
  }

  /**
   * Interrupt the current generation
   */
  async interrupt() {
    try {
      // Comfy Cloud doesn't document an /interrupt endpoint; calling it
      // is a best-effort no-op there. Local ComfyUI accepts it normally.
      await fetch(`${this.getHttpBase()}${this._apiPath('/interrupt')}`, { method: 'POST', headers: this._authHeaders() });
    } catch (error) {
      console.error('Error interrupting:', error);
    }
  }

  /**
   * Get queue status
   */
  async getQueueStatus() {
    try {
      // Comfy Cloud doesn't document /queue (only per-job status via
      // /api/job/<id>/status). On cloud we return an empty queue shape
      // so callers that expect { queue_running, queue_pending } don't
      // break — concurrency limits are managed cloud-side anyway.
      if (getActiveModeSync() === COMFY_MODE_CLOUD) {
        return { queue_running: [], queue_pending: [] }
      }
      const response = await fetch(`${this.getHttpBase()}/queue`, { headers: this._authHeaders() });
      return await response.json();
    } catch (error) {
      console.error('Error getting queue:', error);
      return { queue_running: [], queue_pending: [] };
    }
  }
  
  /**
   * Upload a file to ComfyUI
   * @param {File|Blob} file - The file to upload
   * @param {string} filename - Optional filename override
   * @param {string} subfolder - Optional subfolder (default: empty)
   * @param {string} type - 'input', 'temp', or 'output' (default: 'input')
   * @returns {Promise<{name: string, subfolder: string, type: string}>}
   */
  async uploadFile(file, filename = null, subfolder = '', type = 'input') {
    try {
      const formData = new FormData();
      
      // Use provided filename or file's name
      const uploadFilename = filename || file.name || `upload_${Date.now()}`;
      
      // Append the file with the correct filename
      formData.append('image', file, uploadFilename);
      
      if (subfolder) {
        formData.append('subfolder', subfolder);
      }
      formData.append('type', type);
      formData.append('overwrite', 'true');

      const response = await fetch(`${this.getHttpBase()}${this._apiPath('/upload/image')}`, {
        method: 'POST',
        headers: this._authHeaders(),  // Note: do NOT add Content-Type — fetch will set the multipart boundary
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to upload file: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.log('File uploaded to ComfyUI:', result);
      return result;
    } catch (error) {
      console.error('Error uploading file to ComfyUI:', error);
      throw error;
    }
  }

  /**
   * Download an image from ComfyUI and return as a File object
   * @param {string} filename - The filename on ComfyUI
   * @param {string} subfolder - The subfolder
   * @param {string} type - The type (usually 'output')
   * @returns {Promise<File>} - The image as a File object
   */
  async downloadImage(filename, subfolder = '', type = 'output') {
    const url = this.getMediaUrl(filename, subfolder, type);
    
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download image: ${response.status}`);
      }
      
      const blob = await response.blob();
      const mimeType = blob.type || 'image/png';
      
      // Create a File object from the blob
      return new File([blob], filename, { type: mimeType });
    } catch (error) {
      console.error('Error downloading image from ComfyUI:', error);
      throw error;
    }
  }

  /**
   * Download multiple images (PNG sequence) from ComfyUI
   * @param {Array<{filename: string, subfolder: string, type: string}>} images - Array of image info
   * @returns {Promise<File[]>} - Array of File objects
   */
  async downloadImageSequence(images) {
    const files = [];
    for (const img of images) {
      const file = await this.downloadImage(img.filename, img.subfolder || '', img.type || 'output');
      files.push(file);
    }
    return files;
  }

  /**
   * Get detailed prompt execution info for progress tracking
   * This is useful when WebSocket is unavailable
   */
  async getPromptProgress(promptId) {
    try {
      // First check if it's in the queue
      const queueStatus = await this.getQueueStatus();
      
      // Check if it's currently running
      const running = queueStatus.queue_running || [];
      for (const item of running) {
        if (item[1] === promptId) {
          // It's running - try to get progress from history
          const history = await this.getHistory(promptId);
          const promptHistory = history[promptId];
          
          if (promptHistory?.status?.messages) {
            // Parse messages for progress info
            const messages = promptHistory.status.messages;
            for (const msg of messages) {
              if (msg[0] === 'execution_cached') {
                // Some nodes were cached
              }
            }
          }
          
          return { status: 'running', position: 0, promptId };
        }
      }
      
      // Check if it's pending
      const pending = queueStatus.queue_pending || [];
      for (let i = 0; i < pending.length; i++) {
        if (pending[i][1] === promptId) {
          return { status: 'pending', position: i + 1, promptId };
        }
      }
      
      // Check if it's completed
      const history = await this.getHistory(promptId);
      if (history[promptId]) {
        const promptHistory = history[promptId];
        if (promptHistory.outputs && Object.keys(promptHistory.outputs).length > 0) {
          return { status: 'completed', promptId };
        }
        if (promptHistory.status?.status_str === 'error') {
          return { status: 'error', promptId, error: promptHistory.status.messages };
        }
      }
      
      return { status: 'unknown', promptId };
    } catch (error) {
      console.error('Error getting prompt progress:', error);
      return { status: 'error', promptId, error: error.message };
    }
  }
}

// Singleton instance
export const comfyui = new ComfyUIService();

const IMAGE_EXTENSIONS_FOR_MASK_WORKFLOW = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff', '.tif']

/**
 * Heuristic: is `filename` a still image (versus a video)? Used to decide
 * whether the mask workflow should wire up `VHS_LoadVideo` or `LoadImage` for
 * node 8. We only peek at the extension because that's the same signal ComfyUI
 * itself uses to route uploads into `input/` — the file contents have already
 * been validated by the uploader.
 */
function isImageFilenameForMaskWorkflow(filename) {
  const name = String(filename || '').toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  const ext = name.slice(dot)
  return IMAGE_EXTENSIONS_FOR_MASK_WORKFLOW.includes(ext)
}

/**
 * Workflow modifier for Mask Generation (SAM3 + MatAnyone)
 *
 * Workflow nodes:
 * - Node 8 (VHS_LoadVideo OR LoadImage): Load the input video/image
 * - Node 12 (SAM3VideoSegmentation): Text prompt for segmentation
 * - Node 5 (SaveImage): Output filename prefix
 *
 * Why two loader classes: `VHS_LoadVideo` goes through OpenCV's VideoCapture,
 * which can (and does, inconsistently) fail to open single-frame PNG/JPG/WEBP
 * files with a generic `ValueError: ... could not be loaded with cv.` This
 * bites every user who tries to mask a still image — the most common mask-gen
 * use case. The failure surfaces in the app as a useless "Generation failed"
 * banner because the error only lives in ComfyUI's history payload.
 *
 * The fix is the same trick we applied to the caption transcription workflow:
 * inspect the uploaded filename, and if it's an image, rewrite node 8 as a
 * ComfyUI-builtin `LoadImage` (which reads PIL-supported formats natively and
 * returns a 1-frame IMAGE tensor `[1,H,W,C]`). Downstream nodes
 * (`SAM3VideoSegmentation`, `MatAnyoneVideoMatting`) already declare their
 * `video_frames` input as IMAGE, so a 1-frame batch drops right in without
 * re-wiring slots.
 *
 * @param {Object} workflow - The base mask generation workflow
 * @param {Object} options - Configuration options
 * @returns {Object} Modified workflow
 */
export function modifyMaskWorkflow(workflow, options = {}) {
  const {
    inputFilename = '',       // The uploaded filename in ComfyUI
    textPrompt = '',          // What to segment (e.g., "person on the left")
    outputPrefix = 'ComfyStudioMask',  // Output filename prefix
    scoreThreshold = 0.04,    // Detection sensitivity (lower = more sensitive)
    frameIdx = 0,             // Which frame to use for initial detection
  } = options;

  // Create a deep copy
  const modified = JSON.parse(JSON.stringify(workflow));

  if (modified['8']) {
    if (isImageFilenameForMaskWorkflow(inputFilename)) {
      // Replace VHS_LoadVideo with LoadImage. Output slot 0 is IMAGE on both
      // classes, so the existing `["8", 0]` references in downstream nodes stay
      // valid. We intentionally drop VHS-specific inputs (force_rate,
      // frame_load_cap, format, etc.) because LoadImage doesn't accept them
      // and ComfyUI will reject the prompt with "extra inputs not allowed".
      modified['8'] = {
        inputs: {
          image: inputFilename,
          // The `upload` hint is how the ComfyUI web client triggers the upload
          // dropzone, but the server ignores it during graph execution. Still,
          // we include it so the workflow matches what ComfyUI exports when a
          // user picks an uploaded image manually.
          upload: 'image',
        },
        class_type: 'LoadImage',
        _meta: {
          title: 'Load Image',
        },
      }
    } else {
      modified['8'].inputs.video = inputFilename;
    }
  }

  // Update text prompt and threshold (node 12 - SAM3VideoSegmentation)
  if (modified['12']) {
    modified['12'].inputs.text_prompt = textPrompt;
    modified['12'].inputs.score_threshold = scoreThreshold;
    modified['12'].inputs.frame_idx = frameIdx;
  }

  // Update output filename prefix (node 5 - SaveImage)
  if (modified['5']) {
    modified['5'].inputs.filename_prefix = outputPrefix;
  }

  return modified;
}


/**
 * Workflow modifier for LTX 2.3 Image-to-Video
 */
export function modifyLTX23I2VWorkflow(workflow, options = {}) {
  const {
    prompt = '',
    negativePrompt = '',
    inputImage = '',
    width = 1280,
    height = 720,
    frames = 121,
    fps = 24,
    seed = Math.floor(Math.random() * 1000000000000),
    filenamePrefix = 'video/ltx23_i2v',
  } = options

  const modified = JSON.parse(JSON.stringify(workflow))
  const numericWidth = Math.max(256, Math.round(Number(width) || 1280))
  const numericHeight = Math.max(256, Math.round(Number(height) || 720))
  const numericFrames = Math.max(2, Math.round(Number(frames) || 121))
  const numericFps = Math.max(1, Math.round(Number(fps) || 24))
  const numericSeed = Math.round(Number(seed) || Math.floor(Math.random() * 1000000000000))

  if (modified['269'] && inputImage) {
    modified['269'].inputs.image = inputImage
  }

  if (modified['267:266']) {
    modified['267:266'].inputs.value = prompt
  }

  if (modified['267:247']) {
    modified['267:247'].inputs.text = negativePrompt
  }

  if (modified['267:257']) {
    modified['267:257'].inputs.value = numericWidth
  }

  if (modified['267:258']) {
    modified['267:258'].inputs.value = numericHeight
  }

  if (modified['267:225']) {
    modified['267:225'].inputs.value = numericFrames
  }

  if (modified['267:260']) {
    modified['267:260'].inputs.value = numericFps
  }

  if (modified['267:201']) {
    modified['267:201'].inputs.value = false
  }

  if (modified['267:216']) {
    modified['267:216'].inputs.noise_seed = numericSeed
  }

  if (modified['267:237']) {
    modified['267:237'].inputs.noise_seed = numericSeed
  }

  if (modified['75']) {
    modified['75'].inputs.filename_prefix = filenamePrefix
  }

  return modified
}


/**
 * Workflow modifier for Z Image Turbo (text-to-image).
 * Sets prompt on CLIPTextEncode and seed on KSampler.
 */
export function modifyZImageTurboWorkflow(workflow, options = {}) {
  const {
    prompt = '',
    seed = Math.floor(Math.random() * 1000000000000),
    width = 1024,
    height = 1024,
    filenamePrefix = '',
  } = options

  const modified = JSON.parse(JSON.stringify(workflow))
  const numericWidth = Math.max(256, Math.round(Number(width) || 1024))
  const numericHeight = Math.max(256, Math.round(Number(height) || 1024))

  for (const node of Object.values(modified)) {
    if (!node?.inputs) continue
    if (node.class_type === 'CLIPTextEncode' && (node._meta?.title || '').includes('Prompt')) {
      node.inputs.text = prompt
    }
    if (node.class_type === 'KSampler' && 'seed' in node.inputs) {
      node.inputs.seed = seed
    }
    if ((node.class_type === 'EmptySD3LatentImage' || node.class_type === 'EmptyLatentImage')) {
      if ('width' in node.inputs) node.inputs.width = numericWidth
      if ('height' in node.inputs) node.inputs.height = numericHeight
    }
    if (node.class_type === 'SaveImage' && 'filename_prefix' in node.inputs) {
      node.inputs.filename_prefix = filenamePrefix || node.inputs.filename_prefix || 'image/z_image_turbo'
    }
  }

  return modified
}


function resolveTieredImageResolution(width, height, fallback = '1K') {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h)) return fallback
  const longestEdge = Math.max(w, h)
  return longestEdge >= 1800 ? '2K' : '1K'
}

function resolveSeedreamSizePreset(width, height) {
  const w = Math.max(256, Math.round(Number(width) || 0))
  const h = Math.max(256, Math.round(Number(height) || 0))
  const sizePresetMap = {
    '1280x720': '1280x720 (16:9)',
    '1920x1080': '1920x1080 (16:9)',
    '720x1280': '720x1280 (9:16)',
    '1080x1920': '1080x1920 (9:16)',
    '1024x1024': '1024x1024 (1:1)',
    '2048x2048': '2048x2048 (1:1)',
  }
  return sizePresetMap[`${w}x${h}`] || null
}

function resolveClosestAspectRatio(width, height) {
  const w = Number(width)
  const h = Number(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || h <= 0) return '16:9'

  const target = w / h
  const candidates = [
    { label: '16:9', value: 16 / 9 },
    { label: '9:16', value: 9 / 16 },
    { label: '1:1', value: 1 },
    { label: '4:3', value: 4 / 3 },
    { label: '3:4', value: 3 / 4 },
  ]

  let best = candidates[0]
  let bestDelta = Math.abs(target - best.value)
  for (const candidate of candidates.slice(1)) {
    const delta = Math.abs(target - candidate.value)
    if (delta < bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }

  return best.label
}


export default comfyui;
