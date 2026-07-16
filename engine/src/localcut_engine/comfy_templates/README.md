# ComfyUI workflow templates

API-format workflow JSON with `%%PLACEHOLDER%%` substitution (PROMPT, SEED,
WIDTH, HEIGHT, KEYFRAME, FRAMES) applied by the ComfyUI backend. Users can
override any template by dropping a same-named file in
`<data_dir>/comfy-templates/`.

- `keyframe_default.json` / `thumbnail_default.json` — SDXL text-to-image
  (needs `checkpoints/sd_xl_base_1.0.safetensors`)
- `clip_default.json` — LTX-Video image-to-video (needs
  `checkpoints/ltx-video-2b-v0.9.5.safetensors` +
  `text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors`); untested below
  12 GB VRAM
