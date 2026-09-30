// One-time mechanical export of a saved ComfyUI graph, including subgraphs and Set/Get links.
// Does not edit the source workflow, models, samplers or LoRA settings.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/import-h3-workflow.cjs <saved workflow.json>');
const raw = fs.readFileSync(source, 'utf8');
const workflow = JSON.parse(raw);
const definitions = new Map((workflow.definitions?.subgraphs || []).map(g => [g.id, g]));
const result = {};
function exportGraph(graph, prefix = '', parentInputs = {}) {
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  const links = new Map(graph.links.map(l => Array.isArray(l)
    ? [l[0], { origin_id: l[1], origin_slot: l[2] }] : [l.id, l]));
  const values = new Map();
  function inputsFor(node) {
    if (values.has(node.id)) return values.get(node.id);
    const inputs = {};
    let i = 0;
    for (const input of node.inputs || []) {
      let value;
      if (input.widget && input.type !== 'IMAGEUPLOAD' && input.type !== 'RESOLUTION_PREVIEW') {
        value = Array.isArray(node.widgets_values) ? node.widgets_values[i++] : node.widgets_values?.[input.name];
      }
      if (input.link != null) {
        const l = links.get(input.link);
        value = resolve(l.origin_id, l.origin_slot);
      }
      if (value !== undefined) inputs[input.name] = value;
    }
    values.set(node.id, inputs);
    return inputs;
  }
  function resolve(id, slot) {
    if (id === -10) return parentInputs[graph.inputs[slot].name];
    const node = nodes.get(id);
    if (!node) throw new Error('Missing linked node ' + id);
    if (node.type === 'GetNode') {
      const setter = graph.nodes.find(n => n.type === 'SetNode' && n.widgets_values[0] === node.widgets_values[0]);
      if (!setter) throw new Error('Missing SetNode for ' + node.widgets_values[0]);
      const link = links.get(setter.inputs[0].link);
      return resolve(link.origin_id, link.origin_slot);
    }
    if (definitions.has(node.type)) {
      const sub = definitions.get(node.type);
      exportGraph(sub, prefix + id + '_', inputsFor(node));
      const out = sub.links.find(l => l.target_id === -20 && l.target_slot === slot);
      return [prefix + id + '_' + out.origin_id, out.origin_slot];
    }
    return [prefix + id, slot];
  }
  for (const node of graph.nodes) {
    if (['SetNode', 'GetNode', 'MarkdownNote', 'Note'].includes(node.type)) continue;
    if (node.mode === 2 || node.mode === 4) throw new Error('Bypassed node requires API export from ComfyUI: ' + node.id);
    if (definitions.has(node.type)) { exportGraph(definitions.get(node.type), prefix + node.id + '_', inputsFor(node)); continue; }
    result[prefix + node.id] = { class_type: node.type, inputs: inputsFor(node) };
  }
}
exportGraph(workflow);
// Remove UI-only previews and unused nodes by tracing the actual video output.
const used = new Set();
function visit(id) {
  if (used.has(id)) return;
  used.add(id);
  for (const v of Object.values(result[id].inputs)) if (Array.isArray(v) && result[v[0]]) visit(v[0]);
}
const outputs = Object.entries(result).filter(([, n]) => n.class_type === 'SaveVideo' || n.class_type === 'VHS_VideoCombine');
if (outputs.length !== 1) throw new Error('Expected one video output');
visit(outputs[0][0]);
for (const id of Object.keys(result)) if (!used.has(id)) delete result[id];
const h3 = Object.entries(result).find(([,n]) => n.class_type === 'MiniMaxH3ImageToVideo');
if (!h3) throw new Error('Expected existing MiniMaxH3ImageToVideo');
result[h3[0]].inputs.prompt = '';
for (const node of Object.values(result)) if (node.class_type === 'LoadImage') node.inputs.image = 'reference.png';
const dir = path.resolve(__dirname, '../configs/workflows');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'minimax_h3.json'), JSON.stringify(result, null, 2) + '\n');
const mapping = {
  version: 1, engine: 'minimax-h3', mode: 'I2VA', supported_modes: ['I2VA'],
  source_file: path.basename(source), source_sha256: crypto.createHash('sha256').update(raw).digest('hex'),
  native_fps: 24, frame_grid: { block: 17, offset: 5 },
  fields: {
    prompt: { node: h3[0], input: 'prompt' },
    reference_image: { node: '114', input: 'image' }, first_frame: { node: '114', input: 'image' },
    last_frame: null, duration: { node: '105_111', input: 'value' },
    frames: { node: h3[0], input: 'length' }, fps: { node: '105_91', input: 'fps' },
    width: { node: h3[0], input: 'width' }, height: { node: h3[0], input: 'height' },
    seed: { node: '105_15', input: 'noise_seed' }, audio: null,
    output: { node: outputs[0][0], input: 'filename_prefix', media_keys: ['images', 'videos', 'gifs'] },
  },
  model_nodes: Object.entries(result).filter(([,n]) => /Loader/.test(n.class_type)).map(([id]) => id),
  notes: 'Saved current graph; first image is resized as in the original graph, dimensions follow that image. Native audio is generated, external audio/last frame are not connected.'
};
fs.writeFileSync(path.join(dir, 'minimax_h3.mapping.json'), JSON.stringify(mapping, null, 2) + '\n');
console.log('Exported', Object.keys(result).length, 'nodes; mode', mapping.mode);
