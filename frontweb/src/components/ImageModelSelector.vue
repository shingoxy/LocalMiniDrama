<template>
  <el-popover placement="bottom-end" :width="760" :popper-style="{ maxWidth: 'calc(100vw - 32px)' }" trigger="click" @show="openPanel" @hide="stopPolling">
    <template #reference><el-button size="small">图片模型与本地素材</el-button></template>
    <div class="image-settings">
      <strong>图片模型</strong>
      <p>本次选择覆盖项目默认。本地 Qwen 支持文生图与参考图编辑。提示词优化可能仍使用云端文本服务。</p>
      <div v-for="use in purposes" :key="use.key" class="selection-row">
        <span>{{ use.label }}</span>
        <el-select v-model="choices[use.key]" size="small" @change="syncOptions">
          <el-option label="跟随项目 / 本地 Qwen 默认" value="auto" />
          <el-option v-for="model in catalogs[use.key] || []" :key="model.key" :label="model.label" :value="model.key" />
        </el-select>
        <el-button v-if="dramaId" size="small" @click="saveDefault(use.key)">保存项目默认</el-button>
        <span class="default-note">默认：{{ modelLabel(defaults[use.key] || (use.key === 'prop' ? defaults.image : null), use.key) }}</span>
      </div>
      <div class="settings-row">
        <el-input v-model="localSize" size="small" placeholder="本次本地尺寸，如 1024x1024" @change="syncOptions" />
        <el-input v-model="seed" size="small" placeholder="Seed 留空随机" @change="syncOptions" />
        <el-select v-model="generationMode" size="small" @change="syncOptions">
          <el-option label="自动匹配模式" value="auto" />
          <el-option label="文生图" value="t2i" />
          <el-option label="参考图编辑（Qwen）" value="edit" />
        </el-select>
      </div>
      <div class="settings-row">
        <el-input v-model="referenceText" type="textarea" :rows="2" placeholder="可选参考图片：每行一个素材路径或图片历史编号，最多 6 张。" @change="syncOptions" />
      </div>
      <div class="settings-row">
        <el-input v-model="loraName" size="small" placeholder="可选人物 LoRA 文件名，默认关闭" @change="syncOptions" />
        <el-select v-model="loraCharacterId" size="small" clearable placeholder="LoRA 对应人物" @change="syncOptions">
          <el-option v-for="character in characters" :key="character.id" :label="character.name" :value="character.id" />
        </el-select>
        <el-input-number v-model="loraStrength" size="small" :min="-2" :max="2" :step="0.1" @change="syncOptions" />
      </div>
      <el-divider />
      <strong>ComfyUI（与 H3 共用地址）</strong>
      <div class="settings-row">
        <el-input v-model="settings.comfy_url" size="small" placeholder="http://127.0.0.1:8000" />
        <el-input v-model="settings.default_size" size="small" placeholder="默认尺寸" />
        <el-button size="small" @click="saveSettings">保存设置</el-button>
        <el-button size="small" :loading="checking" @click="checkConnection">检查连接与工作流</el-button>
      </div>
      <p v-if="connectionText">{{ connectionText }}</p>
      <el-divider />
      <div class="settings-row"><strong>本地图片候选</strong><el-button size="small" @click="loadHistory">刷新历史与队列</el-button><span>{{ queueText }}</span></div>
      <p>候选自动刷新，保留原人物、场景、道具和首尾帧；预览后点击“选用”切换。</p>
      <div class="candidate-list">
        <div v-for="item in history" :key="item.id" class="candidate">
          <el-image v-if="item.image_url" :src="item.image_url" :preview-src-list="[item.image_url]" preview-teleported fit="contain" />
          <div>
            <div>#{{ item.id }} · {{ item.model }} · {{ item.status }} · {{ targetLabel(item) }}</div>
            <div v-if="item.width">{{ item.width }}×{{ item.height }} · Seed {{ item.seed }} · {{ item.generation_elapsed_seconds == null ? '耗时未确认' : item.generation_elapsed_seconds + ' 秒' }}</div>
            <div>{{ item.generation_metadata?.progress?.status === 'queued' ? '排队：第 ' + item.generation_metadata.progress.queue_position + ' 项' : '' }}</div>
            <div v-if="item.error_msg">{{ item.error_msg }}</div>
            <el-button v-if="item.status === 'completed' && (item.character_id || item.scene_id || item.prop_id || item.storyboard_id) && !['quad_grid','nine_grid'].includes(item.frame_type)" size="small" @click="selectCandidate(item, item.generation_mode === 'crop' ? 'first' : undefined)">{{ item.generation_mode === 'crop' ? '设为首帧' : '选用' }}</el-button>
            <el-button v-if="item.status === 'completed' && item.storyboard_id && item.generation_mode === 'crop'" size="small" @click="selectCandidate(item, 'last')">设为尾帧</el-button>
            <el-button v-if="['pending', 'processing'].includes(item.status)" size="small" @click="cancelCandidate(item)">取消</el-button>
            <el-button v-if="item.generation_metadata?.resumable" size="small" @click="resumeCandidate(item)">继续查询</el-button>
            <el-button v-if="['failed', 'cancelled', 'completed'].includes(item.status) && item.generation_mode !== 'crop'" size="small" @click="retryCandidate(item)">再生成候选</el-button>
          </div>
        </div>
      </div>
    </div>
  </el-popover>
</template>

<script setup>
import { reactive, ref, watch, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { imagesAPI } from '@/api/images'
import { dramaAPI } from '@/api/drama'
import { setImageRequestOptions, clearImageRequestOptions } from '@/utils/imageRequestOptions'
const props = defineProps({ dramaId: { type: Number, default: 0 } })
const emit = defineEmits(['selected'])
const purposes = [{ key: 'character', label: '人物' }, { key: 'scene', label: '场景' }, { key: 'prop', label: '道具' }, { key: 'first', label: '首帧' }, { key: 'last', label: '尾帧' }, { key: 'image', label: '通用生图' }]
const choices = reactive(Object.fromEntries(purposes.map(p => [p.key, 'auto'])))
const catalogs = reactive({}), defaults = ref({}), settings = reactive({})
const localSize = ref(''), seed = ref(''), generationMode = ref('auto')
const loraName = ref(''), loraCharacterId = ref(''), loraStrength = ref(1), characters = ref([]), referenceText = ref('')
const checking = ref(false), connectionText = ref(''), queueText = ref(''), history = ref([])
let pollTimer, loadingHistory = false, panelOpen = false
function stopPolling() { panelOpen = false; clearInterval(pollTimer) }
async function openPanel() {
  stopPolling(); panelOpen = true
  await refresh()
  if (panelOpen) pollTimer = setInterval(() => loadHistory(), 3000)
}
function syncOptions() {
  const options = Object.fromEntries(purposes.map(p => [p.key, {
    image_model_key: choices[p.key], generation_mode: generationMode.value,
    ...(localSize.value && { local_size: localSize.value }), ...(seed.value !== '' && { seed: Number(seed.value) }),
    ...(referenceText.value.trim() && { reference_images: referenceText.value.trim().split(/\r?\n/).map(v => /^\d+$/.test(v.trim()) ? Number(v.trim()) : v.trim()).filter(Boolean) }),
    ...(loraName.value && ['character', 'first', 'last'].includes(p.key) && { lora: { name: loraName.value, character_id: Number(loraCharacterId.value), strength: loraStrength.value } })
  }]))
  setImageRequestOptions(props.dramaId, options)
}
watch(() => props.dramaId, (id, old) => {
  clearImageRequestOptions(old); for (const p of purposes) choices[p.key] = 'auto'
  localSize.value = ''; seed.value = ''; generationMode.value = 'auto'; loraName.value = ''; loraCharacterId.value = ''; referenceText.value = ''; characters.value = []
  syncOptions()
}, { immediate: true })
onUnmounted(() => { stopPolling(); clearImageRequestOptions(props.dramaId) })
const modelLabel = (key, use) => !key || key === 'auto' || key === 'local:qwen-image-2.1' ? '本地 Qwen-Image 2.1' : catalogs[use]?.find(m => m.key === key)?.label || '已停用，请重新选择'
const targetLabel = item => item.character_id ? '人物 ' + item.character_id : item.prop_id ? '道具 ' + item.prop_id : item.storyboard_id ? '分镜 ' + item.storyboard_id + ' / ' + (item.frame_type || '首帧') : item.scene_id ? '场景 ' + item.scene_id : '通用图片'
async function refresh() {
  try {
    const results = await Promise.all(purposes.map(p => imagesAPI.models({ purpose: p.key, drama_id: props.dramaId || undefined })))
    results.forEach((r, i) => { catalogs[purposes[i].key] = r.models }); defaults.value = results[0].defaults
    Object.assign(settings, await imagesAPI.localSettings()); await loadHistory(false)
    if (props.dramaId) characters.value = (await dramaAPI.get(props.dramaId)).characters || []
  } catch (e) { ElMessage.error(e.message) }
}
async function saveDefault(purpose) {
  try { defaults.value = await imagesAPI.selection({ drama_id: props.dramaId, purpose, key: choices[purpose] }); ElMessage.success('项目默认已保存') } catch (e) { ElMessage.error(e.message) }
}
async function saveSettings() {
  try { Object.assign(settings, await imagesAPI.saveLocalSettings(settings)); ElMessage.success('本地图片设置已保存') } catch (e) { ElMessage.error(e.message) }
}
async function checkConnection() {
  checking.value = true
  try { const r = await imagesAPI.connection(); connectionText.value = r.workflows.map(w => w.key + '：' + (w.available ? '可用' : w.error)).join('；') } catch (e) { connectionText.value = e.message } finally { checking.value = false }
}
async function loadHistory(checkQueue = true) {
  if (loadingHistory) return
  loadingHistory = true
  try {
    const result = await imagesAPI.list({ drama_id: props.dramaId || 0, engine: 'comfyui', model_key: 'local:qwen-image-2.1', page_size: 30 })
    history.value = result.items || []
    if (checkQueue) { const q = await imagesAPI.queue(); queueText.value = `运行 ${q.queue_running?.length || 0}，排队 ${q.queue_pending?.length || 0}` }
  } catch (e) { queueText.value = e.message } finally { loadingHistory = false }
}
async function selectCandidate(item, frame_type) {
  try { await imagesAPI.select(item.id, frame_type ? { frame_type } : {}); ElMessage.success('已选用，原图保留在历史'); emit('selected', item); await loadHistory(false) } catch (e) { ElMessage.error(e.message) }
}
async function cancelCandidate(item) { try { await imagesAPI.cancel(item.id); await loadHistory(false) } catch (e) { ElMessage.error(e.message) } }
async function resumeCandidate(item) { try { await imagesAPI.resume(item.id); ElMessage.success('正在查询原任务'); await loadHistory(false) } catch (e) { ElMessage.error(e.message) } }
async function retryCandidate(item) {
  try {
    await imagesAPI.create({ ...item.generation_metadata?.input, drama_id: props.dramaId || null, character_id: item.character_id, scene_id: item.scene_id, prop_id: item.prop_id, storyboard_id: item.storyboard_id, frame_type: item.frame_type,
      prompt: item.prompt, negative_prompt: item.negative_prompt, image_model_key: item.model_key, generation_mode: item.generation_mode, local_size: item.generation_metadata?.input?.size })
    ElMessage.success('已提交新候选'); await loadHistory(false)
  } catch (e) { ElMessage.error(e.message) }
}
</script>

<style scoped>
.image-settings { max-height: 75vh; overflow-y: auto; padding-right: 8px; }
.image-settings p, .default-note { font-size: 12px; color: var(--el-text-color-secondary); }
.selection-row { display: grid; grid-template-columns: 72px minmax(180px, 1fr) 96px minmax(160px, 1fr); align-items: center; gap: 10px; margin: 10px 0; }
.selection-row > span:first-child { white-space: nowrap; line-height: 28px; }
.selection-row .el-select { width: 100%; min-width: 0; }
.selection-row .el-button { margin: 0; width: 96px; }
.default-note { line-height: 1.5; overflow-wrap: anywhere; }
.settings-row { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
.settings-row .el-button { margin: 0; }
.settings-row .el-input, .settings-row .el-select { min-width: 0; flex: 1; }
.candidate-list { min-height: 60px; }
.candidate { display: flex; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--el-border-color); font-size: 12px; }
.candidate > div { min-width: 0; overflow-wrap: anywhere; line-height: 1.6; }
.candidate .el-image { width: 100px; height: 100px; flex-shrink: 0; }
@media (max-width: 720px) {
  .selection-row { grid-template-columns: 72px minmax(120px, 1fr) 96px; }
  .default-note { grid-column: 2 / -1; }
  .settings-row { flex-wrap: wrap; }
  .settings-row .el-input, .settings-row .el-select { flex-basis: 140px; }
}
</style>
