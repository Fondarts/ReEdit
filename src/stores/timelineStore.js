import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Maximum number of undo states to keep
const MAX_HISTORY_SIZE = 50

/**
 * Store for managing timeline state
 * Persisted to localStorage for data survival across refreshes
 */
export const useTimelineStore = create(
  persist(
    (set, get) => ({
  // Timeline settings
  duration: 60, // Total timeline duration in seconds
  zoom: 100, // Zoom level (100 = 1 second = ~20px)
  playheadPosition: 0, // Current playhead position in seconds
  isPlaying: false,
  
  // JKL Shuttle playback
  playbackRate: 1, // Playback speed multiplier (negative = reverse)
  shuttleMode: false, // Whether in JKL shuttle mode
  
  // Playback loop modes: 'normal', 'loop', 'loop-in-out', 'ping-pong'
  loopMode: 'normal',
  
  // Tracks
  tracks: [
    { id: 'video-1', name: 'Video 1', type: 'video', muted: false, locked: false, visible: true },
    { id: 'video-2', name: 'Video 2', type: 'video', muted: false, locked: false, visible: true },
    { id: 'music', name: 'Music', type: 'audio', muted: false, locked: false, visible: true },
    { id: 'voiceover', name: 'Voiceover', type: 'audio', muted: false, locked: false, visible: true },
    { id: 'sfx', name: 'SFX', type: 'audio', muted: false, locked: false, visible: true },
  ],
  
  // Clips on timeline
  clips: [],
  
  // Transitions between clips
  // Types: 'dissolve', 'fade-black', 'fade-white', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'slide-left', 'slide-right'
  transitions: [],
  
  // Selected clips (multi-select support)
  selectedClipIds: [], // Array of selected clip IDs
  
  // Clip counter for unique IDs
  clipCounter: 1,
  
  // Transition counter for unique IDs
  transitionCounter: 1,
  
  // Snapping settings
  snappingEnabled: true,
  snappingThreshold: 10, // pixels - distance at which snapping activates
  
  // Active snap indicator (for visual feedback)
  activeSnapTime: null, // Time position being snapped to (null = no active snap)
  
  // Ripple edit mode - when enabled, moving/trimming clips shifts subsequent clips
  rippleEditMode: false,
  
  // In/Out points for three-point editing
  inPoint: null, // Timeline in-point (seconds)
  outPoint: null, // Timeline out-point (seconds)
  
  // Undo/Redo history
  history: [], // Array of past states
  historyIndex: -1, // Current position in history (-1 means at present state)
  
  /**
   * Save current state to history (call before making changes)
   */
  saveToHistory: () => {
    const state = get()
    const snapshot = {
      clips: JSON.parse(JSON.stringify(state.clips)),
      tracks: JSON.parse(JSON.stringify(state.tracks)),
      transitions: JSON.parse(JSON.stringify(state.transitions)),
      clipCounter: state.clipCounter,
      transitionCounter: state.transitionCounter,
    }
    
    set((state) => {
      // If we're not at the end of history, truncate the "future" states
      let newHistory = state.historyIndex >= 0 
        ? state.history.slice(0, state.historyIndex + 1)
        : [...state.history]
      
      // Add current state to history
      newHistory.push(snapshot)
      
      // Limit history size
      if (newHistory.length > MAX_HISTORY_SIZE) {
        newHistory = newHistory.slice(newHistory.length - MAX_HISTORY_SIZE)
      }
      
      return {
        history: newHistory,
        historyIndex: newHistory.length - 1
      }
    })
  },
  
  /**
   * Undo - restore previous state
   */
  undo: () => {
    const state = get()
    
    // If historyIndex is -1, we need to save current state first before undoing
    if (state.historyIndex === -1 && state.history.length > 0) {
      // Save current state so we can redo back to it
      const currentSnapshot = {
        clips: JSON.parse(JSON.stringify(state.clips)),
        tracks: JSON.parse(JSON.stringify(state.tracks)),
        transitions: JSON.parse(JSON.stringify(state.transitions)),
        clipCounter: state.clipCounter,
        transitionCounter: state.transitionCounter,
      }
      
      const lastHistoryState = state.history[state.history.length - 1]
      
      set({
        clips: lastHistoryState.clips,
        tracks: lastHistoryState.tracks,
        transitions: lastHistoryState.transitions,
        clipCounter: lastHistoryState.clipCounter,
        transitionCounter: lastHistoryState.transitionCounter,
        history: [...state.history, currentSnapshot],
        historyIndex: state.history.length - 1,
        selectedClipIds: [] // Clear selection on undo
      })
      return true
    }
    
    // Normal undo - go back in history
    if (state.historyIndex > 0) {
      const prevState = state.history[state.historyIndex - 1]
      set({
        clips: prevState.clips,
        tracks: prevState.tracks,
        transitions: prevState.transitions,
        clipCounter: prevState.clipCounter,
        transitionCounter: prevState.transitionCounter,
        historyIndex: state.historyIndex - 1,
        selectedClipIds: [] // Clear selection on undo
      })
      return true
    }
    
    return false // Nothing to undo
  },
  
  /**
   * Redo - restore next state
   */
  redo: () => {
    const state = get()
    
    if (state.historyIndex >= 0 && state.historyIndex < state.history.length - 1) {
      const nextState = state.history[state.historyIndex + 1]
      set({
        clips: nextState.clips,
        tracks: nextState.tracks,
        transitions: nextState.transitions,
        clipCounter: nextState.clipCounter,
        transitionCounter: nextState.transitionCounter,
        historyIndex: state.historyIndex + 1,
        selectedClipIds: [] // Clear selection on redo
      })
      return true
    }
    
    return false // Nothing to redo
  },
  
  /**
   * Check if undo is available
   */
  canUndo: () => {
    const state = get()
    return state.history.length > 0 && (state.historyIndex === -1 || state.historyIndex > 0)
  },
  
  /**
   * Check if redo is available
   */
  canRedo: () => {
    const state = get()
    return state.historyIndex >= 0 && state.historyIndex < state.history.length - 1
  },
  
  /**
   * Clear history (e.g., on project clear)
   */
  clearHistory: () => {
    set({ history: [], historyIndex: -1 })
  },

  /**
   * Handle clip overlaps on the same track (NLE overwrite behavior)
   * When a clip is placed, it cuts/trims any overlapping clips on the same track
   */
  resolveOverlaps: (trackId, newClipId, newStartTime, newDuration) => {
    const state = get()
    const newEndTime = newStartTime + newDuration
    
    // Find all clips on the same track that overlap with the new clip (excluding itself)
    const overlappingClips = state.clips.filter(clip => 
      clip.trackId === trackId &&
      clip.id !== newClipId &&
      clip.startTime < newEndTime &&
      clip.startTime + clip.duration > newStartTime
    )
    
    if (overlappingClips.length === 0) return { clips: state.clips, addedCount: 0 }
    
    let updatedClips = [...state.clips]
    let clipsToRemove = []
    let clipsToAdd = []
    
    overlappingClips.forEach(clip => {
      const clipEnd = clip.startTime + clip.duration
      
      // Case 1: New clip completely covers existing clip -> remove existing
      if (newStartTime <= clip.startTime && newEndTime >= clipEnd) {
        clipsToRemove.push(clip.id)
      }
      // Case 2: New clip cuts the beginning of existing clip -> trim existing clip's start
      else if (newStartTime <= clip.startTime && newEndTime < clipEnd) {
        const trimAmount = newEndTime - clip.startTime
        const idx = updatedClips.findIndex(c => c.id === clip.id)
        if (idx !== -1) {
          updatedClips[idx] = {
            ...updatedClips[idx],
            startTime: newEndTime,
            duration: clipEnd - newEndTime,
            trimStart: (clip.trimStart || 0) + trimAmount
          }
        }
      }
      // Case 3: New clip cuts the end of existing clip -> trim existing clip's end
      else if (newStartTime > clip.startTime && newEndTime >= clipEnd) {
        const idx = updatedClips.findIndex(c => c.id === clip.id)
        if (idx !== -1) {
          updatedClips[idx] = {
            ...updatedClips[idx],
            duration: newStartTime - clip.startTime,
            trimEnd: (clip.trimStart || 0) + (newStartTime - clip.startTime)
          }
        }
      }
      // Case 4: New clip is in the middle of existing clip -> split into two clips
      else if (newStartTime > clip.startTime && newEndTime < clipEnd) {
        // Trim the existing clip to end at newStartTime
        const idx = updatedClips.findIndex(c => c.id === clip.id)
        if (idx !== -1) {
          const firstPartDuration = newStartTime - clip.startTime
          updatedClips[idx] = {
            ...updatedClips[idx],
            duration: firstPartDuration,
            trimEnd: (clip.trimStart || 0) + firstPartDuration
          }
          
          // Create a second clip for the part after the new clip
          const secondPartStart = newEndTime
          const secondPartDuration = clipEnd - newEndTime
          const secondPartTrimStart = (clip.trimStart || 0) + (newEndTime - clip.startTime)
          
          clipsToAdd.push({
            ...clip,
            id: `clip-${state.clipCounter + clipsToAdd.length + 1}`,
            startTime: secondPartStart,
            duration: secondPartDuration,
            trimStart: secondPartTrimStart,
            trimEnd: clip.trimEnd || clip.sourceDuration
          })
        }
      }
    })
    
    // Remove fully covered clips
    updatedClips = updatedClips.filter(c => !clipsToRemove.includes(c.id))
    
    // Add split clips
    updatedClips = [...updatedClips, ...clipsToAdd]
    
    return { clips: updatedClips, addedCount: clipsToAdd.length }
  },

  /**
   * Add a clip to the timeline
   */
  addClip: (trackId, asset, startTime = null) => {
    const state = get()
    const track = state.tracks.find(t => t.id === trackId)
    if (!track) return null
    
    // Save to history before modifying
    get().saveToHistory()
    
    // Find the end of existing clips on this track if no start time specified
    const trackClips = state.clips.filter(c => c.trackId === trackId)
    const calculatedStartTime = startTime ?? trackClips.reduce((max, clip) => 
      Math.max(max, clip.startTime + clip.duration), 0
    )
    
    const sourceDuration = asset.settings?.duration || 5
    
    const newClip = {
      id: `clip-${state.clipCounter}`,
      trackId,
      assetId: asset.id,
      name: asset.name,
      startTime: calculatedStartTime,
      duration: sourceDuration, // Visible duration on timeline
      sourceDuration: sourceDuration, // Original video duration
      trimStart: 0, // In-point (seconds from source start)
      trimEnd: sourceDuration, // Out-point (seconds from source start)
      color: track.type === 'video' ? getVideoColor(state.clipCounter) : getAudioColor(track.id),
      type: asset.type,
      url: asset.url,
      thumbnail: asset.url, // For video clips
      // 2D Transform properties (NLE-style)
      transform: {
        positionX: 0,        // X position offset (pixels, 0 = centered)
        positionY: 0,        // Y position offset (pixels, 0 = centered)
        scaleX: 100,         // Horizontal scale (percentage, 100 = original)
        scaleY: 100,         // Vertical scale (percentage, 100 = original)
        scaleLinked: true,   // Link X and Y scale together
        rotation: 0,         // Rotation angle (degrees, -180 to 180)
        anchorX: 50,         // Anchor point X (percentage, 50 = center)
        anchorY: 50,         // Anchor point Y (percentage, 50 = center)
        opacity: 100,        // Opacity (percentage, 0-100)
        flipH: false,        // Horizontal flip
        flipV: false,        // Vertical flip
        // Crop (percentage from each edge)
        cropTop: 0,
        cropBottom: 0,
        cropLeft: 0,
        cropRight: 0,
      },
    }
    
    // Resolve overlaps with existing clips on the same track (NLE overwrite behavior)
    const { clips: updatedClips, addedCount } = get().resolveOverlaps(
      trackId, 
      newClip.id, 
      calculatedStartTime, 
      sourceDuration
    )
    
    set((state) => ({
      clips: [...updatedClips, newClip],
      clipCounter: state.clipCounter + 1 + addedCount,
      selectedClipIds: [newClip.id],
      // Extend timeline if needed
      duration: Math.max(state.duration, calculatedStartTime + newClip.duration + 10)
    }))
    
    return newClip
  },

  /**
   * Add a text clip to the timeline
   * @param {string} trackId - Target video track ID
   * @param {object} textOptions - Text configuration options
   * @param {number|null} startTime - Start time (null = end of existing clips)
   */
  addTextClip: (trackId, textOptions = {}, startTime = null) => {
    const state = get()
    const track = state.tracks.find(t => t.id === trackId)
    if (!track || track.type !== 'video') return null
    
    // Save to history before modifying
    get().saveToHistory()
    
    // Find the end of existing clips on this track if no start time specified
    const trackClips = state.clips.filter(c => c.trackId === trackId)
    const calculatedStartTime = startTime ?? trackClips.reduce((max, clip) => 
      Math.max(max, clip.startTime + clip.duration), 0
    )
    
    // Default text properties
    const defaultText = {
      text: textOptions.text || 'Sample Text',
      fontFamily: textOptions.fontFamily || 'Inter',
      fontSize: textOptions.fontSize || 64,
      fontWeight: textOptions.fontWeight || 'bold',
      fontStyle: textOptions.fontStyle || 'normal',
      textColor: textOptions.textColor || '#FFFFFF',
      backgroundColor: textOptions.backgroundColor || 'transparent',
      backgroundOpacity: textOptions.backgroundOpacity || 0,
      backgroundPadding: textOptions.backgroundPadding || 20,
      textAlign: textOptions.textAlign || 'center',
      verticalAlign: textOptions.verticalAlign || 'center',
      strokeColor: textOptions.strokeColor || '#000000',
      strokeWidth: textOptions.strokeWidth || 0,
      letterSpacing: textOptions.letterSpacing || 0,
      lineHeight: textOptions.lineHeight || 1.2,
      shadow: textOptions.shadow || false,
      shadowColor: textOptions.shadowColor || 'rgba(0,0,0,0.5)',
      shadowBlur: textOptions.shadowBlur || 4,
      shadowOffsetX: textOptions.shadowOffsetX || 2,
      shadowOffsetY: textOptions.shadowOffsetY || 2,
    }
    
    const duration = textOptions.duration || 5
    
    const newClip = {
      id: `clip-${state.clipCounter}`,
      trackId,
      assetId: null, // Text clips don't have asset references
      name: defaultText.text.substring(0, 20) + (defaultText.text.length > 20 ? '...' : ''),
      startTime: calculatedStartTime,
      duration: duration,
      sourceDuration: duration,
      trimStart: 0,
      trimEnd: duration,
      color: '#F59E0B', // Amber color for text clips
      type: 'text',
      url: null,
      thumbnail: null,
      // Text-specific properties
      textProperties: defaultText,
      // 2D Transform properties (same as video clips)
      transform: {
        positionX: 0,
        positionY: 0,
        scaleX: 100,
        scaleY: 100,
        scaleLinked: true,
        rotation: 0,
        anchorX: 50,
        anchorY: 50,
        opacity: 100,
        flipH: false,
        flipV: false,
        cropTop: 0,
        cropBottom: 0,
        cropLeft: 0,
        cropRight: 0,
      },
    }
    
    // Resolve overlaps with existing clips on the same track
    const { clips: updatedClips, addedCount } = get().resolveOverlaps(
      trackId, 
      newClip.id, 
      calculatedStartTime, 
      duration
    )
    
    set((state) => ({
      clips: [...updatedClips, newClip],
      clipCounter: state.clipCounter + 1 + addedCount,
      selectedClipIds: [newClip.id],
      duration: Math.max(state.duration, calculatedStartTime + newClip.duration + 10)
    }))
    
    return newClip
  },

  /**
   * Update text clip properties
   * @param {string} clipId - The text clip to update
   * @param {object} textUpdates - Partial text properties object
   * @param {boolean} saveHistory - Whether to save to history
   */
  updateTextProperties: (clipId, textUpdates, saveHistory = false) => {
    if (saveHistory) {
      get().saveToHistory()
    }
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId || clip.type !== 'text') return clip
        
        const currentText = clip.textProperties || {}
        const updatedText = { ...currentText, ...textUpdates }
        
        // Update clip name if text content changed
        const newName = textUpdates.text 
          ? textUpdates.text.substring(0, 20) + (textUpdates.text.length > 20 ? '...' : '')
          : clip.name
        
        return {
          ...clip,
          name: newName,
          textProperties: updatedText
        }
      })
    }))
  },

  /**
   * Remove a clip (or multiple clips if they're selected)
   */
  removeClip: (clipId) => {
    // Save to history before modifying
    get().saveToHistory()
    
    set((state) => ({
      clips: state.clips.filter(c => c.id !== clipId),
      selectedClipIds: state.selectedClipIds.filter(id => id !== clipId)
    }))
  },

  /**
   * Remove all selected clips
   */
  removeSelectedClips: () => {
    // Save to history before modifying
    get().saveToHistory()
    
    set((state) => ({
      clips: state.clips.filter(c => !state.selectedClipIds.includes(c.id)),
      selectedClipIds: []
    }))
  },

  /**
   * Move a clip to a new position/track
   * @param {string} clipId - The clip to move
   * @param {string} newTrackId - The target track ID
   * @param {number} newStartTime - The new start time
   * @param {boolean} resolveOverlaps - Whether to cut overlapping clips (default: false, set true on drag end)
   */
  moveClip: (clipId, newTrackId, newStartTime, resolveOverlaps = false) => {
    const state = get()
    const clip = state.clips.find(c => c.id === clipId)
    if (!clip) return
    
    // Save to history only on drag end (when resolving overlaps) to avoid flooding history during drag
    if (resolveOverlaps) {
      get().saveToHistory()
    }
    
    const delta = newStartTime - clip.startTime
    const finalStartTime = Math.max(0, newStartTime)
    
    set((state) => {
      // First, update the clip position
      let updatedClips = state.clips.map(c => 
        c.id === clipId 
          ? { ...c, trackId: newTrackId, startTime: finalStartTime }
          : c
      )
      
      // If ripple mode is on and we're moving forward, shift subsequent clips
      if (state.rippleEditMode && delta !== 0) {
        updatedClips = updatedClips.map(c => {
          // Only affect clips on the same track that come after the moved clip
          if (c.id !== clipId && c.trackId === clip.trackId && c.startTime > clip.startTime) {
            return { ...c, startTime: Math.max(0, c.startTime + delta) }
          }
          return c
        })
      }
      
      // Only resolve overlaps if explicitly requested (on drag end)
      if (resolveOverlaps) {
        const movedClip = updatedClips.find(c => c.id === clipId)
        if (movedClip) {
          const newEndTime = finalStartTime + movedClip.duration
          
          // Find all clips on the same track that overlap (excluding the moved clip)
          const overlappingClips = updatedClips.filter(c => 
            c.trackId === newTrackId &&
            c.id !== clipId &&
            c.startTime < newEndTime &&
            c.startTime + c.duration > finalStartTime
          )
          
          if (overlappingClips.length > 0) {
            let clipsToRemove = []
            let clipsToAdd = []
            
            overlappingClips.forEach(existingClip => {
              const clipEnd = existingClip.startTime + existingClip.duration
              
              // Case 1: Moved clip completely covers existing clip -> remove existing
              if (finalStartTime <= existingClip.startTime && newEndTime >= clipEnd) {
                clipsToRemove.push(existingClip.id)
              }
              // Case 2: Moved clip cuts the beginning of existing clip -> trim existing clip's start
              else if (finalStartTime <= existingClip.startTime && newEndTime < clipEnd) {
                const trimAmount = newEndTime - existingClip.startTime
                const idx = updatedClips.findIndex(c => c.id === existingClip.id)
                if (idx !== -1) {
                  updatedClips[idx] = {
                    ...updatedClips[idx],
                    startTime: newEndTime,
                    duration: clipEnd - newEndTime,
                    trimStart: (existingClip.trimStart || 0) + trimAmount
                  }
                }
              }
              // Case 3: Moved clip cuts the end of existing clip -> trim existing clip's end
              else if (finalStartTime > existingClip.startTime && newEndTime >= clipEnd) {
                const idx = updatedClips.findIndex(c => c.id === existingClip.id)
                if (idx !== -1) {
                  updatedClips[idx] = {
                    ...updatedClips[idx],
                    duration: finalStartTime - existingClip.startTime,
                    trimEnd: (existingClip.trimStart || 0) + (finalStartTime - existingClip.startTime)
                  }
                }
              }
              // Case 4: Moved clip is in the middle of existing clip -> split into two clips
              else if (finalStartTime > existingClip.startTime && newEndTime < clipEnd) {
                // Trim the existing clip to end at finalStartTime
                const idx = updatedClips.findIndex(c => c.id === existingClip.id)
                if (idx !== -1) {
                  const firstPartDuration = finalStartTime - existingClip.startTime
                  updatedClips[idx] = {
                    ...updatedClips[idx],
                    duration: firstPartDuration,
                    trimEnd: (existingClip.trimStart || 0) + firstPartDuration
                  }
                  
                  // Create a second clip for the part after the moved clip
                  const secondPartStart = newEndTime
                  const secondPartDuration = clipEnd - newEndTime
                  const secondPartTrimStart = (existingClip.trimStart || 0) + (newEndTime - existingClip.startTime)
                  
                  clipsToAdd.push({
                    ...existingClip,
                    id: `clip-${state.clipCounter + clipsToAdd.length + 1}`,
                    startTime: secondPartStart,
                    duration: secondPartDuration,
                    trimStart: secondPartTrimStart,
                    trimEnd: existingClip.trimEnd || existingClip.sourceDuration
                  })
                }
              }
            })
            
            // Remove fully covered clips
            updatedClips = updatedClips.filter(c => !clipsToRemove.includes(c.id))
            
            // Add split clips
            updatedClips = [...updatedClips, ...clipsToAdd]
            
            // Update clip counter if we added clips
            if (clipsToAdd.length > 0) {
              return { 
                clips: updatedClips,
                clipCounter: state.clipCounter + clipsToAdd.length
              }
            }
          }
        }
      }
      
      return { clips: updatedClips }
    })
  },

  /**
   * Move all selected clips by a delta amount
   * @param {number} deltaTime - The time delta to move by
   * @param {string|null} newTrackId - Optional new track ID
   * @param {boolean} resolveOverlaps - Whether to cut overlapping clips (default: false, set true on drag end)
   */
  moveSelectedClips: (deltaTime, newTrackId = null, resolveOverlaps = false) => {
    // Save to history only on drag end (when resolving overlaps) to avoid flooding history during drag
    if (resolveOverlaps) {
      get().saveToHistory()
    }
    
    set((state) => {
      // First, move all selected clips
      let updatedClips = state.clips.map(clip => {
        if (state.selectedClipIds.includes(clip.id)) {
          return {
            ...clip,
            startTime: Math.max(0, clip.startTime + deltaTime),
            trackId: newTrackId !== null ? newTrackId : clip.trackId
          }
        }
        return clip
      })
      
      // Only resolve overlaps if explicitly requested (on drag end)
      if (!resolveOverlaps) {
        return { clips: updatedClips }
      }
      
      // Now resolve overlaps for each moved clip (NLE overwrite behavior)
      // This is done after all clips are moved to handle them as a group
      let clipsToRemove = []
      let clipsToAdd = []
      let addedCounter = 0
      
      state.selectedClipIds.forEach(movedClipId => {
        const movedClip = updatedClips.find(c => c.id === movedClipId)
        if (!movedClip) return
        
        const newStartTime = movedClip.startTime
        const newEndTime = newStartTime + movedClip.duration
        const trackId = movedClip.trackId
        
        // Find all clips on the same track that overlap (excluding moved/selected clips)
        const overlappingClips = updatedClips.filter(c => 
          c.trackId === trackId &&
          !state.selectedClipIds.includes(c.id) &&
          !clipsToRemove.includes(c.id) &&
          c.startTime < newEndTime &&
          c.startTime + c.duration > newStartTime
        )
        
        overlappingClips.forEach(existingClip => {
          const clipEnd = existingClip.startTime + existingClip.duration
          
          // Case 1: Moved clip completely covers existing clip -> remove existing
          if (newStartTime <= existingClip.startTime && newEndTime >= clipEnd) {
            clipsToRemove.push(existingClip.id)
          }
          // Case 2: Moved clip cuts the beginning of existing clip
          else if (newStartTime <= existingClip.startTime && newEndTime < clipEnd) {
            const trimAmount = newEndTime - existingClip.startTime
            const idx = updatedClips.findIndex(c => c.id === existingClip.id)
            if (idx !== -1) {
              updatedClips[idx] = {
                ...updatedClips[idx],
                startTime: newEndTime,
                duration: clipEnd - newEndTime,
                trimStart: (existingClip.trimStart || 0) + trimAmount
              }
            }
          }
          // Case 3: Moved clip cuts the end of existing clip
          else if (newStartTime > existingClip.startTime && newEndTime >= clipEnd) {
            const idx = updatedClips.findIndex(c => c.id === existingClip.id)
            if (idx !== -1) {
              updatedClips[idx] = {
                ...updatedClips[idx],
                duration: newStartTime - existingClip.startTime,
                trimEnd: (existingClip.trimStart || 0) + (newStartTime - existingClip.startTime)
              }
            }
          }
          // Case 4: Moved clip is in the middle of existing clip -> split
          else if (newStartTime > existingClip.startTime && newEndTime < clipEnd) {
            const idx = updatedClips.findIndex(c => c.id === existingClip.id)
            if (idx !== -1) {
              const firstPartDuration = newStartTime - existingClip.startTime
              updatedClips[idx] = {
                ...updatedClips[idx],
                duration: firstPartDuration,
                trimEnd: (existingClip.trimStart || 0) + firstPartDuration
              }
              
              const secondPartStart = newEndTime
              const secondPartDuration = clipEnd - newEndTime
              const secondPartTrimStart = (existingClip.trimStart || 0) + (newEndTime - existingClip.startTime)
              
              clipsToAdd.push({
                ...existingClip,
                id: `clip-${state.clipCounter + addedCounter + 1}`,
                startTime: secondPartStart,
                duration: secondPartDuration,
                trimStart: secondPartTrimStart,
                trimEnd: existingClip.trimEnd || existingClip.sourceDuration
              })
              addedCounter++
            }
          }
        })
      })
      
      // Remove fully covered clips
      updatedClips = updatedClips.filter(c => !clipsToRemove.includes(c.id))
      
      // Add split clips
      updatedClips = [...updatedClips, ...clipsToAdd]
      
      return { 
        clips: updatedClips,
        clipCounter: clipsToAdd.length > 0 ? state.clipCounter + clipsToAdd.length : state.clipCounter
      }
    })
  },

  /**
   * Resize a clip
   */
  resizeClip: (clipId, newDuration) => {
    set((state) => ({
      clips: state.clips.map(clip =>
        clip.id === clipId
          ? { ...clip, duration: Math.max(0.5, newDuration) }
          : clip
      )
    }))
  },

  /**
   * Update clip trim properties directly (for interactive trimming)
   * @param {string} clipId - The clip to update
   * @param {object} updates - Object with properties to update (startTime, duration, trimStart, trimEnd)
   */
  updateClipTrim: (clipId, updates) => {
    set((state) => ({
      clips: state.clips.map(clip =>
        clip.id === clipId
          ? { ...clip, ...updates }
          : clip
      )
    }))
  },

  /**
   * Update clip transform properties (position, scale, rotation, flip, crop, opacity)
   * @param {string} clipId - The clip to update
   * @param {object} transformUpdates - Partial transform object with properties to update
   * @param {boolean} saveHistory - Whether to save to history (default: false for realtime sliders)
   */
  updateClipTransform: (clipId, transformUpdates, saveHistory = false) => {
    if (saveHistory) {
      get().saveToHistory()
    }
    
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        // Ensure transform object exists (for legacy clips)
        const currentTransform = clip.transform || {
          positionX: 0, positionY: 0,
          scaleX: 100, scaleY: 100, scaleLinked: true,
          rotation: 0, anchorX: 50, anchorY: 50, opacity: 100,
          flipH: false, flipV: false,
          cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
        }
        
        // Handle linked scale: if scaleLinked and one scale changed, update both
        let finalUpdates = { ...transformUpdates }
        if (currentTransform.scaleLinked) {
          if ('scaleX' in transformUpdates && !('scaleY' in transformUpdates)) {
            finalUpdates.scaleY = transformUpdates.scaleX
          } else if ('scaleY' in transformUpdates && !('scaleX' in transformUpdates)) {
            finalUpdates.scaleX = transformUpdates.scaleY
          }
        }
        
        return {
          ...clip,
          transform: {
            ...currentTransform,
            ...finalUpdates
          }
        }
      })
    }))
  },

  /**
   * Reset clip transform to defaults
   * @param {string} clipId - The clip to reset
   */
  resetClipTransform: (clipId) => {
    get().saveToHistory()
    
    set((state) => ({
      clips: state.clips.map(clip =>
        clip.id === clipId
          ? {
              ...clip,
              transform: {
                positionX: 0, positionY: 0,
                scaleX: 100, scaleY: 100, scaleLinked: true,
                rotation: 0, anchorX: 50, anchorY: 50, opacity: 100,
                flipH: false, flipV: false,
                cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
              }
            }
          : clip
      )
    }))
  },

  /**
   * Get the currently selected clip (first selected)
   */
  getSelectedClip: () => {
    const state = get()
    if (state.selectedClipIds.length === 0) return null
    return state.clips.find(c => c.id === state.selectedClipIds[0]) || null
  },

  /**
   * Trim a clip from the left (adjust in-point)
   */
  trimClipStart: (clipId, deltaTime) => {
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        const newTrimStart = Math.max(0, Math.min(clip.trimEnd - 0.5, clip.trimStart + deltaTime))
        const trimDelta = newTrimStart - clip.trimStart
        
        return {
          ...clip,
          trimStart: newTrimStart,
          startTime: clip.startTime + trimDelta,
          duration: clip.duration - trimDelta
        }
      })
    }))
  },

  /**
   * Trim a clip from the right (adjust out-point)
   */
  trimClipEnd: (clipId, deltaTime) => {
    set((state) => ({
      clips: state.clips.map(clip => {
        if (clip.id !== clipId) return clip
        
        const newTrimEnd = Math.max(clip.trimStart + 0.5, Math.min(clip.sourceDuration, clip.trimEnd + deltaTime))
        const newDuration = newTrimEnd - clip.trimStart
        
        return {
          ...clip,
          trimEnd: newTrimEnd,
          duration: newDuration
        }
      })
    }))
  },

  /**
   * Add a transition between two clips
   */
  addTransition: (clipAId, clipBId, transitionType = 'dissolve', duration = 0.5) => {
    const state = get()
    const clipA = state.clips.find(c => c.id === clipAId)
    const clipB = state.clips.find(c => c.id === clipBId)
    
    if (!clipA || !clipB) return null
    
    // Check if transition already exists
    const existingTransition = state.transitions.find(
      t => (t.clipAId === clipAId && t.clipBId === clipBId) ||
           (t.clipAId === clipBId && t.clipBId === clipAId)
    )
    if (existingTransition) return existingTransition
    
    // Save to history before modifying
    get().saveToHistory()
    
    const newTransition = {
      id: `transition-${state.transitionCounter}`,
      clipAId,
      clipBId,
      type: transitionType, // 'dissolve', 'fade', 'wipe', etc.
      duration: duration, // transition duration in seconds
    }
    
    set((state) => ({
      transitions: [...state.transitions, newTransition],
      transitionCounter: state.transitionCounter + 1
    }))
    
    return newTransition
  },

  /**
   * Remove a transition
   */
  removeTransition: (transitionId) => {
    // Save to history before modifying
    get().saveToHistory()
    
    set((state) => ({
      transitions: state.transitions.filter(t => t.id !== transitionId)
    }))
  },

  /**
   * Update transition duration
   */
  updateTransition: (transitionId, updates) => {
    set((state) => ({
      transitions: state.transitions.map(t =>
        t.id === transitionId ? { ...t, ...updates } : t
      )
    }))
  },

  /**
   * Get the active video clip at a specific time (topmost video track)
   */
  getActiveClipAtTime: (time) => {
    const state = get()
    // Get video tracks in reverse order (top track = highest priority)
    const videoTracks = state.tracks.filter(t => t.type === 'video' && t.visible && !t.muted)
    
    for (const track of videoTracks) {
      const clip = state.clips.find(c => 
        c.trackId === track.id &&
        time >= c.startTime &&
        time < c.startTime + c.duration
      )
      if (clip) return clip
    }
    return null
  },

  /**
   * Get all active clips at a specific time (for compositing)
   */
  getActiveClipsAtTime: (time) => {
    const state = get()
    const activeClips = []
    
    for (const track of state.tracks) {
      if (!track.visible || track.muted) continue
      
      const clip = state.clips.find(c =>
        c.trackId === track.id &&
        time >= c.startTime &&
        time < c.startTime + c.duration
      )
      if (clip) {
        activeClips.push({ clip, track })
      }
    }
    return activeClips
  },

  /**
   * Get transition info at a specific time (if in transition zone)
   */
  getTransitionAtTime: (time) => {
    const state = get()
    
    for (const transition of state.transitions) {
      const clipA = state.clips.find(c => c.id === transition.clipAId)
      const clipB = state.clips.find(c => c.id === transition.clipBId)
      
      if (!clipA || !clipB) continue
      
      // Transition happens at the overlap point
      const transitionStart = clipB.startTime
      const transitionEnd = transitionStart + transition.duration
      
      if (time >= transitionStart && time < transitionEnd) {
        const progress = (time - transitionStart) / transition.duration
        return { transition, clipA, clipB, progress }
      }
    }
    return null
  },

  /**
   * Get the end time of the last clip
   */
  getTimelineEndTime: () => {
    const state = get()
    if (state.clips.length === 0) return 0
    return Math.max(...state.clips.map(c => c.startTime + c.duration))
  },

  /**
   * Select a clip (supports multi-select modes)
   * @param {string} clipId - The clip to select
   * @param {object} options - Selection options
   * @param {boolean} options.addToSelection - Add to existing selection (Shift+click)
   * @param {boolean} options.toggleSelection - Toggle this clip in selection (Ctrl/Cmd+click)
   */
  selectClip: (clipId, options = {}) => {
    const { addToSelection = false, toggleSelection = false } = options
    
    set((state) => {
      if (toggleSelection) {
        // Ctrl/Cmd+click: toggle this clip in selection
        const isSelected = state.selectedClipIds.includes(clipId)
        if (isSelected) {
          return { selectedClipIds: state.selectedClipIds.filter(id => id !== clipId) }
        } else {
          return { selectedClipIds: [...state.selectedClipIds, clipId] }
        }
      } else if (addToSelection) {
        // Shift+click: add to selection (or range select)
        if (state.selectedClipIds.includes(clipId)) {
          return state // Already selected
        }
        return { selectedClipIds: [...state.selectedClipIds, clipId] }
      } else {
        // Normal click: replace selection
        return { selectedClipIds: [clipId] }
      }
    })
  },

  /**
   * Clear all selections
   */
  clearSelection: () => {
    set({ selectedClipIds: [] })
  },

  /**
   * Select multiple clips at once
   */
  selectClips: (clipIds) => {
    set({ selectedClipIds: clipIds })
  },

  /**
   * Check if a clip is selected
   */
  isClipSelected: (clipId) => {
    return get().selectedClipIds.includes(clipId)
  },

  /**
   * Set playhead position
   */
  setPlayheadPosition: (position) => {
    set({ playheadPosition: Math.max(0, position) })
  },

  /**
   * Toggle play/pause
   */
  togglePlay: () => {
    set((state) => ({ 
      isPlaying: !state.isPlaying,
      playbackRate: state.isPlaying ? state.playbackRate : 1, // Reset to 1x when starting
      shuttleMode: false
    }))
  },

  /**
   * Set playback rate (for JKL shuttle)
   */
  setPlaybackRate: (rate) => {
    set({ playbackRate: rate })
  },

  /**
   * JKL Shuttle: J key - play reverse (multiple presses increase speed)
   */
  shuttleReverse: () => {
    set((state) => {
      const speeds = [-1, -2, -4, -8]
      
      if (!state.isPlaying || state.playbackRate > 0) {
        // Not playing or playing forward - start reverse at 1x
        return { isPlaying: true, playbackRate: -1, shuttleMode: true }
      }
      
      // Already playing reverse - increase speed
      const currentIndex = speeds.indexOf(state.playbackRate)
      const nextIndex = Math.min(currentIndex + 1, speeds.length - 1)
      return { playbackRate: speeds[nextIndex], shuttleMode: true }
    })
  },

  /**
   * JKL Shuttle: K key - pause
   */
  shuttlePause: () => {
    set({ isPlaying: false, playbackRate: 1, shuttleMode: false })
  },

  /**
   * JKL Shuttle: L key - play forward (multiple presses increase speed)
   */
  shuttleForward: () => {
    set((state) => {
      const speeds = [1, 2, 4, 8]
      
      if (!state.isPlaying || state.playbackRate < 0) {
        // Not playing or playing reverse - start forward at 1x
        return { isPlaying: true, playbackRate: 1, shuttleMode: true }
      }
      
      // Already playing forward - increase speed
      const currentIndex = speeds.indexOf(state.playbackRate)
      const nextIndex = Math.min(currentIndex + 1, speeds.length - 1)
      return { playbackRate: speeds[nextIndex], shuttleMode: true }
    })
  },

  /**
   * JKL Shuttle: K+J or K+L - slow shuttle (hold K and tap J or L)
   */
  shuttleSlow: (direction) => {
    set((state) => {
      const rate = direction === 'reverse' ? -0.5 : 0.5
      return { isPlaying: true, playbackRate: rate, shuttleMode: true }
    })
  },

  /**
   * Set playback loop mode
   * @param {'normal' | 'loop' | 'loop-in-out' | 'ping-pong'} mode
   */
  setLoopMode: (mode) => {
    set({ loopMode: mode })
  },

  /**
   * Set zoom level (20% - 2000%)
   */
  setZoom: (zoom) => {
    set({ zoom: Math.max(20, Math.min(2000, zoom)) })
  },

  /**
   * Toggle track mute
   */
  toggleTrackMute: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId ? { ...track, muted: !track.muted } : track
      )
    }))
  },

  /**
   * Toggle track lock
   */
  toggleTrackLock: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId ? { ...track, locked: !track.locked } : track
      )
    }))
  },

  /**
   * Toggle track visibility
   */
  toggleTrackVisibility: (trackId) => {
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId ? { ...track, visible: !track.visible } : track
      )
    }))
  },

  /**
   * Add a new track
   */
  addTrack: (type) => {
    const state = get()
    const existingTracks = state.tracks.filter(t => t.type === type)
    
    // Generate unique ID by finding the highest existing number
    let maxNum = 0
    existingTracks.forEach(t => {
      const match = t.id.match(new RegExp(`^${type}-(\\d+)$`))
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1]))
      }
    })
    
    const newTrack = {
      id: `${type}-${maxNum + 1}`,
      name: `${type === 'video' ? 'Video' : 'Audio'} ${maxNum + 1}`,
      type,
      muted: false,
      locked: false,
      visible: true
    }
    
    set((state) => {
      // For video tracks, add to the beginning (top)
      // For audio tracks, add to the end (bottom)
      if (type === 'video') {
        const videoTracks = state.tracks.filter(t => t.type === 'video')
        const audioTracks = state.tracks.filter(t => t.type === 'audio')
        return {
          tracks: [newTrack, ...videoTracks, ...audioTracks]
        }
      } else {
        return {
          tracks: [...state.tracks, newTrack]
        }
      }
    })
    
    return newTrack
  },

  /**
   * Remove a track (and all its clips)
   * Prevents removing the last video or audio track
   */
  removeTrack: (trackId) => {
    const state = get()
    const track = state.tracks.find(t => t.id === trackId)
    if (!track) return false
    
    // Count tracks of this type
    const tracksOfType = state.tracks.filter(t => t.type === track.type)
    
    // Prevent removing the last track of a type
    if (tracksOfType.length <= 1) {
      return false
    }
    
    // Save to history before modifying
    get().saveToHistory()
    
    set((state) => ({
      tracks: state.tracks.filter(t => t.id !== trackId),
      // Also remove all clips on this track
      clips: state.clips.filter(c => c.trackId !== trackId),
      // Clear selection if any selected clips were on this track
      selectedClipIds: state.selectedClipIds.filter(id => {
        const clip = state.clips.find(c => c.id === id)
        return clip && clip.trackId !== trackId
      })
    }))
    
    return true
  },

  /**
   * Rename a track
   */
  renameTrack: (trackId, newName) => {
    if (!newName || newName.trim() === '') return false
    
    // Save to history before modifying
    get().saveToHistory()
    
    set((state) => ({
      tracks: state.tracks.map(track =>
        track.id === trackId ? { ...track, name: newName.trim() } : track
      )
    }))
    
    return true
  },

  /**
   * Get clip at specific time on specific track
   */
  getClipAtTime: (trackId, time) => {
    const state = get()
    return state.clips.find(clip => 
      clip.trackId === trackId &&
      time >= clip.startTime &&
      time < clip.startTime + clip.duration
    )
  },

  /**
   * Clear all project data (for "New Project")
   */
  clearProject: () => {
    set({
      duration: 60,
      zoom: 100,
      playheadPosition: 0,
      isPlaying: false,
      playbackRate: 1,
      shuttleMode: false,
      loopMode: 'normal',
      tracks: [
        { id: 'video-1', name: 'Video 1', type: 'video', muted: false, locked: false, visible: true },
        { id: 'video-2', name: 'Video 2', type: 'video', muted: false, locked: false, visible: true },
        { id: 'music', name: 'Music', type: 'audio', muted: false, locked: false, visible: true },
        { id: 'voiceover', name: 'Voiceover', type: 'audio', muted: false, locked: false, visible: true },
        { id: 'sfx', name: 'SFX', type: 'audio', muted: false, locked: false, visible: true },
      ],
      clips: [],
      transitions: [],
      selectedClipIds: [],
      clipCounter: 1,
      transitionCounter: 1,
      snappingEnabled: true,
      snappingThreshold: 10,
      activeSnapTime: null,
      rippleEditMode: false,
      inPoint: null,
      outPoint: null,
      // Clear undo/redo history
      history: [],
      historyIndex: -1,
    })
  },

  /**
   * Load timeline data from a project
   * @param {object} timelineData - Timeline data from project file
   */
  loadFromProject: (timelineData) => {
    if (!timelineData) return
    
    set({
      duration: timelineData.duration || 60,
      zoom: timelineData.zoom || 100,
      tracks: timelineData.tracks || [
        { id: 'video-1', name: 'Video 1', type: 'video', muted: false, locked: false, visible: true },
        { id: 'video-2', name: 'Video 2', type: 'video', muted: false, locked: false, visible: true },
        { id: 'music', name: 'Music', type: 'audio', muted: false, locked: false, visible: true },
        { id: 'voiceover', name: 'Voiceover', type: 'audio', muted: false, locked: false, visible: true },
        { id: 'sfx', name: 'SFX', type: 'audio', muted: false, locked: false, visible: true },
      ],
      clips: timelineData.clips || [],
      transitions: timelineData.transitions || [],
      clipCounter: timelineData.clipCounter || 1,
      transitionCounter: timelineData.transitionCounter || 1,
      snappingEnabled: timelineData.snappingEnabled ?? true,
      snappingThreshold: timelineData.snappingThreshold || 10,
      rippleEditMode: timelineData.rippleEditMode || false,
      // Reset playback state
      playheadPosition: 0,
      isPlaying: false,
      playbackRate: 1,
      shuttleMode: false,
      loopMode: 'normal',
      selectedClipIds: [],
      activeSnapTime: null,
      inPoint: null,
      outPoint: null,
      // Clear history on load
      history: [],
      historyIndex: -1,
    })
  },

  /**
   * Get timeline data for saving to project
   */
  getProjectData: () => {
    const state = get()
    return {
      duration: state.duration,
      zoom: state.zoom,
      tracks: state.tracks,
      clips: state.clips,
      transitions: state.transitions,
      clipCounter: state.clipCounter,
      transitionCounter: state.transitionCounter,
      snappingEnabled: state.snappingEnabled,
      snappingThreshold: state.snappingThreshold,
      rippleEditMode: state.rippleEditMode,
    }
  },

  /**
   * Toggle snapping on/off
   */
  toggleSnapping: () => {
    set((state) => ({ snappingEnabled: !state.snappingEnabled }))
  },

  /**
   * Set snapping enabled/disabled
   */
  setSnappingEnabled: (enabled) => {
    set({ snappingEnabled: enabled })
  },

  /**
   * Set snapping threshold (in pixels)
   */
  setSnappingThreshold: (threshold) => {
    set({ snappingThreshold: Math.max(5, Math.min(30, threshold)) })
  },

  /**
   * Set active snap time for visual feedback
   */
  setActiveSnapTime: (time) => {
    set({ activeSnapTime: time })
  },

  /**
   * Clear active snap indicator
   */
  clearActiveSnap: () => {
    set({ activeSnapTime: null })
  },

  /**
   * Toggle ripple edit mode
   */
  toggleRippleEdit: () => {
    set((state) => ({ rippleEditMode: !state.rippleEditMode }))
  },

  /**
   * Set ripple edit mode
   */
  setRippleEditMode: (enabled) => {
    set({ rippleEditMode: enabled })
  },

  /**
   * Get clips that would be affected by ripple edit
   * (clips on the same track after the given time)
   */
  getClipsToRipple: (trackId, afterTime) => {
    const state = get()
    return state.clips
      .filter(c => c.trackId === trackId && c.startTime >= afterTime)
      .sort((a, b) => a.startTime - b.startTime)
  },

  /**
   * Set In point at current playhead position
   */
  setInPoint: (time = null) => {
    set((state) => ({ 
      inPoint: time !== null ? time : state.playheadPosition 
    }))
  },

  /**
   * Set Out point at current playhead position
   */
  setOutPoint: (time = null) => {
    set((state) => ({ 
      outPoint: time !== null ? time : state.playheadPosition 
    }))
  },

  /**
   * Clear In point
   */
  clearInPoint: () => {
    set({ inPoint: null })
  },

  /**
   * Clear Out point
   */
  clearOutPoint: () => {
    set({ outPoint: null })
  },

  /**
   * Clear both In and Out points
   */
  clearInOutPoints: () => {
    set({ inPoint: null, outPoint: null })
  },

  /**
   * Go to In point
   */
  goToInPoint: () => {
    const state = get()
    if (state.inPoint !== null) {
      set({ playheadPosition: state.inPoint })
    }
  },

  /**
   * Go to Out point
   */
  goToOutPoint: () => {
    const state = get()
    if (state.outPoint !== null) {
      set({ playheadPosition: state.outPoint })
    }
  }
    }),
    {
      name: 'storyflow-timeline', // localStorage key
      partialize: (state) => ({
        // Only persist these fields (exclude transient UI state)
        duration: state.duration,
        zoom: state.zoom,
        tracks: state.tracks,
        clips: state.clips,
        transitions: state.transitions,
        clipCounter: state.clipCounter,
        transitionCounter: state.transitionCounter,
        snappingEnabled: state.snappingEnabled,
        snappingThreshold: state.snappingThreshold,
        rippleEditMode: state.rippleEditMode,
        // Note: Transient UI state NOT persisted:
        // - activeSnapTime, selectedClipIds, playheadPosition
        // - isPlaying, playbackRate, shuttleMode
        // - inPoint, outPoint (session-specific)
      }),
    }
  )
)

// Helper function to get video clip colors (desaturated palette)
function getVideoColor(index) {
  const colors = [
    '#5a7a9e', // desaturated blue
    '#7a6a9e', // desaturated purple
    '#b06a8a', // desaturated pink
    '#4a8a7a', // desaturated green
    '#b08a4a', // desaturated amber
    '#b06a6a', // desaturated red
  ]
  return colors[index % colors.length]
}

// Helper function to get audio clip colors (desaturated palette)
function getAudioColor(trackId) {
  const colors = {
    'music': '#4a8a6a', // desaturated green
    'voiceover': '#b07a4a', // desaturated orange
    'sfx': '#8a6a9a', // desaturated purple
  }
  return colors[trackId] || '#6B7280'
}

export default useTimelineStore
