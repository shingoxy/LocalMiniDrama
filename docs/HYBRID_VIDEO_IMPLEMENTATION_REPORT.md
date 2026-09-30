# Hybrid Video 实现与验证报告

日期：2026-09-30。状态：代码与文档已落地，离线测试和构建通过；真实 ComfyUI / H3 验证按当前指示保留到下次明确要求时执行。

## 1. 核心架构修改

沿现有 Express、Vue、SQLite 与 FFmpeg 制作链增加集中服务：

- `videoModelSelection.js`：模型目录、配置锁定、Shot > Episode > Project 继承和批量选择。
- `shotIntent.js` 与 `videoPromptAdapters/`：保留原 Storyboard，整理 Intent，H3 专用转换，Seedance / Kling 独立接口。
- `comfyVideoProvider.js`：原生 Node HTTP(S) 直连 ComfyUI、模板绑定、Queue / History / Progress、取消与 MP4 获取。
- `hybridVideoService.js`：报价确认、本地调度、Prompt 缓存、生成记录与 Keep Static。
- `costEngine.js`：价格、套餐、Retry、历史估速、电费与季预算。
- `HybridVideoToolbar.vue / HybridShotVideo.vue`：在现有 Storyboard 列表增加操作；原画布 / 视频生成入口复用 Backend 路由与费用确认。

没有安装新模型或 Worker，没有修改 CUDA / PyTorch，没有回退已有 DeepSeek / Seedream / Seedance 等实现。新增代码不增加 npm 依赖。

## 2. ComfyUI 如何连接

Storyboard → **ComfyUI / Cost Settings** 设置 URL。产品默认 `http://127.0.0.1:8188`，当前本机既有 Desktop 实际端口为 8000，已保存为 `http://127.0.0.1:8000`。

**Test Connection** 手动查询系统和节点信息；生成由 Node Backend 直接提交至 ComfyUI。无法连接显示 `ComfyUI Offline`，不改变其他 Provider。当前停止实机验证后没有再次调用连接、Queue、提交或重试接口。

## 3. 已读取的 Workflow / Mapping

来源：`E:\ComfyUI-Files\user\default\workflows\图+文-视频生成-MinMaxH3-Auto短剧.json`。

已从当前保存图机械展开 22 个执行节点，保留模型、LoRA、采样器、调度器、尺寸与原生音频链。原图文件未改，私人 Prompt 没有写入项目模板。

| 项目 | 文件 / 行为 |
| --- | --- |
| 模板 | `backend-node/configs/workflows/minimax_h3.json` |
| 独立 Mapping | `backend-node/configs/workflows/minimax_h3.mapping.json` |
| Mode | I2VA，Storyboard 首帧 + Prompt |
| FPS / Duration | 固定 24 FPS，默认 5 秒，保留原帧数公式 |
| Width / Height | 默认从原 1MP / 32 倍数首帧缩放链取得 |
| First / Last / Audio | 首帧已连接；尾帧与外部音频未连接；保留原生生成音频 |
| Output | 原 SaveVideo 节点，取回 MP4 并写入现有媒体目录 |

5 秒输入对应 124 帧，实际约 5.17 秒；成功文件实际时长需由 ffprobe 核实。全部 Node ID 由 Mapping 集中描述，详情见 [COMFYUI.md](COMFYUI.md)。

## 4. H3 Prompt Adapter

已读取 [MiniMax H3 官方 Skill](https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing) 及 Base / Reference Guide，按 I2VA 使用对应首帧声明、视觉 / Soundscape / Music 结构。

Universal Shot Intent → 指定启用的 DeepSeek 配置 → 英文 H3 Prompt → 缓存。保留原对白与剧情，短镜头聚焦核心动作。保存 hash、Mode、Prompt、模型、时间、手工标记与版本；手工编辑不被自动覆盖，并防止异步优化覆盖后来修改。

Seedance / Kling 当前沿用原 Prompt 行为，留在各自 Adapter 模块。DeepSeek 文本优化可能收费，不包含在本地视频 API ¥0 中。详见 [VIDEO_PROMPT_ADAPTER.md](VIDEO_PROMPT_ADAPTER.md)。

## 5. Storyboard 模型选择

每个 Shot 的 Video Model 可选 Auto、Local H3 或启用的云视频配置。Project Default 在顶部设置，具体 Shot 可以覆盖。配置持久化后重新打开项目仍保留。

选择优先级 Shot > Episode > Project > 原 AI 默认视频配置。云模型绑定具体配置 ID；失效配置报错而不替换。下拉框只显示当前启用的模型，Kling 等需要对应 AI 配置已启用才能选用。

## 6. 一键本地 / 云端 / 多选

顶部 **全部使用 MiniMax H3**、**全部使用云端模型** 修改本集选择并清除旧 Shot 覆盖；**恢复默认** 清除 Episode 与 Shot 覆盖，继承 Project Default。

Checkbox 选部分 Shot 后使用 **将选中 Shot 设置为**，只改所选范围，不影响其他镜头与剧集。

## 7. Hybrid Generate All 与 Local Draft

Generate All / Selected 按每个 Shot 的有效模型分别分发，本地和云端可混用。包含云模型时先显示成本并确认；服务端验证 quote token，未确认不建立视频 / 异步任务。无 Local → Cloud 自动 fallback。

Local Draft 临时选择 H3，不覆盖保存的云模型。Keep Local 采用最近本地结果，Local Regenerate 创建新的本地任务，Upgrade 只改模型并在生成时再确认云费用，Keep Static 使用现有 FFmpeg。H3 可直接作为最终镜头。

原批量按钮继续跳过已有完成视频，新工具栏可重新生成选定范围。详情见 [HYBRID_VIDEO.md](HYBRID_VIDEO.md)。

## 8. Cost Engine 配置

ComfyUI / Cost Settings 的价格表可编辑 Provider、Model、Billing Type、Price、Currency、Resolution、Effective Date。支持秒、请求、图像、月费和本地计算计费。

云价格留空时为未知。CNY / USD 分别汇总。记录 Estimated、Calculated 和 Actual：当前 Calculated 使用提交价格快照；云 API 没有真实账单时 Actual = null。本地 API Actual = 0。

Retry Budget 仅调整预算，不增加生成次数。Local Compute 用成功历史估时，电费默认关闭，开启后使用自填功耗与电价。详情见 [COST_ENGINE.md](COST_ENGINE.md)。

## 9. ¥500/月套餐

添加并启用 Subscription Plan：Monthly Fee = 500 CNY，Expected Episodes Per Month = 20，每集固定分摊 ¥25。

Included Quota 不明时留空，不能视为无限。填写已知 Quota Unit 和 Overage Price，选择对应 Provider；覆盖模型使用 monthly_subscription 价格类型。固定月费和按量 API 分别显示。

## 10. 单集 / 整季成本位置

Storyboard 顶部可展开当前 Episode 预测；点击 **单集 / 整季成本** 选择 1 / 10 / 30 / 100 集。以当前集 Provider 分布与时长推算，显示 API、固定月费、超额、本地计算、电费、Base 与 Risk Budget。

Generation History 展示每次尝试的模型、状态、错误、耗时、费用与重试。未知项目保持未知。

## 11. README / Docs / Repo

根 README 已完整改写为中文项目说明，在前部明确 Upstream & Credits，感谢 xuanyustudio 与原贡献者，并区分 fork 增强功能。MIT LICENSE 与已 fetch 的 origin/main 一致，版权声明未修改。

新增专项文档：

- [COMFYUI.md](COMFYUI.md)
- [HYBRID_VIDEO.md](HYBRID_VIDEO.md)
- [VIDEO_PROMPT_ADAPTER.md](VIDEO_PROMPT_ADAPTER.md)
- [COST_ENGINE.md](COST_ENGINE.md)

Git origin fetch / push 均已切换为 `https://github.com/shingoxy/LocalMiniDrama.git`，fetch 成功。增强代码与其依赖的已有 Provider / 本地部署改动通过 main 分支提交发布，具体 commit / push 状态以 Git 历史为准。私有配置、数据库、素材、备份与运行日志不进入提交。

## 12. 本地 H3 5 秒测试耗时

在停止实机验证的指示之前，独立测试项目进行过一次 5 秒提交：DeepSeek 优化完成，ComfyUI 接受任务并开始执行，但最终记录为 **failed**。

总耗时 **693.556 秒（约 11 分 34 秒）**，包含优化和等待，不是成功生成速度。`generation_elapsed_seconds = null`、`output_duration = null`，没有可用 MP4，不能作为本机估速样本，也不能声称 H3 集成已稳定跑通。

相关结果保存在 `.local/h3-smoke-result.json`。失败原因尚未定位；按后续指示未再运行 ComfyUI 或重试。独立的 `H3 Integration Smoke Test` 项目保留用于下次验证。数据库当前没有 processing 的本地 H3 记录。

## 13. 已完成的验证

| 验证 | 结果 |
| --- | --- |
| Backend 测试 | 126 passed / 0 failed，其中新增 Hybrid 测试 17 项 |
| Frontend 测试 | 14 passed / 0 failed，其中成本展示测试 3 项 |
| Frontend Vite Build | 成功；保留原有 >500kB bundle 警告 |
| Git diff 空白检查 | 通过 |
| 模板 / Mapping | 离线结构和输入绑定测试通过，采样 / 数学节点保持原值 |
| Cloud Guard / Hybrid | Mock 确认前拦截、一次消费、变更失效、Local / Seedance / Kling 分发通过 |
| Prompt / Cost | Mock 缓存、手工 / 并发编辑保护、未知价格、套餐、Retry、历史估速、电费通过 |
| Migration | 增量迁移与重复执行测试通过；原数据库使用新增字段与表 |
| 原数据 / 未提交改动 | 对照改动前备份，原有记录原字段未变化；50 个不受影响文件逐字节相同 |
| 真实收费云视频 API | 没有调用 |

备份在 `.local/pre-hybrid-20260930/`，包含原脏文件与在线 SQLite 备份，属于私有本机资料，不提交。备份中的 6 个原脏文件在其已有改动上继续进行了必要集成，其余 50 个文件保持相同。

原项目 1、原剧集 1、原分镜 26、原 AI 配置 16、原视频记录 46 的原字段全部一致。额外增加了一个独立测试项目 / 剧集 / Shot 和一条失败测试记录。对照摘要在 `.local/final-audit.json`；测试 / 构建日志在 `.local/backend-tests.log`、`.local/frontend-tests.log`、`.local/frontend-build.log`。

## 14. 尚存限制与下次验证

真实 ComfyUI 连接、执行、Sampling WebSocket、有效 MP4 解码 / 导入、Keep Local / Static、FFmpeg 最终合成、批量取消 / 恢复与成功本机耗时，都留到下次明确要求验证时安排。Web UI 的实际交互与 Electron 打包也未作为本轮实机验收。

当前模板只启用 I2VA、24 FPS、4–15 秒，尾帧与外部音频未连接。云模型真实账户权限、配额、返回时长与账单未验证。季预算按当前集线性推算；per_image 暂按每 Shot 一个图像单位，文本 / 图片 / TTS 费用不计入视频报价。

离线测试通过证明代码中的解析、保护和计算逻辑，不证明真实 H3 成功率、生成速度、视觉质量或真实云账单准确性。
