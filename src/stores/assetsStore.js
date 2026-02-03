import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Store for managing generated and imported assets
 * Persisted to localStorage for data survival across refreshes
 * 
 * Asset structure:
 * {
 *   id: string,
 *   name: string,
 *   type: 'video' | 'audio' | 'image',
 *   url: string (blob URL for playback),
 *   path: string (relative path in project for imported assets),
 *   createdAt: ISO string,
 *   imported: ISO string (for imported assets),
 *   isImported: boolean,
 *   settings: { duration, width, height, etc. },
 *   prompt: string (for AI-generated),
 *   mimeType: string,
 *   size: number,
 * }
 */
export const useAssetsStore = create(
  persist(
    (set, get) => ({
  // All assets (AI-generated + imported)
  assets: [],
  
  // Currently selected asset for preview
  currentPreview: null,
  
  // Counter for auto-naming
  assetCounter: 1,
  
  // Video playback state (shared between PreviewPanel and TransportControls)
  videoRef: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 0.75,
  
  // Register video element ref
  registerVideoRef: (ref) => {
    set({ videoRef: ref })
  },
  
  // Playback controls
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (dur) => set({ duration: dur }),
  setVolume: (vol) => {
    const ref = get().videoRef
    if (ref) {
      ref.volume = vol
    }
    set({ volume: vol })
  },
  
  togglePlay: () => {
    const { videoRef, isPlaying } = get()
    if (videoRef) {
      if (isPlaying) {
        videoRef.pause()
      } else {
        videoRef.play()
      }
    }
  },
  
  seekTo: (time) => {
    const { videoRef, duration } = get()
    if (videoRef) {
      const clampedTime = Math.max(0, Math.min(duration, time))
      videoRef.currentTime = clampedTime
      set({ currentTime: clampedTime })
    }
  },
  
  skip: (seconds) => {
    const { videoRef, currentTime, duration } = get()
    if (videoRef) {
      const newTime = Math.max(0, Math.min(duration, currentTime + seconds))
      videoRef.currentTime = newTime
      set({ currentTime: newTime })
    }
  },
  
  /**
   * Generate a name from prompt text
   */
  generateName: (prompt) => {
    const counter = get().assetCounter
    // Take first few words, clean up, limit length
    const words = prompt
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .split(/\s+/)
      .slice(0, 4)
      .join('_')
      .substring(0, 30)
    
    set({ assetCounter: counter + 1 })
    return `${words}_${String(counter).padStart(3, '0')}`
  },
  
  /**
   * Add a new generated asset
   */
  addAsset: (asset) => {
    const newAsset = {
      id: Date.now().toString(),
      createdAt: new Date().toISOString(),
      ...asset
    }
    
    set((state) => ({
      assets: [newAsset, ...state.assets],
      currentPreview: newAsset // Auto-preview new assets
    }))
    
    return newAsset
  },
  
  /**
   * Set the current preview
   */
  setPreview: (asset) => {
    set({ currentPreview: asset, previewMode: 'asset' })
  },
  
  /**
   * Preview mode: 'asset' (single asset preview) or 'timeline' (playing timeline)
   */
  previewMode: 'asset',
  
  /**
   * Set the preview mode explicitly
   */
  setPreviewMode: (mode) => {
    set({ previewMode: mode })
  },
  
  /**
   * Clear the current preview
   */
  clearPreview: () => {
    set({ currentPreview: null })
  },
  
  /**
   * Remove an asset
   */
  removeAsset: (id) => {
    set((state) => ({
      assets: state.assets.filter(a => a.id !== id),
      currentPreview: state.currentPreview?.id === id ? null : state.currentPreview
    }))
  },
  
  /**
   * Rename an asset
   */
  renameAsset: (id, newName) => {
    set((state) => ({
      assets: state.assets.map(a => 
        a.id === id ? { ...a, name: newName } : a
      ),
      currentPreview: state.currentPreview?.id === id 
        ? { ...state.currentPreview, name: newName }
        : state.currentPreview
    }))
  },

  /**
   * Clear all assets (for "New Project")
   */
  clearProject: () => {
    // Revoke any blob URLs before clearing
    const state = get()
    state.assets.forEach(asset => {
      if (asset.url && asset.url.startsWith('blob:')) {
        URL.revokeObjectURL(asset.url)
      }
    })
    
    set({
      assets: [],
      currentPreview: null,
      assetCounter: 1,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
    })
  },

  /**
   * Load assets from project data
   * @param {Array} projectAssets - Assets from project file
   * @param {FileSystemDirectoryHandle} projectHandle - The project directory handle for regenerating URLs
   */
  loadFromProject: async (projectAssets, projectHandle) => {
    // Clear existing assets first
    get().clearProject()
    
    // Load assets - URLs need to be regenerated for imported assets
    const assetsWithUrls = []
    
    for (const asset of (projectAssets || [])) {
      if (asset.isImported && asset.path && projectHandle) {
        // For imported assets, regenerate blob URL from file
        try {
          const { getProjectFileUrl } = await import('../services/fileSystem')
          const url = await getProjectFileUrl(projectHandle, asset.path)
          assetsWithUrls.push({ ...asset, url })
        } catch (err) {
          console.warn(`Could not load imported asset ${asset.name}:`, err)
          // Keep asset but mark URL as null
          assetsWithUrls.push({ ...asset, url: null })
        }
      } else {
        // For AI assets, keep the URL as-is (may need ComfyUI to be running)
        // In future, these should also be saved locally
        assetsWithUrls.push(asset)
      }
    }
    
    set({
      assets: assetsWithUrls,
      assetCounter: (projectAssets?.length || 0) + 1,
    })
  },

  /**
   * Get assets data for saving to project
   * Returns assets without blob URLs (paths only for imported)
   */
  getProjectData: () => {
    const state = get()
    return state.assets.map(asset => ({
      ...asset,
      // Don't save blob URLs - they're session-specific
      url: asset.isImported ? null : asset.url, // Keep URL for AI assets (they're external)
    }))
  },

  /**
   * Update asset URL (for when loading from project and regenerating blob URLs)
   */
  updateAssetUrl: (assetId, url) => {
    set((state) => ({
      assets: state.assets.map(a => 
        a.id === assetId ? { ...a, url } : a
      ),
      currentPreview: state.currentPreview?.id === assetId 
        ? { ...state.currentPreview, url }
        : state.currentPreview
    }))
  },

  /**
   * Regenerate URLs for all imported assets that have null URLs
   * Called when project handle becomes available
   * @param {FileSystemDirectoryHandle} projectHandle - The project directory handle
   */
  regenerateImportedUrls: async (projectHandle) => {
    if (!projectHandle) return
    
    const state = get()
    const assetsNeedingUrls = state.assets.filter(a => a.isImported && a.path && !a.url)
    
    if (assetsNeedingUrls.length === 0) return
    
    console.log(`Regenerating URLs for ${assetsNeedingUrls.length} imported assets...`)
    
    for (const asset of assetsNeedingUrls) {
      try {
        const { getProjectFileUrl } = await import('../services/fileSystem')
        const url = await getProjectFileUrl(projectHandle, asset.path)
        get().updateAssetUrl(asset.id, url)
        console.log(`Regenerated URL for ${asset.name}`)
      } catch (err) {
        console.warn(`Could not regenerate URL for ${asset.name}:`, err)
      }
    }
  }
    }),
    {
      name: 'storyflow-assets', // localStorage key
      partialize: (state) => ({
        // Only persist these fields (exclude transient playback state)
        assets: state.assets,
        assetCounter: state.assetCounter,
        volume: state.volume,
        // Don't persist previewMode - always start fresh
      }),
    }
  )
)

export default useAssetsStore
