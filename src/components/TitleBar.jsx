import { Minus, Square, X, Film, Home, Save, FolderOpen } from 'lucide-react'
import useProjectStore from '../stores/projectStore'

function TitleBar({ projectName }) {
  const { closeProject, saveProject } = useProjectStore()
  
  const handleSave = async () => {
    await saveProject()
  }
  
  const handleGoHome = async () => {
    // Save and close current project, return to welcome screen
    await closeProject()
  }
  
  return (
    <div className="h-10 bg-sf-dark-900 border-b border-sf-dark-700 flex items-center justify-between px-4 drag-region">
      {/* Left - Logo, Home & Project Name */}
      <div className="flex items-center gap-2 no-drag">
        {/* Home/Projects Button */}
        <button
          onClick={handleGoHome}
          className="flex items-center gap-1.5 px-2 py-1 hover:bg-sf-dark-700 rounded transition-colors group"
          title="Back to Projects"
        >
          <Home className="w-4 h-4 text-sf-text-muted group-hover:text-sf-accent transition-colors" />
        </button>
        
        <span className="text-sf-dark-600">|</span>
        
        {/* Logo */}
        <div className="flex items-center gap-2">
          <Film className="w-5 h-5 text-sf-accent" />
          <span className="font-semibold text-sf-text-primary">StoryFlow</span>
        </div>
        
        <span className="text-sf-dark-600">|</span>
        
        {/* Project Name */}
        <span className="text-sf-text-secondary text-sm">{projectName}</span>
        
        {/* Save Button */}
        <button
          onClick={handleSave}
          className="ml-2 p-1 hover:bg-sf-dark-700 rounded transition-colors group"
          title="Save Project (Auto-saves every 30s)"
        >
          <Save className="w-3.5 h-3.5 text-sf-text-muted group-hover:text-sf-accent transition-colors" />
        </button>
      </div>
      
      {/* Center - Could add transport controls here later */}
      <div className="flex-1" />
      
      {/* Right - Window Controls (Windows style) */}
      <div className="flex items-center no-drag">
        <button className="w-10 h-10 flex items-center justify-center hover:bg-sf-dark-700 transition-colors">
          <Minus className="w-4 h-4 text-sf-text-secondary" />
        </button>
        <button className="w-10 h-10 flex items-center justify-center hover:bg-sf-dark-700 transition-colors">
          <Square className="w-3 h-3 text-sf-text-secondary" />
        </button>
        <button className="w-10 h-10 flex items-center justify-center hover:bg-red-600 transition-colors">
          <X className="w-4 h-4 text-sf-text-secondary" />
        </button>
      </div>
    </div>
  )
}

export default TitleBar
