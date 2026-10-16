/** 统一媒体 URL：优先 local_path，其次 image_url / video_url */
export function assetImageUrl(item) {
  if (!item) return ''
  const lp = item.local_path && String(item.local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return item.image_url || ''
}

export function assetPreviewUrl(item) {
  return assetImageUrl(item) || assetImageUrl(item?.image_candidate)
}

/** 最新未选用候选只供预览；主图切换仍由用户明确执行。 */
export function latestAssetCandidate(items, kind, entity) {
  const field = { character: 'character_id', scene: 'scene_id', prop: 'prop_id' }[kind]
  if (!field || !entity?.id) return null
  return (items || []).find(row => Number(row.drama_id) === Number(entity.drama_id) &&
    Number(row[field]) === Number(entity.id) && row.status === 'completed' && row.engine === 'comfyui' &&
    row.generation_metadata?.result_usage !== 'selected' && assetImageUrl(row) &&
    assetImageUrl(row) !== assetImageUrl(entity)) || null
}

export function storyboardImageUrl(sb) {
  if (!sb) return ''
  return assetImageUrl(sb)
}

export function storyboardVideoUrl(sb) {
  if (!sb) return ''
  const lp = sb.video_local_path && String(sb.video_local_path).trim()
  if (lp) return '/static/' + lp.replace(/^\//, '')
  return sb.video_url || ''
}

export function audioUrl(localPath) {
  if (!localPath) return ''
  const p = String(localPath).trim()
  if (!p) return ''
  return '/static/' + p.replace(/^\//, '')
}
