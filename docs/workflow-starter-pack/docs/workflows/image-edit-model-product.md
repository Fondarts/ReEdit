# Qwen Image Edit 2509 (Model + Product)

Local image-edit workflow used by Director Mode for combined model and product keyframes.

- **Workflow ID:** `image-edit-model-product`
- **Category:** `image`
- **Tier:** `standard`
- **Runtime:** `local`
- **App Workflow JSON:** `/workflows/image_qwen_image_edit_2509_Model_and_Product.json`
- **Starter Pack Setup Workflow:** `workflows/local/image-edit-model-product.comfyui.json`
- **Setup Workflow Status:** `available`

## What This Setup Workflow Is
- A ComfyUI-importable copy of the workflow graph bundled with ComfyStudio.
- Use it to inspect missing nodes, model loaders, and expected filenames directly inside ComfyUI.
- This is a local workflow: expect to install the listed custom nodes and local model files before it runs successfully.

## Required Custom Nodes
- `FluxKontextImageScale`
- `ImageResizeKJv2`
- `KSampler`
- `SaveImage`
- `TextEncodeQwenImageEditPlus`

## Required Models
| Filename | ComfyUI Folder | Loader | Input Key |
|---|---|---|---|
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | `models/text_encoders` | `CLIPLoader` | `clip_name` |
| `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | `models/diffusion_models` | `UNETLoader` | `unet_name` |
| `qwen_image_vae.safetensors` | `models/vae` | `VAELoader` | `vae_name` |
| `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors` | `models/loras` | `LoraLoaderModelOnly` | `lora_name` |

## API Key
- Not required for this workflow.

## Setup Steps
1. Import `workflows/local/image-edit-model-product.comfyui.json` into ComfyUI.
2. Let ComfyUI show any missing custom nodes, then install them in ComfyUI Manager.
3. Place the required model files into the folders listed above.
4. Re-open the workflow in ComfyUI and confirm all loaders resolve.
5. Return to ComfyStudio Generate and click `Re-check` before queueing.

## Related Guides
- `../WHERE_FILES_GO.md`
- `../API_KEYS.md`
- `../TROUBLESHOOTING.md`

