import test from 'node:test'
import assert from 'node:assert/strict'
import * as media from '../src/utils/mediaUrl.js'
test('an empty asset can preview its completed candidate without adopting it', () => {
  assert.equal(typeof media.latestAssetCandidate, 'function')
  const entity = { id: 3, drama_id: 7, local_path: null, image_url: null }
  const candidate = { id: 50, drama_id: 7, character_id: 3, engine: 'comfyui', status: 'completed', image_url: '/static/candidate.png' }
  assert.equal(media.latestAssetCandidate([candidate], 'character', entity), candidate)
  assert.equal(media.assetImageUrl(entity), '')
  assert.equal(media.assetImageUrl(candidate), '/static/candidate.png')
})
test('candidate preview keeps existing main image and excludes foreign, failed and selected records', () => {
  assert.equal(typeof media.latestAssetCandidate, 'function')
  const entity = { id: 16, drama_id: 7, image_url: '/static/main.png' }
  const base = { drama_id: 7, prop_id: 16, engine: 'comfyui', status: 'completed', image_url: '/static/new.png' }
  const candidates = [{ ...base, drama_id: 8 }, { ...base, prop_id: 17 }, { ...base, status: 'failed' }, { ...base, generation_metadata: { result_usage: 'selected' } }, base]
  assert.equal(media.latestAssetCandidate(candidates, 'prop', entity), base)
  assert.equal(media.assetImageUrl(entity), '/static/main.png')
})
test('preview URLs show candidates explicitly and keep asset reference URLs empty until selection', () => {
  const entity = { image_candidate: { image_url: '/static/candidate.png' } }
  assert.equal(media.assetPreviewUrl(entity), '/static/candidate.png')
  assert.equal(media.assetImageUrl(entity), '')
  assert.equal(media.assetPreviewUrl({ ...entity, image_url: '/static/main.png' }), '/static/main.png')
})
