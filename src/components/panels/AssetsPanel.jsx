import { Upload, FolderOpen, Image, Video, Music, Search, Grid, List, Trash2, Edit3, Play, FileVideo, FileAudio, FileImage, Loader2 } from 'lucide-react'
import { useState, useRef } from 'react'
import useAssetsStore from '../../stores/assetsStore'
import useProjectStore from '../../stores/projectStore'
import { importAsset } from '../../services/fileSystem'

function AssetsPanel() {
  const [viewMode, setViewMode] = useState('grid')
  const [searchQuery, setSearchQuery] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editName, setEditName] = useState('')
  const [isImporting, setIsImporting] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef(null)

  // Get assets from store
  const { assets, currentPreview, setPreview, removeAsset, renameAsset, addAsset } = useAssetsStore()
  const { currentProjectHandle } = useProjectStore()
  
  // Supported file types
  const SUPPORTED_VIDEO = ['.mp4', '.webm', '.mov']
  const SUPPORTED_AUDIO = ['.mp3', '.wav', '.ogg']
  const SUPPORTED_IMAGE = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
  const ALL_SUPPORTED = [...SUPPORTED_VIDEO, ...SUPPORTED_AUDIO, ...SUPPORTED_IMAGE]
  
  // Determine file category from extension
  const getFileCategory = (filename) => {
    const ext = '.' + filename.split('.').pop().toLowerCase()
    if (SUPPORTED_VIDEO.includes(ext)) return 'video'
    if (SUPPORTED_AUDIO.includes(ext)) return 'audio'
    if (SUPPORTED_IMAGE.includes(ext)) return 'images'
    return null
  }
  
  // Handle file import
  const handleImport = async (files) => {
    if (!currentProjectHandle || files.length === 0) return
    
    setIsImporting(true)
    
    for (const file of files) {
      const category = getFileCategory(file.name)
      if (!category) {
        console.warn(`Unsupported file type: ${file.name}`)
        continue
      }
      
      try {
        const assetInfo = await importAsset(currentProjectHandle, file, category)
        
        // Add to assets store with URL for playback
        // Note: We'll need to get a URL when the asset is used
        addAsset({
          ...assetInfo,
          url: URL.createObjectURL(file), // Temporary URL for preview
          settings: {
            duration: assetInfo.duration,
          },
        })
      } catch (err) {
        console.error(`Error importing ${file.name}:`, err)
      }
    }
    
    setIsImporting(false)
  }
  
  // Handle file input change
  const handleFileInputChange = (e) => {
    const files = Array.from(e.target.files || [])
    handleImport(files)
    e.target.value = '' // Reset input
  }
  
  // Handle drag and drop
  const handleDragOver = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }
  
  const handleDragLeave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }
  
  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    
    const files = Array.from(e.dataTransfer.files || [])
    const validFiles = files.filter(f => {
      const ext = '.' + f.name.split('.').pop().toLowerCase()
      return ALL_SUPPORTED.includes(ext)
    })
    
    if (validFiles.length > 0) {
      handleImport(validFiles)
    }
  }
  
  // Open file picker
  const openFilePicker = () => {
    fileInputRef.current?.click()
  }

  // Filter assets by search query
  const filteredAssets = assets.filter(asset => 
    asset.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    asset.prompt?.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const getIcon = (type) => {
    switch (type) {
      case 'image': return Image
      case 'video': return Video
      case 'audio': return Music
      default: return FolderOpen
    }
  }

  // Format relative time
  const formatTime = (isoString) => {
    const date = new Date(isoString)
    const now = new Date()
    const diffMs = now - date
    const diffMins = Math.floor(diffMs / 60000)
    
    if (diffMins < 1) return 'Just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    return date.toLocaleDateString()
  }

  // Handle double-click to preview (shows asset in preview panel)
  const handleDoubleClick = (asset) => {
    setPreview(asset) // This now also sets previewMode to 'asset'
  }
  
  // Handle single-click to select and preview
  const handleClick = (asset) => {
    setPreview(asset) // This now also sets previewMode to 'asset'
  }

  // Start editing name
  const startEditing = (e, asset) => {
    e.stopPropagation()
    setEditingId(asset.id)
    setEditName(asset.name)
  }

  // Save edited name
  const saveEdit = (e) => {
    e.preventDefault()
    if (editName.trim() && editingId) {
      renameAsset(editingId, editName.trim())
    }
    setEditingId(null)
    setEditName('')
  }

  // Handle delete
  const handleDelete = (e, id) => {
    e.stopPropagation()
    if (confirm('Delete this asset?')) {
      removeAsset(id)
    }
  }

  return (
    <div 
      className={`h-full flex flex-col ${isDragOver ? 'ring-2 ring-sf-accent ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ALL_SUPPORTED.join(',')}
        onChange={handleFileInputChange}
        className="hidden"
      />
      
      {/* Header */}
      <div className="p-2 border-b border-sf-dark-700 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sf-text-muted" />
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-sf-dark-800 border border-sf-dark-600 rounded pl-7 pr-2 py-1 text-xs text-sf-text-primary placeholder-sf-text-muted focus:outline-none focus:border-sf-accent"
            />
          </div>
          
          <div className="flex items-center gap-0.5 bg-sf-dark-800 rounded p-0.5">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1 rounded ${viewMode === 'grid' ? 'bg-sf-dark-600' : ''}`}
            >
              <Grid className="w-3.5 h-3.5 text-sf-text-secondary" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-1 rounded ${viewMode === 'list' ? 'bg-sf-dark-600' : ''}`}
            >
              <List className="w-3.5 h-3.5 text-sf-text-secondary" />
            </button>
          </div>
          
          <button 
            onClick={openFilePicker}
            disabled={!currentProjectHandle || isImporting}
            className="p-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 disabled:opacity-50 rounded transition-colors" 
            title="Import Media"
          >
            {isImporting ? (
              <Loader2 className="w-3.5 h-3.5 text-sf-text-secondary animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5 text-sf-text-secondary" />
            )}
          </button>
        </div>
      </div>
      
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-sf-accent/20 border-2 border-dashed border-sf-accent rounded-lg flex items-center justify-center z-10 pointer-events-none">
          <div className="text-center">
            <Upload className="w-8 h-8 text-sf-accent mx-auto mb-2" />
            <p className="text-sm text-sf-text-primary font-medium">Drop to import</p>
            <p className="text-xs text-sf-text-muted">Video, audio, or image files</p>
          </div>
        </div>
      )}
      
      {/* Assets Grid/List */}
      <div className="flex-1 p-2 overflow-auto relative">
        {filteredAssets.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-sf-text-muted">
            <Video className="w-10 h-10 mb-2 opacity-50" />
            <p className="text-xs">No assets yet</p>
            <p className="text-[10px] mt-1">Generate AI videos or import your footage</p>
            <button
              onClick={openFilePicker}
              disabled={!currentProjectHandle}
              className="mt-3 flex items-center gap-1.5 px-3 py-1.5 bg-sf-dark-700 hover:bg-sf-dark-600 disabled:opacity-50 rounded text-xs text-sf-text-secondary transition-colors"
            >
              <Upload className="w-3 h-3" />
              Import Media
            </button>
          </div>
        ) : viewMode === 'grid' ? (
          <div className="grid grid-cols-2 gap-2">
            {filteredAssets.map((asset) => {
              const Icon = getIcon(asset.type)
              const isSelected = currentPreview?.id === asset.id
              
              return (
                <div
                  key={asset.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('assetId', asset.id)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => handleClick(asset)}
                  onDoubleClick={() => handleDoubleClick(asset)}
                  className={`bg-sf-dark-800 border rounded overflow-hidden cursor-grab transition-all group ${
                    isSelected 
                      ? 'border-sf-accent ring-1 ring-sf-accent' 
                      : 'border-sf-dark-600 hover:border-sf-dark-500'
                  }`}
                >
                  {/* Thumbnail */}
                  <div className="aspect-video bg-sf-dark-700 flex items-center justify-center relative overflow-hidden">
                    {asset.type === 'video' && asset.url ? (
                      <video
                        src={asset.url}
                        className="w-full h-full object-cover"
                        muted
                        onMouseEnter={(e) => e.target.play()}
                        onMouseLeave={(e) => {
                          e.target.pause()
                          e.target.currentTime = 0
                        }}
                      />
                    ) : asset.type === 'image' && asset.url ? (
                      <img
                        src={asset.url}
                        alt={asset.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Icon className="w-6 h-6 text-sf-text-muted" />
                    )}
                    
                    {/* Badge - AI or Imported */}
                    <div className={`absolute top-0.5 left-0.5 px-1 py-0.5 rounded text-[7px] text-white font-medium ${
                      asset.isImported ? 'bg-sf-dark-700/90' : 'bg-sf-accent/90'
                    }`}>
                      {asset.isImported ? 'IMP' : 'AI'}
                    </div>
                    
                    {/* Play overlay on hover */}
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <Play className="w-6 h-6 text-white" />
                    </div>

                    {/* Actions */}
                    <div className="absolute top-0.5 right-0.5 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => startEditing(e, asset)}
                        className="p-0.5 bg-sf-dark-800/90 hover:bg-sf-dark-700 rounded"
                        title="Rename"
                      >
                        <Edit3 className="w-2.5 h-2.5 text-sf-text-muted" />
                      </button>
                      <button
                        onClick={(e) => handleDelete(e, asset.id)}
                        className="p-0.5 bg-sf-dark-800/90 hover:bg-sf-error rounded"
                        title="Delete"
                      >
                        <Trash2 className="w-2.5 h-2.5 text-sf-text-muted" />
                      </button>
                    </div>
                  </div>
                  
                  {/* Info */}
                  <div className="p-1.5">
                    {editingId === asset.id ? (
                      <form onSubmit={saveEdit}>
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={saveEdit}
                          autoFocus
                          className="w-full bg-sf-dark-700 border border-sf-accent rounded px-1 py-0.5 text-[10px] text-sf-text-primary focus:outline-none"
                        />
                      </form>
                    ) : (
                      <p className="text-[10px] text-sf-text-primary truncate" title={asset.name}>
                        {asset.name}
                      </p>
                    )}
                    <p className="text-[9px] text-sf-text-muted mt-0.5">
                      {formatTime(asset.createdAt)} • {asset.settings?.duration}s
                    </p>
                  </div>
                </div>
              )
            })}
            
            {/* Upload placeholder */}
            <button
              onClick={openFilePicker}
              disabled={!currentProjectHandle || isImporting}
              className="aspect-video border-2 border-dashed border-sf-dark-600 rounded flex items-center justify-center hover:border-sf-accent disabled:opacity-50 cursor-pointer transition-colors"
            >
              <div className="text-center">
                {isImporting ? (
                  <Loader2 className="w-4 h-4 text-sf-text-muted mx-auto mb-1 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4 text-sf-text-muted mx-auto mb-1" />
                )}
                <span className="text-[10px] text-sf-text-muted">Import</span>
              </div>
            </button>
          </div>
        ) : (
          /* List View - Compact for narrow panel */
          <div className="space-y-1">
            {filteredAssets.map((asset) => {
              const Icon = getIcon(asset.type)
              const isSelected = currentPreview?.id === asset.id
              
              return (
                <div 
                  key={asset.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('assetId', asset.id)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => handleClick(asset)}
                  onDoubleClick={() => handleDoubleClick(asset)}
                  className={`flex items-center gap-2 p-1.5 rounded cursor-pointer transition-colors group ${
                    isSelected ? 'bg-sf-accent/20' : 'hover:bg-sf-dark-800'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 text-sf-text-muted flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    {editingId === asset.id ? (
                      <form onSubmit={saveEdit}>
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={saveEdit}
                          autoFocus
                          className="w-full bg-sf-dark-700 border border-sf-accent rounded px-1 py-0.5 text-[10px] text-sf-text-primary focus:outline-none"
                        />
                      </form>
                    ) : (
                      <>
                        <p className="text-[11px] text-sf-text-primary truncate">{asset.name}</p>
                        <p className="text-[9px] text-sf-text-muted">{formatTime(asset.createdAt)} • {asset.settings?.duration}s</p>
                      </>
                    )}
                  </div>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => startEditing(e, asset)}
                      className="p-0.5 hover:bg-sf-dark-700 rounded"
                      title="Rename"
                    >
                      <Edit3 className="w-2.5 h-2.5 text-sf-text-muted" />
                    </button>
                    <button
                      onClick={(e) => handleDelete(e, asset.id)}
                      className="p-0.5 hover:bg-sf-error rounded"
                      title="Delete"
                    >
                      <Trash2 className="w-2.5 h-2.5 text-sf-text-muted" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      
      {/* Footer with asset count */}
      <div className="px-2 py-1.5 border-t border-sf-dark-700 text-[10px] text-sf-text-muted">
        {filteredAssets.length} {filteredAssets.length === 1 ? 'asset' : 'assets'}
      </div>
    </div>
  )
}

export default AssetsPanel
