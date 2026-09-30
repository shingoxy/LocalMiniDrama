// Rules derived from MiniMax-AI/MiniMax-H3/skills/h3-prompt-writing, checked 2026-09-30.
const VERSION = 'h3-official-20260930-v1';
const FIRST = 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
function alignment(mode, duration) {
  if (mode === 'I2VA') return FIRST;
  if (mode === 'FL2VA') return `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${Number(duration).toFixed(2)}-second mark of the target video.`;
  if (mode === 'L2VA') return `How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the ${Number(duration).toFixed(2)}-second mark of the target video.`;
  return '';
}
function systemPrompt(mode, duration) {
  if (!['T2VA', 'I2VA', 'FL2VA', 'L2VA', 'Ref2VA'].includes(mode)) throw new Error('不支持的 H3 Mode');
  const sections = mode === 'Ref2VA'
    ? 'subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music'
    : 'integrated_multimodal_description, overall_soundscape, non_diegetic_music';
  return `Convert the supplied director intent into a MiniMax H3 ${mode} prompt for ${duration} seconds. Do not rewrite the story or add characters, dialogue, events or plot twists.
Use English prose; keep every word and punctuation of supplied dialogue and visible text in its original language. Keep one core action and one continuous shot for a short clip. Establish the composition, expression, camera angle and camera motion; describe onset, continuous movement, reaction and final state in order. Do not crowd the time span. If dialogue cannot fit, return an error instead of silently shortening it.
Output ONLY plain text, with these exact colon-delimited fields in order: ${sections}.
${alignment(mode, duration) ? 'The very first line must be: ' + alignment(mode, duration) + '\nThen a blank line before the fields.' : 'Do not add image alignment instructions for T2VA.'}
In base modes start the main field with [Shot 1], without an opening timestamp. Do not introduce cuts unless supplied. Subsequent cuts use [Shot N] At MM:SS.mmm, strictly increasing and inside the clip. Camera movement is a physical verb with meaningful amplitude and speed.
Use stable speaker IDs (S1), (S2) only for speaking subjects, describing their voice outside the dialogue tag. Spoken words go inside <d>[Language] exact original words</d>. Voiceover uses "says in an off-screen voiceover" and states that the on-screen character's lips remain closed. Do not invent speech. Preserve image identity and clothing. I2VA evolves forward from the exact opening image. FL2VA connects both keyframes continuously and reaches the last one at the end. L2VA converges to the ending image with no later action.
overall_soundscape is a short paragraph of ambience, physical sounds and non-verbal human sounds; do not duplicate dialogue. N/A is used for complete silence only. non_diegetic_music describes concrete instruments/rhythm, or N/A when no score is wanted. Keep environmental sound separate from music.
Ref2VA must use the six-field format instead, stable <Picture N>/<Video N>/<Audio N> labels, explicit retained/replaced reference attributes, and timeline placement of references. Never confuse a reference image with a keyframe.`;
}
function validate(prompt, mode, duration) {
  const p = String(prompt || '').trim().replace(/^```(?:text)?\s*\n/, '').replace(/\n```$/, '').trim();
  const fields = mode === 'Ref2VA' ? ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']
    : ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'];
  let previous = -1;
  for (const field of fields) {
    const at = p.indexOf(field + ':');
    if (at <= previous) throw new Error('H3 Prompt 缺少或顺序错误: ' + field);
    previous = at;
  }
  const first = alignment(mode, duration);
  if (first && !p.startsWith(first)) throw new Error('H3 Prompt 首/尾帧对齐声明不匹配当前 Mode');
  if (mode !== 'Ref2VA' && !p.includes('[Shot 1]')) throw new Error('H3 Prompt 缺少 [Shot 1]');
  if (/<think>|```/i.test(p)) throw new Error('H3 Prompt 包含推理或 Markdown');
  return p;
}
module.exports = { VERSION, alignment, systemPrompt, validate };
