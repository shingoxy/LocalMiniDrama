<template>
  <div class="hybrid-toolbar">
    <div class="toolbar-row">
      <el-tag>Hybrid Local + Cloud</el-tag>
      <el-button size="small" :disabled="busy" @click="assignEpisode('local:minimax-h3')">全部使用 MiniMax H3</el-button>
      <el-select :model-value="null" placeholder="全部使用云端模型" style="width:260px" size="small" :disabled="busy" @change="assignEpisode">
        <el-option v-for="m in cloudModels" :key="m.key" :label="m.label" :value="m.key" />
      </el-select>
      <el-button size="small" :disabled="busy" @click="assignEpisode('auto')">恢复默认</el-button>
      <el-button size="small" @click="settingsOpen=true">ComfyUI / Cost Settings</el-button>
      <el-button size="small" :loading="checking" @click="connection">Test Connection</el-button>
      <el-tag v-if="connectionText" :type="connectionText==='ComfyUI Offline' ? 'danger' : 'info'">{{ connectionText }}</el-tag>
    </div>
    <div class="toolbar-row">
      <span>Project Default Video Model</span>
      <el-select v-model="projectDefault" style="width:260px" size="small" :disabled="busy" @change="assignProject">
        <el-option label="Auto / AI 配置默认" value="auto" />
        <el-option v-for="m in models" :key="m.key" :label="m.label" :value="m.key" />
      </el-select>
      <span>本集：{{ episodeLabel }}</span>
    </div>
    <div class="toolbar-row">
      <el-checkbox :model-value="selected.length===shots.length && shots.length>0" @change="toggleAll">全选</el-checkbox>
      <el-select :model-value="null" placeholder="将选中 Shot 设置为" style="width:260px" size="small" :disabled="!selected.length || busy" @change="assignSelected">
        <el-option label="Auto / Default" value="auto" />
        <el-option v-for="m in models" :key="m.key" :label="m.label" :value="m.key" />
      </el-select>
      <el-button size="small" :disabled="!selected.length || busy" @click="$emit('generate',{ids:selected})">Generate Selected</el-button>
      <el-button size="small" :disabled="!selected.length || busy" @click="$emit('generate',{ids:selected,local_draft:true})">Local Draft / 本地预演</el-button>
      <el-button size="small" :disabled="busy" @click="$emit('generate',{ids:shots.map(s=>s.id)})">Generate All（按 Shot 路由）</el-button>
      <el-button size="small" @click="showForecast">单集 / 整季成本</el-button>
      <el-button size="small" @click="showHistory">Generation History</el-button>
    </div>
    <el-checkbox-group v-model="selected" class="shot-checks">
      <el-checkbox v-for="(s,i) in shots" :key="s.id" :value="s.id">Shot {{ String(i+1).padStart(2,'0') }}</el-checkbox>
    </el-checkbox-group>
    <details v-if="report">
      <summary>当前 Episode 成本预测：{{ budgetText }}{{ report.incomplete ? '（部分费用未知）' : '' }}</summary>
      <pre class="forecast-text">{{ costReportText(report) }}</pre>
    </details>
    <el-dialog v-model="settingsOpen" title="ComfyUI / Cost Engine" width="min(1100px,95vw)" append-to-body>
      <el-form label-width="230px" size="small">
        <el-form-item label="ComfyUI URL"><el-input v-model="settings.comfy_url" /></el-form-item>
        <el-form-item label="Local Timeout (min)"><el-input-number v-model="settings.local_timeout_minutes" :min="1" :max="1440" /></el-form-item>
        <el-form-item label="Retry Budget Multiplier"><el-select v-model="settings.retry_multiplier"><el-option v-for="n in [1,1.2,1.5,2]" :key="n" :value="n" :label="n+'x'" /></el-select><span class="hint">只调整预算，不自动重试</span></el-form-item>
        <el-form-item label="Expected Episodes Per Month"><el-input-number v-model="settings.expected_episodes_per_month" :min="1" /></el-form-item>
        <el-form-item label="Enable Electricity Estimate"><el-switch v-model="settings.electricity.enabled" /></el-form-item>
        <el-form-item v-if="settings.electricity.enabled" label="Average System Power W"><el-input-number v-model="settings.electricity.power_w" :min="0" /></el-form-item>
        <el-form-item v-if="settings.electricity.enabled" label="Electricity Price CNY/kWh"><el-input-number v-model="settings.electricity.price_per_kwh" :min="0" :precision="3" /></el-form-item>
      </el-form>
      <p>模型价格：请按实际账户填写；空价格表示未知。币种分别汇总，API 费用与月费分摊分别显示。</p>
      <el-table :data="prices" size="small" max-height="320">
        <el-table-column label="Provider / Model" min-width="240"><template #default="{row}"><el-select :model-value="priceModelKey(row)" size="small" @change="key=>setPriceModel(row,key)"><el-option v-for="m in models" :key="m.key" :label="m.label" :value="m.key" /></el-select><br>{{ row.provider }}</template></el-table-column>
        <el-table-column label="Billing Type" width="170"><template #default="{row}"><el-select v-model="row.billing_type" size="small"><el-option v-for="t in billingTypes" :key="t" :label="t" :value="t" /></el-select></template></el-table-column>
        <el-table-column label="Price" width="135"><template #default="{row}"><el-input-number v-model="row.price" :min="0" :precision="4" :controls="false" style="width:110px" size="small" /></template></el-table-column>
        <el-table-column label="Currency" width="85"><template #default="{row}"><el-input v-model="row.currency" size="small" /></template></el-table-column>
        <el-table-column label="Resolution" width="100"><template #default="{row}"><el-input v-model="row.resolution" size="small" /></template></el-table-column>
        <el-table-column label="Effective Date" width="145"><template #default="{row}"><el-input v-model="row.effective_date" type="date" size="small" /></template></el-table-column>
        <el-table-column label="" width="65"><template #default="{row,$index}"><el-button link @click="prices.splice($index,1)">移除</el-button></template></el-table-column>
      </el-table>
      <el-button size="small" @click="addPrice">新增价格 / 分辨率档</el-button>
      <p>Subscription Plan：¥500/月、每月 20 集 = ¥25 fixed allocation/episode。额度未知时留空，不代表无限。</p>
      <div v-for="(plan,i) in settings.subscriptions" :key="i" class="plan-row">
        <el-switch v-model="plan.enabled" />
        <el-input v-model="plan.name" placeholder="Name" style="width:130px" size="small" />
        <el-input-number v-model="plan.monthly_fee" :min="0" :precision="2" style="width:140px" size="small" /><span>/month</span>
        <el-input v-model="plan.currency" style="width:75px" size="small" />
        <el-input v-model="plan.provider" placeholder="Provider（空=全部订阅模型）" style="width:190px" size="small" />
        <el-input-number v-model="plan.included_quota" :min="0" :controls="false" placeholder="Included Quota（未知留空）" style="width:150px" size="small" />
        <el-select v-model="plan.quota_unit" style="width:100px" size="small"><el-option v-for="u in ['requests','seconds','images']" :key="u" :label="u" :value="u" /></el-select>
        <el-input-number v-model="plan.overage_price" :min="0" :precision="4" :controls="false" placeholder="Overage Price" style="width:125px" size="small" />
        <el-button link @click="settings.subscriptions.splice(i,1)">移除</el-button>
      </div>
      <el-button size="small" @click="addPlan">添加 Subscription Plan</el-button>
      <p class="hint">当前 H3 Mode: {{ mapping?.mode }} · {{ mapping?.native_fps }} FPS · 外部音频/尾帧以 Mapping 为准。</p>
      <template #footer><el-button @click="settingsOpen=false">关闭</el-button><el-button type="primary" @click="saveSettings">保存设置和价格</el-button></template>
    </el-dialog>
    <el-dialog v-model="forecastOpen" title="单集 / 整季成本预测" width="min(950px,95vw)" append-to-body>
      <el-select v-model="seasonEpisodes" size="small" @change="updateSeason"><el-option v-for="n in [1,10,30,100]" :key="n" :label="n+' Episodes'" :value="n" /></el-select>
      <p>以当前 Episode 的 Provider 分配与时长按比例推算。</p>
      <pre class="forecast-text">{{ seasonReport ? costReportText(seasonReport) : '加载中…' }}</pre>
    </el-dialog>
    <el-dialog v-model="historyOpen" title="Generation History · Actual 未返回时为未知" width="min(1150px,95vw)" append-to-body>
      <el-button size="small" @click="showHistory">刷新 / Queue / Progress</el-button>
      <el-table :data="history" size="small" max-height="500">
        <el-table-column prop="storyboard_id" label="Shot" width="65" />
        <el-table-column prop="provider" label="Provider" width="120" />
        <el-table-column prop="model" label="Model" min-width="170" />
        <el-table-column prop="duration" label="Sec" width="60" />
        <el-table-column prop="resolution" label="Resolution" width="100" />
        <el-table-column prop="status" label="Status" width="95" />
        <el-table-column prop="error_msg" label="Error" min-width="160" show-overflow-tooltip />
        <el-table-column prop="elapsed_seconds" label="Elapsed sec" width="100" />
        <el-table-column label="Estimated / Calculated / Actual" width="210"><template #default="{row}">{{ recordMoney(row,'estimated_cost') }} / {{ recordMoney(row,'calculated_cost') }} / {{ recordMoney(row,'actual_cost') }}</template></el-table-column>
        <el-table-column prop="retry_count" label="Retry" width="65" />
        <el-table-column label="Action" width="105"><template #default="{row}"><el-button v-if="row.provider==='local_comfyui' && row.status==='processing'" size="small" @click="cancel(row)">Cancel</el-button></template></el-table-column>
      </el-table>
      <p v-if="queueText">{{ queueText }}</p>
    </el-dialog>
  </div>
</template>
<script setup>
import { ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { hybridVideoAPI } from '@/api/hybridVideo'
import { money, costReportText } from '@/utils/videoCostReport'
const props=defineProps({dramaId:Number,episodeId:Number,shots:{type:Array,default:()=>[]},resolution:String,busy:Boolean})
const emit=defineEmits(['state','generate','changed'])
const models=ref([]),selected=ref([]),report=ref(null),settingsOpen=ref(false),settings=ref({electricity:{},subscriptions:[]}),prices=ref([]),mapping=ref(null)
const projectDefault=ref('auto'),episodeSelection=ref('auto'),connectionText=ref(''),checking=ref(false)
const forecastOpen=ref(false),seasonEpisodes=ref(1),seasonReport=ref(null),historyOpen=ref(false),history=ref([]),queueText=ref('')
const cloudModels=computed(()=>models.value.filter(m=>!m.local))
const budgetText=computed(()=>Object.entries(report.value?.totals || {}).map(([currency,total])=>money(total.base_total,currency)).join(' + '))
const episodeLabel=computed(()=>models.value.find(m=>m.key===episodeSelection.value)?.label || 'Auto / Project Default')
const billingTypes=['per_second','per_request','per_image','monthly_subscription','local_compute']
const today=()=>new Date().toISOString().slice(0,10)
let refreshVersion=0
async function refresh() {
  if (!props.episodeId) return
  const version=++refreshVersion,episodeId=props.episodeId
  const [ms,config,state]=await Promise.all([hybridVideoAPI.models(),hybridVideoAPI.settings(),hybridVideoAPI.state(episodeId)])
  if (version!==refreshVersion || episodeId!==props.episodeId) return
  models.value=ms;mapping.value=config.mapping;projectDefault.value=state.project_default || 'auto';episodeSelection.value=state.episode_selection || 'auto'
  if (!settingsOpen.value) {
    settings.value=config.settings;prices.value=[...config.prices]
    for (const m of ms) if (!prices.value.some(p=>p.provider===m.provider && p.model===m.model)) prices.value.push({provider:m.provider,model:m.model,billing_type:m.local ? 'local_compute' : 'per_second',price:m.local ? 0 : null,currency:'CNY',resolution:'*',effective_date:today()})
  }
  selected.value=selected.value.filter(id=>props.shots.some(s=>s.id===id))
  const forecast=props.shots.length ? await hybridVideoAPI.forecast({episode_id:episodeId,resolution:props.resolution}) : null
  if (version!==refreshVersion || episodeId!==props.episodeId) return
  report.value=forecast
  emit('state',{models:ms,report:report.value})
}
watch(()=>[props.episodeId,props.shots.map(s=>`${s.id}:${s.duration}:${s.video_prompt}:${s.image_url}`).join('|'),props.resolution],()=>refresh().catch(()=>{report.value=null;emit('state',{models:models.value,report:null})}),{immediate:true})
async function assignEpisode(key) { await hybridVideoAPI.selection({scope:'episode',episode_id:props.episodeId,key});emit('changed');await refresh() }
async function assignProject(key) { await hybridVideoAPI.selection({scope:'project',drama_id:props.dramaId,key});await refresh() }
async function assignSelected(key) { await hybridVideoAPI.selection({scope:'shots',shot_ids:selected.value,key});emit('changed');await refresh() }
function toggleAll(value) { selected.value=value ? props.shots.map(s=>s.id) : [] }
async function connection() {
  checking.value=true
  try { const r=await hybridVideoAPI.connection();connectionText.value=`ComfyUI Online · ${r.address} · ${r.mapping.mode}` }
  catch(e) { connectionText.value=e.message==='ComfyUI Offline' ? 'ComfyUI Offline' : e.message }
  finally { checking.value=false }
}
function addPlan() { settings.value.subscriptions.push({name:'Agent Plan',monthly_fee:500,included_quota:null,quota_unit:'requests',overage_price:null,enabled:false,currency:'CNY',provider:''}) }
function addPrice() { const m=models.value[0];if(m) prices.value.push({provider:m.provider,model:m.model,billing_type:'per_second',price:null,currency:'CNY',resolution:'720p',effective_date:today()}) }
function priceModelKey(row) { return models.value.find(m=>m.provider===row.provider && m.model===row.model)?.key }
function setPriceModel(row,key) { const m=models.value.find(m=>m.key===key);if(m) {row.provider=m.provider;row.model=m.model} }
async function saveSettings() { await hybridVideoAPI.saveSettings({settings:settings.value,prices:prices.value});settingsOpen.value=false;await refresh();ElMessage.success('ComfyUI / Cost 设置已保存') }
async function updateSeason() { seasonReport.value=await hybridVideoAPI.forecast({episode_id:props.episodeId,resolution:props.resolution,episodes:seasonEpisodes.value}) }
async function showForecast() { forecastOpen.value=true;await updateSeason() }
function recordMoney(row,field) { let currency='CNY';try {currency=JSON.parse(row.cost_metadata || '{}').currency || currency}catch{}return money(row[field],currency) }
async function showHistory() { history.value=await hybridVideoAPI.history(props.episodeId);historyOpen.value=true;try {const q=await fetch('/api/v1/hybrid-video/queue').then(r=>r.json());queueText.value=q.data ? `ComfyUI: Running ${q.data.queue_running.length} / Pending ${q.data.queue_pending.length}` : q.error?.message}catch{queueText.value='ComfyUI Offline'} }
async function cancel(row) { await hybridVideoAPI.cancel(row.id);await showHistory();ElMessage.success('本地任务已取消') }
defineExpose({refresh})
</script>
<style scoped>
.hybrid-toolbar{padding:12px;margin:12px 0;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-bg-color)}
.toolbar-row,.plan-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0}.shot-checks{max-height:100px;overflow:auto}.hint{color:var(--el-text-color-secondary);font-size:12px;margin-left:8px}.forecast-text{white-space:pre-wrap;font:inherit;line-height:1.7}
</style>
