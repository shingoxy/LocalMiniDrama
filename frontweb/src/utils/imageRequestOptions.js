// Temporary choices belong to the currently displayed project; saved defaults are resolved by the backend.
let currentProject = null
let currentOptions = {}
export function setImageRequestOptions(dramaId, options = {}) {
  currentProject = Number(dramaId) || 0
  currentOptions = options
}
export function clearImageRequestOptions(dramaId) {
  if (currentProject === (Number(dramaId) || 0)) { currentProject = null; currentOptions = {} }
}
export function withImageOptions(data = {}, purpose = 'image') {
  const project = data.drama_id == null ? currentProject : Number(data.drama_id) || 0
  const options = project === currentProject ? currentOptions : {}
  const selected = options[purpose] || {}
  return { ...selected, ...(['character', 'scene', 'prop'].includes(purpose) && project > 0 && data.drama_id == null ? { drama_id: project } : {}), ...data }
}
export function imagePurpose(data = {}) {
  if (data.character_id) return 'character'
  if (data.prop_id) return 'prop'
  if (data.scene_id && !data.storyboard_id) return 'scene'
  if (['last', 'storyboard_last', 'tail', 'last_frame'].includes(data.frame_type)) return 'last'
  return data.storyboard_id ? 'first' : 'image'
}
