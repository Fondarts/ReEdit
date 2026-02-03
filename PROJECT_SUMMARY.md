# StoryFlow - AI Animatic Studio

## Overview
AI-powered video editing app with DaVinci Resolve-style UI. Integrates with ComfyUI for AI video generation.

| Aspect | Details |
|--------|---------|
| **Type** | React + Vite + Tailwind CSS web app |
| **AI Backend** | ComfyUI at `http://127.0.0.1:8188` |
| **Storage** | File System Access API (project files) + localStorage (settings) |
| **Location** | `c:\Users\papa\Documents\coding_projects\general\comfyui_editing` |
| **Browser** | Chrome/Edge required (File System Access API) |

## Running the App
```bash
npm run dev
```
Opens at `http://localhost:5173`

## Layout Structure

### Normal Mode (Contracted Left Panel)
```
┌─────────────────────────────────────────────────────────┐
│  [🏠] StoryFlow │ Project Name │ [💾]    Title Bar      │
├──┬──────────┬─────────────────────────┬──────────────┬──┤
│I │  Left    │                         │   Inspector  │I │
│C │  Panel   │        Preview          │   Panel      │C │
│O │ (Tabbed) │        Panel            │              │O │
│N │          │                         │  Transform   │N │
│  │[Generate]│                         │  Crop        │  │
│B │[Text]    │                         │  Timing      │B │
│A │[Assets]  │                         │  Effects     │A │
│R │[Workflow]│                         │              │R │
│  │[Settings]│                         │              │  │
├──┴──────────┴─────────────────────────┴──────────────┴──┤
│ [Timeline ▼] │◀◀│◀│ ▶ │▶│▶▶│ 00:00:00   Transport      │
├─────────────────────────────────────────────────────────┤
│                 Timeline (Full Width)                    │
│  Video 1  │ clip │ clip │ TEXT │                        │
│  Video 2  │      │ clip │                               │
│  Audio    │                                             │
└─────────────────────────────────────────────────────────┘
```

### Expanded Mode (Full Height Left Panel - Resolve-style)
```
┌─────────────────────────────────────────────────────────┐
│  [🏠] StoryFlow │ Project Name │ [💾]    Title Bar      │
├──┬──────────┬─────────────────────────┬──────────────┬──┤
│I │  Left    │                         │   Inspector  │I │
│C │  Panel   │        Preview          │   Panel      │C │
│O │ (Tabbed) │        Panel            │              │O │
│N │          │                         │  Transform   │N │
│  │[Generate]├─────────────────────────┴──────────────┴──┤
│B │[Text]    │ [Timeline ▼]│◀◀│◀│ ▶ │▶│▶▶│ Transport    │
│A │[Assets]  ├───────────────────────────────────────────┤
│R │[Workflow]│           Timeline (Shifted Right)        │
│  │[Settings]│  Video 1 │ clip │ clip │ TEXT │          │
│  │          │  Video 2 │      │ clip │                  │
│  │  [⊞][◀]  │  Audio   │                                │
└──┴──────────┴───────────────────────────────────────────┘
```

### Expand/Contract Toggle
- **Button Location**: Bottom of left panel icon bar (above collapse chevron)
- **Icons**: `PanelLeft` (expand) / `PanelLeftClose` (contract)
- **Behavior**:
  - **Contracted**: Left panel only above timeline (default)
  - **Expanded**: Left panel spans full height, timeline shifts right
- **Use Case**: More panel space for browsing assets/workflows while editing

## Project Management
On first launch, users are prompted to select a **Projects Folder**. All projects are saved here.

### New Project Dialog
- **Project Name**: Required, typed by user
- **Resolution**: Presets (HD 1080p, 720p, 4K, Vertical, Square, Instagram 4:5, Cinematic 21:9) + Custom
- **Frame Rate**: 15, 23.976, 24, 25, 30, 60 fps

### Project Folder Structure
```
MyProject/
├── project.storyflow          # JSON (timeline, assets, settings)
├── assets/
│   ├── video/                 # Imported videos
│   ├── audio/                 # Audio files
│   └── images/                # Images
├── renders/                   # Exported videos
└── autosave/                  # Auto-save backups
```

### Welcome Screen
- Grid of recent projects (last 10)
- Project cards show: thumbnail, name, modified date, resolution
- "New Project" and "Open Project" buttons
- Click project to open

### Import Footage
Users can import their own media via Assets Panel:
- **Supported**: .mp4, .webm, .mov, .mp3, .wav, .ogg, .jpg, .png, .gif, .webp
- Drag-and-drop or click Import button
- Files are copied to project's `assets/` folder
- Imported assets show "IMP" badge, AI-generated show "AI"

### Auto-save
- Saves every 30 seconds (configurable)
- Also saves on window close/refresh
- Toggle in Settings panel

### Title Bar Navigation
- **Home button** (🏠): Returns to Welcome Screen (saves & closes current project)
- **Save button** (💾): Manual save (though auto-save handles this)
- Project name displayed in center

## Multiple Timelines
Each project supports multiple timelines (like DaVinci Resolve):

### Timeline Switcher
Located in the Transport Controls bar:
- Dropdown showing all timelines in the project
- Click to switch between timelines
- Shows timeline name, clip count, and resolution (if custom)
- Current timeline highlighted with accent color

### Timeline Operations
- **New Timeline**: Opens dialog to set name, resolution, and frame rate
- **Duplicate**: Creates a copy of existing timeline (including all clips and settings)
- **Rename**: Double-click or use edit button
- **Delete**: Remove timeline (can't delete last one)

### Timeline-Specific Settings
Each timeline can have its own resolution and frame rate:
- **When creating a new project**: Settings apply to the first timeline only
- **When creating additional timelines**: Dialog allows specifying unique resolution/fps
- **"Use Project Settings" option**: Quick toggle to inherit from project defaults
- **Custom settings**: Choose different resolution presets or enter custom dimensions

This enables workflows like:
- 16:9 main cut + 9:16 vertical cut for social media
- 4K master + 720p proxy timeline
- 30fps timeline + 24fps cinematic version

### How Timelines Work
- Assets are **shared** across all timelines in a project
- Each timeline has its own tracks, clips, resolution, fps, and other settings
- Switching timelines saves current state automatically
- Preview panel automatically adjusts aspect ratio based on timeline settings
- Timelines with custom settings show resolution badge in the switcher dropdown

## Key Files
| File | Purpose |
|------|---------|
| `src/App.jsx` | Main layout, panel state, auto-save |
| `src/stores/projectStore.js` | Project management, recent projects, file operations |
| `src/stores/timelineStore.js` | Timeline state, clips, tracks, transforms, text clips |
| `src/stores/assetsStore.js` | Asset library (AI + imported), preview state |
| `src/services/fileSystem.js` | File System Access API operations |
| `src/components/WelcomeScreen.jsx` | First-run setup, recent projects grid |
| `src/components/NewProjectDialog.jsx` | Project creation form |
| `src/components/NewTimelineDialog.jsx` | Timeline creation form with resolution/fps settings |
| `src/components/TimelineSwitcher.jsx` | Timeline dropdown for multi-timeline support |
| `src/components/TitleBar.jsx` | App title bar with home/save buttons |
| `src/components/Timeline.jsx` | Multi-track timeline with clips, resizable track headers |
| `src/components/PreviewPanel.jsx` | Video preview with multi-layer compositing, scroll zoom |
| `src/components/VideoLayerRenderer.jsx` | Video + text layer rendering with preloading |
| `src/components/InspectorPanel.jsx` | Clip transform/crop controls, draggable number inputs |
| `src/components/TransportControls.jsx` | JKL shuttle, I/O points, playback modes |
| `src/components/GeneratePanel.jsx` | AI video generation UI (Video + Audio tabs) |
| `src/components/LeftPanel.jsx` | Tabbed left panel container |
| `src/components/panels/TextPanel.jsx` | Text clip creation with styling |
| `src/hooks/useTimelinePlayback.js` | Timeline playback loop with loop modes |
| `src/hooks/useSnapping.js` | Clip snapping logic |
| `src/services/comfyui.js` | ComfyUI API service |
| `src/services/videoCache.js` | Video element pooling and preloading |

## Timeline Features
- **Multi-track**: Video tracks (add to top), Audio tracks (add to bottom)
- **Track Headers**: Resizable by dragging right edge (100-400px)
- **Vertical Scrolling**: Tracks scroll vertically with synced headers
- **Clip Operations**: Drag, trim (head/tail), move, delete, split, duplicate
- **Text Clips**: Amber-colored clips with text preview on timeline
- **Snapping**: To playhead, clip edges, grid (toggle with `S` key)
- **Multi-select**: Shift+click, Ctrl+click, Ctrl+A, Alt+drag marquee
- **Ripple Edit**: Toggle with `R` key
- **Roll Edit**: Drag between adjacent clips
- **Undo/Redo**: Ctrl+Z / Ctrl+Shift+Z (50 states)
- **Transitions**: 9 types (dissolve, fade, wipe, slide)
- **I/O Points**: `I` and `O` keys for three-point editing

## Text Clips
Text clips can be added via the **Text** tab in the left panel:
```javascript
textProperties: {
  text: 'Sample Text',
  fontFamily: 'Inter',           // 10 font options
  fontSize: 64,                  // 12-200px
  fontWeight: 'bold',            // normal, bold, 100-900
  textColor: '#FFFFFF',
  textAlign: 'center',           // left, center, right
  verticalAlign: 'center',       // top, center, bottom
  strokeColor: '#000000',
  strokeWidth: 0,                // 0-10px
  backgroundColor: '#000000',
  backgroundOpacity: 0,          // 0-100%
  backgroundPadding: 20,
  shadow: false,
  shadowColor: 'rgba(0,0,0,0.5)',
  shadowBlur: 4,
  shadowOffsetX: 2,
  shadowOffsetY: 2,
}
```
- Text presets: Title, Subtitle, Lower Third, Caption
- Inspector shows text-specific controls when text clip selected

## Clip Transform Properties
Each clip has a `transform` object:
```javascript
transform: {
  positionX: 0, positionY: 0,     // Pixels (draggable inputs)
  scaleX: 100, scaleY: 100,       // Percentage (10-400)
  scaleLinked: true,              // Lock X/Y
  rotation: 0,                     // Degrees (-180 to 180)
  anchorX: 50, anchorY: 50,       // Anchor (0-100%, draggable)
  opacity: 100,                    // Transparency (0-100%)
  flipH: false, flipV: false,     // Mirror
  cropTop: 0, cropBottom: 0,      // Edge crop (0-50%)
  cropLeft: 0, cropRight: 0,
}
```

## Multi-Layer Compositing
- Clips on multiple video tracks at same time = stacked layers
- **Video 1 = TOP**, Video 2 = behind
- Text clips render on top of video layers
- Scale down top layer → see layer beneath (picture-in-picture)
- Each layer has independent transforms
- Preview shows "X Layers" badge when multiple active

## Inspector Panel (Right)
When a clip is selected:
1. **Header**: Clip name, track, duration, **Reset Transform** button
2. **Transform**: Position (draggable), Scale (link toggle), Rotation, Flip, Opacity, Anchor Point (9-grid + draggable inputs)
3. **Crop**: Visual preview + 4 edge sliders
4. **Timing**: Start time, duration, trim in/out
5. **Effects**: Placeholders for Ken Burns, Camera Shake, Color Grade

**Text Clip Inspector** shows:
- Text content, font family, size (draggable input), weight
- Horizontal/vertical alignment buttons
- Colors & style (text color, stroke, background, shadow)
- Transform and timing (shared with video clips)
- **Real-time preview**: Text changes reflect immediately in preview (no need to move playhead)

## Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `J/K/L` | Reverse / Pause / Forward (speed ramps) |
| `I/O` | Set In/Out points |
| `Alt+X` | Clear In/Out |
| `S` | Toggle snapping |
| `R` | Toggle ripple edit |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |
| `Delete` | Delete selected clips |
| `Escape` | Clear selection |
| `Ctrl+A` | Select all clips |
| `Alt+Drag` | Marquee selection |
| `Space+Drag` | Pan preview |

## Generate Panel Features
- **Video Tab**: Prompt/negative prompt with cinematography tags (10 categories)
- **Audio Tab**: Music, SFX, Voice generation (placeholder)
- Resolution: 1920x1080, 1280x720, etc.
- Duration: 2s, 3s, 5s, 8s
- Frame rate: 24fps, 30fps
- Seed with randomize

## Text Panel Features
- Text content textarea
- Font family dropdown (10 fonts)
- Font size slider (12-200px)
- Font weight dropdown
- Text alignment buttons
- Colors: text, stroke (with width), background (with opacity)
- Drop shadow toggle
- Duration presets (2s, 3s, 5s, 8s, 10s)
- Live preview
- Presets: Title, Subtitle, Lower Third, Caption

## Preview Panel Features
- **Aspect ratio**: Automatically matches current timeline's resolution settings
- Zoom: Fit, 25%-200% (also via **mouse scroll wheel**)
- Pan: Space+Drag
- Fullscreen mode
- Multi-layer video + text compositing
- Video preloading/caching for seamless clip transitions
- Video clips maintain aspect ratio (letterbox/pillarbox, no stretching)

### Safe Guides & Letterbox
Preview panel includes professional overlay guides accessible via **Guides** dropdown:

**Safe Guides:**
- **Title Safe (80%)** - Yellow dashed border for text placement
- **Action Safe (90%)** - Cyan border for important action
- **Rule of Thirds** - 3×3 grid with intersection points
- **Center Crosshair** - Center point marker
- **Title + Action Safe** - Both zones shown together

**Letterbox Preview:**
- **2.35:1 Cinemascope** - Classic widescreen
- **2.39:1 Anamorphic** - Modern anamorphic
- **1.85:1 Theatrical** - Standard theatrical
- **4:3 Classic TV** - Old TV format

Letterbox shows black bars to visualize how content will appear in different delivery formats.

## Playback Modes (Right-click Play button)
- **Normal**: Play once and stop at end
- **Loop**: Loop entire timeline continuously
- **In to Out**: Loop between In/Out points (requires I/O points set)
- **Back and Forth (Ping-Pong)**: Play forward then reverse

## Technical Notes
- **Tailwind colors**: Custom `sf-` prefix (e.g., `sf-dark-900`, `sf-accent`, `sf-blue`)
- **Color scheme**: DaVinci Resolve-inspired dark theme with desaturated colors
  - `sf-dark-*`: Deep grays (#0d0d0d to #5c5c5c)
  - `sf-accent`: Orange/red for playhead and highlights (#e85d04)
  - `sf-blue`: Desaturated blue for action buttons (#5a7a9e)
  - `sf-clip-video`: Desaturated teal for video clips (#3d7080)
  - `sf-clip-audio`: Desaturated green for audio (#2d5f4a)
  - `sf-clip-text`: Desaturated amber for text clips (#a89030)
- **Text colors**: `sf-text-primary` (#e5e5e5), `sf-text-secondary` (#a3a3a3), `sf-text-muted` (#737373)
- **Persistence**: Zustand with `persist` middleware → localStorage
- **Panel widths**: Left 220-500px, Right 200-400px, Timeline 180-450px
- **Collapsible panels**: Icon bar always visible (48px each side)
- **Full-height mode**: Left panel can expand to span entire height (Resolve-style)
- **Draggable inputs**: Position X/Y, Anchor X/Y - click+drag to adjust, double-click to edit

## Pending Features
- [ ] Keyboard: C (split), Ctrl+D (duplicate)
- [ ] Copy/Paste clips
- [ ] Timeline markers
- [ ] Audio waveforms
- [ ] Export to video file
- [ ] Text animation presets

---

## Recent Changes Log

### Session Updates (Feb 2026)

**Timeline-Specific Settings:**
- Each timeline can now have its own resolution and frame rate
- New Timeline dialog with resolution/fps options (similar to New Project dialog)
- "Use Project Settings" toggle for quick inheritance
- Preview panel auto-adjusts to timeline's aspect ratio
- Files: `NewTimelineDialog.jsx`, `projectStore.js`, `TimelineSwitcher.jsx`

**Safe Guides Feature:**
- Removed aspect ratio dropdown from preview (now uses timeline settings)
- Added Guides dropdown with safe zone overlays
- Title Safe (80%), Action Safe (90%), Rule of Thirds, Center Crosshair
- Letterbox preview for 2.35:1, 2.39:1, 1.85:1, 4:3 formats
- File: `PreviewPanel.jsx`

**Inspector Panel Improvements:**
- Moved Reset Transform button to header for better visibility
- Removed duplicate/cut/delete buttons from header (use timeline instead)
- Font size input now draggable (like transform inputs)
- File: `InspectorPanel.jsx`

**Real-time Text Editing:**
- Text clip changes now reflect immediately in preview
- Fixed by adding `clips` to dependency array in VideoLayerRenderer
- File: `VideoLayerRenderer.jsx`

**Video Aspect Ratio Fix:**
- Videos no longer stretch/squeeze when placed in different aspect ratio timelines
- Uses `objectFit: 'contain'` for proper letterboxing
- Files: `VideoLayerRenderer.jsx`, `PreviewPanel.jsx`

**ComfyUI Progress Tracking:**
- WebSocket now connects directly to ComfyUI (bypasses Vite proxy)
- Real-time progress updates during video generation
- Shows current node being executed
- Warning message if WebSocket unavailable
- Files: `comfyui.js`, `useComfyUI.js`, `GeneratePanel.jsx`

### Color Theme Update (Feb 2026)
Updated the app's color scheme to match DaVinci Resolve more closely.

**Files Modified:**
- `tailwind.config.js` - Main color definitions
- `src/index.css` - Background colors, scrollbar colors
- `src/components/Timeline.jsx` - Playhead color (orange), clip colors (teal), I/O markers
- `src/components/TransportControls.jsx` - Play button (desaturated blue), I/O point buttons
- `src/components/PreviewPanel.jsx` - Darker preview background, play button color
- `src/components/GeneratePanel.jsx` - Generate button (desaturated blue)
- `src/components/WelcomeScreen.jsx` - Action buttons (desaturated blue)
- `src/components/NewProjectDialog.jsx` - Create button (desaturated blue)
- `src/components/InspectorPanel.jsx` - Default clip color fallback
- `src/stores/timelineStore.js` - Clip color palettes (video & audio)

**Key Color Changes:**
| Element | Old | New |
|---------|-----|-----|
| Backgrounds | Blue-tinted grays | True neutral grays (#0d0d0d - #5c5c5c) |
| Playhead | Red (#ef4444) | Orange (#e85d04) |
| Action buttons | Bright blue (#3b82f6) | Desaturated blue (#5a7a9e) |
| Video clips | Blue tints | Desaturated teal (#3d7080) |
| Audio clips | Bright green | Desaturated green (#2d5f4a) |
| Text clips | Bright amber | Desaturated amber (#a89030) |
| I/O markers | Bright blue | Desaturated blue (#5a7a9e) |
| Text colors | Cool whites | Warmer off-whites |

**Design Philosophy:**
- Darker, more neutral backgrounds (no blue tint) like Resolve
- Orange playhead matching Resolve's edit page
- All accent colors desaturated by ~30% for professional look
- Muted, functional colors that don't distract from content

---
*Backup of previous version: `backUP01_PROJECT_SUMMARY.md`*
