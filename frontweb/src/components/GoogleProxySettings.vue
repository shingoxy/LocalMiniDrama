<template>
  <div v-loading="loading" class="google-proxy-settings">
    <div class="gp-header">
      <div class="gp-title">🌐 Google API 代理设置</div>
      <el-tag v-if="form.enabled && form.host && form.port" type="success" size="small">
        已启用专用代理
      </el-tag>
      <el-tag v-else-if="form.enabled && statusMeta.has_env_fallback" type="warning" size="small">
        已约束 · 当前回退环境变量代理
      </el-tag>
      <el-tag v-else-if="form.enabled" type="danger" size="small">
        已约束 · 待填写代理地址
      </el-tag>
      <el-tag v-else type="info" size="small">
        已关闭代理约束（直连）
      </el-tag>
    </div>

    <p class="gp-desc">
      默认约束所有 Google API（Gemini 文本 / 视觉 / 图片 / Omni Flash 视频及视频下载）必须通过代理访问，不影响 DeepSeek、火山引擎、通义、本地 ComfyUI 等其他服务。
    </p>

    <el-alert
      v-if="form.enabled && !form.host && statusMeta.has_env_fallback"
      type="info"
      :closable="false"
      show-icon
      style="margin-bottom: 16px"
      :title="`当前未填写专用代理，Google 请求将回退使用系统环境代理：${statusMeta.env_proxy_preview}。填写下方地址保存后将优先使用此处配置。`"
    />

    <el-form :model="form" label-width="136px" class="gp-form">
      <el-form-item label="Google 默认走代理">
        <el-switch v-model="form.enabled" />
        <span class="gp-inline-tip">
          开启后，未配置代理地址时将阻止直连 Google 并提示先配置代理
        </span>
      </el-form-item>

      <el-form-item label="代理协议">
        <el-select v-model="form.protocol" style="width: 240px">
          <el-option label="HTTPS 代理 (https://)" value="https" />
          <el-option label="HTTP 代理 (http://)" value="http" />
        </el-select>
        <p class="gp-field-tip">
          默认使用 HTTPS 代理；若本机代理端口未开启 TLS（如常见本地明文 HTTP 代理端口，通过 CONNECT 隧道转发 HTTPS 流量），请切换为 HTTP 代理。
        </p>
      </el-form-item>

      <el-form-item label="代理地址">
        <div class="gp-host-port">
          <el-input
            v-model="form.host"
            placeholder="例如 127.0.0.1 或 proxy.example.com（可粘贴完整 URL）"
            clearable
            style="flex: 1"
            @blur="onHostBlur"
          />
          <span class="gp-colon">:</span>
          <el-input
            v-model="form.port"
            placeholder="端口，如 443 / 7890"
            clearable
            style="width: 150px"
          />
        </div>
      </el-form-item>

      <el-form-item label="用户名（可选）">
        <el-input
          v-model="form.username"
          placeholder="代理需要鉴权时填写，否则留空"
          autocomplete="off"
          clearable
        />
      </el-form-item>

      <el-form-item label="密码（可选）">
        <div class="gp-password-row">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            autocomplete="new-password"
            :placeholder="statusMeta.has_password && !clearPassword ? '已保存密码（留空则保持不变）' : '代理需要鉴权时填写，否则留空'"
            style="flex: 1"
            @input="onPasswordInput"
          />
          <el-button
            v-if="statusMeta.has_password && !clearPassword"
            link
            type="danger"
            @click="markClearPassword"
          >
            清除已保存密码
          </el-button>
          <el-tag v-else-if="clearPassword" type="warning" size="small">保存后将清除原密码</el-tag>
        </div>
      </el-form-item>

      <el-form-item>
        <div class="gp-actions">
          <el-button type="primary" :loading="saving" @click="onSave">
            保存代理配置
          </el-button>
          <el-button plain :loading="testing" @click="onTest">
            测试代理连通性
          </el-button>
        </div>
      </el-form-item>
    </el-form>

    <el-alert
      v-if="testState.message"
      :type="testState.ok ? 'success' : 'error'"
      :title="testState.message"
      show-icon
      closable
      style="margin-top: 8px; margin-bottom: 14px"
      @close="testState = { ok: false, message: '' }"
    />

    <div class="gp-tip-box">
      <div class="gp-tip-title">📌 约束与安全说明</div>
      <ul class="gp-tip-list">
        <li><b>生效域名：</b><code>generativelanguage.googleapis.com</code>、<code>*.googleapis.com</code>、<code>*.googleusercontent.com</code>、<code>ai.google.dev</code>。</li>
        <li><b>实时生效：</b>保存后立即作用于文本、视觉识图、原生生图、Omni Flash 视频及视频下载，无需重启服务。</li>
        <li><b>连通性测试：</b>仅向 Google API 元数据地址发起无 Key 探测，不消耗任何模型额度；若返回 407 说明代理用户名/密码错误。</li>
        <li><b>密码安全：</b>密码仅保存在本机 SQLite 数据库中，接口不回传明文，后端日志自动脱敏。</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { googleProxyAPI } from '@/api/prompts'

const emit = defineEmits(['updated'])

const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const clearPassword = ref(false)

const form = ref({
  enabled: true,
  protocol: 'https',
  host: '',
  port: '',
  username: '',
  password: '',
})

const statusMeta = ref({
  has_password: false,
  is_configured: false,
  has_env_fallback: false,
  env_proxy_preview: '',
})

const testState = ref({ ok: false, message: '' })

function applyServerData(data) {
  if (!data) return
  form.value = {
    enabled: data.enabled !== false,
    protocol: data.protocol === 'http' ? 'http' : 'https',
    host: data.host || '',
    port: data.port ? String(data.port) : '',
    username: data.username || '',
    password: '',
  }
  statusMeta.value = {
    has_password: Boolean(data.has_password),
    is_configured: Boolean(data.is_configured),
    has_env_fallback: Boolean(data.has_env_fallback),
    env_proxy_preview: data.env_proxy_preview || '',
  }
  clearPassword.value = false
  emit('updated', data)
}

async function load() {
  loading.value = true
  try {
    const data = await googleProxyAPI.get()
    applyServerData(data)
  } catch (e) {
    ElMessage.error('加载 Google 代理配置失败：' + (e?.message || ''))
  } finally {
    loading.value = false
  }
}

/** 粘贴完整代理 URL 时自动拆解协议、主机、端口和用户名/密码 */
function onHostBlur() {
  const raw = (form.value.host || '').trim()
  if (!raw || !raw.includes('://')) return
  try {
    const parsed = new URL(raw)
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
    if (scheme === 'https' || scheme === 'http') {
      form.value.protocol = scheme
    }
    if (parsed.hostname) form.value.host = parsed.hostname
    if (parsed.port) form.value.port = parsed.port
    if (parsed.username && !form.value.username) {
      form.value.username = decodeURIComponent(parsed.username)
    }
    if (parsed.password && !form.value.password) {
      form.value.password = decodeURIComponent(parsed.password)
      clearPassword.value = false
    }
  } catch (_) {}
}

function onPasswordInput() {
  if (form.value.password) clearPassword.value = false
}

function markClearPassword() {
  form.value.password = ''
  clearPassword.value = true
}

function buildPayload() {
  return {
    enabled: form.value.enabled,
    protocol: form.value.protocol,
    host: (form.value.host || '').trim(),
    port: String(form.value.port || '').trim(),
    username: (form.value.username || '').trim(),
    ...(form.value.password ? { password: form.value.password } : {}),
    ...(clearPassword.value ? { clear_password: true } : {}),
  }
}

async function onSave() {
  onHostBlur()
  const payload = buildPayload()
  if (payload.host && !payload.port) {
    ElMessage.warning('请填写代理端口（1-65535）')
    return
  }
  saving.value = true
  try {
    const saved = await googleProxyAPI.update(payload)
    applyServerData(saved)
    ElMessage.success('Google 代理配置已保存')
  } catch (e) {
    ElMessage.error('保存失败：' + (e?.message || ''))
  } finally {
    saving.value = false
  }
}

async function onTest() {
  onHostBlur()
  const payload = buildPayload()
  if (!payload.host || !payload.port) {
    ElMessage.warning('请先填写代理地址和端口后再测试')
    return
  }
  testing.value = true
  testState.value = { ok: false, message: '' }
  try {
    const res = await googleProxyAPI.test(payload)
    testState.value = {
      ok: true,
      message: res?.message || '代理连通性测试通过',
    }
  } catch (e) {
    testState.value = {
      ok: false,
      message: e?.message || '代理连通性测试失败',
    }
  } finally {
    testing.value = false
  }
}

onMounted(load)

defineExpose({ load })
</script>

<style scoped>
.google-proxy-settings {
  max-width: 680px;
}
.gp-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.gp-title {
  font-size: 15px;
  font-weight: 600;
}
.gp-desc {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.gp-form {
  max-width: 640px;
}
.gp-inline-tip {
  margin-left: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.gp-field-tip {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.gp-host-port {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.gp-colon {
  color: var(--el-text-color-secondary);
  font-weight: 600;
}
.gp-password-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}
.gp-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.gp-tip-box {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
}
.gp-tip-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
}
.gp-tip-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--el-text-color-secondary);
}
.gp-tip-list code {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--el-fill-color);
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 11.5px;
}
</style>
