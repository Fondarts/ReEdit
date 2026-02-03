/**
 * File System Service
 * Handles all File System Access API operations for project management
 */

// Check if File System Access API is supported
export const isFileSystemSupported = () => {
  return 'showDirectoryPicker' in window && 'showOpenFilePicker' in window
}

/**
 * Request directory access from user
 * @param {string} purpose - Description shown to user (e.g., "Select Projects Folder")
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export const requestDirectoryAccess = async (purpose = 'Select Folder') => {
  if (!isFileSystemSupported()) {
    throw new Error('File System Access API not supported. Please use Chrome or Edge.')
  }

  try {
    const handle = await window.showDirectoryPicker({
      mode: 'readwrite',
      startIn: 'documents',
    })
    return handle
  } catch (err) {
    if (err.name === 'AbortError') {
      return null // User cancelled
    }
    throw err
  }
}

/**
 * Request to open a specific project folder
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export const openProjectFolder = async () => {
  return requestDirectoryAccess('Select Project Folder')
}

/**
 * Create project folder structure
 * @param {FileSystemDirectoryHandle} baseDir - The base projects directory
 * @param {string} projectName - Name of the project
 * @returns {Promise<FileSystemDirectoryHandle>} - The project directory handle
 */
export const createProjectFolder = async (baseDir, projectName) => {
  // Create main project folder
  const projectDir = await baseDir.getDirectoryHandle(projectName, { create: true })
  
  // Create subfolders
  await projectDir.getDirectoryHandle('assets', { create: true })
  const assetsDir = await projectDir.getDirectoryHandle('assets', { create: false })
  await assetsDir.getDirectoryHandle('video', { create: true })
  await assetsDir.getDirectoryHandle('audio', { create: true })
  await assetsDir.getDirectoryHandle('images', { create: true })
  
  await projectDir.getDirectoryHandle('renders', { create: true })
  await projectDir.getDirectoryHandle('autosave', { create: true })
  
  return projectDir
}

/**
 * Save project data to .storyflow file
 * @param {FileSystemDirectoryHandle} projectDir - The project directory
 * @param {object} projectData - The project data to save
 */
export const saveProject = async (projectDir, projectData) => {
  const fileHandle = await projectDir.getFileHandle('project.storyflow', { create: true })
  const writable = await fileHandle.createWritable()
  
  const dataWithMeta = {
    ...projectData,
    version: '1.0',
    modified: new Date().toISOString(),
  }
  
  await writable.write(JSON.stringify(dataWithMeta, null, 2))
  await writable.close()
}

/**
 * Load project data from .storyflow file
 * @param {FileSystemDirectoryHandle} projectDir - The project directory
 * @returns {Promise<object|null>} - The project data or null if not found
 */
export const loadProject = async (projectDir) => {
  try {
    const fileHandle = await projectDir.getFileHandle('project.storyflow')
    const file = await fileHandle.getFile()
    const text = await file.text()
    return JSON.parse(text)
  } catch (err) {
    if (err.name === 'NotFoundError') {
      return null
    }
    throw err
  }
}

/**
 * Check if a directory is a valid StoryFlow project
 * @param {FileSystemDirectoryHandle} dir - Directory to check
 * @returns {Promise<boolean>}
 */
export const isValidProject = async (dir) => {
  try {
    await dir.getFileHandle('project.storyflow')
    return true
  } catch {
    return false
  }
}

/**
 * List all projects in the projects directory
 * @param {FileSystemDirectoryHandle} baseDir - The base projects directory
 * @returns {Promise<Array>} - Array of project info objects
 */
export const listProjects = async (baseDir) => {
  const projects = []
  
  for await (const entry of baseDir.values()) {
    if (entry.kind === 'directory') {
      try {
        const isProject = await isValidProject(entry)
        if (isProject) {
          const projectData = await loadProject(entry)
          if (projectData) {
            projects.push({
              name: projectData.name || entry.name,
              handle: entry,
              modified: projectData.modified,
              created: projectData.created,
              settings: projectData.settings,
              thumbnail: projectData.thumbnail,
            })
          }
        }
      } catch (err) {
        console.warn(`Error reading project ${entry.name}:`, err)
      }
    }
  }
  
  // Sort by modified date (most recent first)
  projects.sort((a, b) => new Date(b.modified) - new Date(a.modified))
  
  return projects
}

/**
 * Import a file to the project's assets folder
 * @param {FileSystemDirectoryHandle} projectDir - The project directory
 * @param {File} file - The file to import
 * @param {string} category - Asset category: 'video', 'audio', or 'images'
 * @returns {Promise<object>} - Asset info object with relative path
 */
export const importAsset = async (projectDir, file, category = 'video') => {
  const assetsDir = await projectDir.getDirectoryHandle('assets')
  const categoryDir = await assetsDir.getDirectoryHandle(category, { create: true })
  
  // Generate unique filename if exists
  let fileName = file.name
  let counter = 1
  let fileHandle
  
  while (true) {
    try {
      // Check if file exists
      await categoryDir.getFileHandle(fileName)
      // File exists, generate new name
      const ext = file.name.includes('.') ? '.' + file.name.split('.').pop() : ''
      const baseName = file.name.replace(ext, '')
      fileName = `${baseName}_${counter}${ext}`
      counter++
    } catch {
      // File doesn't exist, we can use this name
      break
    }
  }
  
  // Create and write the file
  fileHandle = await categoryDir.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(file)
  await writable.close()
  
  // Get file info
  const relativePath = `assets/${category}/${fileName}`
  
  // For video/audio, try to get duration
  let duration = null
  let width = null
  let height = null
  
  if (category === 'video' || category === 'audio') {
    try {
      const mediaInfo = await getMediaInfo(file)
      duration = mediaInfo.duration
      width = mediaInfo.width
      height = mediaInfo.height
    } catch (err) {
      console.warn('Could not get media info:', err)
    }
  }
  
  return {
    id: `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name: fileName,
    type: category === 'images' ? 'image' : category,
    path: relativePath,
    imported: new Date().toISOString(),
    size: file.size,
    mimeType: file.type,
    duration,
    width,
    height,
    isImported: true, // Flag to distinguish from AI-generated assets
  }
}

/**
 * Get media file info (duration, dimensions)
 * @param {File} file - The media file
 * @returns {Promise<object>} - Object with duration, width, height
 */
const getMediaInfo = (file) => {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    
    if (file.type.startsWith('video/')) {
      const video = document.createElement('video')
      video.preload = 'metadata'
      
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(url)
        resolve({
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
        })
      }
      
      video.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Failed to load video metadata'))
      }
      
      video.src = url
    } else if (file.type.startsWith('audio/')) {
      const audio = document.createElement('audio')
      audio.preload = 'metadata'
      
      audio.onloadedmetadata = () => {
        URL.revokeObjectURL(url)
        resolve({
          duration: audio.duration,
          width: null,
          height: null,
        })
      }
      
      audio.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Failed to load audio metadata'))
      }
      
      audio.src = url
    } else {
      URL.revokeObjectURL(url)
      resolve({ duration: null, width: null, height: null })
    }
  })
}

/**
 * Read a file from the project directory
 * @param {FileSystemDirectoryHandle} projectDir - The project directory
 * @param {string} relativePath - Relative path to the file
 * @returns {Promise<File>} - The file object
 */
export const readProjectFile = async (projectDir, relativePath) => {
  const parts = relativePath.split('/')
  let currentDir = projectDir
  
  // Navigate to the file's directory
  for (let i = 0; i < parts.length - 1; i++) {
    currentDir = await currentDir.getDirectoryHandle(parts[i])
  }
  
  // Get the file
  const fileName = parts[parts.length - 1]
  const fileHandle = await currentDir.getFileHandle(fileName)
  return await fileHandle.getFile()
}

/**
 * Get a URL for a project file (for use in video/audio elements)
 * @param {FileSystemDirectoryHandle} projectDir - The project directory
 * @param {string} relativePath - Relative path to the file
 * @returns {Promise<string>} - Object URL for the file
 */
export const getProjectFileUrl = async (projectDir, relativePath) => {
  const file = await readProjectFile(projectDir, relativePath)
  return URL.createObjectURL(file)
}

/**
 * Delete a file from the project
 * @param {FileSystemDirectoryHandle} projectDir - The project directory
 * @param {string} relativePath - Relative path to the file
 */
export const deleteProjectFile = async (projectDir, relativePath) => {
  const parts = relativePath.split('/')
  let currentDir = projectDir
  
  // Navigate to the file's directory
  for (let i = 0; i < parts.length - 1; i++) {
    currentDir = await currentDir.getDirectoryHandle(parts[i])
  }
  
  // Delete the file
  const fileName = parts[parts.length - 1]
  await currentDir.removeEntry(fileName)
}

/**
 * Store directory handle in IndexedDB for persistence across sessions
 * (File System Access API handles need to be re-validated on page load)
 */
const DB_NAME = 'storyflow-handles'
const DB_VERSION = 1
const STORE_NAME = 'directory-handles'

const openDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })
}

/**
 * Store a directory handle for later retrieval
 * @param {string} key - Storage key (e.g., 'defaultProjectsLocation', 'currentProject')
 * @param {FileSystemDirectoryHandle} handle - The directory handle
 */
export const storeDirectoryHandle = async (key, handle) => {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.put(handle, key)
    
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

/**
 * Retrieve a stored directory handle
 * @param {string} key - Storage key
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export const getStoredDirectoryHandle = async (key) => {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(key)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result || null)
    })
  } catch {
    return null
  }
}

/**
 * Verify and request permission for a stored handle
 * @param {FileSystemDirectoryHandle} handle - The stored handle
 * @returns {Promise<boolean>} - Whether permission was granted
 */
export const verifyPermission = async (handle) => {
  if (!handle) return false
  
  try {
    // Check if we already have permission
    const options = { mode: 'readwrite' }
    if ((await handle.queryPermission(options)) === 'granted') {
      return true
    }
    
    // Request permission
    if ((await handle.requestPermission(options)) === 'granted') {
      return true
    }
    
    return false
  } catch {
    return false
  }
}

/**
 * Remove a stored directory handle
 * @param {string} key - Storage key
 */
export const removeStoredDirectoryHandle = async (key) => {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.delete(key)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch {
    // Ignore errors
  }
}

export default {
  isFileSystemSupported,
  requestDirectoryAccess,
  openProjectFolder,
  createProjectFolder,
  saveProject,
  loadProject,
  isValidProject,
  listProjects,
  importAsset,
  readProjectFile,
  getProjectFileUrl,
  deleteProjectFile,
  storeDirectoryHandle,
  getStoredDirectoryHandle,
  verifyPermission,
  removeStoredDirectoryHandle,
}
