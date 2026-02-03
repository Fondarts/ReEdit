import { useState, useEffect, useCallback, useRef } from 'react';
import comfyui, { modifyLTX2Workflow } from '../services/comfyui';

// Store the base workflow in memory after first load
let cachedWorkflows = {};

/**
 * Hook for interacting with ComfyUI
 */
export function useComfyUI() {
  const [isConnected, setIsConnected] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState({ value: 0, max: 100 });
  const [currentPromptId, setCurrentPromptId] = useState(null);
  const [error, setError] = useState(null);
  const [queueCount, setQueueCount] = useState(0);
  const [generationResult, setGenerationResult] = useState(null);
  
  // Use ref to track polling interval
  const pollingRef = useRef(null);

  // Track WebSocket connection state
  const [wsConnected, setWsConnected] = useState(false);
  
  // Check connection on mount
  useEffect(() => {
    const checkConnection = async () => {
      const connected = await comfyui.checkConnection();
      setIsConnected(connected);
      
      if (connected && !comfyui.isWebSocketConnected()) {
        try {
          await comfyui.connect();
          setWsConnected(true);
          console.log('WebSocket connected successfully');
        } catch (err) {
          setWsConnected(false);
          // Only log once
          if (!window._wsErrorLogged) {
            console.log('WebSocket connection failed, will use HTTP polling for progress');
            window._wsErrorLogged = true;
          }
        }
      } else if (connected && comfyui.isWebSocketConnected()) {
        setWsConnected(true);
      }
    };

    checkConnection();
    
    // Check connection periodically (less frequently if already connected)
    const interval = setInterval(checkConnection, wsConnected ? 10000 : 5000);
    return () => clearInterval(interval);
  }, [wsConnected]);

  // Track which node is currently executing (for progress estimation)
  const [currentNode, setCurrentNode] = useState(null);
  const nodeProgressRef = useRef({ completed: 0, total: 0 });
  
  // Set up WebSocket event listeners
  useEffect(() => {
    const handleProgress = (data) => {
      // This is the actual step-by-step progress from ComfyUI
      console.log('Progress event:', data);
      if (data.promptId === currentPromptId || !currentPromptId) {
        // Calculate percentage
        const percent = data.max > 0 ? Math.round((data.value / data.max) * 100) : 0;
        setProgress({ value: data.value, max: data.max, percent });
      }
    };

    const handleComplete = (data) => {
      console.log('Complete event:', data);
      if (data.promptId === currentPromptId) {
        // Set progress to 100% when complete
        setProgress({ value: 100, max: 100, percent: 100 });
      }
    };

    const handleExecuting = (data) => {
      // Track which node is being executed
      if (data.promptId === currentPromptId) {
        setCurrentNode(data.node);
        if (data.node) {
          nodeProgressRef.current.completed++;
          console.log(`Executing node: ${data.node} (${nodeProgressRef.current.completed} nodes completed)`);
        }
      }
    };

    const handleExecuted = (data) => {
      console.log('Node executed:', data.node, data.output);
      // If this is the SaveVideo node (75), the video is ready
      if (data.node === '75' && data.output?.videos) {
        console.log('Video output detected:', data.output);
      }
    };

    comfyui.on('progress', handleProgress);
    comfyui.on('complete', handleComplete);
    comfyui.on('executing', handleExecuting);
    comfyui.on('executed', handleExecuted);

    return () => {
      comfyui.off('progress', handleProgress);
      comfyui.off('complete', handleComplete);
      comfyui.off('executing', handleExecuting);
      comfyui.off('executed', handleExecuted);
    };
  }, [currentPromptId]);

  // Track if we've already processed the current result
  const processedPromptRef = useRef(null);

  // Poll for completion when generating
  useEffect(() => {
    if (!isGenerating || !currentPromptId) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    const pollForCompletion = async () => {
      // Skip if we've already processed this prompt
      if (processedPromptRef.current === currentPromptId) {
        return;
      }

      try {
        const history = await comfyui.getHistory(currentPromptId);
        const promptHistory = history[currentPromptId];
        
        if (promptHistory) {
          // Check if there's an error
          if (promptHistory.status?.status_str === 'error') {
            processedPromptRef.current = currentPromptId;
            setError('Generation failed');
            setIsGenerating(false);
            setProgress({ value: 0, max: 100 });
            return;
          }
          
          // Check if outputs are available (generation complete)
          const outputs = promptHistory.outputs;
          if (outputs && Object.keys(outputs).length > 0) {
            // Mark as processed immediately to prevent duplicate processing
            processedPromptRef.current = currentPromptId;
            
            // Stop polling immediately
            if (pollingRef.current) {
              clearInterval(pollingRef.current);
              pollingRef.current = null;
            }
            
            console.log('Generation complete, full history:', promptHistory);
            console.log('Outputs:', outputs);
            console.log('Available output nodes:', Object.keys(outputs));
            
            // Find video output - check multiple possible node IDs
            let videoData = null;
            
            // Log the full structure of node 75 to see what we're dealing with
            console.log('Node 75 full output:', JSON.stringify(outputs['75'], null, 2));
            
            // Try node 75 first (SaveVideo) - check various possible keys
            const node75 = outputs['75'];
            if (node75) {
              // Check for videos array
              if (node75.videos?.[0]) {
                videoData = node75.videos[0];
                console.log('Found video in node 75 videos:', videoData);
              }
              // Check for gifs array (some nodes output as gifs)
              else if (node75.gifs?.[0]) {
                videoData = node75.gifs[0];
                console.log('Found gif in node 75:', videoData);
              }
              // Check for images array (fallback)
              else if (node75.images?.[0]) {
                videoData = node75.images[0];
                console.log('Found image in node 75:', videoData);
              }
              // Check if it's directly an array
              else if (Array.isArray(node75) && node75[0]) {
                videoData = node75[0];
                console.log('Found direct array in node 75:', videoData);
              }
            }
            
            // Also check all other nodes for any video/gif output
            if (!videoData) {
              for (const nodeId of Object.keys(outputs)) {
                const nodeOutput = outputs[nodeId];
                console.log(`Checking node ${nodeId}:`, Object.keys(nodeOutput));
                
                if (nodeOutput.videos?.[0]) {
                  videoData = nodeOutput.videos[0];
                  console.log(`Found video in node ${nodeId}:`, videoData);
                  break;
                }
                if (nodeOutput.gifs?.[0]) {
                  videoData = nodeOutput.gifs[0];
                  console.log(`Found gif in node ${nodeId}:`, videoData);
                  break;
                }
                if (nodeOutput.images?.[0]) {
                  // Only use images if they look like videos (mp4, webm, etc)
                  const img = nodeOutput.images[0];
                  if (img.filename?.match(/\.(mp4|webm|gif)$/i)) {
                    videoData = img;
                    console.log(`Found video-like image in node ${nodeId}:`, videoData);
                    break;
                  }
                }
              }
            }
            
            if (videoData) {
              const url = comfyui.getMediaUrl(
                videoData.filename, 
                videoData.subfolder || '', 
                videoData.type || 'output'
              );
              console.log('Constructed video URL:', url);
              
              const result = {
                type: 'video',
                url: url,
                filename: videoData.filename,
                subfolder: videoData.subfolder
              };
              console.log('Setting generation result:', result);
              setGenerationResult(result);
            } else {
              console.warn('No video found in outputs');
            }
            
            setIsGenerating(false);
            setProgress({ value: 100, max: 100 });
          }
        }
      } catch (err) {
        console.error('Error polling for completion:', err);
      }
    };

    // Poll every 2 seconds
    pollingRef.current = setInterval(pollForCompletion, 2000);
    
    // Also poll immediately
    pollForCompletion();

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [isGenerating, currentPromptId]);

  // Update queue count periodically
  useEffect(() => {
    const updateQueue = async () => {
      if (isConnected) {
        const status = await comfyui.getQueueStatus();
        setQueueCount(status.queue_pending?.length || 0);
      }
    };

    updateQueue();
    const interval = setInterval(updateQueue, 2000);
    return () => clearInterval(interval);
  }, [isConnected]);

  /**
   * Generate video using LTX-2 workflow
   */
  const generateVideo = useCallback(async (options) => {
    if (!isConnected) {
      setError('ComfyUI is not connected');
      return null;
    }

    setIsGenerating(true);
    setError(null);
    setProgress({ value: 0, max: 100, percent: 0 });
    setGenerationResult(null);
    setCurrentNode(null);
    nodeProgressRef.current = { completed: 0, total: 0 };
    processedPromptRef.current = null; // Reset for new generation

    try {
      // Load the workflow if not cached
      if (!cachedWorkflows['ltx2-t2v']) {
        const response = await fetch('/workflows/video_ltx2_t2v.json');
        if (!response.ok) {
          throw new Error('Failed to load workflow');
        }
        cachedWorkflows['ltx2-t2v'] = await response.json();
      }

      const baseWorkflow = cachedWorkflows['ltx2-t2v'];
      
      // Modify workflow with user options
      const workflow = modifyLTX2Workflow(baseWorkflow, {
        prompt: options.prompt,
        negativePrompt: options.negativePrompt,
        width: options.width || 1280,
        height: options.height || 720,
        frames: options.frames || 121,
        seed: options.seed,
        fps: options.fps || 24
      });

      console.log('Queueing workflow with options:', options);

      // Queue the prompt
      const promptId = await comfyui.queuePrompt(workflow);
      console.log('Got prompt ID:', promptId);
      setCurrentPromptId(promptId);

      return promptId;
    } catch (err) {
      console.error('Generation error:', err);
      setError(err.message);
      setIsGenerating(false);
      return null;
    }
  }, [isConnected]);

  /**
   * Get the result of a generation
   */
  const getResult = useCallback(async (promptId) => {
    try {
      const history = await comfyui.getHistory(promptId);
      const outputs = history[promptId]?.outputs;
      
      if (!outputs) return null;

      // Find the SaveVideo node output (node 75)
      const videoOutput = outputs['75'];
      if (videoOutput?.videos?.[0]) {
        const video = videoOutput.videos[0];
        return {
          type: 'video',
          url: comfyui.getMediaUrl(video.filename, video.subfolder || '', video.type || 'output'),
          filename: video.filename
        };
      }

      return null;
    } catch (err) {
      console.error('Error getting result:', err);
      return null;
    }
  }, []);

  /**
   * Cancel the current generation
   */
  const cancel = useCallback(async () => {
    await comfyui.interrupt();
    setIsGenerating(false);
    setProgress({ value: 0, max: 100 });
    setCurrentPromptId(null);
  }, []);

  /**
   * Clear the current result
   */
  const clearResult = useCallback(() => {
    setGenerationResult(null);
  }, []);

  return {
    isConnected,
    isGenerating,
    progress,
    error,
    queueCount,
    generationResult,
    generateVideo,
    getResult,
    cancel,
    clearResult,
    wsConnected,  // Expose WebSocket connection status
    currentNode,  // Expose which node is executing
  };
}

export default useComfyUI;
