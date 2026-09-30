# ComfyUI + MiniMax H3

[返回 README](../README.md) · [混合视频操作](HYBRID_VIDEO.md)

## 连接现有环境

LocalMiniDrama Backend 直接连接 ComfyUI，不启动、安装或管理 ComfyUI / H3。继续使用已经可运行的 Desktop、模型、LoRA 和节点。

Storyboard 顶部 **ComfyUI / Cost Settings**：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| ComfyUI URL | `http://127.0.0.1:8188` | 填实际 API 地址；Desktop 可能使用其他端口 |
| Local Timeout | 120 min | 等待本地任务输出的期限，1–1440 分钟 |

设置保存在 SQLite `global_settings.hybrid_video`。连接使用原生 Node HTTP(S)，本机请求不会经过云 Provider 的环境代理。服务不可达时显示 `ComfyUI Offline`。

**Test Connection** 查询 `/system_stats` 和 `/object_info`，检查源模板所需节点及加载器候选值。此操作不提交 Workflow、不生成视频。生成时也检查可达性，避免离线任务排队；已有云视频配置独立工作。

## 模板来源

模板从已保存的 `图+文-视频生成-MinMaxH3-Auto短剧.json` 机械展开子图、Set / Get 引用，沿真实输出链保留 22 个执行节点。原图不被修改。

- 模板：[`backend-node/configs/workflows/minimax_h3.json`](../backend-node/configs/workflows/minimax_h3.json)
- Mapping：[`minimax_h3.mapping.json`](../backend-node/configs/workflows/minimax_h3.mapping.json)
- 导出工具：[`import-h3-workflow.cjs`](../backend-node/scripts/import-h3-workflow.cjs)

Mapping 保存源文件名、SHA256、Mode、FPS、帧网格和模型节点。业务服务只读取 Mapping，不另写 Node ID。导出器针对当前图结构，不能当作任意 ComfyUI 图的通用转换器；换图后必须核对映射。

## 当前 Node Mapping

| 字段 | Node / Input | 行为 |
| --- | --- | --- |
| Prompt | `105_104.prompt` | H3 Optimized Prompt |
| Reference Image | `114.image` | 上传到 ComfyUI 的首帧图像名 |
| First Frame | `114.image` | 同一参考图进入源缩放链 |
| Last Frame | `null` | 没有连接，不能提交尾帧 |
| Duration | `105_111.value` | 输入秒数，默认 5 |
| Frames | `105_104.length` | 由原 `105_107` 数学节点计算 |
| FPS | `105_91.fps` | 固定 24 |
| Width / Height | `105_104.width / height` | 默认跟随 `119 → 120` 图像尺寸 |
| Seed | `105_15.noise_seed` | 请求 Seed 或随机 Seed，写入生成记录 |
| Audio | `null` | 不接外部音频；保留源图生成的原生音频 |
| Output | `92.filename_prefix` | 唯一输出前缀，读取其 MP4 |

模型加载器、LoRA、Sampler、Scheduler、原生音频链与 VAE 沿用模板。模型主加载器使用源 Workflow 的 `minimax_h3_fl2va_pruned_int8_convrot.safetensors`；使用何种视频模式由当前连接和 Prompt 决定，加载器名称不代表尾帧已连接。

源缩放节点使用 nearest-exact、1 megapixel、32 倍数对齐。默认宽高从首帧实际缩放结果取得；可通过已有提交接口传 32 倍数的宽高，但界面不额外改写源缩放策略。

## Duration 与 Frames

当前 Mode 为 **I2VA**，允许 4–15 秒输入。帧数保持源公式：

```text
max(5, round(duration × 24))
  + (5 - (max(5, round(duration × 24)) % 17)) % 17
```

5 秒输入得到 124 帧；24 FPS 下约 5.17 秒。`duration` 记录请求时长，`output_duration` 保存 ffprobe 测到的实际输出时长，二者可能不同。不能随意改 FPS 而继续使用此帧数公式。

FL2VA、L2VA、Ref2VA、T2VA 的 Prompt 规则在 Adapter 中分开描述，但当前 Mapping 只启用 I2VA；没有接入对应图的模式不会成为可生成选项。

## API 与输出路径

1. 从本机 Media Library 解析首帧，检查路径范围与 50MB 上限。
2. 读取或优化当前 H3 Prompt。
3. `POST /upload/image` 上传首帧。
4. 绑定模板输入，`POST /prompt` 提交，保存 `prompt_id` 与客户端 ID。
5. WebSocket `/ws` 接收匹配任务的节点 / Sampling 进度；没有原生 WebSocket 的 Node 环境使用轮询。
6. 轮询 `/history/<prompt_id>` 与 `/queue`，检查错误、任务消失与超时。
7. 从映射的输出节点选取 MP4，经 `/view` 下载至 `.part` 文件，检查 MP4 文件标识后改名。
8. 使用现有 ffprobe 测时长，保存到 `storage/<project>/videos/h3_<generation_id>.mp4`，暴露 `/static/...`。
9. 更新 Shot 的 `video_url`，保留原分镜参考图的 `local_path`。FFmpeg Compose 继续使用已有服务。

`storage` 根目录来自现有 `config.yaml`，不另建公共媒体目录。远程图先导入素材库；本地 Provider 不会随意下载任意远程 URL 或读取媒体根目录之外的文件。

## Queue、History 与 Cancel

Storyboard **Generation History** 显示本集生成记录，并查询当前 ComfyUI Queue。后端接口位于 `/api/v1/hybrid-video/`：

| 接口 | 用途 |
| --- | --- |
| `POST connection` | 连接与节点检查 |
| `GET queue` | ComfyUI Running / Pending |
| `GET history?episode_id=...` | 当前集的本机生成历史 |
| `POST generations/:id/cancel` | 取消已提交的本地任务 |

Pending 任务只删除对应 `prompt_id`。Running 使用 ComfyUI interrupt，只有能确认当前队列唯一运行任务为本项目任务时才发送；存在其他运行任务时报错，避免中断其他生成。

取消不影响云模型。超时后原任务可能仍在 ComfyUI 执行，可以使用已有 **继续查询** 取回相同任务；**Retry Local** 是新的生成，不会切换到云。

## 故障与验证边界

缺少节点、模型或 LoRA 时保留原错误，由现有 ComfyUI 环境处理。服务离线、执行失败、输出无 MP4、下载失败或超时都结束本地记录，不会产生收费 fallback。

代码测试通过 Mock HTTP 服务检查提交、Queue、History、取消和输出获取。Mock MP4 标识检查不等于真实视频解码或视觉质量验证。真实 5 秒 H3 生成、有效 MP4、导入、合成、本机成功耗时与批量稳定性仍需要单独实机验证。
