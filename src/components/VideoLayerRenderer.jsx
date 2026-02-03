import { useEffect, useRef, useCallback, useState, memo } from 'react'
import useTimelineStore from '../stores/timelineStore'
import videoCache from '../services/videoCache'

/**
 * VideoLayerRenderer - Renders video layers with preloading for seamless playback
 * 
 * This component handles:
 * - Preloading upcoming clips before they're needed
 * - Seamless transitions between adjacent clips (no black flicker)
 * - Multi-layer compositing with cached videos
 * - Proper sync between timeline position and video playback
 */

// How far ahead to preload (in seconds)
const PRELOAD_LOOKAHEAD = 2.5

/**
 * Single video layer component - renders one video with transforms
 */
const VideoLayer = memo(function VideoLayer({ 
  clip, 
  track, 
  layerIndex, 
  totalLayers,
  playheadPosition, 
  isPlaying,
  buildVideoTransform,
  getClipTransform,
}) {
  const videoRef = useRef(null)
  const [isReady, setIsReady] = useState(false)
  const lastSyncTime = useRef(0)
  
  // Get cached video element on mount
  useEffect(() => {
    if (!clip?.url) return
    
    // Get or create cached video for this clip
    const cachedVideo = videoCache.getVideoElement(clip)
    if (cachedVideo && videoRef.current) {
      // Copy source from cached video if different
      if (videoRef.current.src !== clip.url) {
        videoRef.current.src = clip.url
      }
    }
  }, [clip?.url, clip?.id])

  // Sync video playback with timeline
  useEffect(() => {
    if (!videoRef.current || !clip) return
    
    const video = videoRef.current
    const clipTime = (clip.trimStart || 0) + (playheadPosition - clip.startTime)
    
    // Clamp clipTime to valid range
    const clampedTime = Math.max(0, Math.min(clipTime, clip.sourceDuration || clip.duration))
    
    // Only seek if significantly different to avoid stuttering
    // Use smaller threshold for smoother scrubbing
    const timeDiff = Math.abs(video.currentTime - clampedTime)
    if (timeDiff > 0.08) {
      video.currentTime = clampedTime
      lastSyncTime.current = playheadPosition
    }
    
    // Sync play/pause state
    if (isPlaying) {
      if (video.paused && video.readyState >= 2) {
        video.play().catch(() => {})
      }
    } else {
      if (!video.paused) {
        video.pause()
      }
    }
  }, [clip, playheadPosition, isPlaying])

  // Handle video ready state
  const handleCanPlay = useCallback(() => {
    setIsReady(true)
  }, [])

  const handleWaiting = useCallback(() => {
    setIsReady(false)
  }, [])

  if (!clip) return null

  const transform = getClipTransform(clip)
  const transformStyle = buildVideoTransform(transform)
  
  // First layer (bottom) can have audio in single-layer mode
  const shouldMute = layerIndex > 0 || totalLayers > 1

  return (
    <video
      ref={videoRef}
      className="bg-transparent w-full h-full"
      style={{
        objectFit: 'contain', // Maintain aspect ratio, letterbox if needed (no stretching/squeezing)
        display: 'block',
        position: layerIndex === 0 ? 'relative' : 'absolute',
        top: 0,
        left: 0,
        zIndex: layerIndex + 1,
        // Apply clip transforms
        ...transformStyle,
      }}
      muted={shouldMute}
      loop={false}
      playsInline
      preload="auto"
      onCanPlay={handleCanPlay}
      onCanPlayThrough={handleCanPlay}
      onWaiting={handleWaiting}
      onContextMenu={(e) => e.preventDefault()}
      controlsList="nodownload nofullscreen noremoteplayback"
      disablePictureInPicture
    />
  )
})

/**
 * Image layer component - renders static image with transforms
 */
const ImageLayer = memo(function ImageLayer({ 
  clip, 
  track, 
  layerIndex, 
  totalLayers,
  buildVideoTransform,
  getClipTransform,
}) {
  if (!clip?.url) return null

  const transform = getClipTransform(clip)
  const transformStyle = buildVideoTransform(transform)

  return (
    <img
      src={clip.url}
      alt={clip.name || 'Image'}
      className="bg-transparent w-full h-full"
      style={{
        objectFit: 'contain', // Maintain aspect ratio, letterbox if needed
        display: 'block',
        position: layerIndex === 0 ? 'relative' : 'absolute',
        top: 0,
        left: 0,
        zIndex: layerIndex + 1,
        // Apply clip transforms
        ...transformStyle,
      }}
      onContextMenu={(e) => e.preventDefault()}
      draggable={false}
    />
  )
})

/**
 * Text layer component - renders text overlay with transforms
 */
const TextLayer = memo(function TextLayer({
  clip,
  track,
  layerIndex,
  totalLayers,
  buildVideoTransform,
  getClipTransform,
}) {
  if (!clip || clip.type !== 'text') return null
  
  const transform = getClipTransform(clip)
  const transformStyle = buildVideoTransform(transform)
  const textProps = clip.textProperties || {}
  
  // Build text styles from textProperties
  const textStyle = {
    fontFamily: textProps.fontFamily || 'Inter',
    fontSize: `${textProps.fontSize || 64}px`,
    fontWeight: textProps.fontWeight || 'bold',
    fontStyle: textProps.fontStyle || 'normal',
    color: textProps.textColor || '#FFFFFF',
    textAlign: textProps.textAlign || 'center',
    letterSpacing: textProps.letterSpacing ? `${textProps.letterSpacing}px` : 'normal',
    lineHeight: textProps.lineHeight || 1.2,
    // Text stroke
    WebkitTextStroke: textProps.strokeWidth > 0 
      ? `${textProps.strokeWidth}px ${textProps.strokeColor || '#000000'}`
      : 'none',
    paintOrder: 'stroke fill',
    // Text shadow
    textShadow: textProps.shadow 
      ? `${textProps.shadowOffsetX || 2}px ${textProps.shadowOffsetY || 2}px ${textProps.shadowBlur || 4}px ${textProps.shadowColor || 'rgba(0,0,0,0.5)'}`
      : 'none',
  }
  
  // Background style
  const backgroundStyle = textProps.backgroundOpacity > 0 
    ? {
        backgroundColor: textProps.backgroundColor || '#000000',
        opacity: textProps.backgroundOpacity / 100,
        padding: `${textProps.backgroundPadding || 20}px`,
        borderRadius: '8px',
      }
    : {}
  
  // Vertical alignment
  const getVerticalAlign = () => {
    switch (textProps.verticalAlign) {
      case 'top': return 'flex-start'
      case 'bottom': return 'flex-end'
      default: return 'center'
    }
  }

  return (
    <div
      className="absolute inset-0 flex items-center justify-center pointer-events-none"
      style={{
        zIndex: layerIndex + 10, // Text layers render on top of video
        alignItems: getVerticalAlign(),
        ...transformStyle,
      }}
    >
      <div 
        className="relative"
        style={backgroundStyle}
      >
        <span 
          style={textStyle}
          className="whitespace-pre-wrap"
        >
          {textProps.text || 'Sample Text'}
        </span>
      </div>
    </div>
  )
})

/**
 * Main VideoLayerRenderer component
 */
function VideoLayerRenderer({
  buildVideoTransform,
  getClipTransform,
  transitionInfo,
  getTransitionStyles,
  getTransitionOverlay,
}) {
  const containerRef = useRef(null)
  const preloadTimerRef = useRef(null)
  const lastPreloadPosition = useRef(0)
  
  // Track preloaded clip IDs to avoid redundant work
  const preloadedClips = useRef(new Set())
  
  const {
    clips,
    tracks,
    isPlaying,
    playheadPosition,
    playbackRate,
    getActiveClipsAtTime,
  } = useTimelineStore()
  
  // State for active layer clips
  const [activeLayerClips, setActiveLayerClips] = useState([])

  /**
   * Get clips that should be preloaded based on current position
   */
  const getClipsToPreload = useCallback((currentTime) => {
    const isForward = playbackRate >= 0
    const lookaheadEnd = currentTime + (isForward ? PRELOAD_LOOKAHEAD : -PRELOAD_LOOKAHEAD)
    
    // Find video clips that:
    // 1. Are currently active
    // 2. Will become active within lookahead window
    const videoTracks = tracks.filter(t => t.type === 'video')
    const videoTrackIds = new Set(videoTracks.map(t => t.id))
    
    const relevantClips = clips.filter(clip => {
      if (!videoTrackIds.has(clip.trackId)) return false
      
      const clipEnd = clip.startTime + clip.duration
      
      // Currently active
      if (currentTime >= clip.startTime && currentTime < clipEnd) {
        return true
      }
      
      // Will become active soon (forward)
      if (isForward && clip.startTime > currentTime && clip.startTime <= lookaheadEnd) {
        return true
      }
      
      // Will become active soon (reverse)
      if (!isForward && clipEnd < currentTime && clipEnd >= lookaheadEnd) {
        return true
      }
      
      return false
    })
    
    return relevantClips
  }, [clips, tracks, playbackRate])

  /**
   * Preload upcoming clips
   */
  const preloadUpcoming = useCallback(() => {
    const clipsToPreload = getClipsToPreload(playheadPosition)
    
    clipsToPreload.forEach(clip => {
      if (!preloadedClips.current.has(clip.id)) {
        // Request preload from cache
        videoCache.getVideoElement(clip, true)
        preloadedClips.current.add(clip.id)
      }
    })
    
    // Also use the cache's built-in preloader
    videoCache.preloadUpcoming(clips, playheadPosition, playbackRate)
    
    lastPreloadPosition.current = playheadPosition
  }, [clips, playheadPosition, playbackRate, getClipsToPreload])

  // Update active layer clips when playhead moves OR when clips change (for real-time text editing)
  useEffect(() => {
    // Get all video clips at current time
    const allActiveClips = getActiveClipsAtTime(playheadPosition)
    const videoClips = allActiveClips.filter(({ track }) => track.type === 'video')
    
    // Sort by track index (higher index = lower in stack, first rendered)
    // Video 1 on top of Video 2
    const sortedClips = [...videoClips].sort((a, b) => {
      const indexA = tracks.findIndex(t => t.id === a.track.id)
      const indexB = tracks.findIndex(t => t.id === b.track.id)
      return indexB - indexA
    })
    
    setActiveLayerClips(sortedClips)
  }, [playheadPosition, getActiveClipsAtTime, tracks, clips])

  // Preload on position change (throttled)
  useEffect(() => {
    // Preload when position changes by more than 0.3 seconds
    if (Math.abs(playheadPosition - lastPreloadPosition.current) > 0.3) {
      preloadUpcoming()
    }
  }, [playheadPosition, preloadUpcoming])

  // Set up preload interval during playback
  useEffect(() => {
    if (isPlaying) {
      // Preload frequently during playback
      preloadTimerRef.current = setInterval(() => {
        preloadUpcoming()
      }, 250)
      
      // Initial preload
      preloadUpcoming()
    } else {
      if (preloadTimerRef.current) {
        clearInterval(preloadTimerRef.current)
        preloadTimerRef.current = null
      }
      // Pause all cached videos when timeline stops
      videoCache.pauseAll()
    }

    return () => {
      if (preloadTimerRef.current) {
        clearInterval(preloadTimerRef.current)
      }
    }
  }, [isPlaying, preloadUpcoming])

  // Clean up preloaded set periodically to allow re-preloading
  useEffect(() => {
    const cleanup = setInterval(() => {
      // Keep only clips that are within a larger window
      const keepWindow = PRELOAD_LOOKAHEAD * 3
      preloadedClips.current = new Set(
        [...preloadedClips.current].filter(clipId => {
          const clip = clips.find(c => c.id === clipId)
          if (!clip) return false
          const clipEnd = clip.startTime + clip.duration
          return (
            Math.abs(clip.startTime - playheadPosition) < keepWindow ||
            Math.abs(clipEnd - playheadPosition) < keepWindow
          )
        })
      )
    }, 5000)
    
    return () => clearInterval(cleanup)
  }, [clips, playheadPosition])

  // Handle no active clips
  if (activeLayerClips.length === 0 && !transitionInfo) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black">
        <span className="text-sf-text-muted text-sm">No clip at this position</span>
      </div>
    )
  }

  // Render transition if active
  if (transitionInfo) {
    const { clipA, clipB } = transitionInfo
    
    return (
      <div ref={containerRef} className="relative w-full h-full">
        {/* Video A (outgoing) */}
        <VideoLayer
          clip={clipA}
          track={tracks.find(t => t.id === clipA.trackId)}
          layerIndex={0}
          totalLayers={2}
          playheadPosition={playheadPosition}
          isPlaying={isPlaying}
          buildVideoTransform={(transform) => ({
            ...buildVideoTransform(transform),
            ...getTransitionStyles(transitionInfo, true),
          })}
          getClipTransform={getClipTransform}
        />
        
        {/* Video B (incoming) */}
        <VideoLayer
          clip={clipB}
          track={tracks.find(t => t.id === clipB.trackId)}
          layerIndex={1}
          totalLayers={2}
          playheadPosition={playheadPosition}
          isPlaying={isPlaying}
          buildVideoTransform={(transform) => ({
            ...buildVideoTransform(transform),
            ...getTransitionStyles(transitionInfo, false),
          })}
          getClipTransform={getClipTransform}
        />
        
        {/* Transition overlay (for fade effects) */}
        {getTransitionOverlay(transitionInfo)}
      </div>
    )
  }

  // Separate video, image, and text clips
  const videoClips = activeLayerClips.filter(({ clip }) => clip.type === 'video')
  const imageClips = activeLayerClips.filter(({ clip }) => clip.type === 'image')
  const textClips = activeLayerClips.filter(({ clip }) => clip.type === 'text')
  
  // Combined video and image layers (both render in the same z-order space)
  const mediaClips = activeLayerClips.filter(({ clip }) => clip.type === 'video' || clip.type === 'image')

  // Render multi-layer composition
  return (
    <div ref={containerRef} className="relative w-full h-full">
      {/* Video/Image layers */}
      {mediaClips.map(({ clip, track }, index) => (
        clip.type === 'image' ? (
          <ImageLayer
            key={`img-${track.id}-${clip.id}`}
            clip={clip}
            track={track}
            layerIndex={index}
            totalLayers={mediaClips.length}
            buildVideoTransform={buildVideoTransform}
            getClipTransform={getClipTransform}
          />
        ) : (
          <VideoLayer
            key={`${track.id}-${clip.id}`}
            clip={clip}
            track={track}
            layerIndex={index}
            totalLayers={mediaClips.length}
            playheadPosition={playheadPosition}
            isPlaying={isPlaying}
            buildVideoTransform={buildVideoTransform}
            getClipTransform={getClipTransform}
          />
        )
      ))}
      
      {/* Text layers (rendered on top) */}
      {textClips.map(({ clip, track }, index) => (
        <TextLayer
          key={`text-${track.id}-${clip.id}`}
          clip={clip}
          track={track}
          layerIndex={index}
          totalLayers={textClips.length}
          buildVideoTransform={buildVideoTransform}
          getClipTransform={getClipTransform}
        />
      ))}
    </div>
  )
}

export default memo(VideoLayerRenderer)
