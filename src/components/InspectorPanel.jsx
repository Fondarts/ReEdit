import { useState, useCallback, useRef, useEffect } from 'react'
import { 
  Move, RotateCw, Maximize2, Clock, Layers, Volume2, 
  ChevronDown, ChevronRight, ChevronLeft, Sparkles, Film,
  Zap, Eye, SlidersHorizontal,
  FlipHorizontal, FlipVertical, Link, Unlink, Crop,
  Anchor, RotateCcw, Type, AlignLeft, AlignCenter, AlignRight,
  AlignVerticalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd
} from 'lucide-react'
import useTimelineStore from '../stores/timelineStore'

// Draggable number input component - click and drag to change value
function DraggableNumberInput({ value, onChange, onCommit, min, max, step = 1, sensitivity = 0.5, suffix = '', className = '' }) {
  const [isDragging, setIsDragging] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(value.toString())
  const startX = useRef(0)
  const startValue = useRef(0)
  const inputRef = useRef(null)
  
  // Update edit value when value changes externally
  useEffect(() => {
    if (!isEditing) {
      setEditValue(value.toString())
    }
  }, [value, isEditing])
  
  // Handle drag
  useEffect(() => {
    if (!isDragging) return
    
    const handleMouseMove = (e) => {
      const deltaX = e.clientX - startX.current
      let newValue = startValue.current + (deltaX * sensitivity * step)
      
      // Apply min/max constraints
      if (min !== undefined) newValue = Math.max(min, newValue)
      if (max !== undefined) newValue = Math.min(max, newValue)
      
      // Round to step
      newValue = Math.round(newValue / step) * step
      
      onChange(newValue)
    }
    
    const handleMouseUp = () => {
      setIsDragging(false)
      onCommit && onCommit(value)
    }
    
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDragging, onChange, onCommit, value, min, max, step, sensitivity])
  
  const handleMouseDown = (e) => {
    if (isEditing) return
    e.preventDefault()
    startX.current = e.clientX
    startValue.current = value
    setIsDragging(true)
  }
  
  const handleDoubleClick = () => {
    setIsEditing(true)
    setEditValue(value.toString())
    setTimeout(() => inputRef.current?.select(), 0)
  }
  
  const handleInputBlur = () => {
    setIsEditing(false)
    let newValue = parseFloat(editValue) || 0
    if (min !== undefined) newValue = Math.max(min, newValue)
    if (max !== undefined) newValue = Math.min(max, newValue)
    onChange(newValue)
    onCommit && onCommit(newValue)
  }
  
  const handleInputKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleInputBlur()
    } else if (e.key === 'Escape') {
      setIsEditing(false)
      setEditValue(value.toString())
    }
  }
  
  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="number"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleInputBlur}
        onKeyDown={handleInputKeyDown}
        autoFocus
        className={`w-full bg-sf-dark-700 border border-sf-accent rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none ${className}`}
      />
    )
  }
  
  return (
    <div
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      className={`w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary cursor-ew-resize select-none hover:border-sf-dark-500 transition-colors ${className}`}
      title="Drag to adjust, double-click to edit"
    >
      {Math.round(value * 100) / 100}{suffix}
    </div>
  )
}

// Available fonts for text clips
const FONT_OPTIONS = [
  'Inter', 'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 
  'Courier New', 'Verdana', 'Impact', 'Comic Sans MS', 'Trebuchet MS'
]

function InspectorPanel({ isExpanded, onToggleExpanded }) {
  const [expandedSections, setExpandedSections] = useState(['transform', 'crop', 'timing', 'effects', 'text', 'style'])
  
  // Get selected clip from timeline store
  const { 
    selectedClipIds, 
    clips, 
    tracks,
    updateClipTransform, 
    resetClipTransform,
    updateTextProperties,
    removeClip,
    resizeClip
  } = useTimelineStore()
  
  // Get the first selected clip (for now, single selection for inspector)
  const selectedClip = selectedClipIds.length > 0 
    ? clips.find(c => c.id === selectedClipIds[0]) 
    : null
  
  // Get track info for the selected clip
  const selectedTrack = selectedClip 
    ? tracks.find(t => t.id === selectedClip.trackId) 
    : null
  
  // Check if it's a video, text, or audio clip
  const isTextClip = selectedClip?.type === 'text'
  const isVideoClip = selectedTrack?.type === 'video' && !isTextClip
  const isAudioClip = selectedTrack?.type === 'audio'
  
  // Get transform with defaults for legacy clips
  const getTransform = useCallback(() => {
    if (!selectedClip) return null
    return selectedClip.transform || {
      positionX: 0, positionY: 0,
      scaleX: 100, scaleY: 100, scaleLinked: true,
      rotation: 0, anchorX: 50, anchorY: 50, opacity: 100,
      flipH: false, flipV: false,
      cropTop: 0, cropBottom: 0, cropLeft: 0, cropRight: 0,
    }
  }, [selectedClip])
  
  const transform = getTransform()
  
  // Update transform handler (doesn't save to history for realtime sliders)
  const handleTransformChange = useCallback((key, value) => {
    if (!selectedClip) return
    updateClipTransform(selectedClip.id, { [key]: value }, false)
  }, [selectedClip, updateClipTransform])
  
  // Save to history when user finishes editing (on blur or mouse up)
  const handleTransformCommit = useCallback((key, value) => {
    if (!selectedClip) return
    updateClipTransform(selectedClip.id, { [key]: value }, true)
  }, [selectedClip, updateClipTransform])
  
  // Reset all transform
  const handleResetTransform = useCallback(() => {
    if (!selectedClip) return
    resetClipTransform(selectedClip.id)
  }, [selectedClip, resetClipTransform])
  
  // Legacy audio data state (for audio clips - will be connected to real data later)
  const [audioData, setAudioData] = useState({
    volume: 100,
    fadeIn: 0,
    fadeOut: 0,
    pan: 0
  })

  const toggleSection = (section) => {
    setExpandedSections(prev => 
      prev.includes(section) 
        ? prev.filter(s => s !== section)
        : [...prev, section]
    )
  }

  const renderSectionHeader = (id, title, icon) => {
    const Icon = icon
    const isSectionExpanded = expandedSections.includes(id)
    return (
      <button
        onClick={() => toggleSection(id)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-sf-dark-800 hover:bg-sf-dark-700 transition-colors"
      >
        {isSectionExpanded ? (
          <ChevronDown className="w-3 h-3 text-sf-text-muted" />
        ) : (
          <ChevronRight className="w-3 h-3 text-sf-text-muted" />
        )}
        <Icon className="w-4 h-4 text-sf-text-muted" />
        <span className="text-xs font-medium text-sf-text-primary uppercase tracking-wider">{title}</span>
      </button>
    )
  }

  // Render Video Clip Inspector (with 2D transforms)
  const renderVideoClipInspector = () => {
    if (!selectedClip || !transform) return null
    
    return (
      <>
        {/* Clip Info Header */}
        <div className="p-3 border-b border-sf-dark-700">
          <div className="flex items-center gap-2 mb-2">
            <div 
              className="w-8 h-8 rounded flex items-center justify-center"
              style={{ backgroundColor: selectedClip.color || '#5a7a9e' }}
            >
              <Film className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sf-text-primary truncate">
                {selectedClip.name}
              </p>
              <p className="text-[10px] text-sf-text-muted">
                {selectedTrack?.name || 'Unknown Track'} • {selectedClip.duration?.toFixed(2)}s
              </p>
            </div>
          </div>
          
          {/* Reset Transform Button */}
          <button 
            onClick={handleResetTransform}
            className="w-full py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-[11px] text-sf-text-secondary hover:text-sf-text-primary transition-colors flex items-center justify-center gap-1.5"
            title="Reset all transform properties to default"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Transform
          </button>
        </div>

        {/* Transform Section */}
        {renderSectionHeader('transform', 'Transform', Move)}
        {expandedSections.includes('transform') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            {/* Position */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5 flex items-center gap-1">
                <Move className="w-3 h-3" /> Position
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] text-sf-text-muted block mb-0.5">X</label>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={transform.positionX}
                      onChange={(val) => handleTransformChange('positionX', val)}
                      onCommit={(val) => handleTransformCommit('positionX', val)}
                      step={1}
                      sensitivity={1}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                  </div>
                </div>
                <div>
                  <label className="text-[9px] text-sf-text-muted block mb-0.5">Y</label>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={transform.positionY}
                      onChange={(val) => handleTransformChange('positionY', val)}
                      onCommit={(val) => handleTransformCommit('positionY', val)}
                      step={1}
                      sensitivity={1}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Scale with Link toggle */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <Maximize2 className="w-3 h-3" /> Scale
                </label>
                <button
                  onClick={() => handleTransformCommit('scaleLinked', !transform.scaleLinked)}
                  className={`p-1 rounded transition-colors ${transform.scaleLinked ? 'bg-sf-accent/30 text-sf-accent' : 'hover:bg-sf-dark-700 text-sf-text-muted'}`}
                  title={transform.scaleLinked ? 'Unlink X/Y Scale' : 'Link X/Y Scale'}
                >
                  {transform.scaleLinked ? <Link className="w-3 h-3" /> : <Unlink className="w-3 h-3" />}
                </button>
              </div>
              
              {transform.scaleLinked ? (
                // Single scale slider when linked
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-[9px] text-sf-text-muted">Uniform</span>
                    <span className="text-[10px] text-sf-text-secondary">{transform.scaleX}%</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="400"
                    value={transform.scaleX}
                    onChange={(e) => handleTransformChange('scaleX', parseInt(e.target.value))}
                    onMouseUp={(e) => handleTransformCommit('scaleX', parseInt(e.target.value))}
                    className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                  />
                </div>
              ) : (
                // Separate X/Y sliders when unlinked
                <div className="space-y-2">
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-[9px] text-sf-text-muted">Width (X)</span>
                      <span className="text-[10px] text-sf-text-secondary">{transform.scaleX}%</span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="400"
                      value={transform.scaleX}
                      onChange={(e) => handleTransformChange('scaleX', parseInt(e.target.value))}
                      onMouseUp={(e) => handleTransformCommit('scaleX', parseInt(e.target.value))}
                      className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-[9px] text-sf-text-muted">Height (Y)</span>
                      <span className="text-[10px] text-sf-text-secondary">{transform.scaleY}%</span>
                    </div>
                    <input
                      type="range"
                      min="10"
                      max="400"
                      value={transform.scaleY}
                      onChange={(e) => handleTransformChange('scaleY', parseInt(e.target.value))}
                      onMouseUp={(e) => handleTransformCommit('scaleY', parseInt(e.target.value))}
                      className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Rotation */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <RotateCw className="w-3 h-3" /> Rotation
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={transform.rotation}
                    onChange={(e) => handleTransformChange('rotation', parseFloat(e.target.value) || 0)}
                    onBlur={(e) => handleTransformCommit('rotation', parseFloat(e.target.value) || 0)}
                    className="w-14 bg-sf-dark-700 border border-sf-dark-600 rounded px-1.5 py-0.5 text-[10px] text-sf-text-primary focus:outline-none focus:border-sf-accent text-right"
                  />
                  <span className="text-[10px] text-sf-text-secondary">°</span>
                </div>
              </div>
              <input
                type="range"
                min="-180"
                max="180"
                value={transform.rotation}
                onChange={(e) => handleTransformChange('rotation', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('rotation', parseInt(e.target.value))}
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            {/* Flip Controls */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5">Flip</label>
              <div className="flex gap-2">
                <button
                  onClick={() => handleTransformCommit('flipH', !transform.flipH)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs transition-colors ${
                    transform.flipH 
                      ? 'bg-sf-accent text-white' 
                      : 'bg-sf-dark-700 text-sf-text-secondary hover:bg-sf-dark-600'
                  }`}
                >
                  <FlipHorizontal className="w-3.5 h-3.5" />
                  Horizontal
                </button>
                <button
                  onClick={() => handleTransformCommit('flipV', !transform.flipV)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs transition-colors ${
                    transform.flipV 
                      ? 'bg-sf-accent text-white' 
                      : 'bg-sf-dark-700 text-sf-text-secondary hover:bg-sf-dark-600'
                  }`}
                >
                  <FlipVertical className="w-3.5 h-3.5" />
                  Vertical
                </button>
              </div>
            </div>

            {/* Opacity */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <Eye className="w-3 h-3" /> Opacity
                </label>
                <span className="text-[10px] text-sf-text-secondary">{transform.opacity}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={transform.opacity}
                onChange={(e) => handleTransformChange('opacity', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('opacity', parseInt(e.target.value))}
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            {/* Anchor Point */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5 flex items-center gap-1">
                <Anchor className="w-3 h-3" /> Anchor Point
              </label>
              <div className="grid grid-cols-3 gap-1">
                {[
                  [0, 0], [50, 0], [100, 0],
                  [0, 50], [50, 50], [100, 50],
                  [0, 100], [50, 100], [100, 100],
                ].map(([x, y], i) => (
                  <button
                    key={i}
                    onClick={() => {
                      handleTransformChange('anchorX', x)
                      handleTransformCommit('anchorY', y)
                    }}
                    className={`h-6 rounded text-[9px] transition-colors ${
                      transform.anchorX === x && transform.anchorY === y
                        ? 'bg-sf-accent text-white'
                        : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                    }`}
                    title={`Anchor ${x}%, ${y}%`}
                  >
                    {x === 50 && y === 50 ? '●' : '○'}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <div>
                  <label className="text-[9px] text-sf-text-muted block mb-0.5">X</label>
                  <DraggableNumberInput
                    value={transform.anchorX}
                    onChange={(val) => handleTransformChange('anchorX', val)}
                    onCommit={(val) => handleTransformCommit('anchorX', val)}
                    min={0}
                    max={100}
                    step={1}
                    sensitivity={0.5}
                  />
                </div>
                <div>
                  <label className="text-[9px] text-sf-text-muted block mb-0.5">Y</label>
                  <DraggableNumberInput
                    value={transform.anchorY}
                    onChange={(val) => handleTransformChange('anchorY', val)}
                    onCommit={(val) => handleTransformCommit('anchorY', val)}
                    min={0}
                    max={100}
                    step={1}
                    sensitivity={0.5}
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Crop Section */}
        {renderSectionHeader('crop', 'Crop', Crop)}
        {expandedSections.includes('crop') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            {/* Visual Crop Preview */}
            <div className="relative w-full aspect-video bg-sf-dark-800 rounded overflow-hidden">
              <div 
                className="absolute bg-sf-dark-600 border border-sf-dark-500"
                style={{
                  left: `${transform.cropLeft}%`,
                  right: `${transform.cropRight}%`,
                  top: `${transform.cropTop}%`,
                  bottom: `${transform.cropBottom}%`,
                }}
              >
                <div className="w-full h-full flex items-center justify-center text-[9px] text-sf-text-muted">
                  Preview
                </div>
              </div>
            </div>

            {/* Crop Sliders */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-[9px] text-sf-text-muted">Top</label>
                  <span className="text-[9px] text-sf-text-secondary">{transform.cropTop}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={transform.cropTop}
                  onChange={(e) => handleTransformChange('cropTop', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropTop', parseInt(e.target.value))}
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-[9px] text-sf-text-muted">Bottom</label>
                  <span className="text-[9px] text-sf-text-secondary">{transform.cropBottom}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={transform.cropBottom}
                  onChange={(e) => handleTransformChange('cropBottom', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropBottom', parseInt(e.target.value))}
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-[9px] text-sf-text-muted">Left</label>
                  <span className="text-[9px] text-sf-text-secondary">{transform.cropLeft}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={transform.cropLeft}
                  onChange={(e) => handleTransformChange('cropLeft', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropLeft', parseInt(e.target.value))}
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <label className="text-[9px] text-sf-text-muted">Right</label>
                  <span className="text-[9px] text-sf-text-secondary">{transform.cropRight}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="50"
                  value={transform.cropRight}
                  onChange={(e) => handleTransformChange('cropRight', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTransformCommit('cropRight', parseInt(e.target.value))}
                  className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
                />
              </div>
            </div>

            <button 
              onClick={() => {
                handleTransformChange('cropTop', 0)
                handleTransformChange('cropBottom', 0)
                handleTransformChange('cropLeft', 0)
                handleTransformCommit('cropRight', 0)
              }}
              className="w-full text-[10px] text-sf-accent hover:text-sf-accent-hover transition-colors"
            >
              Reset Crop
            </button>
          </div>
        )}

        {/* Timing Section */}
        {renderSectionHeader('timing', 'Timing', Clock)}
        {expandedSections.includes('timing') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Start Time</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={selectedClip.startTime?.toFixed(2)}
                    disabled
                    className="w-full bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1 text-xs text-sf-text-muted cursor-not-allowed"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Duration</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    value={selectedClip.duration?.toFixed(2)}
                    onChange={(e) => resizeClip(selectedClip.id, parseFloat(e.target.value) || 0.5)}
                    className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Trim Start</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={selectedClip.trimStart?.toFixed(2)}
                    disabled
                    className="w-full bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1 text-xs text-sf-text-muted cursor-not-allowed"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Trim End</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    value={selectedClip.trimEnd?.toFixed(2)}
                    disabled
                    className="w-full bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1 text-xs text-sf-text-muted cursor-not-allowed"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
            </div>

            <div className="text-[9px] text-sf-text-muted">
              Source Duration: {selectedClip.sourceDuration?.toFixed(2)}s
            </div>
          </div>
        )}

        {/* Effects Section */}
        {renderSectionHeader('effects', 'Effects', Zap)}
        {expandedSections.includes('effects') && (
          <div className="p-3 space-y-2 border-b border-sf-dark-700">
            <button className="w-full flex items-center justify-between px-3 py-2 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors">
              <span>Ken Burns (Slow Zoom)</span>
              <ChevronRight className="w-3 h-3" />
            </button>
            <button className="w-full flex items-center justify-between px-3 py-2 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors">
              <span>Camera Shake</span>
              <ChevronRight className="w-3 h-3" />
            </button>
            <button className="w-full flex items-center justify-between px-3 py-2 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-xs text-sf-text-secondary transition-colors">
              <span>Color Grade</span>
              <ChevronRight className="w-3 h-3" />
            </button>
            <button className="w-full py-2 border border-dashed border-sf-dark-600 rounded text-xs text-sf-text-muted hover:border-sf-dark-500 transition-colors">
              + Add Effect
            </button>
          </div>
        )}
      </>
    )
  }

  // Text property handlers
  const handleTextPropertyChange = useCallback((key, value) => {
    if (!selectedClip) return
    updateTextProperties(selectedClip.id, { [key]: value }, false)
  }, [selectedClip, updateTextProperties])
  
  const handleTextPropertyCommit = useCallback((key, value) => {
    if (!selectedClip) return
    updateTextProperties(selectedClip.id, { [key]: value }, true)
  }, [selectedClip, updateTextProperties])

  // Get text properties with defaults
  const getTextProps = useCallback(() => {
    if (!selectedClip || selectedClip.type !== 'text') return null
    return selectedClip.textProperties || {
      text: 'Sample Text',
      fontFamily: 'Inter',
      fontSize: 64,
      fontWeight: 'bold',
      fontStyle: 'normal',
      textColor: '#FFFFFF',
      backgroundColor: '#000000',
      backgroundOpacity: 0,
      backgroundPadding: 20,
      textAlign: 'center',
      verticalAlign: 'center',
      strokeColor: '#000000',
      strokeWidth: 0,
      letterSpacing: 0,
      lineHeight: 1.2,
      shadow: false,
      shadowColor: 'rgba(0,0,0,0.5)',
      shadowBlur: 4,
      shadowOffsetX: 2,
      shadowOffsetY: 2,
    }
  }, [selectedClip])

  // Render Text Clip Inspector
  const renderTextClipInspector = () => {
    if (!selectedClip || !transform) return null
    const textProps = getTextProps()
    if (!textProps) return null
    
    return (
      <>
        {/* Text Clip Info Header */}
        <div className="p-3 border-b border-sf-dark-700">
          <div className="flex items-center gap-2 mb-2">
            <div 
              className="w-8 h-8 rounded flex items-center justify-center bg-amber-500"
            >
              <Type className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sf-text-primary truncate">
                Text Clip
              </p>
              <p className="text-[10px] text-sf-text-muted">
                {selectedTrack?.name || 'Unknown Track'} • {selectedClip.duration?.toFixed(2)}s
              </p>
            </div>
          </div>
          
          {/* Reset Transform Button */}
          <button 
            onClick={handleResetTransform}
            className="w-full py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 rounded text-[11px] text-sf-text-secondary hover:text-sf-text-primary transition-colors flex items-center justify-center gap-1.5"
            title="Reset all transform properties to default"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset Transform
          </button>
        </div>

        {/* Text Content Section */}
        {renderSectionHeader('text', 'Text Content', Type)}
        {expandedSections.includes('text') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            {/* Text Content */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">Content</label>
              <textarea
                value={textProps.text}
                onChange={(e) => handleTextPropertyChange('text', e.target.value)}
                onBlur={(e) => handleTextPropertyCommit('text', e.target.value)}
                className="w-full h-20 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary resize-none focus:outline-none focus:border-sf-accent"
                placeholder="Enter text..."
              />
            </div>

            {/* Font Family */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">Font</label>
              <select
                value={textProps.fontFamily}
                onChange={(e) => handleTextPropertyCommit('fontFamily', e.target.value)}
                className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1.5 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              >
                {FONT_OPTIONS.map(font => (
                  <option key={font} value={font} style={{ fontFamily: font }}>{font}</option>
                ))}
              </select>
            </div>

            {/* Font Size and Weight */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Size</label>
                <DraggableNumberInput
                  value={textProps.fontSize}
                  onChange={(val) => handleTextPropertyChange('fontSize', val)}
                  onCommit={(val) => handleTextPropertyCommit('fontSize', val)}
                  min={8}
                  max={300}
                  step={1}
                  sensitivity={0.5}
                  suffix="px"
                />
              </div>
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Weight</label>
                <select
                  value={textProps.fontWeight}
                  onChange={(e) => handleTextPropertyCommit('fontWeight', e.target.value)}
                  className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                >
                  <option value="normal">Normal</option>
                  <option value="bold">Bold</option>
                  <option value="100">Thin</option>
                  <option value="300">Light</option>
                  <option value="500">Medium</option>
                  <option value="600">Semi Bold</option>
                  <option value="800">Extra Bold</option>
                </select>
              </div>
            </div>

            {/* Text Alignment */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5">Alignment</label>
              <div className="grid grid-cols-2 gap-2">
                {/* Horizontal */}
                <div className="flex gap-1">
                  {[
                    { value: 'left', icon: AlignLeft },
                    { value: 'center', icon: AlignCenter },
                    { value: 'right', icon: AlignRight },
                  ].map(({ value, icon: Icon }) => (
                    <button
                      key={value}
                      onClick={() => handleTextPropertyCommit('textAlign', value)}
                      className={`flex-1 p-1.5 rounded text-xs transition-colors ${
                        textProps.textAlign === value
                          ? 'bg-sf-accent text-white'
                          : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                      }`}
                      title={`Align ${value}`}
                    >
                      <Icon className="w-3.5 h-3.5 mx-auto" />
                    </button>
                  ))}
                </div>
                {/* Vertical */}
                <div className="flex gap-1">
                  {[
                    { value: 'top', icon: AlignVerticalJustifyStart },
                    { value: 'center', icon: AlignVerticalJustifyCenter },
                    { value: 'bottom', icon: AlignVerticalJustifyEnd },
                  ].map(({ value, icon: Icon }) => (
                    <button
                      key={value}
                      onClick={() => handleTextPropertyCommit('verticalAlign', value)}
                      className={`flex-1 p-1.5 rounded text-xs transition-colors ${
                        textProps.verticalAlign === value
                          ? 'bg-sf-accent text-white'
                          : 'bg-sf-dark-700 text-sf-text-muted hover:bg-sf-dark-600'
                      }`}
                      title={`Vertical ${value}`}
                    >
                      <Icon className="w-3.5 h-3.5 mx-auto" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Colors & Style Section */}
        {renderSectionHeader('style', 'Colors & Style', Sparkles)}
        {expandedSections.includes('style') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            {/* Text Color */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1">Text Color</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  value={textProps.textColor}
                  onChange={(e) => handleTextPropertyChange('textColor', e.target.value)}
                  onBlur={(e) => handleTextPropertyCommit('textColor', e.target.value)}
                  className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="text"
                  value={textProps.textColor}
                  onChange={(e) => handleTextPropertyChange('textColor', e.target.value)}
                  onBlur={(e) => handleTextPropertyCommit('textColor', e.target.value)}
                  className="flex-1 bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                />
              </div>
            </div>

            {/* Stroke */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted">Stroke</label>
                <span className="text-[10px] text-sf-text-secondary">{textProps.strokeWidth}px</span>
              </div>
              <div className="flex gap-2 mb-2">
                <input
                  type="color"
                  value={textProps.strokeColor}
                  onChange={(e) => handleTextPropertyChange('strokeColor', e.target.value)}
                  onBlur={(e) => handleTextPropertyCommit('strokeColor', e.target.value)}
                  className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="range"
                  min="0"
                  max="10"
                  value={textProps.strokeWidth}
                  onChange={(e) => handleTextPropertyChange('strokeWidth', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTextPropertyCommit('strokeWidth', parseInt(e.target.value))}
                  className="flex-1 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent self-center"
                />
              </div>
            </div>

            {/* Background */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted">Background</label>
                <span className="text-[10px] text-sf-text-secondary">{textProps.backgroundOpacity}%</span>
              </div>
              <div className="flex gap-2 mb-2">
                <input
                  type="color"
                  value={textProps.backgroundColor}
                  onChange={(e) => handleTextPropertyChange('backgroundColor', e.target.value)}
                  onBlur={(e) => handleTextPropertyCommit('backgroundColor', e.target.value)}
                  className="w-8 h-8 rounded border border-sf-dark-600 cursor-pointer bg-transparent"
                />
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={textProps.backgroundOpacity}
                  onChange={(e) => handleTextPropertyChange('backgroundOpacity', parseInt(e.target.value))}
                  onMouseUp={(e) => handleTextPropertyCommit('backgroundOpacity', parseInt(e.target.value))}
                  className="flex-1 h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent self-center"
                />
              </div>
            </div>

            {/* Shadow Toggle */}
            <div className="flex items-center gap-2 p-2 bg-sf-dark-800 rounded">
              <input
                type="checkbox"
                id="textShadowInspector"
                checked={textProps.shadow}
                onChange={(e) => handleTextPropertyCommit('shadow', e.target.checked)}
                className="w-3.5 h-3.5 rounded border-sf-dark-600 bg-sf-dark-700 text-sf-accent focus:ring-sf-accent cursor-pointer"
              />
              <label htmlFor="textShadowInspector" className="text-[11px] text-sf-text-secondary cursor-pointer flex-1">
                Drop shadow
              </label>
            </div>
          </div>
        )}

        {/* Transform Section (shared with video) */}
        {renderSectionHeader('transform', 'Transform', Move)}
        {expandedSections.includes('transform') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            {/* Position */}
            <div>
              <label className="text-[10px] text-sf-text-muted block mb-1.5 flex items-center gap-1">
                <Move className="w-3 h-3" /> Position
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] text-sf-text-muted block mb-0.5">X</label>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={transform.positionX}
                      onChange={(val) => handleTransformChange('positionX', val)}
                      onCommit={(val) => handleTransformCommit('positionX', val)}
                      step={1}
                      sensitivity={1}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                  </div>
                </div>
                <div>
                  <label className="text-[9px] text-sf-text-muted block mb-0.5">Y</label>
                  <div className="flex items-center">
                    <DraggableNumberInput
                      value={transform.positionY}
                      onChange={(val) => handleTransformChange('positionY', val)}
                      onCommit={(val) => handleTransformCommit('positionY', val)}
                      step={1}
                      sensitivity={1}
                    />
                    <span className="ml-1 text-[9px] text-sf-text-muted">px</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Scale */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <Maximize2 className="w-3 h-3" /> Scale
                </label>
                <span className="text-[10px] text-sf-text-secondary">{transform.scaleX}%</span>
              </div>
              <input
                type="range"
                min="10"
                max="400"
                value={transform.scaleX}
                onChange={(e) => handleTransformChange('scaleX', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('scaleX', parseInt(e.target.value))}
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            {/* Rotation */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <RotateCw className="w-3 h-3" /> Rotation
                </label>
                <span className="text-[10px] text-sf-text-secondary">{transform.rotation}°</span>
              </div>
              <input
                type="range"
                min="-180"
                max="180"
                value={transform.rotation}
                onChange={(e) => handleTransformChange('rotation', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('rotation', parseInt(e.target.value))}
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>

            {/* Opacity */}
            <div>
              <div className="flex justify-between mb-1">
                <label className="text-[10px] text-sf-text-muted flex items-center gap-1">
                  <Eye className="w-3 h-3" /> Opacity
                </label>
                <span className="text-[10px] text-sf-text-secondary">{transform.opacity}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={transform.opacity}
                onChange={(e) => handleTransformChange('opacity', parseInt(e.target.value))}
                onMouseUp={(e) => handleTransformCommit('opacity', parseInt(e.target.value))}
                className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
              />
            </div>
          </div>
        )}

        {/* Timing Section */}
        {renderSectionHeader('timing', 'Timing', Clock)}
        {expandedSections.includes('timing') && (
          <div className="p-3 space-y-3 border-b border-sf-dark-700">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Start Time</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={selectedClip.startTime?.toFixed(2)}
                    disabled
                    className="w-full bg-sf-dark-800 border border-sf-dark-700 rounded px-2 py-1 text-xs text-sf-text-muted cursor-not-allowed"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
              <div>
                <label className="text-[9px] text-sf-text-muted block mb-1">Duration</label>
                <div className="flex items-center">
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    value={selectedClip.duration?.toFixed(2)}
                    onChange={(e) => resizeClip(selectedClip.id, parseFloat(e.target.value) || 0.5)}
                    className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
                  />
                  <span className="ml-1 text-[9px] text-sf-text-muted">s</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </>
    )
  }

  // Render Audio Inspector
  const renderAudioInspector = () => (
    <>
      {/* Audio Info Header */}
      <div className="p-3 border-b border-sf-dark-700">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-8 h-8 bg-cyan-600 rounded flex items-center justify-center">
            <Volume2 className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <input
              type="text"
              value={audioData.name}
              onChange={(e) => setAudioData({ ...audioData, name: e.target.value })}
              className="w-full bg-transparent text-sm font-medium text-sf-text-primary focus:outline-none"
            />
            <p className="text-[10px] text-sf-text-muted capitalize">{audioData.type}</p>
          </div>
        </div>
      </div>

      {/* Volume & Pan */}
      <div className="p-3 space-y-3 border-b border-sf-dark-700">
        <div>
          <div className="flex justify-between mb-1">
            <label className="text-[10px] text-sf-text-muted">Volume</label>
            <span className="text-[10px] text-sf-text-secondary">{audioData.volume}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={audioData.volume}
            onChange={(e) => setAudioData({ ...audioData, volume: parseInt(e.target.value) })}
            className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
          />
        </div>

        <div>
          <div className="flex justify-between mb-1">
            <label className="text-[10px] text-sf-text-muted">Pan</label>
            <span className="text-[10px] text-sf-text-secondary">
              {audioData.pan === 0 ? 'Center' : audioData.pan < 0 ? `L${Math.abs(audioData.pan)}` : `R${audioData.pan}`}
            </span>
          </div>
          <input
            type="range"
            min="-100"
            max="100"
            value={audioData.pan}
            onChange={(e) => setAudioData({ ...audioData, pan: parseInt(e.target.value) })}
            className="w-full h-1 bg-sf-dark-600 rounded-lg appearance-none cursor-pointer accent-sf-accent"
          />
        </div>
      </div>

      {/* Fades */}
      <div className="p-3 space-y-3 border-b border-sf-dark-700">
        <h4 className="text-[10px] text-sf-text-muted uppercase tracking-wider">Fades</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-sf-text-muted block mb-1">Fade In</label>
            <div className="flex items-center">
              <input
                type="number"
                step="0.1"
                min="0"
                value={audioData.fadeIn}
                onChange={(e) => setAudioData({ ...audioData, fadeIn: parseFloat(e.target.value) })}
                className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              />
              <span className="ml-1 text-[10px] text-sf-text-muted">s</span>
            </div>
          </div>
          <div>
            <label className="text-[10px] text-sf-text-muted block mb-1">Fade Out</label>
            <div className="flex items-center">
              <input
                type="number"
                step="0.1"
                min="0"
                value={audioData.fadeOut}
                onChange={(e) => setAudioData({ ...audioData, fadeOut: parseFloat(e.target.value) })}
                className="w-full bg-sf-dark-700 border border-sf-dark-600 rounded px-2 py-1 text-xs text-sf-text-primary focus:outline-none focus:border-sf-accent"
              />
              <span className="ml-1 text-[10px] text-sf-text-muted">s</span>
            </div>
          </div>
        </div>
      </div>
    </>
  )

  // Empty state
  const renderEmptyState = () => (
    <div className="h-full flex flex-col items-center justify-center text-center p-4">
      <Layers className="w-10 h-10 text-sf-dark-600 mb-3" />
      <h3 className="text-sm font-medium text-sf-text-primary mb-1">No Selection</h3>
      <p className="text-xs text-sf-text-muted">
        Select a clip on the timeline to view and edit its properties
      </p>
    </div>
  )

  // Multi-selection info
  const renderMultiSelectInfo = () => (
    <div className="h-full flex flex-col items-center justify-center text-center p-4">
      <Layers className="w-10 h-10 text-sf-accent mb-3" />
      <h3 className="text-sm font-medium text-sf-text-primary mb-1">
        {selectedClipIds.length} Clips Selected
      </h3>
      <p className="text-xs text-sf-text-muted">
        Select a single clip to edit its transform properties
      </p>
    </div>
  )

  // Content to render
  const renderContent = () => {
    // No selection
    if (selectedClipIds.length === 0) return renderEmptyState()
    
    // Multi-selection (show info only)
    if (selectedClipIds.length > 1) return renderMultiSelectInfo()
    
    // Single selection
    if (isTextClip) return renderTextClipInspector()
    if (isVideoClip) return renderVideoClipInspector()
    if (isAudioClip) return renderAudioInspector()
    
    return renderEmptyState()
  }

  return (
    <div className="h-full flex">
      {/* Content Panel - Collapsible (on the left side of icon bar) */}
      {isExpanded && (
        <div className="flex-1 bg-sf-dark-900 border-l border-sf-dark-700 flex flex-col min-w-0 overflow-hidden">
          {/* Panel Header */}
          <div className="flex-shrink-0 h-9 bg-sf-dark-800 border-b border-sf-dark-700 flex items-center px-3">
            <span className="text-xs font-medium text-sf-text-primary">Inspector</span>
          </div>
          
          {/* Panel Content */}
          <div className="flex-1 overflow-y-auto">
            {renderContent()}
          </div>
        </div>
      )}
      
      {/* Icon Toolbar - Always Visible (on the right edge) */}
      <div className="w-12 flex-shrink-0 bg-sf-dark-950 border-l border-sf-dark-700 flex flex-col">
        {/* Inspector Icon */}
        <div className="flex-1 flex flex-col pt-2">
          <button
            onClick={onToggleExpanded}
            className={`w-full h-11 flex items-center justify-center transition-all relative group ${
              isExpanded
                ? 'text-sf-accent bg-sf-dark-800'
                : 'text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800/50'
            }`}
            title="Inspector"
          >
            {/* Active indicator bar (on right side for right panel) */}
            {isExpanded && (
              <div className="absolute right-0 top-1 bottom-1 w-0.5 bg-sf-accent rounded-l" />
            )}
            <SlidersHorizontal className="w-5 h-5" />
            
            {/* Tooltip */}
            <div className="absolute right-full mr-2 px-2 py-1 bg-sf-dark-700 text-sf-text-primary text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap z-50 transition-opacity">
              Inspector
            </div>
          </button>
        </div>
        
        {/* Collapse/Expand Button */}
        <div className="border-t border-sf-dark-700">
          <button
            onClick={onToggleExpanded}
            className="w-full h-10 flex items-center justify-center text-sf-text-muted hover:text-sf-text-primary hover:bg-sf-dark-800/50 transition-colors"
            title={isExpanded ? 'Collapse panel' : 'Expand panel'}
          >
            {isExpanded ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

export default InspectorPanel
