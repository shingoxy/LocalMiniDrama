import request from '@/utils/request'
import { withImageOptions, imagePurpose } from '@/utils/imageRequestOptions'

export const imagesAPI = {
  list(params) {
    return request.get('/images', { params: params || {} })
  },
  create(data) {
    return request.post('/images', withImageOptions(data, imagePurpose(data)))
  },
  models(params) { return request.get('/images/models', { params }) },
  selection(data) { return request.put('/images/selection', data) },
  localSettings() { return request.get('/images/local/settings') },
  saveLocalSettings(data) { return request.put('/images/local/settings', data) },
  connection() { return request.post('/images/local/connection', {}) },
  queue() { return request.get('/images/local/queue') },
  select(id, data = {}) { return request.post(`/images/${id}/select`, data) },
  cancel(id) { return request.post(`/images/${id}/cancel`, {}) },
  resume(id) { return request.post(`/images/${id}/resume`, {}) },
  upload(data) {
    return request.post('/images/upload', data)
  },
  delete(id) {
    return request.delete(`/images/${id}`)
  }
}
