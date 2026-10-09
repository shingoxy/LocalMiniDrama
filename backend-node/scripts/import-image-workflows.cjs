// Export minimal API graphs from the installed workflows without copying private prompts.
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const sourceDir = process.argv[2];
if (!sourceDir) throw new Error('Usage: node scripts/import-image-workflows.cjs <ComfyUI workflow directory>');
const out = path.resolve(__dirname, '../configs/workflows');
const node = (class_type, inputs) => ({ class_type, inputs });
function source(name) {
  const bytes = fs.readFileSync(path.join(sourceDir, name));
  return { graph: JSON.parse(bytes), source_file: name, source_sha256: createHash('sha256').update(bytes).digest('hex') };
}
const q = source('qwen_image_2_1_Q8_0_t2i.json');
const edit = source('【Qwen Image 2.1】图像生成大合集.json');
const f = source('文+自动提示词-自动生图-Flux1Dev.json');
function widget(src, id, index) {
  const n = src.graph.nodes.find(n => n.id === id && n.mode === 0);
  if (!n) throw new Error(`Missing active source node ${id}`);
  return n.widgets_values[index];
}
function write(key, workflow, mapping, src) {
  const provenance = { source_file: src.source_file, source_sha256: src.source_sha256 };
  for (const [suffix, value] of [['', workflow], ['.mapping', { version: 1, key, ...provenance, ...mapping }]]) {
    fs.writeFileSync(path.join(out, key + suffix + '.json'), JSON.stringify(value, null, 2) + '\n');
  }
}
for (const mode of ['t2i', 'edit']) {
  const key = 'qwen_image_21_' + mode;
  const w = {
    '1': node('UnetLoaderGGUF', { unet_name: widget(q, 1, 0) }),
    '2': node('CLIPLoader', { clip_name: widget(q, 2, 0), type: widget(q, 2, 1), device: widget(q, 2, 2) }),
    '3': node('VAELoader', { vae_name: widget(q, 3, 0) }),
    '4': node('EmptyLatentImage', { width: 1024, height: 1024, batch_size: 1 }),
    '5': node('TextEncodeQwenImage21', { clip: ['2', 0], vae: ['3', 0], prompt: '', negative_prompt: '', resolution: 1024 }),
    '6': node('KSampler', { model: ['1', 0], positive: ['5', 0], negative: ['5', 1], latent_image: ['4', 0], seed: 0, steps: widget(q, 6, 2), cfg: widget(q, 6, 3), sampler_name: widget(q, 6, 4), scheduler: widget(q, 6, 5), denoise: 1 }),
    '7': node('VAEDecode', { samples: ['6', 0], vae: ['3', 0] }),
    '8': node('SaveImage', { images: ['7', 0], filename_prefix: 'LocalMiniDrama/images' }),
  };
  if (mode === 'edit') {
    w.ref_1 = node('LoadImage', { image: '' });
    w['4'] = node('ImageScale', { image: ['ref_1', 0], upscale_method: 'lanczos', width: 1024, height: 1024, crop: 'disabled' });
    w['5'].inputs['images.image_1'] = ['4', 0];
    w['5'].inputs.resolution = 0;
    w['6'].inputs.latent_image = ['5', 2];
  }
  write(key, w, { model_key: 'local:qwen-image-2.1', mode, max_references: mode === 'edit' ? 6 : 0, size_multiple: 32,
    reference_node: '5', reference_input_prefix: 'images.image_', first_reference_canvas: mode === 'edit', model_node: '1',
    fields: { prompt: { node: '5', input: 'prompt' }, negative_prompt: { node: '5', input: 'negative_prompt' }, seed: { node: '6', input: 'seed' }, width: { node: '4', input: 'width' }, height: { node: '4', input: 'height' }, output: { node: '8', input: 'filename_prefix' } },
    notes: 'Installed GGUF/8B branch; editing samples the encoder latent on the first-reference canvas to avoid spatial shifts. EmptyLatentImage t2i uses native KSampler channel/downscale adaptation. No default LoRA.' }, mode === 'edit' ? edit : q);
}
const flux = {
  '1': node('UNETLoader', { unet_name: widget(f, 20, 0), weight_dtype: widget(f, 20, 1) }),
  '2': node('DualCLIPLoader', { clip_name1: widget(f, 19, 0), clip_name2: widget(f, 19, 1), type: widget(f, 19, 2), device: widget(f, 19, 3) }),
  '3': node('VAELoader', { vae_name: widget(f, 26, 0) }),
  '4': node('EmptySD3LatentImage', { width: 1024, height: 1024, batch_size: 1 }),
  '5': node('CLIPTextEncode', { clip: ['2', 0], text: '' }),
  '9': node('CLIPTextEncode', { clip: ['2', 0], text: '' }),
  '10': node('FluxGuidance', { conditioning: ['5', 0], guidance: widget(f, 13, 0) }),
  '6': node('KSampler', { model: ['1', 0], positive: ['10', 0], negative: ['9', 0], latent_image: ['4', 0], seed: 0, steps: widget(f, 22, 2), cfg: widget(f, 22, 3), sampler_name: widget(f, 22, 4), scheduler: widget(f, 22, 5), denoise: 1 }),
  '7': node('VAEDecode', { samples: ['6', 0], vae: ['3', 0] }),
  '8': node('SaveImage', { images: ['7', 0], filename_prefix: 'LocalMiniDrama/images' }),
};
write('flux1_dev_t2i', flux, { model_key: 'local:flux1-dev', mode: 't2i', max_references: 0, size_multiple: 16, model_node: '1',
  fields: { prompt: { node: '5', input: 'text' }, negative_prompt: { node: '9', input: 'text' }, seed: { node: '6', input: 'seed' }, width: { node: '4', input: 'width' }, height: { node: '4', input: 'height' }, output: { node: '8', input: 'filename_prefix' } },
  notes: 'Text-to-image only; optional user-selected identity LoRA, no private prompts or default LoRAs.' }, f);
console.log('Exported Qwen generation/edit and Flux generation API graphs.');
