import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { getTaskPollInterval } from '../src/utils/generationPolling.js'

// Execute the real store with virtual time and mocked HTTP; no generation is submitted.
const source = readFileSync(new URL('../src/stores/generationTaskStore.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '')
  .replace(/export const /g, 'const ')
const videoMeta = { dramaId: 6, episodeId: 7, resourceType: 'sb_video', resourceId: 130 }
const minute = 60_000

function setup({ completeAt = 22 * minute, getTask } = {}) {
  let now = 0
  let requests = 0
  const timers = []
  const epoch = Date.parse('2026-10-16T00:00:00Z')
  class Clock extends Date {
    static now() { return epoch + now }
  }
  const taskAPI = {
    async get(id) {
      requests++
      return getTask?.({ now, id, requests }) ?? {
        status: now >= completeAt ? 'completed' : 'processing',
        // A queued local task must not be declared orphaned just because progress hasn't changed.
        updated_at: new Date(epoch).toISOString(),
        result: { video_generation_id: 50 },
      }
    },
    async listByResource() { return [] },
  }
  const scope = {
    defineStore: (_, create) => create,
    ref: (value) => ({ value }),
    computed: (get) => ({ get value() { return get() } }),
    taskAPI,
    imagesAPI: { async list() { return { items: [] } } },
    videosAPI: { async list() { return { items: [{ storyboard_id: 130, status: 'processing', task_id: 'video' }] } } },
    getTaskPollInterval,
    Date: Clock,
    console: { warn() {} },
    setTimeout(callback, delay) { timers.push({ callback, at: now + delay }) },
  }
  const store = vm.runInNewContext(`${source}\nuseGenerationTaskStore()`, scope)
  async function advanceTo(target) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    let steps = 0
    while (true) {
      timers.sort((a, b) => a.at - b.at)
      if (!timers.length || timers[0].at > target) break
      assert(++steps < 10_000, 'unexpected polling loop')
      const timer = timers.shift()
      now = timer.at
      await timer.callback()
      for (let i = 0; i < 8; i++) await Promise.resolve()
    }
    now = target
  }
  return { store, scope, advanceTo, requests: () => requests }
}

test('a 22 minute local video completes and refreshes media without a page refresh', async () => {
  const h = setup()
  let previews = 0
  const result = h.store.pollTask('video', videoMeta, () => { previews++ })
  await h.advanceTo(15 * minute)
  assert.equal(h.store.isRunning(videoMeta), true)
  assert.equal(previews, 0)
  await h.advanceTo(22 * minute)
  assert.equal((await result).status, 'completed')
  assert.equal(previews, 1)
  assert.equal(h.requests(), 156) // Previously 660 requests would be needed at 2 second intervals.
})

test('queued videos survive 30 minute reconciliation and a wait longer than two hours', async () => {
  const h = setup({ completeAt: 145 * minute })
  const result = h.store.pollTask('video', videoMeta)
  await h.advanceTo(44 * minute)
  await h.store.reconcileRunningTasks()
  assert.equal(h.store.isRunning(videoMeta), true)
  await h.advanceTo(121 * minute)
  assert.equal(h.store.isRunning(videoMeta), true)
  await h.advanceTo(145 * minute)
  assert.equal((await result).status, 'completed')
})

test('a new view shares the current poll and receives its own completion refresh', async () => {
  const h = setup()
  const refreshed = []
  const original = h.store.pollTask('video', videoMeta, () => refreshed.push('list'))
  await h.advanceTo(16 * minute)
  const recovered = h.store.attachPollIfNeeded('video', videoMeta, () => refreshed.push('canvas'))
  await h.advanceTo(22 * minute)
  assert.equal((await original).status, 'completed')
  assert.equal((await recovered).status, 'completed')
  assert.deepEqual(refreshed.sort(), ['canvas', 'list'])
  assert.equal(h.requests(), 156, 'attaching a view must not start another poll')
})

test('re-entering an episode reattaches its current video completion callback', async () => {
  const h = setup()
  const refreshed = []
  const ctx = { dramaId: 6, episodeId: 7, storyboards: [{ id: 130 }] }
  await h.store.recoverPendingForEpisode({ ...ctx, callbacks: { onStoryboardMedia: () => refreshed.push('old') } })
  await h.advanceTo(16 * minute)
  await h.store.recoverPendingForEpisode({ ...ctx, callbacks: { onStoryboardMedia: () => refreshed.push('new') } })
  assert.equal(h.store.isRunning(videoMeta), true)
  await h.advanceTo(22 * minute)
  assert.deepEqual(refreshed.sort(), ['new', 'old'])
})

test('temporary network failures keep video polling alive until the backend completes', async () => {
  const h = setup({ getTask: ({ now }) => {
    if (now >= 15 * minute && now < 20 * minute) throw new Error('offline')
    return { status: now >= 22 * minute ? 'completed' : 'processing' }
  } })
  const result = h.store.pollTask('video', videoMeta)
  await h.advanceTo(22 * minute)
  assert.equal((await result).status, 'completed')
})

test('backend failure ends video polling and does not refresh a successful preview', async () => {
  const h = setup({ getTask: () => ({ status: 'failed', error: 'ComfyUI failed' }) })
  let previews = 0
  const result = h.store.pollTask('video', videoMeta, () => { previews++ })
  await h.advanceTo(2000)
  assert.equal((await result).status, 'failed')
  assert.equal(previews, 0)
  await h.advanceTo(minute)
  assert.equal(h.requests(), 1)
})

test('stopping a video poll does not continue requests or invoke completion callbacks', async () => {
  const h = setup()
  let previews = 0
  const result = h.store.pollTask('video', videoMeta, () => { previews++ })
  await h.advanceTo(16 * minute)
  h.store.stopPollingTask('video', '用户已取消')
  const requests = h.requests()
  await h.advanceTo(22 * minute)
  assert.equal((await result).status, 'cancelled')
  assert.equal(previews, 0)
  assert.equal(h.requests(), requests)
})

test('non-video polling retains its existing 15 minute limit', async () => {
  const h = setup({ getTask: () => ({ status: 'processing' }) })
  const result = h.store.pollTask('image', { ...videoMeta, resourceType: 'sb_image' })
  await h.advanceTo(15 * minute)
  assert.equal((await result).status, 'timeout')
  assert.equal(h.requests(), 450)
})

const filmSource = readFileSync(new URL('../src/views/FilmCreate.vue', import.meta.url), 'utf8')
const pauseSource = filmSource.slice(filmSource.indexOf('function pollTaskWithPause('), filmSource.indexOf('\nfunction waitForResume('))
function pipelinePoll(h) {
  Object.assign(h.scope, {
    genStore: h.store,
    GEN_RESOURCE: h.store.GEN_RESOURCE,
    resolvePollMeta: (meta) => meta,
    pipelineAbortRequested: { value: false },
    pipelinePaused: { value: false },
  })
  return vm.runInNewContext(`${pauseSource}\npollTaskWithPause`, h.scope)
}

test('one-click video waiting also survives the old two hour limit', async () => {
  const h = setup({ completeAt: 145 * minute })
  let previews = 0
  const result = pipelinePoll(h)('video', () => { previews++ }, videoMeta)
  await h.advanceTo(145 * minute)
  assert.equal((await result).status, 'completed')
  assert.equal(previews, 1)
})

test('one-click pause and abort still interrupt long video waiting', async () => {
  const h = setup()
  const poll = pipelinePoll(h)
  const paused = poll('video', null, videoMeta)
  await h.advanceTo(16 * minute)
  h.scope.pipelinePaused.value = true
  await h.advanceTo(16 * minute + 10_000)
  assert.equal((await paused).paused, true)
  const requests = h.requests()
  await h.advanceTo(17 * minute)
  assert.equal(h.requests(), requests)

  h.scope.pipelinePaused.value = false
  const aborted = assert.rejects(poll('video', null, videoMeta), { message: '全流程已取消' })
  h.scope.pipelineAbortRequested.value = true
  await h.advanceTo(17 * minute + 2000)
  await aborted
  assert.equal(h.requests(), requests)
})

test('canvas video generation uses the shared long task poll with episode metadata', async () => {
  const h = setup()
  const runner = readFileSync(new URL('../src/composables/useCanvasWorkflowRunner.js', import.meta.url), 'utf8')
  const videoSource = runner.slice(runner.indexOf('export async function runVideoStep('), runner.indexOf('\nexport async function runAudioStep(')).replace('export ', '')
  Object.assign(h.scope, {
    useGenerationTaskStore: () => h.store,
    GEN_RESOURCE: h.store.GEN_RESOURCE,
    dramaUsesFirstLastFrame: () => false,
    sbVideoFirstLastUrls: () => ({ first: '/static/reference.png' }),
    toAbsoluteMediaUrl: (url) => url,
    videosAPI: { async create() { return { task_id: 'video' } } },
    findStoryboardInDrama: () => ({ episode: { id: 7 } }),
  })
  const run = vm.runInNewContext(`${videoSource}\nrunVideoStep`, { ...h.scope })
  const result = run({ id: 6 }, { id: 130 }, {})
  await h.advanceTo(16 * minute)
  assert.equal(h.store.isRunning(videoMeta), true, JSON.stringify([...h.store.tasks.value.values()]))
  await h.advanceTo(22 * minute)
  await result
  assert.equal(h.requests(), 156)
})
