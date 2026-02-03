import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  isFileSystemSupported,
  requestDirectoryAccess,
  createProjectFolder,
  saveProject as saveProjectToFile,
  loadProject as loadProjectFromFile,
  listProjects,
  storeDirectoryHandle,
  getStoredDirectoryHandle,
  verifyPermission,
  removeStoredDirectoryHandle,
} from '../services/fileSystem'
import { useTimelineStore } from './timelineStore'
import { useAssetsStore } from './assetsStore'

/**
 * Resolution presets for new projects
 */
export const RESOLUTION_PRESETS = [
  { name: 'HD 1080p', width: 1920, height: 1080, aspect: '16:9' },
  { name: 'HD 720p', width: 1280, height: 720, aspect: '16:9' },
  { name: '4K UHD', width: 3840, height: 2160, aspect: '16:9' },
  { name: 'Vertical 1080', width: 1080, height: 1920, aspect: '9:16' },
  { name: 'Square', width: 1080, height: 1080, aspect: '1:1' },
  { name: 'Instagram 4:5', width: 1080, height: 1350, aspect: '4:5' },
  { name: 'Cinematic 21:9', width: 2560, height: 1080, aspect: '21:9' },
]

/**
 * Frame rate presets
 */
export const FPS_PRESETS = [
  { value: 15, label: '15 fps' },
  { value: 23.976, label: '23.976 fps (Film)' },
  { value: 24, label: '24 fps (Cinema)' },
  { value: 25, label: '25 fps (PAL)' },
  { value: 30, label: '30 fps (NTSC)' },
  { value: 60, label: '60 fps (High Frame Rate)' },
]

/**
 * Create a default timeline structure
 * @param {string} name - Timeline name
 * @param {string} id - Optional timeline ID
 * @param {object} settings - Optional timeline-specific settings (width, height, fps)
 */
const createDefaultTimeline = (name = 'Timeline 1', id = null, settings = null) => ({
  id: id || `timeline-${Date.now()}`,
  name,
  created: new Date().toISOString(),
  modified: new Date().toISOString(),
  // Timeline-specific resolution and frame rate (optional - falls back to project settings if null)
  width: settings?.width || null,
  height: settings?.height || null,
  fps: settings?.fps || null,
  duration: 60,
  zoom: 100,
  tracks: [
    { id: 'video-1', name: 'Video 1', type: 'video', muted: false, locked: false, visible: true },
    { id: 'video-2', name: 'Video 2', type: 'video', muted: false, locked: false, visible: true },
    { id: 'music', name: 'Music', type: 'audio', muted: false, locked: false, visible: true },
    { id: 'voiceover', name: 'Voiceover', type: 'audio', muted: false, locked: false, visible: true },
    { id: 'sfx', name: 'SFX', type: 'audio', muted: false, locked: false, visible: true },
  ],
  clips: [],
  transitions: [],
  clipCounter: 1,
  transitionCounter: 1,
  snappingEnabled: true,
  snappingThreshold: 10,
  rippleEditMode: false,
})

/**
 * Project Store
 * Manages project state, recent projects, and file system operations
 * Supports multiple timelines per project
 */
export const useProjectStore = create(
  persist(
    (set, get) => ({
      // Current project state
      currentProject: null, // { name, settings, created, modified, timelines, currentTimelineId }
      currentProjectHandle: null, // FileSystemDirectoryHandle (not persisted)
      currentTimelineId: null, // ID of the currently active timeline
      
      // Default projects location
      defaultProjectsLocation: null, // Path string for display
      defaultProjectsHandle: null, // FileSystemDirectoryHandle (not persisted)
      
      // Recent projects list (persisted)
      recentProjects: [], // [{ name, path, modified, settings, thumbnail }]
      
      // UI state
      isFirstRun: true, // Whether this is first time opening the app
      isLoading: false,
      error: null,
      
      // Auto-save settings
      autoSaveEnabled: true,
      autoSaveInterval: 30000, // 30 seconds
      lastAutoSave: null,
      
      /**
       * Check if File System API is supported
       */
      checkBrowserSupport: () => {
        return isFileSystemSupported()
      },
      
      /**
       * Initialize the store on app load
       * Attempts to restore directory handles from IndexedDB
       */
      initialize: async () => {
        set({ isLoading: true, error: null })
        
        try {
          // Try to restore default projects location handle
          const storedDefaultHandle = await getStoredDirectoryHandle('defaultProjectsLocation')
          if (storedDefaultHandle) {
            const hasPermission = await verifyPermission(storedDefaultHandle)
            if (hasPermission) {
              set({ 
                defaultProjectsHandle: storedDefaultHandle,
                isFirstRun: false,
              })
            }
          }
          
          // Try to restore current project handle
          const storedProjectHandle = await getStoredDirectoryHandle('currentProject')
          if (storedProjectHandle) {
            const hasPermission = await verifyPermission(storedProjectHandle)
            if (hasPermission) {
              // Load project data
              const projectData = await loadProjectFromFile(storedProjectHandle)
              if (projectData) {
                // Get the current/first timeline
                const currentTimelineId = projectData.currentTimelineId || projectData.timelines?.[0]?.id
                const currentTimeline = projectData.timelines?.find(t => t.id === currentTimelineId) || projectData.timelines?.[0]
                
                // Load timeline data
                if (currentTimeline) {
                  useTimelineStore.getState().loadFromProject(currentTimeline)
                }
                
                // Regenerate asset URLs from project files
                if (projectData.assets) {
                  await useAssetsStore.getState().loadFromProject(projectData.assets, storedProjectHandle)
                }
                
                set({
                  currentProject: projectData,
                  currentProjectHandle: storedProjectHandle,
                  currentTimelineId: currentTimelineId,
                })
              }
            }
          }
          
          set({ isLoading: false })
        } catch (err) {
          console.error('Error initializing project store:', err)
          set({ isLoading: false, error: err.message })
        }
      },
      
      /**
       * Set the default projects location
       * @param {FileSystemDirectoryHandle} handle - The directory handle
       */
      setDefaultProjectsLocation: async (handle) => {
        if (!handle) return
        
        try {
          await storeDirectoryHandle('defaultProjectsLocation', handle)
          set({ 
            defaultProjectsHandle: handle,
            defaultProjectsLocation: handle.name,
            isFirstRun: false,
          })
        } catch (err) {
          console.error('Error storing default projects location:', err)
          set({ error: err.message })
        }
      },
      
      /**
       * Prompt user to select default projects location
       */
      selectDefaultProjectsLocation: async () => {
        try {
          const handle = await requestDirectoryAccess('Select Projects Folder')
          if (handle) {
            await get().setDefaultProjectsLocation(handle)
            return true
          }
          return false
        } catch (err) {
          console.error('Error selecting projects location:', err)
          set({ error: err.message })
          return false
        }
      },
      
      /**
       * Create a new project
       * @param {object} options - Project options
       * @param {string} options.name - Project name
       * @param {number} options.width - Resolution width
       * @param {number} options.height - Resolution height
       * @param {number} options.fps - Frame rate
       */
      createProject: async ({ name, width, height, fps }) => {
        const state = get()
        
        if (!state.defaultProjectsHandle) {
          set({ error: 'No projects location set. Please select a projects folder first.' })
          return null
        }
        
        set({ isLoading: true, error: null })
        
        try {
          // Create project folder structure
          const projectHandle = await createProjectFolder(state.defaultProjectsHandle, name)
          
          // Create default timeline
          const defaultTimeline = createDefaultTimeline('Timeline 1')
          
          // Create project data with timelines array
          const projectData = {
            name,
            version: '1.1', // Updated version for multi-timeline support
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            settings: {
              width,
              height,
              fps,
              aspectRatio: `${width}:${height}`,
            },
            timelines: [defaultTimeline], // Array of timelines
            currentTimelineId: defaultTimeline.id,
            assets: [],
          }
          
          // Save project file
          await saveProjectToFile(projectHandle, projectData)
          
          // Store handle for persistence
          await storeDirectoryHandle('currentProject', projectHandle)
          
          // Add to recent projects
          const recentProject = {
            name,
            modified: projectData.modified,
            created: projectData.created,
            settings: projectData.settings,
            thumbnail: null,
          }
          
          // Load the first timeline into the timeline store
          useTimelineStore.getState().loadFromProject(defaultTimeline)
          await useAssetsStore.getState().loadFromProject(projectData.assets, projectHandle)
          
          set((state) => ({
            currentProject: projectData,
            currentProjectHandle: projectHandle,
            currentTimelineId: defaultTimeline.id,
            recentProjects: [recentProject, ...state.recentProjects.filter(p => p.name !== name)].slice(0, 10),
            isLoading: false,
          }))
          
          return projectData
        } catch (err) {
          console.error('Error creating project:', err)
          set({ isLoading: false, error: err.message })
          return null
        }
      },
      
      /**
       * Open an existing project
       * @param {FileSystemDirectoryHandle} projectHandle - The project directory handle
       */
      openProject: async (projectHandle) => {
        set({ isLoading: true, error: null })
        
        try {
          // Verify permission
          const hasPermission = await verifyPermission(projectHandle)
          if (!hasPermission) {
            throw new Error('Permission denied to access project folder')
          }
          
          // Load project data
          const projectData = await loadProjectFromFile(projectHandle)
          if (!projectData) {
            throw new Error('Invalid project file')
          }
          
          // Store handle for persistence
          await storeDirectoryHandle('currentProject', projectHandle)
          
          // Handle legacy projects (single timeline) - migrate to multi-timeline format
          if (projectData.timeline && !projectData.timelines) {
            const migratedTimeline = {
              ...projectData.timeline,
              id: 'timeline-1',
              name: 'Timeline 1',
              created: projectData.created,
              modified: projectData.modified,
            }
            projectData.timelines = [migratedTimeline]
            projectData.currentTimelineId = migratedTimeline.id
            delete projectData.timeline
          }
          
          // Ensure we have timelines array
          if (!projectData.timelines || projectData.timelines.length === 0) {
            projectData.timelines = [createDefaultTimeline('Timeline 1')]
            projectData.currentTimelineId = projectData.timelines[0].id
          }
          
          // Get the current timeline to load
          const currentTimelineId = projectData.currentTimelineId || projectData.timelines[0].id
          const currentTimeline = projectData.timelines.find(t => t.id === currentTimelineId) || projectData.timelines[0]
          
          // Load timeline and assets data into their respective stores
          useTimelineStore.getState().loadFromProject(currentTimeline)
          await useAssetsStore.getState().loadFromProject(projectData.assets, projectHandle)
          
          // Update recent projects
          const recentProject = {
            name: projectData.name,
            modified: projectData.modified,
            created: projectData.created,
            settings: projectData.settings,
            thumbnail: projectData.thumbnail,
          }
          
          set((state) => ({
            currentProject: projectData,
            currentProjectHandle: projectHandle,
            currentTimelineId: currentTimeline.id,
            recentProjects: [recentProject, ...state.recentProjects.filter(p => p.name !== projectData.name)].slice(0, 10),
            isLoading: false,
          }))
          
          return projectData
        } catch (err) {
          console.error('Error opening project:', err)
          set({ isLoading: false, error: err.message })
          return null
        }
      },
      
      /**
       * Open a project via file picker
       */
      openProjectFromPicker: async () => {
        try {
          const handle = await requestDirectoryAccess('Select Project Folder')
          if (handle) {
            return await get().openProject(handle)
          }
          return null
        } catch (err) {
          console.error('Error opening project from picker:', err)
          set({ error: err.message })
          return null
        }
      },
      
      /**
       * Save the current project
       * @param {object} updates - Partial project data to merge
       */
      saveProject: async (updates = {}) => {
        const state = get()
        
        if (!state.currentProjectHandle || !state.currentProject) {
          console.warn('No project to save')
          return false
        }
        
        try {
          // Gather current state from timeline and assets stores
          const currentTimelineData = useTimelineStore.getState().getProjectData()
          const assetsData = useAssetsStore.getState().getProjectData()
          
          // Update the current timeline in the timelines array
          const updatedTimelines = (state.currentProject.timelines || []).map(t => 
            t.id === state.currentTimelineId 
              ? { ...t, ...currentTimelineData, modified: new Date().toISOString() }
              : t
          )
          
          const updatedProject = {
            ...state.currentProject,
            ...updates,
            timelines: updatedTimelines,
            currentTimelineId: state.currentTimelineId,
            assets: assetsData,
            modified: new Date().toISOString(),
          }
          
          await saveProjectToFile(state.currentProjectHandle, updatedProject)
          
          set({
            currentProject: updatedProject,
            lastAutoSave: new Date().toISOString(),
          })
          
          // Update recent projects list
          set((state) => ({
            recentProjects: state.recentProjects.map(p => 
              p.name === updatedProject.name 
                ? { ...p, modified: updatedProject.modified }
                : p
            ),
          }))
          
          return true
        } catch (err) {
          console.error('Error saving project:', err)
          set({ error: err.message })
          return false
        }
      },
      
      /**
       * Close the current project
       */
      closeProject: async () => {
        // Save before closing
        await get().saveProject()
        
        // Clear current project handle from storage
        await removeStoredDirectoryHandle('currentProject')
        
        // Clear timeline and assets stores
        useTimelineStore.getState().clearProject()
        useAssetsStore.getState().clearProject()
        
        set({
          currentProject: null,
          currentProjectHandle: null,
          currentTimelineId: null,
        })
      },
      
      // ==========================================
      // TIMELINE MANAGEMENT (Multiple Timelines)
      // ==========================================
      
      /**
       * Get all timelines for the current project
       */
      getTimelines: () => {
        const state = get()
        return state.currentProject?.timelines || []
      },
      
      /**
       * Get the current timeline
       */
      getCurrentTimeline: () => {
        const state = get()
        if (!state.currentProject?.timelines) return null
        return state.currentProject.timelines.find(t => t.id === state.currentTimelineId) || null
      },
      
      /**
       * Get effective settings for the current timeline
       * Falls back to project settings if timeline-specific settings aren't set
       * @returns {object} - { width, height, fps, aspectRatio }
       */
      getCurrentTimelineSettings: () => {
        const state = get()
        if (!state.currentProject) return null
        
        const timeline = state.currentProject.timelines?.find(t => t.id === state.currentTimelineId)
        const projectSettings = state.currentProject.settings || {}
        
        const width = timeline?.width || projectSettings.width || 1920
        const height = timeline?.height || projectSettings.height || 1080
        const fps = timeline?.fps || projectSettings.fps || 24
        
        // Calculate aspect ratio
        const gcd = (a, b) => b === 0 ? a : gcd(b, a % b)
        const divisor = gcd(width, height)
        const aspectRatio = `${width / divisor}:${height / divisor}`
        
        return {
          width,
          height,
          fps,
          aspectRatio,
          isTimelineSpecific: !!(timeline?.width || timeline?.height || timeline?.fps),
        }
      },
      
      /**
       * Switch to a different timeline
       * @param {string} timelineId - ID of the timeline to switch to
       */
      switchTimeline: async (timelineId) => {
        const state = get()
        if (!state.currentProject?.timelines) return false
        
        // Find the target timeline
        const targetTimeline = state.currentProject.timelines.find(t => t.id === timelineId)
        if (!targetTimeline) return false
        
        // Save current timeline state first
        const currentTimelineData = useTimelineStore.getState().getProjectData()
        const updatedTimelines = state.currentProject.timelines.map(t => 
          t.id === state.currentTimelineId 
            ? { ...t, ...currentTimelineData, modified: new Date().toISOString() }
            : t
        )
        
        // Update project with saved timeline
        set((state) => ({
          currentProject: {
            ...state.currentProject,
            timelines: updatedTimelines,
          },
        }))
        
        // Load the target timeline into the timeline store
        useTimelineStore.getState().loadFromProject(targetTimeline)
        
        // Update current timeline ID
        set({ currentTimelineId: timelineId })
        
        return true
      },
      
      /**
       * Create a new timeline
       * @param {object|string} options - Timeline options or just name for backward compatibility
       * @param {string} options.name - Name for the new timeline
       * @param {number} options.width - Optional timeline-specific width
       * @param {number} options.height - Optional timeline-specific height
       * @param {number} options.fps - Optional timeline-specific frame rate
       */
      createTimeline: (options = null) => {
        const state = get()
        if (!state.currentProject) return null
        
        // Handle backward compatibility - if options is a string, treat as name
        const isLegacyCall = typeof options === 'string' || options === null
        const name = isLegacyCall ? options : options?.name
        const settings = isLegacyCall ? null : {
          width: options?.width || null,
          height: options?.height || null,
          fps: options?.fps || null,
        }
        
        const existingTimelines = state.currentProject.timelines || []
        const timelineNumber = existingTimelines.length + 1
        const timelineName = name || `Timeline ${timelineNumber}`
        
        const newTimeline = createDefaultTimeline(timelineName, null, settings)
        
        set((state) => ({
          currentProject: {
            ...state.currentProject,
            timelines: [...(state.currentProject.timelines || []), newTimeline],
          },
        }))
        
        return newTimeline
      },
      
      /**
       * Duplicate an existing timeline
       * @param {string} timelineId - ID of the timeline to duplicate
       */
      duplicateTimeline: (timelineId) => {
        const state = get()
        if (!state.currentProject?.timelines) return null
        
        // If duplicating current timeline, save its state first
        if (timelineId === state.currentTimelineId) {
          const currentTimelineData = useTimelineStore.getState().getProjectData()
          const updatedTimelines = state.currentProject.timelines.map(t => 
            t.id === state.currentTimelineId 
              ? { ...t, ...currentTimelineData, modified: new Date().toISOString() }
              : t
          )
          set((state) => ({
            currentProject: {
              ...state.currentProject,
              timelines: updatedTimelines,
            },
          }))
        }
        
        // Get fresh state
        const freshState = get()
        const sourceTimeline = freshState.currentProject.timelines.find(t => t.id === timelineId)
        if (!sourceTimeline) return null
        
        const newTimeline = {
          ...JSON.parse(JSON.stringify(sourceTimeline)), // Deep clone
          id: `timeline-${Date.now()}`,
          name: `${sourceTimeline.name} (Copy)`,
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
        }
        
        set((state) => ({
          currentProject: {
            ...state.currentProject,
            timelines: [...state.currentProject.timelines, newTimeline],
          },
        }))
        
        return newTimeline
      },
      
      /**
       * Rename a timeline
       * @param {string} timelineId - ID of the timeline to rename
       * @param {string} newName - New name for the timeline
       */
      renameTimeline: (timelineId, newName) => {
        const state = get()
        if (!state.currentProject?.timelines || !newName.trim()) return false
        
        set((state) => ({
          currentProject: {
            ...state.currentProject,
            timelines: state.currentProject.timelines.map(t => 
              t.id === timelineId 
                ? { ...t, name: newName.trim(), modified: new Date().toISOString() }
                : t
            ),
          },
        }))
        
        return true
      },
      
      /**
       * Delete a timeline
       * @param {string} timelineId - ID of the timeline to delete
       */
      deleteTimeline: (timelineId) => {
        const state = get()
        if (!state.currentProject?.timelines) return false
        
        // Can't delete the last timeline
        if (state.currentProject.timelines.length <= 1) return false
        
        // If deleting the current timeline, switch to another first
        if (timelineId === state.currentTimelineId) {
          const remainingTimelines = state.currentProject.timelines.filter(t => t.id !== timelineId)
          const nextTimeline = remainingTimelines[0]
          
          // Load the next timeline
          useTimelineStore.getState().loadFromProject(nextTimeline)
          
          set((state) => ({
            currentProject: {
              ...state.currentProject,
              timelines: remainingTimelines,
            },
            currentTimelineId: nextTimeline.id,
          }))
        } else {
          set((state) => ({
            currentProject: {
              ...state.currentProject,
              timelines: state.currentProject.timelines.filter(t => t.id !== timelineId),
            },
          }))
        }
        
        return true
      },
      
      /**
       * Get list of recent projects with handles (for display)
       */
      getRecentProjectsList: async () => {
        const state = get()
        
        if (!state.defaultProjectsHandle) {
          return state.recentProjects
        }
        
        try {
          // Refresh list from file system
          const projects = await listProjects(state.defaultProjectsHandle)
          
          // Update recent projects with fresh data
          const updatedRecent = state.recentProjects.map(recent => {
            const fresh = projects.find(p => p.name === recent.name)
            if (fresh) {
              return {
                ...recent,
                ...fresh,
              }
            }
            return recent
          })
          
          return updatedRecent.slice(0, 10)
        } catch (err) {
          console.error('Error getting recent projects:', err)
          return state.recentProjects
        }
      },
      
      /**
       * Update project settings
       */
      updateProjectSettings: (settings) => {
        set((state) => ({
          currentProject: state.currentProject ? {
            ...state.currentProject,
            settings: { ...state.currentProject.settings, ...settings },
          } : null,
        }))
      },
      
      /**
       * Clear error
       */
      clearError: () => {
        set({ error: null })
      },
      
      /**
       * Set auto-save enabled
       */
      setAutoSaveEnabled: (enabled) => {
        set({ autoSaveEnabled: enabled })
      },
    }),
    {
      name: 'storyflow-project', // localStorage key
      partialize: (state) => ({
        // Only persist these fields
        recentProjects: state.recentProjects,
        isFirstRun: state.isFirstRun,
        defaultProjectsLocation: state.defaultProjectsLocation,
        autoSaveEnabled: state.autoSaveEnabled,
        autoSaveInterval: state.autoSaveInterval,
        // Note: Handles are stored in IndexedDB, not localStorage
      }),
    }
  )
)

export default useProjectStore
