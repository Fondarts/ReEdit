# Image to Video (WAN 2.2)

Animate an image into video

- **Workflow ID:** `wan22-i2v`
- **Category:** `video`
- **Tier:** `pro`
- **Runtime:** `local`
- **App Workflow JSON:** `/workflows/video_wan2_2_14B_i2v.json`
- **Starter Pack Setup Workflow:** `workflows/local/wan22-i2v.comfyui.json`
- **Setup Workflow Status:** `available`

## What This Setup Workflow Is
- A ComfyUI-importable copy of the workflow graph bundled with ComfyStudio.
- Use it to inspect missing nodes, model loaders, and expected filenames directly inside ComfyUI.
- This is a local workflow: expect to install the listed custom nodes and local model files before it runs successfully.

## Required Custom Nodes
- `CLIPLoader`
- `LoraLoaderModelOnly`
- `SaveVideo`
- `UNETLoader`
- `VAELoader`
- `WanImageToVideo`

## Required Models
| Filename | ComfyUI Folder | Loader | Input Key |
|---|---|---|---|
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `models/text_encoders` | `CLIPLoader` | `clip_name` |
| `wan_2.1_vae.safetensors` | `models/vae` | `VAELoader` | `vae_name` |
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | `models/diffusion_models` | `UNETLoader` | `unet_name` |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | `models/loras` | `LoraLoaderModelOnly` | `lora_name` |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | `models/loras` | `LoraLoaderModelOnly` | `lora_name` |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | `models/diffusion_models` | `UNETLoader` | `unet_name` |

## API Key
- Not required for this workflow.

## Setup Steps
1. Import `workflows/local/wan22-i2v.comfyui.json` into ComfyUI.
2. Let ComfyUI show any missing custom nodes, then install them in ComfyUI Manager.
3. Place the required model files into the folders listed above.
4. Re-open the workflow in ComfyUI and confirm all loaders resolve.
5. Return to ComfyStudio Generate and click `Re-check` before queueing.

## Related Guides
- `../WHERE_FILES_GO.md`
- `../API_KEYS.md`
- `../TROUBLESHOOTING.md`

