# Text to Image (Z Image Turbo)

Generate image from text prompt using Z Image Turbo

- **Workflow ID:** `z-image-turbo`
- **Category:** `image`
- **Tier:** `lite`
- **Runtime:** `local`
- **App Workflow JSON:** `/workflows/image_z_image_turbo.json`
- **Starter Pack Setup Workflow:** `workflows/local/z-image-turbo.comfyui.json`
- **Setup Workflow Status:** `available`

## What This Setup Workflow Is
- A ComfyUI-importable copy of the workflow graph bundled with ComfyStudio.
- Use it to inspect missing nodes, model loaders, and expected filenames directly inside ComfyUI.
- This is a local workflow: expect to install the listed custom nodes and local model files before it runs successfully.

## Required Custom Nodes
- `CLIPLoader`
- `KSampler`
- `ModelSamplingAuraFlow`
- `SaveImage`
- `UNETLoader`
- `VAELoader`

## Required Models
| Filename | ComfyUI Folder | Loader | Input Key |
|---|---|---|---|
| `ae.safetensors` | `models/vae` | `VAELoader` | `vae_name` |
| `qwen_3_4b.safetensors` | `models/text_encoders` | `CLIPLoader` | `clip_name` |
| `z_image_turbo_bf16.safetensors` | `models/diffusion_models` | `UNETLoader` | `unet_name` |

## API Key
- Not required for this workflow.

## Setup Steps
1. Import `workflows/local/z-image-turbo.comfyui.json` into ComfyUI.
2. Let ComfyUI show any missing custom nodes, then install them in ComfyUI Manager.
3. Place the required model files into the folders listed above.
4. Re-open the workflow in ComfyUI and confirm all loaders resolve.
5. Return to ComfyStudio Generate and click `Re-check` before queueing.

## Related Guides
- `../WHERE_FILES_GO.md`
- `../API_KEYS.md`
- `../TROUBLESHOOTING.md`

