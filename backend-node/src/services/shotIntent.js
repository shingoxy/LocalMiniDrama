const { createHash } = require('crypto');
const { json } = require('./videoModelSelection');
function imageKey(value) {
  if (!value) return '';
  try { const u = new URL(value); if (u.pathname.startsWith('/static/')) return u.pathname; } catch {}
  return value;
}
function build(db, shot = {}, body = {}) {
  const ids = json(shot.characters, []);
  const characters = Array.isArray(ids) ? ids.map(id => db.prepare('SELECT name, appearance, description FROM characters WHERE id = ?').get(Number(typeof id === 'object' ? id.id : id))).filter(Boolean) : [];
  const scene = shot.scene_id ? db.prepare('SELECT * FROM scenes WHERE id = ?').get(shot.scene_id) : null;
  const saved = json(shot.shot_intent);
  return {
    original_prompt: (shot.creation_mode === 'universal' ? shot.universal_segment_text : '') || shot.video_prompt || shot.description || body.prompt || '',
    duration: Number(body.duration || shot.duration) > 0 ? Number(body.duration || shot.duration) : 5,
    characters, appearance: characters.map(c => c.appearance || c.description || '').join('; '),
    action: shot.action || '', expression: shot.atmosphere || '', dialogue: shot.dialogue || '',
    scene: scene?.prompt || scene?.location || shot.location || shot.description || '', lighting: shot.time || '',
    framing: shot.shot_type || '', camera_angle: [shot.angle, shot.angle_h, shot.angle_v, shot.angle_s].filter(Boolean).join(', '),
    camera_movement: shot.movement || '', action_sequence: shot.action || '', sound: '', music: '',
    reference_image_role: 'first frame', first_frame_intent: 'Preserve identity, clothing, composition and environment.',
    last_frame_intent: shot.result || '',
    ...saved,
    duration: Number(body.duration || shot.duration) > 0 ? Number(body.duration || shot.duration) : 5,
    reference_image: imageKey(body.first_frame_url || body.image_url || shot.composed_image || shot.image_url || ''),
    last_frame: imageKey(body.last_frame_url || shot.last_frame_image_url || ''),
  };
}
function hash(intent, mode) { return createHash('sha256').update(JSON.stringify({ intent, mode })).digest('hex'); }
module.exports = { build, hash };
