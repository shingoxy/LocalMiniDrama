import request from '@/utils/request'
export const hybridVideoAPI = {
  models: () => request.get('/hybrid-video/models'),
  state: episode_id => request.get('/hybrid-video/state', { params: { episode_id } }),
  settings: () => request.get('/hybrid-video/settings'),
  saveSettings: body => request.put('/hybrid-video/settings', body),
  connection: () => request.post('/hybrid-video/connection'),
  selection: body => request.put('/hybrid-video/selection', body),
  forecast: body => request.post('/hybrid-video/forecast', body),
  quote: requests => request.post('/hybrid-video/quote', { requests }),
  prompt: id => request.get(`/hybrid-video/shots/${id}/prompt`),
  optimize: (id, force = false) => request.post(`/hybrid-video/shots/${id}/optimize`, { force }),
  savePrompt: (id, body) => request.put(`/hybrid-video/shots/${id}/prompt`, body),
  keepStatic: id => request.post(`/hybrid-video/shots/${id}/static`),
  history: episode_id => request.get('/hybrid-video/history', { params: { episode_id } }),
  cancel: id => request.post(`/hybrid-video/generations/${id}/cancel`),
}
