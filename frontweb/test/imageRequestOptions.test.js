import test from 'node:test'
import assert from 'node:assert/strict'
import { setImageRequestOptions, clearImageRequestOptions, withImageOptions, imagePurpose } from '../src/utils/imageRequestOptions.js'
test('temporary image choices are scoped to the active project and explicit request wins', () => {
  setImageRequestOptions(7, { first: { image_model_key: 'local:qwen-image-2.1', seed: 42 } })
  assert.equal(withImageOptions({ drama_id: 7 }, 'first').image_model_key, 'local:qwen-image-2.1')
  assert.equal(withImageOptions({ drama_id: 8 }, 'first').image_model_key, undefined)
  assert.equal(withImageOptions({ drama_id: 7, image_model_key: 'local:flux1-dev' }, 'first').image_model_key, 'local:flux1-dev')
  clearImageRequestOptions(7)
  assert.equal(withImageOptions({ drama_id: 7 }, 'first').seed, undefined)
})
test('character, scene, canvas and batch wrappers share purpose options without leaking to text/video requests', () => {
  setImageRequestOptions(7, { character: { image_model_key: 'local:flux1-dev' }, scene: { image_model_key: 'local:qwen-image-2.1' } })
  assert.equal(withImageOptions({ model: undefined }, 'character').image_model_key, 'local:flux1-dev')
  assert.equal(withImageOptions({ scene_id: 9 }, 'scene').image_model_key, 'local:qwen-image-2.1')
  assert.equal(imagePurpose({ storyboard_id: 1, frame_type: 'storyboard_last' }), 'last')
  assert.equal(imagePurpose({ storyboard_id: 1, scene_id: 9 }), 'first')
  assert.equal(imagePurpose({ character_id: 1 }), 'character')
  assert.equal(imagePurpose({ scene_id: 1 }), 'scene')
  clearImageRequestOptions(7)
})
