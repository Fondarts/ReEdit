import { Maximize2, Minimize2, Plus, X, Check, Home, ZoomIn, ZoomOut, Move, Play, Pause, SkipBack, SkipForward, Volume2, Film, Image as ImageIcon, ChevronDown, Grid3X3, Crosshair, Square, Frame } from 'lucide-react'
import { useState, useRef, useEffect, useCallback } from 'react'
import useAssetsStore from '../stores/assetsStore'
import useTimelineStore from '../stores/timelineStore'
import useProjectStore from '../stores/projectStore'
import { useTimelinePlayback } from '../hooks/useTimelinePlayback'
import VideoLayerRenderer from './VideoLayerRenderer'

// Zoom presets
const ZOOM_PRESETS = [
  { label: 'Fit', value: 'fit' },
  { label: '25%', value: 25 },
  { label: '50%', value: 50 },
  { label: '75%', value: 75 },
  { label: '100%', value: 100 },
  { label: '150%', value: 150 },
  { label: '200%', value: 200 },
]

// Safe guide presets
const SAFE_GUIDES = [
  { id: 'none', label: 'No Guides', description: 'Hide all guides' },
  { id: 'title-safe', label: 'Title Safe', description: '80% - Keep text inside', percent: 80 },
  { id: 'action-safe', label: 'Action Safe', description: '90% - Keep action inside', percent: 90 },
  { id: 'rule-of-thirds', label: 'Rule of Thirds', description: '3x3 grid overlay' },
  { id: 'center', label: 'Center Crosshair', description: 'Center point marker' },
  { id: 'all-safe', label: 'Title + Action Safe', description: 'Both safe zones' },
]

// Letterbox presets (for visualizing different delivery formats)
const LETTERBOX_PRESETS = [
  { id: 'none', label: 'No Letterbox', ratio: null },
  { id: '2.39:1', label: '2.39:1 Anamorphic', ratio: 2.39 },
  { id: '2.35:1', label: '2.35:1 Cinemascope', ratio: 2.35 },
  { id: '1.85:1', label: '1.85:1 Theatrical', ratio: 1.85 },
  { id: '16:9', label: '16:9 HD', ratio: 16/9 },
  { id: '4:3', label: '4:3 Classic TV', ratio: 4/3 },
  { id: '9:16', label: '9:16 Vertical (TikTok/Reels)', ratio: 9/16 },
  { id: '4:5', label: '4:5 Instagram Portrait', ratio: 4/5 },
  { id: '1:1', label: '1:1 Square (Instagram)', ratio: 1 },
]

function PreviewPanel() {
  const videoRefA = useRef(null) // Used for asset preview mode
  const containerRef = useRef(null)
  const viewportRef = useRef(null)
  const panelRef = useRef(null)
  
  // Track active clips at current playhead position (for overlay display)
  const [activeLayerClips, setActiveLayerClips] = useState([])
  
  // Context menu state
  const [contextMenu, setContextMenu] = useState(null) // { x, y }

  // Get current preview and playback state from assets store
  const { 
    currentPreview, 
    clearPreview,
    volume,
    registerVideoRef,
    setIsPlaying: setAssetIsPlaying,
    setCurrentTime: setAssetCurrentTime,
    setDuration: setAssetDuration,
    isPlaying: assetIsPlaying,
    currentTime: assetCurrentTime,
    duration: assetDuration,
    togglePlay: assetTogglePlay,
    seekTo: assetSeekTo,
    setVolume,
    previewMode,
    setPreviewMode
  } = useAssetsStore()
  
  // Timeline store for adding clips and playback
  const { 
    addClip, 
    isPlaying: timelineIsPlaying,
    playheadPosition,
    setPlayheadPosition,
    togglePlay: timelineTogglePlay,
    getActiveClipAtTime,
    getActiveClipsAtTime,
    getTransitionAtTime,
    getTimelineEndTime,
    clips,
    tracks
  } = useTimelineStore()
  
  // Use timeline playback hook
  const {
    activeClip,
    transitionInfo,
    sourceTime,
    endTime,
  } = useTimelinePlayback()
  
  // Get full clip data with transform for the active clip
  const getClipTransform = (clip) => {
    if (!clip) return null
    // Find the full clip object from the store to get transform
    const fullClip = clips.find(c => c.id === clip.id)
    return fullClip?.transform || {
      positionX: 0, positionY: 0,
      scaleX: 100, scaleY: 100, scaleLinked: true,
      rotation: 0, anchorX: 50, anchorY: 50, opacity: 100,
      flipH: false, flipV: false,
      cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
    }
  }
  
  // Build CSS transform string from clip transform properties
  const buildVideoTransform = (clipTransform) => {
    if (!clipTransform) return {}
    
    const {
      positionX, positionY,
      scaleX, scaleY,
      rotation,
      anchorX, anchorY,
      opacity,
      flipH, flipV,
      cropTop, cropBottom, cropLeft, cropRight,
    } = clipTransform
    
    // Build transform components
    const transforms = []
    
    // Position (translate)
    if (positionX !== 0 || positionY !== 0) {
      transforms.push(`translate(${positionX}px, ${positionY}px)`)
    }
    
    // Scale (with flip)
    const finalScaleX = (scaleX / 100) * (flipH ? -1 : 1)
    const finalScaleY = (scaleY / 100) * (flipV ? -1 : 1)
    if (finalScaleX !== 1 || finalScaleY !== 1) {
      transforms.push(`scale(${finalScaleX}, ${finalScaleY})`)
    }
    
    // Rotation
    if (rotation !== 0) {
      transforms.push(`rotate(${rotation}deg)`)
    }
    
    // Build style object
    const style = {}
    
    if (transforms.length > 0) {
      style.transform = transforms.join(' ')
    }
    
    // Transform origin (anchor point)
    style.transformOrigin = `${anchorX}% ${anchorY}%`
    
    // Opacity
    if (opacity !== 100) {
      style.opacity = opacity / 100
    }
    
    // Crop using clip-path
    if (cropTop > 0 || cropBottom > 0 || cropLeft > 0 || cropRight > 0) {
      style.clipPath = `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`
    }
    
    return style
  }
  
  // Track if we just added to timeline
  const [justAdded, setJustAdded] = useState(false)
  
  // Fullscreen state
  const [isFullscreen, setIsFullscreen] = useState(false)
  
  // Zoom and pan state
  const [zoom, setZoom] = useState('fit') // 'fit' or number (percentage)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [isZooming, setIsZooming] = useState(false)
  const [isSpaceHeld, setIsSpaceHeld] = useState(false)
  const [isCtrlHeld, setIsCtrlHeld] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [zoomStart, setZoomStart] = useState(100)
  const [showZoomDropdown, setShowZoomDropdown] = useState(false)
  
  // Safe guides state
  const [safeGuide, setSafeGuide] = useState('none')
  const [letterbox, setLetterbox] = useState('none')
  const [showGuidesDropdown, setShowGuidesDropdown] = useState(false)
  
  // Get timeline-specific settings
  const { getCurrentTimelineSettings, getCurrentTimeline } = useProjectStore()
  const timelineSettings = getCurrentTimelineSettings()
  const currentTimeline = getCurrentTimeline()
  
  // Register video ref with store (for asset preview mode)
  useEffect(() => {
    if (videoRefA.current && previewMode === 'asset') {
      registerVideoRef(videoRefA.current)
      videoRefA.current.volume = volume
    }
    return () => registerVideoRef(null)
  }, [registerVideoRef, volume, previewMode])

  // Get all active video clips at current playhead position (for overlay display only)
  useEffect(() => {
    if (previewMode !== 'timeline') {
      setActiveLayerClips([])
      return
    }
    
    // Get all video clips at current time (video tracks only)
    const allActiveClips = getActiveClipsAtTime(playheadPosition)
    const videoClips = allActiveClips.filter(({ track }) => track.type === 'video')
    
    // Sort by track index (higher index = lower in stack, first rendered)
    // We want Video 1 on top of Video 2, so reverse the natural order
    const sortedClips = [...videoClips].sort((a, b) => {
      const indexA = tracks.findIndex(t => t.id === a.track.id)
      const indexB = tracks.findIndex(t => t.id === b.track.id)
      return indexB - indexA // Video 2 renders first (behind), Video 1 renders last (on top)
    })
    
    setActiveLayerClips(sortedClips)
  }, [previewMode, playheadPosition, getActiveClipsAtTime, tracks])

  // NOTE: Video sync is now handled by VideoLayerRenderer component

  // Get transition styles based on type
  const getTransitionStyles = (transitionInfo, isVideoA) => {
    if (!transitionInfo) {
      return isVideoA ? { opacity: 1 } : { opacity: 0, display: 'none' }
    }
    
    const { transition, progress } = transitionInfo
    const type = transition?.type || 'dissolve'
    
    // Video A is outgoing, Video B is incoming
    if (isVideoA) {
      switch (type) {
        case 'dissolve':
          return { opacity: 1 - progress, position: 'absolute' }
        case 'fade-black':
        case 'fade-white':
          // Fade out to color then fade in
          return { opacity: progress < 0.5 ? 1 - progress * 2 : 0, position: 'absolute' }
        case 'wipe-left':
          return { clipPath: `inset(0 ${progress * 100}% 0 0)`, position: 'absolute' }
        case 'wipe-right':
          return { clipPath: `inset(0 0 0 ${progress * 100}%)`, position: 'absolute' }
        case 'wipe-up':
          return { clipPath: `inset(0 0 ${progress * 100}% 0)`, position: 'absolute' }
        case 'wipe-down':
          return { clipPath: `inset(${progress * 100}% 0 0 0)`, position: 'absolute' }
        case 'slide-left':
          return { transform: `translateX(-${progress * 100}%)`, position: 'absolute' }
        case 'slide-right':
          return { transform: `translateX(${progress * 100}%)`, position: 'absolute' }
        default:
          return { opacity: 1 - progress, position: 'absolute' }
      }
    } else {
      // Video B (incoming)
      switch (type) {
        case 'dissolve':
          return { opacity: progress, position: 'absolute', top: 0, left: 0 }
        case 'fade-black':
        case 'fade-white':
          // Fade in from color
          return { opacity: progress > 0.5 ? (progress - 0.5) * 2 : 0, position: 'absolute', top: 0, left: 0 }
        case 'wipe-left':
          return { clipPath: `inset(0 0 0 ${(1 - progress) * 100}%)`, position: 'absolute', top: 0, left: 0 }
        case 'wipe-right':
          return { clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)`, position: 'absolute', top: 0, left: 0 }
        case 'wipe-up':
          return { clipPath: `inset(${(1 - progress) * 100}% 0 0 0)`, position: 'absolute', top: 0, left: 0 }
        case 'wipe-down':
          return { clipPath: `inset(0 0 ${(1 - progress) * 100}% 0)`, position: 'absolute', top: 0, left: 0 }
        case 'slide-left':
          return { transform: `translateX(${(1 - progress) * 100}%)`, position: 'absolute', top: 0, left: 0 }
        case 'slide-right':
          return { transform: `translateX(-${(1 - progress) * 100}%)`, position: 'absolute', top: 0, left: 0 }
        default:
          return { opacity: progress, position: 'absolute', top: 0, left: 0 }
      }
    }
  }
  
  // Get transition overlay (for fade to color)
  const getTransitionOverlay = (transitionInfo) => {
    if (!transitionInfo) return null
    
    const { transition, progress } = transitionInfo
    const type = transition?.type
    
    if (type === 'fade-black') {
      const overlayOpacity = progress < 0.5 ? progress * 2 : (1 - progress) * 2
      return (
        <div 
          className="absolute inset-0 bg-black pointer-events-none z-10"
          style={{ opacity: overlayOpacity }}
        />
      )
    }
    
    if (type === 'fade-white') {
      const overlayOpacity = progress < 0.5 ? progress * 2 : (1 - progress) * 2
      return (
        <div 
          className="absolute inset-0 bg-white pointer-events-none z-10"
          style={{ opacity: overlayOpacity }}
        />
      )
    }
    
    return null
  }

  // Switch to timeline mode when timeline playback starts
  useEffect(() => {
    if (timelineIsPlaying && clips.length > 0) {
      setPreviewMode('timeline')
    }
  }, [timelineIsPlaying, clips.length, setPreviewMode])
  
  // When first clip is added, switch to timeline mode
  useEffect(() => {
    if (clips.length > 0 && previewMode === 'asset' && !currentPreview) {
      setPreviewMode('timeline')
    }
  }, [clips.length, previewMode, currentPreview, setPreviewMode])
  
  // Fullscreen toggle
  const toggleFullscreen = useCallback(async () => {
    if (!panelRef.current) return
    
    try {
      if (!document.fullscreenElement) {
        await panelRef.current.requestFullscreen()
      } else {
        await document.exitFullscreen()
      }
    } catch (err) {
      console.error('Fullscreen error:', err)
    }
  }, [])
  
  // Listen for fullscreen changes (including ESC key)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])
  
  // Handle add to timeline
  const handleAddToTimeline = () => {
    if (currentPreview) {
      addClip('video-1', currentPreview)
      setJustAdded(true)
      setTimeout(() => setJustAdded(false), 2000)
    }
  }

  // Handle video time update (asset mode)
  const handleTimeUpdate = () => {
    if (videoRefA.current && previewMode === 'asset') {
      setAssetCurrentTime(videoRefA.current.currentTime)
    }
  }

  // Handle video loaded (asset mode)
  const handleLoadedMetadata = () => {
    if (videoRefA.current && previewMode === 'asset') {
      setAssetDuration(videoRefA.current.duration)
    }
  }

  // Handle video end (asset mode)
  const handleEnded = () => {
    if (previewMode === 'asset') {
      setAssetIsPlaying(false)
      if (videoRefA.current) {
        videoRefA.current.currentTime = 0
      }
    }
  }

  // Computed values based on mode
  const isPlaying = previewMode === 'timeline' ? timelineIsPlaying : assetIsPlaying
  const currentTime = previewMode === 'timeline' ? playheadPosition : assetCurrentTime
  const duration = previewMode === 'timeline' ? endTime : assetDuration
  const togglePlay = previewMode === 'timeline' ? timelineTogglePlay : assetTogglePlay
  const seekTo = previewMode === 'timeline' 
    ? (time) => setPlayheadPosition(Math.max(0, Math.min(endTime, time)))
    : assetSeekTo

  // Check if we have content to show
  const hasContent = previewMode === 'timeline' 
    ? (clips.length > 0)
    : (currentPreview !== null)

  // Auto-play when new preview is set (asset mode only)
  useEffect(() => {
    if (currentPreview && videoRefA.current && previewMode === 'asset') {
      videoRefA.current.play().catch(() => {
        // Autoplay might be blocked
      })
      setAssetIsPlaying(true)
    }
    // Reset zoom/pan when preview changes
    setZoom('fit')
    setPan({ x: 0, y: 0 })
  }, [currentPreview, setAssetIsPlaying, previewMode])
  
  // Reset view to center
  const resetView = useCallback(() => {
    setZoom('fit')
    setPan({ x: 0, y: 0 })
  }, [])
  
  // Zoom in/out functions
  const zoomIn = useCallback(() => {
    setZoom(prev => {
      const current = prev === 'fit' ? 100 : prev
      return Math.min(400, current + 25)
    })
  }, [])
  
  const zoomOut = useCallback(() => {
    setZoom(prev => {
      const current = prev === 'fit' ? 100 : prev
      const newZoom = current - 25
      if (newZoom <= 25) return 'fit'
      return newZoom
    })
  }, [])
  
  // Handle keyboard events for spacebar and ctrl
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't capture Space when typing in input fields
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
        return
      }
      
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        setIsSpaceHeld(true)
      }
      if (e.key === 'Control') {
        setIsCtrlHeld(true)
      }
    }
    
    const handleKeyUp = (e) => {
      if (e.code === 'Space') {
        setIsSpaceHeld(false)
        setIsPanning(false)
        setIsZooming(false)
      }
      if (e.key === 'Control') {
        setIsCtrlHeld(false)
        setIsZooming(false)
      }
    }
    
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])
  
  // Handle mouse events for panning and zooming
  const handleMouseDown = useCallback((e) => {
    if (isSpaceHeld && isCtrlHeld) {
      // Start zooming with mouse drag
      e.preventDefault()
      setIsZooming(true)
      setDragStart({ x: e.clientX, y: e.clientY })
      setZoomStart(zoom === 'fit' ? 100 : zoom)
    } else if (isSpaceHeld) {
      // Start panning
      e.preventDefault()
      setIsPanning(true)
      setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y })
    }
  }, [isSpaceHeld, isCtrlHeld, pan, zoom])
  
  const handleMouseMove = useCallback((e) => {
    if (isZooming) {
      // Zoom based on horizontal mouse movement (right = zoom in, left = zoom out)
      const deltaX = e.clientX - dragStart.x
      const zoomChange = deltaX * 0.5 // Adjust sensitivity
      const newZoom = Math.max(10, Math.min(400, zoomStart + zoomChange))
      setZoom(Math.round(newZoom))
    } else if (isPanning) {
      setPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      })
    }
  }, [isZooming, isPanning, dragStart, zoomStart])
  
  const handleMouseUp = useCallback(() => {
    setIsPanning(false)
    setIsZooming(false)
  }, [])
  
  // Handle mouse wheel for zooming
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    
    // Determine zoom direction (scroll up = zoom in, scroll down = zoom out)
    const delta = -e.deltaY
    const zoomStep = 10 // Zoom step per scroll tick
    
    setZoom(prev => {
      const current = prev === 'fit' ? 100 : prev
      let newZoom = current + (delta > 0 ? zoomStep : -zoomStep)
      
      // Clamp zoom between 10% and 400%
      newZoom = Math.max(10, Math.min(400, newZoom))
      
      return Math.round(newZoom)
    })
  }, [])
  
  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = () => {
      setShowZoomDropdown(false)
      setShowGuidesDropdown(false)
    }
    if (showZoomDropdown || showGuidesDropdown) {
      document.addEventListener('click', handleClickOutside)
      return () => document.removeEventListener('click', handleClickOutside)
    }
  }, [showZoomDropdown, showGuidesDropdown])
  
  // Calculate actual zoom scale
  const getZoomScale = () => {
    if (zoom === 'fit') return 1
    return zoom / 100
  }
  
  // Get zoom display label
  const getZoomLabel = () => {
    if (zoom === 'fit') return 'Fit'
    return `${zoom}%`
  }
  
  // Format time as MM:SS
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  
  // Transport controls for fullscreen
  const goToStart = () => seekTo(0)
  const goToEnd = () => seekTo(duration)

  // Handle context menu on video
  const handleContextMenu = (e) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }
  
  // Close context menu
  useEffect(() => {
    if (!contextMenu) return
    
    const handleClick = () => setContextMenu(null)
    const handleEscape = (e) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    
    window.addEventListener('click', handleClick)
    window.addEventListener('keydown', handleEscape)
    
    return () => {
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [contextMenu])

  // Context menu actions
  const handleContextAction = (action) => {
    switch (action) {
      case 'play':
        togglePlay()
        break
      case 'fullscreen':
        toggleFullscreen()
        break
      case 'add-to-timeline':
        if (currentPreview) {
          addClip('video-1', currentPreview)
          setJustAdded(true)
          setTimeout(() => setJustAdded(false), 2000)
        }
        break
      case 'reset-view':
        resetView()
        break
      case 'zoom-100':
        setZoom(100)
        setPan({ x: 0, y: 0 })
        break
      case 'zoom-fit':
        setZoom('fit')
        setPan({ x: 0, y: 0 })
        break
    }
    setContextMenu(null)
  }
  
  // Get cursor style
  const getCursor = () => {
    if (isZooming) return 'ew-resize'
    if (isPanning) return 'grabbing'
    if (isSpaceHeld && isCtrlHeld) return 'ew-resize'
    if (isSpaceHeld) return 'grab'
    return 'default'
  }

  // Get timeline aspect ratio from settings
  const getTimelineAspectRatio = () => {
    if (timelineSettings) {
      return timelineSettings.width / timelineSettings.height
    }
    return 16 / 9 // Default fallback
  }
  
  const timelineAspectRatio = getTimelineAspectRatio()

  // State for computed video dimensions
  const [videoDimensions, setVideoDimensions] = useState({ width: 0, height: 0 })
  
  // Calculate video container dimensions to fill viewport while maintaining aspect ratio
  useEffect(() => {
    const calculateDimensions = () => {
      if (!viewportRef.current) return
      
      const viewport = viewportRef.current.getBoundingClientRect()
      const ar = timelineAspectRatio
      const padding = 24 // Padding around the video
      
      const availableWidth = viewport.width - padding * 2
      const availableHeight = viewport.height - padding * 2
      
      let width, height
      
      // Calculate dimensions to fit within viewport while maintaining aspect ratio
      if (availableWidth / availableHeight > ar) {
        // Viewport is wider than aspect ratio - constrain by height
        height = availableHeight
        width = height * ar
      } else {
        // Viewport is taller than aspect ratio - constrain by width
        width = availableWidth
        height = width / ar
      }
      
      setVideoDimensions({ width, height })
    }
    
    calculateDimensions()
    
    // Recalculate on resize
    const resizeObserver = new ResizeObserver(calculateDimensions)
    if (viewportRef.current) {
      resizeObserver.observe(viewportRef.current)
    }
    
    return () => resizeObserver.disconnect()
  }, [timelineAspectRatio])
  
  // Get video container style with computed dimensions
  const getAspectRatioStyle = () => {
    if (isFullscreen) {
      const ar = timelineAspectRatio
      // In fullscreen, constrain to viewport
      return ar >= 1 
        ? { maxWidth: '90vw', maxHeight: `calc(90vw / ${ar})`, aspectRatio: `${ar}` }
        : { maxHeight: '85vh', maxWidth: `calc(85vh * ${ar})`, aspectRatio: `${ar}` }
    }
    
    // Use computed dimensions for exact fit
    if (videoDimensions.width > 0 && videoDimensions.height > 0) {
      return {
        width: `${videoDimensions.width}px`,
        height: `${videoDimensions.height}px`,
      }
    }
    
    // Fallback while computing
    return { aspectRatio: `${timelineAspectRatio}` }
  }
  
  // Render safe guides overlay
  const renderSafeGuides = () => {
    if (safeGuide === 'none' && letterbox === 'none') return null
    
    const guideColor = 'rgba(255, 255, 255, 0.4)'
    const guides = []
    
    // Title Safe (80%)
    if (safeGuide === 'title-safe' || safeGuide === 'all-safe') {
      const inset = 10 // 10% from each edge = 80% safe area
      guides.push(
        <div
          key="title-safe"
          className="absolute pointer-events-none border border-dashed"
          style={{
            top: `${inset}%`,
            left: `${inset}%`,
            right: `${inset}%`,
            bottom: `${inset}%`,
            borderColor: 'rgba(255, 200, 0, 0.5)',
          }}
        >
          <span className="absolute -top-4 left-0 text-[9px] text-yellow-400/70">Title Safe</span>
        </div>
      )
    }
    
    // Action Safe (90%)
    if (safeGuide === 'action-safe' || safeGuide === 'all-safe') {
      const inset = 5 // 5% from each edge = 90% safe area
      guides.push(
        <div
          key="action-safe"
          className="absolute pointer-events-none border"
          style={{
            top: `${inset}%`,
            left: `${inset}%`,
            right: `${inset}%`,
            bottom: `${inset}%`,
            borderColor: 'rgba(0, 200, 255, 0.5)',
          }}
        >
          <span className="absolute -top-4 left-0 text-[9px] text-cyan-400/70">Action Safe</span>
        </div>
      )
    }
    
    // Rule of Thirds
    if (safeGuide === 'rule-of-thirds') {
      guides.push(
        <div key="thirds" className="absolute inset-0 pointer-events-none">
          {/* Vertical lines - full height */}
          <div className="absolute top-0 bottom-0 left-1/3 w-px" style={{ backgroundColor: guideColor }} />
          <div className="absolute top-0 bottom-0 left-2/3 w-px" style={{ backgroundColor: guideColor }} />
          {/* Horizontal lines - full width */}
          <div className="absolute left-0 right-0 top-1/3 h-px" style={{ backgroundColor: guideColor }} />
          <div className="absolute left-0 right-0 top-2/3 h-px" style={{ backgroundColor: guideColor }} />
          {/* Intersection points */}
          {[[1/3, 1/3], [2/3, 1/3], [1/3, 2/3], [2/3, 2/3]].map(([x, y], i) => (
            <div
              key={i}
              className="absolute w-2 h-2 rounded-full"
              style={{
                left: `calc(${x * 100}% - 4px)`,
                top: `calc(${y * 100}% - 4px)`,
                backgroundColor: 'rgba(255, 255, 255, 0.6)',
              }}
            />
          ))}
        </div>
      )
    }
    
    // Center Crosshair - full width and height lines
    if (safeGuide === 'center') {
      guides.push(
        <div key="center" className="absolute inset-0 pointer-events-none">
          {/* Horizontal line - full width */}
          <div className="absolute left-0 right-0 top-1/2 h-px" style={{ backgroundColor: guideColor }} />
          {/* Vertical line - full height */}
          <div className="absolute left-1/2 top-0 bottom-0 w-px" style={{ backgroundColor: guideColor }} />
          {/* Center circle */}
          <div 
            className="absolute w-3 h-3 rounded-full border-2" 
            style={{ 
              borderColor: guideColor,
              left: 'calc(50% - 6px)',
              top: 'calc(50% - 6px)',
            }} 
          />
        </div>
      )
    }
    
    // Letterbox overlay
    if (letterbox !== 'none') {
      const preset = LETTERBOX_PRESETS.find(p => p.id === letterbox)
      if (preset && preset.ratio) {
        const currentRatio = timelineAspectRatio
        const targetRatio = preset.ratio
        
        if (targetRatio > currentRatio) {
          // Letterbox (horizontal bars top/bottom) - target is WIDER than current
          // e.g., showing 2.35:1 on a 16:9 timeline crops top/bottom
          const barHeightPercent = ((1 - (currentRatio / targetRatio)) / 2) * 100
          guides.push(
            <div key="letterbox-top" className="absolute left-0 right-0 top-0 bg-black/80 pointer-events-none" style={{ height: `${barHeightPercent}%` }} />,
            <div key="letterbox-bottom" className="absolute left-0 right-0 bottom-0 bg-black/80 pointer-events-none" style={{ height: `${barHeightPercent}%` }} />
          )
        } else if (targetRatio < currentRatio) {
          // Pillarbox (vertical bars left/right) - target is NARROWER than current
          // e.g., showing 9:16 on a 16:9 timeline crops left/right
          const barWidthPercent = ((1 - (targetRatio / currentRatio)) / 2) * 100
          guides.push(
            <div key="pillarbox-left" className="absolute top-0 bottom-0 left-0 bg-black/80 pointer-events-none" style={{ width: `${barWidthPercent}%` }} />,
            <div key="pillarbox-right" className="absolute top-0 bottom-0 right-0 bg-black/80 pointer-events-none" style={{ width: `${barWidthPercent}%` }} />
          )
        }
      }
    }
    
    return <>{guides}</>
  }

  return (
    <div 
      ref={panelRef}
      className={`flex-1 bg-sf-dark-950 flex flex-col h-full ${isFullscreen ? 'fullscreen-panel' : ''}`}
    >
      {/* Preview Header */}
      <div className="h-8 bg-sf-dark-900 border-b border-sf-dark-700 flex items-center justify-between px-3 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-xs text-sf-text-secondary">
            {currentPreview ? `Preview - ${currentPreview.name}` : 'Preview'}
            {isFullscreen && <span className="ml-2 text-sf-text-muted">(Press ESC to exit)</span>}
          </span>
          
          {/* Safe Guides Dropdown */}
          <div className="relative">
            <button
              onClick={(e) => {
                e.stopPropagation()
                setShowGuidesDropdown(!showGuidesDropdown)
                setShowZoomDropdown(false)
              }}
              className={`flex items-center gap-1.5 px-2 py-1 hover:bg-sf-dark-700 rounded transition-colors text-xs ${
                safeGuide !== 'none' || letterbox !== 'none' ? 'text-sf-accent' : 'text-sf-text-muted'
              }`}
              title="Safe Guides & Letterbox"
            >
              <Grid3X3 className="w-3.5 h-3.5" />
              <span>Guides</span>
              <ChevronDown className="w-3 h-3" />
            </button>
            
            {showGuidesDropdown && (
              <div 
                className="absolute top-full left-0 mt-1 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl py-2 z-50 min-w-[200px]"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Safe Guides Section */}
                <div className="px-3 py-1 text-[10px] text-sf-text-muted uppercase tracking-wider">
                  Safe Guides
                </div>
                {SAFE_GUIDES.map((guide) => (
                  <button
                    key={guide.id}
                    onClick={() => setSafeGuide(guide.id)}
                    className={`w-full px-3 py-1.5 text-left text-xs hover:bg-sf-dark-700 flex items-center gap-2 transition-colors ${
                      safeGuide === guide.id ? 'bg-sf-dark-700' : ''
                    }`}
                  >
                    <div className="w-4 flex justify-center">
                      {guide.id === 'rule-of-thirds' && <Grid3X3 className="w-3.5 h-3.5 text-sf-text-muted" />}
                      {guide.id === 'center' && <Crosshair className="w-3.5 h-3.5 text-sf-text-muted" />}
                      {guide.id === 'title-safe' && <Square className="w-3 h-3 text-yellow-400/70" />}
                      {guide.id === 'action-safe' && <Square className="w-3.5 h-3.5 text-cyan-400/70" />}
                      {guide.id === 'all-safe' && <Frame className="w-3.5 h-3.5 text-sf-text-muted" />}
                      {guide.id === 'none' && <X className="w-3.5 h-3.5 text-sf-text-muted" />}
                    </div>
                    <div className="flex-1">
                      <span className="text-sf-text-primary">{guide.label}</span>
                      <p className="text-[10px] text-sf-text-muted">{guide.description}</p>
                    </div>
                    {safeGuide === guide.id && (
                      <Check className="w-3 h-3 text-sf-accent" />
                    )}
                  </button>
                ))}
                
                {/* Divider */}
                <div className="h-px bg-sf-dark-600 my-2" />
                
                {/* Letterbox Section */}
                <div className="px-3 py-1 text-[10px] text-sf-text-muted uppercase tracking-wider">
                  Letterbox Preview
                </div>
                {LETTERBOX_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => setLetterbox(preset.id)}
                    className={`w-full px-3 py-1.5 text-left text-xs hover:bg-sf-dark-700 flex items-center gap-2 transition-colors ${
                      letterbox === preset.id ? 'bg-sf-dark-700' : ''
                    }`}
                  >
                    <div className="w-4 flex justify-center">
                      {preset.id === 'none' ? (
                        <X className="w-3.5 h-3.5 text-sf-text-muted" />
                      ) : (
                        <div className="w-4 h-2 border border-sf-text-muted rounded-sm" />
                      )}
                    </div>
                    <span className="text-sf-text-primary">{preset.label}</span>
                    {letterbox === preset.id && (
                      <Check className="w-3 h-3 text-sf-accent ml-auto" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {currentPreview && !isFullscreen && (
            <button 
              onClick={clearPreview}
              className="p-1 hover:bg-sf-dark-700 rounded transition-colors"
              title="Clear preview"
            >
              <X className="w-4 h-4 text-sf-text-muted" />
            </button>
          )}
          <button 
            onClick={toggleFullscreen}
            className="p-1 hover:bg-sf-dark-700 rounded transition-colors"
            title={isFullscreen ? 'Exit Fullscreen (ESC)' : 'Fullscreen'}
          >
            {isFullscreen ? (
              <Minimize2 className="w-4 h-4 text-sf-text-muted" />
            ) : (
              <Maximize2 className="w-4 h-4 text-sf-text-muted" />
            )}
          </button>
        </div>
      </div>
      
      {/* Preview Area with subtle grid pattern */}
      <div 
        ref={viewportRef}
        className="flex-1 flex items-center justify-center min-h-0 overflow-hidden"
        style={{ 
          cursor: getCursor(),
          backgroundColor: '#121212',
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)
          `,
          backgroundSize: '20px 20px',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        {/* Wrapper for video container and guides overlay */}
        <div className="relative" style={getAspectRatioStyle()}>
          <div 
            ref={containerRef}
            className="relative bg-black overflow-hidden w-full h-full"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${getZoomScale()})`,
              transformOrigin: 'center center',
              transition: isZooming || isPanning ? 'none' : 'transform 0.1s ease-out',
            }}
            onContextMenu={handleContextMenu}
          >
              {/* Timeline Playback Mode */}
            {previewMode === 'timeline' && clips.length > 0 ? (
              <>
                {/* Video Layer Renderer - handles preloading and seamless playback */}
                <VideoLayerRenderer
                  buildVideoTransform={buildVideoTransform}
                  getClipTransform={getClipTransform}
                  transitionInfo={transitionInfo}
                  getTransitionStyles={getTransitionStyles}
                  getTransitionOverlay={getTransitionOverlay}
                />
                
                {/* Timeline Mode Overlay */}
                <div className="absolute top-2 left-2 right-2 flex items-start justify-between pointer-events-none z-50">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="px-2 py-1 bg-sf-accent/80 rounded text-xs text-white flex items-center gap-1">
                      <Film className="w-3 h-3" />
                      Timeline
                    </div>
                    {/* Show timeline resolution */}
                    {timelineSettings && (
                      <div className={`px-2 py-1 rounded text-xs ${timelineSettings.isTimelineSpecific ? 'bg-purple-600/80 text-white' : 'bg-sf-dark-900/80 text-sf-text-muted'}`}>
                        {timelineSettings.width}×{timelineSettings.height} @ {timelineSettings.fps}fps
                      </div>
                    )}
                    {activeLayerClips.length > 1 ? (
                      // Show layer count in multi-layer mode
                      <div className="px-2 py-1 bg-green-600/80 rounded text-xs text-white">
                        {activeLayerClips.length} Layers
                      </div>
                    ) : activeClip ? (
                      <div className="px-2 py-1 bg-sf-dark-900/80 rounded text-xs text-sf-text-muted">
                        {activeClip.name}
                      </div>
                    ) : null}
                    {transitionInfo && (
                      <div className="px-2 py-1 bg-purple-600/80 rounded text-xs text-white capitalize">
                        {transitionInfo.transition?.type?.replace('-', ' ') || 'Dissolve'} {Math.round(transitionInfo.progress * 100)}%
                      </div>
                    )}
                  </div>
                  {currentPreview && (
                    <button 
                      onClick={() => {
                        setPreviewMode('asset')
                        if (timelineIsPlaying) timelineTogglePlay()
                      }}
                      className="px-2 py-1 bg-sf-dark-900/80 hover:bg-sf-dark-700 rounded text-xs text-sf-text-muted pointer-events-auto transition-colors"
                    >
                      View Asset
                    </button>
                  )}
                </div>
              </>
            ) : currentPreview ? (
              <>
                {/* Asset Preview Mode - Video or Image */}
                {currentPreview.type === 'image' ? (
                  <img
                    src={currentPreview.url}
                    alt={currentPreview.name}
                    className="w-full h-full"
                    style={{
                      display: 'block',
                      objectFit: 'contain', // Maintain aspect ratio, letterbox if needed (no stretching)
                    }}
                    onContextMenu={(e) => e.preventDefault()}
                  />
                ) : (
                  <video
                    ref={videoRefA}
                    src={currentPreview.url}
                    className="w-full h-full"
                    style={{
                      display: 'block',
                      objectFit: 'contain', // Maintain aspect ratio, letterbox if needed (no stretching)
                    }}
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onEnded={handleEnded}
                    onPlay={() => setAssetIsPlaying(true)}
                    onPause={() => setAssetIsPlaying(false)}
                    onContextMenu={(e) => e.preventDefault()}
                    controlsList="nodownload nofullscreen noremoteplayback"
                    disablePictureInPicture
                    loop
                  />
                )}
                
                {/* Asset Info Overlay */}
                <div className="absolute top-2 left-2 right-2 flex items-start justify-between pointer-events-none">
                  <div className="px-2 py-1 bg-sf-dark-900/80 rounded text-xs text-sf-text-muted">
                    {currentPreview.type === 'image' ? 'Image' : (currentPreview.settings?.resolution || '1280x720')}
                  </div>
                  <div className="flex gap-2 pointer-events-auto">
                    <button 
                      className={`px-2 py-1 rounded text-xs text-white font-medium flex items-center gap-1 transition-colors ${
                        justAdded 
                          ? 'bg-sf-success' 
                          : 'bg-sf-accent/90 hover:bg-sf-accent'
                      }`}
                      onClick={handleAddToTimeline}
                    >
                      {justAdded ? (
                        <>
                          <Check className="w-3 h-3" />
                          Added!
                        </>
                      ) : (
                        <>
                          <Plus className="w-3 h-3" />
                          Add to Timeline
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Prompt Overlay (bottom) - only for AI-generated assets */}
                {currentPreview.prompt && (
                  <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/80 to-transparent pointer-events-none">
                    <p className="text-xs text-white/80 line-clamp-2">
                      {currentPreview.prompt}
                    </p>
                  </div>
                )}
              </>
            ) : (
              /* Empty State */
              <div className="w-full h-full flex flex-col items-center justify-center text-sf-text-muted">
                <div className="text-6xl mb-4">🎬</div>
                <p className="text-sm">No Preview Selected</p>
                <p className="text-xs mt-1 text-sf-text-muted">
                  Generate a video or select from Assets
                </p>
                {clips.length > 0 && (
                  <button 
                    onClick={() => {
                      setPreviewMode('timeline')
                      setPlayheadPosition(0)
                    }}
                    className="mt-3 px-3 py-1.5 bg-sf-blue hover:bg-sf-blue-hover rounded text-xs text-white flex items-center gap-1 transition-colors"
                  >
                    <Film className="w-3 h-3" />
                    Preview Timeline
                  </button>
                )}
              </div>
            )}
            
            {/* Resolution Indicator (when no content) */}
            {!currentPreview && previewMode !== 'timeline' && timelineSettings && (
              <div className="absolute top-2 left-2 px-2 py-0.5 bg-sf-dark-900/80 rounded text-xs text-sf-text-muted">
                {timelineSettings.width}×{timelineSettings.height}
              </div>
            )}
          </div>
          
          {/* Safe Guides Overlay - positioned outside the transformed container */}
          {renderSafeGuides()}
        </div>
      </div>
      
      {/* Fullscreen Transport Controls */}
      {isFullscreen && (
        <div className="h-12 bg-sf-dark-900 border-t border-sf-dark-700 flex items-center px-4 flex-shrink-0">
          {/* Left spacer */}
          <div className="flex-1" />
          
          {/* Center controls */}
          <div className="flex items-center gap-3">
            {/* Skip to Start */}
            <button 
              onClick={goToStart}
              className="p-2 hover:bg-sf-dark-700 rounded transition-colors"
              disabled={!hasContent}
              title="Go to Start"
            >
              <SkipBack className="w-5 h-5 text-sf-text-secondary" />
            </button>
            
            {/* Play/Pause */}
            <button 
              onClick={togglePlay}
              className={`p-3 rounded-full transition-colors ${
                hasContent 
                  ? 'bg-sf-blue hover:bg-sf-blue-hover' 
                  : 'bg-sf-dark-600 cursor-not-allowed'
              }`}
              disabled={!hasContent}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 text-white" />
              ) : (
                <Play className="w-5 h-5 text-white ml-0.5" />
              )}
            </button>
            
            {/* Skip to End */}
            <button 
              onClick={goToEnd}
              className="p-2 hover:bg-sf-dark-700 rounded transition-colors"
              disabled={!hasContent}
              title="Go to End"
            >
              <SkipForward className="w-5 h-5 text-sf-text-secondary" />
            </button>
            
            {/* Timecode */}
            <div className="flex items-center gap-2 text-sm text-sf-text-secondary font-mono ml-4">
              <span>{formatTime(currentTime)}</span>
              <span className="text-sf-text-muted">/</span>
              <span className="text-sf-text-muted">{formatTime(duration)}</span>
            </div>
          </div>
          
          {/* Right side - volume */}
          <div className="flex-1 flex items-center justify-end gap-2">
            <Volume2 className="w-5 h-5 text-sf-text-muted" />
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              className="w-24 h-1.5 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
            />
          </div>
        </div>
      )}
      
      {/* Zoom Controls Bar */}
      <div className="h-8 bg-sf-dark-900 border-t border-sf-dark-700 flex items-center justify-center gap-2 px-3 flex-shrink-0">
        {/* Home/Reset button */}
        <button
          onClick={resetView}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          title="Reset View (Home)"
        >
          <Home className="w-3.5 h-3.5 text-sf-text-secondary" />
        </button>
        
        <div className="w-px h-4 bg-sf-dark-600" />
        
        {/* Zoom out */}
        <button
          onClick={zoomOut}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          title="Zoom Out"
        >
          <ZoomOut className="w-3.5 h-3.5 text-sf-text-secondary" />
        </button>
        
        {/* Zoom dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowZoomDropdown(!showZoomDropdown)}
            className="px-2 py-1 hover:bg-sf-dark-700 rounded transition-colors min-w-[50px] text-center"
          >
            <span className="text-xs text-sf-text-primary font-mono">{getZoomLabel()}</span>
          </button>
          
          {showZoomDropdown && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 bg-sf-dark-800 border border-sf-dark-600 rounded shadow-lg py-1 z-50">
              {ZOOM_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  onClick={() => {
                    setZoom(preset.value)
                    setPan({ x: 0, y: 0 })
                    setShowZoomDropdown(false)
                  }}
                  className={`w-full px-3 py-1 text-xs text-left hover:bg-sf-dark-700 transition-colors ${
                    zoom === preset.value ? 'text-sf-accent' : 'text-sf-text-secondary'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
        </div>
        
        {/* Zoom in */}
        <button
          onClick={zoomIn}
          className="p-1.5 hover:bg-sf-dark-700 rounded transition-colors"
          title="Zoom In"
        >
          <ZoomIn className="w-3.5 h-3.5 text-sf-text-secondary" />
        </button>
        
        <div className="w-px h-4 bg-sf-dark-600" />
        
        {/* Pan indicator */}
        <div className="flex items-center gap-1 text-[10px] text-sf-text-muted">
          <Move className="w-3 h-3" />
          <span>Space+Drag</span>
        </div>
        
        <div className="w-px h-4 bg-sf-dark-600" />
        
        {/* Zoom indicator */}
        <div className="flex items-center gap-1 text-[10px] text-sf-text-muted">
          <ZoomIn className="w-3 h-3" />
          <span>Space+Ctrl+Drag L/R</span>
        </div>
      </div>
      
      {/* Context Menu (Portal) */}
      {contextMenu && (
        <div
          className="fixed z-50 bg-sf-dark-800 border border-sf-dark-600 rounded-lg shadow-xl py-1 min-w-[150px]"
          style={{ 
            left: `${contextMenu.x}px`, 
            top: `${contextMenu.y}px`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => handleContextAction('play')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
          >
            {isPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>Play</span>
              </>
            )}
            <span className="ml-auto text-sf-text-muted text-[10px]">Space</span>
          </button>
          
          <div className="h-px bg-sf-dark-600 my-1" />
          
          {currentPreview && previewMode === 'asset' && (
            <>
              <button
                onClick={() => handleContextAction('add-to-timeline')}
                className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add to Timeline</span>
              </button>
              <div className="h-px bg-sf-dark-600 my-1" />
            </>
          )}
          
          <button
            onClick={() => handleContextAction('zoom-fit')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
          >
            <Home className="w-3.5 h-3.5" />
            <span>Fit to View</span>
          </button>
          
          <button
            onClick={() => handleContextAction('zoom-100')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
          >
            <ZoomIn className="w-3.5 h-3.5" />
            <span>Zoom 100%</span>
          </button>
          
          <div className="h-px bg-sf-dark-600 my-1" />
          
          <button
            onClick={() => handleContextAction('fullscreen')}
            className="w-full px-3 py-1.5 text-left text-xs text-sf-text-primary hover:bg-sf-dark-700 flex items-center gap-2 transition-colors"
          >
            {isFullscreen ? (
              <>
                <Minimize2 className="w-3.5 h-3.5" />
                <span>Exit Fullscreen</span>
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5" />
                <span>Fullscreen</span>
              </>
            )}
            <span className="ml-auto text-sf-text-muted text-[10px]">F</span>
          </button>
        </div>
      )}
    </div>
  )
}

export default PreviewPanel
