# Hybrid Local + Cloud Video

[返回 README](../README.md) · [成本配置](COST_ENGINE.md) · [H3 Prompt](VIDEO_PROMPT_ADAPTER.md)

## 操作入口

打开项目的 Storyboard 列表。顶部显示 Hybrid Local + Cloud 工具栏，每个 Shot 下方显示 Video Model、API 成本、本机耗时和 Prompt 操作。延续现有列表与画布工作流，不另建制作页面。

模型列表来自启用的视频 AI 配置，包含 Local MiniMax H3 和当前账户配置的 Seedance、Kling、其他视频模型。同名模型的不同配置独立列出，保存具体配置 ID；生成期间不重新绑定默认配置。

## 模型继承

| 优先级 | 设置 | 保存位置 |
| --- | --- | --- |
| 1 | 单个 Shot 的显式选择 | `storyboards.video_provider / video_model / video_config_id` |
| 2 | Episode 整集设置 | `episodes.video_selection` |
| 3 | Project Default Video Model | `dramas.default_video_selection` |
| 4 | 原 AI 默认视频模型 | 现有启用的 AI 视频配置 |

Auto / Default 代表继承，不代表随机模型。关闭原 AI 配置后显式选择会报错，不自动用其他收费模型替换。历史无新增字段的 Shot 按原默认配置解析。

### 一键全部本地 / 一键全部云端

**全部使用 MiniMax H3** 设置 Episode 为 Local；**全部使用云端模型** 选择列表中的指定云模型。这两个整集操作清除本集原有 Shot 覆盖，让整集统一采用新选择；不改变其他 Episode 或 Project Default。

**恢复默认** 清除 Episode 和 Shot 覆盖，恢复继承项目默认。要恢复 AI 默认，另将 Project Default 设置为 Auto。

### 多选批量设置

勾选轻量 Shot Checkbox，选择 **将选中 Shot 设置为**。只写入选中镜头。全选只选择范围，设置模型才写数据库；Generate Selected 根据该范围执行。

例如 Project Default = Local H3，Shot 03 = Seedance、Shot 04 = Kling，其他 Shot = Auto，则同一 Episode 的 Generate All 混合执行这些模型。

## 生成流程

1. 完成 Storyboard、分镜首帧与导演意图。
2. 设置 Project / Episode / Shot 模型并检查每镜头成本。
3. 点击 Generate Selected 或 Generate All。
4. Backend 解析各 Shot 有效模型，生成费用预测；纯本地显示 API ¥0 与预计耗时。
5. 包含云模型时先显示模型数量、秒数、已知金额和未知费用。取消确认不会提交任何云视频。
6. 确认后本地进入 H3 Prompt Adapter / ComfyUI，云端沿用对应 Provider。
7. 独立保存状态、错误、视频、计费快照和耗时。完成视频继续参加现有 FFmpeg Compose。

新增工具栏的 Generate All / Selected 会重新生成对应范围；原批量视频按钮默认跳过已有完成视频。没有首帧的 I2VA Shot 不会变为纯文本 H3。

画布生成也经过 Backend 模型解析与费用确认，逐镜头选择在列表中编辑。已有全能云模式依 Provider 协议处理多图；H3 当前始终使用 I2VA 首帧模板。

## Local Draft 与镜头采用

| 操作 | 行为 |
| --- | --- |
| Local Draft / 本地预演 | 临时用 H3 生成，不改变已保存的模型选择 |
| Retry Local / Local Regenerate | 新建本地生成，复用有效 Prompt 缓存 |
| Keep Local | 将最近成功的本地记录用于该 Shot 的最终视频 |
| Upgrade to Cloud Model | 明确改成指定云模型；点击生成时另行确认费用 |
| Keep Static | 当前分镜图用现有 FFmpeg 转为静态 MP4，保存并用于合成 |

H3 既可预演，也可作为最终镜头。Local Draft 不产生自动云调用；失败只记录 `Local generation failed`。本地失败后由用户选择重试或手动升级。

## 云调用确认

`POST /api/v1/hybrid-video/quote` 建立当前请求的报价凭据。`POST /api/v1/videos` 提交时必须带 `quote_token` 与 `cloud_confirmed: true`，服务端会检查模型、Shot、时长、分辨率、Intent 和价格设置。

凭据有效期 24 小时，同一个镜头请求只消费一次；变更价格或模型、重复提交、过期凭据会返回 409，需要重新预测确认。确认也不会使未知费用成为零。全部 Local H3 不要求云调用凭据。

确认针对视频 API；自动优化未缓存的 H3 Prompt 会调用已配置 DeepSeek 文本 API。现有文本、图片、TTS 功能不属于此视频报价保护的计费范围。

## Generation History

查看 Provider、Model、请求时长、Resolution、开始 / 完成时间、耗时、重试计数、状态与费用快照。数据库还记录本地输出时长、实际执行耗时、Prompt 版本与生成元数据。

`elapsed_seconds` 是从本应用提交到结束的总时间，包含优化与排队；`generation_elapsed_seconds` 来自 ComfyUI execution 时间戳。只有成功输出样本进入本机估速。Actual Cost 没有账单时为 null。

Cancel 只用于已提交且仍 processing 的本地任务。停止批量按钮阻止后续提交，已提交任务需单独取消。继续查询复用已有上游任务，Retry 创建新任务。

## 数据迁移与兼容

Migration [`23_hybrid_video.sql`](../backend-node/migrations/23_hybrid_video.sql) 只增列、建表，不重建或清空历史项目。模型设置、Intent、H3 Prompt 与元数据在现有表中持久化；价格与费用确认使用新表。

本地视频采用更新 `video_url`，保留图片引用。合成解析优先使用明确选中的视频，避免把分镜图片的 `local_path` 当作视频。已有 Provider 代码与 FFmpeg 服务继续使用。

## 验证边界

模型优先级、批量设置、配置停用、Hybrid 分发与云确认由 Mock 测试覆盖。真实 H3 批量、各账户云模型能力、画面一致性和最终真实 MP4 合成需独立验证，不能从离线测试结果推断。
