<template>
  <div class="hybrid-shot-video">
    <div class="model-row">
      <span>Video Model</span>
      <el-select v-model="selection" size="small" style="width:260px" @change="saveSelection">
        <el-option label="Auto / Default" value="auto" />
        <el-option v-for="m in models" :key="m.key" :label="m.label" :value="m.key" />
      </el-select>
      <span class="estimate">{{ estimate?.selection.label }} · {{ estimate?.duration }} sec · API {{ money(estimate?.api_cost,estimate?.currency) }}</span>
      <span v-if="estimate?.selection.local" class="estimate">Estimated Local Time: {{ estimate.estimated_compute_seconds == null ? '待本机实测' : (estimate.estimated_compute_seconds/60).toFixed(1)+' min' }}</span>
      <el-button size="small" @click="openPrompt">Original / Shot Intent · H3 Prompt</el-button>
      <el-button size="small" :disabled="busy" @click="$emit('draft',shot)">Local Draft / 本地预演</el-button>
    </div>
    <div class="model-row">
      <el-button size="small" :disabled="busy" @click="$emit('draft',shot)">Retry Local / Local Regenerate</el-button>
      <el-button size="small" @click="keepLocal">Keep Local</el-button>
      <el-select placeholder="Upgrade to Cloud Model" size="small" style="width:260px" :model-value="null" @change="upgrade">
        <el-option v-for="m in models.filter(m=>!m.local)" :key="m.key" :label="m.label" :value="m.key" />
      </el-select>
      <el-button size="small" @click="keepStatic">Keep Static</el-button>
      <span class="estimate">H3 视频可以直接作为最终镜头</span>
    </div>
    <el-dialog v-model="promptOpen" title="MiniMax H3 Prompt" width="min(900px,95vw)" append-to-body>
      <p>Mode: {{ promptState.mode }} · {{ promptState.user_edited ? '手工编辑（自动生成不会覆盖）' : '自动优化' }} · {{ promptState.stale ? 'Storyboard 已变化 / 尚未优化' : '缓存有效' }}</p>
      <p>Original / Universal Shot Intent</p>
      <el-input v-model="intentText" type="textarea" :rows="8" />
      <el-button size="small" @click="saveIntent">保存 Shot Intent</el-button>
      <p>H3 Optimized Prompt</p>
      <el-input v-model="promptText" type="textarea" :rows="10" @input="promptDirty=true" />
      <p v-if="promptState.generated_by_model">{{ promptState.generated_by_model }} · {{ promptState.generated_at }}</p>
      <template #footer>
        <el-button :loading="optimizing" @click="optimize">Optimize for MiniMax H3 / 重新优化</el-button>
        <el-button type="primary" @click="savePrompt">保存手工 Prompt</el-button>
      </template>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { hybridVideoAPI } from '@/api/hybridVideo'
import { storyboardsAPI } from '@/api/storyboards'
import { money } from '@/utils/videoCostReport'
const props = defineProps({ shot:Object, models:{type:Array,default:()=>[]}, estimate:Object, busy:Boolean })
const emit = defineEmits(['changed','draft'])
const selection=ref('auto'), promptOpen=ref(false), promptState=ref({}), intentText=ref(''),promptText=ref(''),promptDirty=ref(false),optimizing=ref(false)
watch(()=>[props.shot.video_model,props.shot.video_config_id,props.shot.video_provider],()=>{
  selection.value=props.shot.video_model ? props.shot.video_provider==='local_comfyui' ? 'local:minimax-h3' : `cloud:${props.shot.video_config_id}:${encodeURIComponent(props.shot.video_model)}` : 'auto'
},{immediate:true})
async function saveSelection(key) {
  try { await hybridVideoAPI.selection({scope:'shots',shot_ids:[props.shot.id],key});emit('changed');return true }
  catch(e) {
    selection.value=props.shot.video_model ? props.shot.video_provider==='local_comfyui' ? 'local:minimax-h3' : `cloud:${props.shot.video_config_id}:${encodeURIComponent(props.shot.video_model)}` : 'auto'
    ElMessage.error(e.message);return false
  }
}
async function upgrade(key) { selection.value=key;if(await saveSelection(key)) ElMessage.success('已选择云模型，点击生成时仍需确认费用') }
async function keepLocal() {
  const records=await hybridVideoAPI.history(props.shot.episode_id)
  const local=records.find(r=>r.storyboard_id===props.shot.id && r.provider==='local_comfyui' && r.status==='completed')
  if (!local) return ElMessage.info('请先完成本地视频生成')
  await storyboardsAPI.update(props.shot.id,{video_url:local.video_url})
  emit('changed'); ElMessage.success('已将本地视频用于最终合成')
}
async function keepStatic() {
  await hybridVideoAPI.keepStatic(props.shot.id)
  emit('changed'); ElMessage.success('已保留静态分镜用于合成')
}
function displayPrompt(state) {
  promptState.value=state; intentText.value=JSON.stringify(state.intent,null,2);promptText.value=state.prompt || '';promptDirty.value=false
}
async function openPrompt() { displayPrompt(await hybridVideoAPI.prompt(props.shot.id));promptOpen.value=true }
async function saveIntent() {
  try { const shot_intent=JSON.parse(intentText.value);const result=await hybridVideoAPI.savePrompt(props.shot.id,{shot_intent});promptState.value={...promptState.value,...result};ElMessage.success('Shot Intent 已保存');emit('changed') }
  catch(e) { ElMessage.error(e.message) }
}
async function optimize() {
  if (promptDirty.value || promptState.value.user_edited) {
    try { await ElMessageBox.confirm('重新优化会替换当前手工提示词。','重新优化',{type:'warning'}) } catch { return }
  }
  optimizing.value=true
  try { displayPrompt(await hybridVideoAPI.optimize(props.shot.id,true));emit('changed') }
  finally { optimizing.value=false }
}
async function savePrompt() {
  const result=await hybridVideoAPI.savePrompt(props.shot.id,{optimized_prompt:promptText.value})
  promptState.value={...promptState.value,...result};promptDirty.value=false;ElMessage.success('手工 Prompt 已保存');emit('changed')
}
</script>
<style scoped>
.hybrid-shot-video{padding:8px 12px;margin:4px 0 10px;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-fill-color-light)}
.model-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0}.estimate{font-size:12px;color:var(--el-text-color-secondary)}
</style>
