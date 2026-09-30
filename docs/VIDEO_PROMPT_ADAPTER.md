# Universal Shot Intent 与 Video Prompt Adapter

[返回 README](../README.md) · [ComfyUI Mapping](COMFYUI.md)

## 原始意图保留

原 Storyboard 文案不被替换。`shotIntent.js` 将当前 Shot、角色与场景整理成模型无关 JSON：

| 字段 | 内容 |
| --- | --- |
| `original_prompt / duration` | 原分镜文案与请求时长 |
| `characters / appearance` | 角色身份、外貌、服装 |
| `action / expression / dialogue` | 动作、表情、原语言对白 |
| `scene / lighting / framing` | 场景、光照、景别 |
| `camera_angle / camera_movement` | 机位与运动 |
| `action_sequence / sound / music` | 动作顺序、环境音、音乐 |
| `reference_image_role` | 图像在镜头中的角色 |
| `first_frame_intent / last_frame_intent` | 首 / 尾帧导演意图 |
| `reference_image / last_frame` | 参考素材定位 |

缺失的声音与音乐默认为空，不擅自改写剧情。界面可编辑 Intent JSON 并保存；时长仍以 Shot 当前值为准，参考图仍按实际输入定位。

## Adapter 分工

模块位于 `backend-node/src/services/videoPromptAdapters/`：

| Adapter | 当前行为 |
| --- | --- |
| `minimaxH3.js` | Mode 专用系统指令、DeepSeek 英文转换、官方字段与对齐结构校验 |
| `seedance.js` | 独立接口，沿用当前云视频 Prompt |
| `kling.js` | 独立接口，沿用当前云视频 Prompt |
| `index.js` | 集中选择已有 Adapter，其他云模型保持原文案行为 |

H3 优化通过现有 `aiClient.generateText`，锁定实际启用的 DeepSeek 配置 ID 和模型，不借用视频 API。任务是转换导演意图，不是重写剧情。

## 官方规则来源

规则依据 MiniMax-AI/MiniMax-H3 官方资源，核对日期 2026-09-30：

- [Prompt Writing Skill](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md)
- [Base 模式英文 Guide](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt)
- [Reference 模式英文 Guide](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt)

当前 Adapter 版本 `h3-official-20260930-v1`。后续官方规则变化后应明确更新版本与验证，而非默默改变已有手工 Prompt。

## Mode 与结构

当前 Mapping 仅启用 **I2VA**。Prompt 必须从对应的官方首帧对齐声明开始，再按顺序包含：

```text
integrated_multimodal_description:
overall_soundscape:
non_diegetic_music:
```

视觉主体使用 `[Shot 1]`，开头不附起始时间。默认短镜头保持一个连续镜头、一个核心动作，按起始动作、持续运动、反应、结尾状态描述。需要后续切镜时，使用递增的 `MM:SS.mmm` 时间，限制在视频时长内。

DeepSeek 使用英文动作与镜头描述，保留原对白及可见文字语言。说话主体使用稳定 `(S1)` 等标记，原话放入 `<d>[Language] ...</d>`。环境、物理声音与非语言人声放在 Soundscape，音乐单独描述；不重复对白或添加剧情。较长对白要求明确报错，不能默默删减；执行质量仍需人工检查。

Adapter 内对 T2VA、FL2VA、L2VA 与 Ref2VA 分别描述对齐和字段规则。Ref2VA 使用六字段结构，区分参考主体与关键帧。只有对应 Workflow Mapping 的 `supported_modes` 启用后才能实际提交；这些系统指令不是其他模式已接入的证明。

## 缓存与手工保护

Shot 保存：

```text
shot_intent
source_prompt_hash
h3_mode
optimized_prompt
provider_prompt
prompt_version
generated_by_model
generated_at
user_edited
```

缓存指纹为 Intent 与 Mode 的 SHA256。未变化时直接复用 Optimized Prompt。改变文案、角色、场景、时长或参考首帧后，自动 Prompt 需要重新优化；缓存过期不会删除旧文案。

保存手工 Prompt 会设 `user_edited = 1`。自动生成保留手工版本，即使原 Intent 已变化，也显示 stale 提醒；Mode 变更则要求明确更新。点击重新优化时界面确认覆盖，再通过 `force` 请求生成新版本。

DeepSeek 请求期间发生手工编辑或原 Intent 变化，Backend 拒绝写回旧结果，避免异步覆盖最新编辑。

## UI 与 API

每个 Shot 点击 **Original / Shot Intent · H3 Prompt**：

1. 编辑 Intent JSON 后点保存。
2. 点击 Optimize / 重新优化取得英文 Prompt。
3. 编辑 H3 Prompt 并保存手工版本。
4. 查看 Mode、缓存状态、模型与生成时间。

对应 `/api/v1/hybrid-video/shots/:id/` 下的 `GET prompt`、`POST optimize`、`PUT prompt`。自动本地生成仅在缺少有效缓存时请求 DeepSeek。

## 费用与限制

DeepSeek 文本请求可能产生账户费用，不纳入视频 Cost Engine。再次生成相同 Shot 默认不重复优化，明确重新优化会重新请求。

结构校验检查所需字段顺序、首 / 尾帧声明、`[Shot 1]` 和不允许的 Markdown / think 内容；无法证明对白能在时长内完成、视觉一致性或执行质量。Mock 测试验证配置锁定、缓存和并发编辑保护，真实视频效果需实机验证。
