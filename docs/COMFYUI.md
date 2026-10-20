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

默认模板已切换为 **LightX2V FL2VA Turbo 4-step v0.1**。基础模型仍为 `minimax_h3_fl2va_pruned_int8_convrot.safetensors`，文本编码器、视频 / 音频 VAE、原生音频、图像缩放、24 FPS 和帧数公式保留。原专用 LoRA 叠加由一个加速 LoRA 替换：

| 参数 | 当前默认 |
| --- | --- |
| LoRA | `minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16.safetensors` |
| 节点 / 强度 | `LoraLoaderModelOnly` / `1.0` |
| Sampler / Scheduler | `euler` / `simple` |
| Steps / Denoise | `4` / `1.0` |
| Video / Audio Shift | `MiniMaxH3SigmaShift`，`12` / `3` |
| Mapping Version | `2` |

将加速 LoRA 放在 ComfyUI 的 `models/loras/` 根目录；本机已有此文件，不需要另行下载。文件 SHA256 为 `3a069f26fbc33f377a60dc72dd9e15f2aa42aa1d1b44915fded835716672dd36`，对应 [Kijai 发布文件](https://huggingface.co/Kijai/MiniMax-H3_comfy/blob/main/loras/minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy_resized_avg_rank_21_bf16.safetensors)。四步、Euler 与 shift 配套参考 [LightX2V 模型规格](https://github.com/ModelTC/Minimax-H3-Turbo#1-model-specs) 和 [ComfyUI 接线说明](https://github.com/ModelTC/Minimax-H3-Turbo/blob/main/COMFYUI_SETUP_AND_INFERENCE.md)。这条模板使用 ComfyUI 核心节点，不混用另一套 H3 Turbo LoRA 的专用采样器。

v0.1 在 544p 混合比例训练；现有分辨率不会自动下调，高分辨率的人脸、动作和音频质量仍需实测。四步减少采样计算次数，模型加载、内存卸载与 VAE 耗时不会同比缩短，不能据此承诺总耗时。缺少 LoRA 或 `MiniMaxH3SigmaShift` 时，连接检查明确报错。

I2VA / FL2VA 继续由参考帧和 Prompt 决定。上述导出工具仅机械展开原始保存图，重新执行会覆盖模板；重新导出的文件需应用本节加速配置及首尾帧 Mapping 后才能替代当前默认。

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

2026-10-20 四步模板切换后，后端 151 项测试通过，覆盖 I2VA / FL2VA 加速链绑定、缺少加速 LoRA 或 shift 节点时的明确报错，以及原有 Mock HTTP 提交、Queue、History、取消和输出获取。当前 ComfyUI 的节点 / 权重只读检查通过，I2VA / FL2VA 输出依赖图分别包含 21 / 23 个节点。本轮未提交 GPU 或云端生成任务；旧版 H3 的视频结果不能证明四步版本的速度、画质或音频质量，这些仍需单独实机验证。
