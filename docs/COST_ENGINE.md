# Video Cost Engine

[返回 README](../README.md) · [Hybrid Video](HYBRID_VIDEO.md)

## 配置入口与数据

Storyboard 顶部 **ComfyUI / Cost Settings** 可编辑全局预算、模型价格、Subscription Plan 与可选电费。模型切换后自动重算该集预测，不触发 Provider 生成。

- `video_cost_prices`：用户填写的模型价格。
- `global_settings.hybrid_video`：重试倍率、每月集数、套餐、电费与 ComfyUI 地址。
- `video_cost_quotes`：云生成费用确认凭据。
- `video_generations`：每次生成的费用与运行快照。

价格不来自硬编码的云单价。未填写的价格保持 null，不能当作免费；不换算不同币种。

## 价格表

| 字段 | 说明 |
| --- | --- |
| Provider / Model | 对应已启用视频配置的模型 |
| Billing Type | `per_second / per_request / per_image / monthly_subscription / local_compute` |
| Price | 单价，可留空表示未知 |
| Currency | CNY、USD 等三位币种代码 |
| Resolution | 如 720p，或 `*` 通用价格 |
| Effective Date | 生效日期，不采用未来价格 |

选择与请求分辨率精确匹配的价格，之后才选择 `*`；同档位取最新已生效日期。新增档位时注意避免 Provider + Model + Resolution + Effective Date 重复。

| Billing Type | 预测口径 |
| --- | --- |
| per_second | 请求时长 × 单价 |
| per_request | 每 Shot 一次请求 × 单价 |
| per_image | 当前每 Shot 一个计费图像单位 × 单价 |
| monthly_subscription | API 变量费用 0；月费单独分摊，额度与超额单独计算 |
| local_compute | Local API 0；实际本机估时小时数 × 计算小时单价 |

视频预算当前不统计独立文本优化、图片生成、TTS、图床费用。`per_image` 的多图 Provider、多个输入或多个输出的特殊计费，需要按实际账户调整预算，不能将此简单口径作为精确账单。

Local H3 的分辨率记录默认为 `workflow:auto`，宽高按源 Workflow 缩放后的图像取得。显式提交宽高时记录 `WIDTHxHEIGHT`。没有成功本机样本时，本机估时未知，不能按显卡理论性能填值。

## Shot、Episode 与 Season

每个 Shot 显示有效模型、秒数、API 金额；本地 Shot 还显示 Estimated Local Time。顶部可展开当前集的分组明细。

**单集 / 整季成本** 选择 1、10、30、100 Episodes，按当前集的镜头数、模型分布、时长和估时线性推算。各币种分别显示：

```text
Variable API Cost
Fixed Subscription Allocation
Subscription Overage
Local Compute
Electricity
Base Estimated Cost
Risk-adjusted Budget
```

Unknown 价格、额度或电费估时会明确提示，显示金额只是已知部分。预测不是新建任务或调用 Provider。

## ¥500/月套餐

点击添加 Subscription Plan，例如填写：

| 字段 | 示例 |
| --- | --- |
| Name | Agent Plan |
| Monthly Fee | 500 |
| Currency | CNY |
| Enabled | 开启 |
| Provider | 对应套餐 Provider；留空覆盖所有订阅计费模型 |
| Included Quota | 仅在知道额度时填写，否则留空 |
| Quota Unit | requests、seconds 或 images |
| Overage Price | 额度外单价，不知道则留空 |
| Expected Episodes Per Month | 20 |

```text
Fixed Allocation Per Episode = Monthly Fee / Expected Episodes Per Month
                            = 500 / 20
                            = ¥25
```

预计 10 集固定分摊 ¥250，30 集 ¥750；这属于制作成本分摊，不代表必须再买若干个月或套餐允许生成任意集数。

订阅表启用的月费会单独分摊。若直接使用模型 `monthly_subscription` 月价且没有适用的启用套餐，该模型月价也按预期集数分摊；同一模型不重复算月费。

套餐额度只覆盖设为 `monthly_subscription` 的模型，不自动免除 `per_second` 等 API 单价。月内已提交的匹配记录用于保守计算已用额度，不等于 Provider 实际扣费，失败请求的真实扣费仍需以账户账单为准。

```text
Incremental Overage Units = max(0, Used + Predicted - Included)
                         - max(0, Used - Included)
Overage Estimate = Incremental Overage Units × Overage Price
```

未知额度不能视为无限，未知超额单价不能默认为零。当前 images 额度同样按每 Shot 一个单位处理。

## Retry Budget

倍率支持 1.0x、1.2x、1.5x、2.0x，仅用于预算：

```text
Base = Variable API + Fixed Allocation + Overage + Local Compute + Electricity
Risk Budget = Fixed Allocation
            + (Variable API + Overage + Local Compute + Electricity) × Retry Multiplier
```

固定月费分摊不随倍率增加。界面不会因此多提交任务，不会自动重试，不会使本地失败切换到云。生成记录的 `retry_count` 是同一 Shot 已有生成尝试数，不等于自动重试次数或 Provider 计费规则。

## 本机估时与电费

仅统计最近成功输出并有有效执行时间的 H3 记录，按对应分辨率过滤最多 30 条历史：

```text
Seconds Per Output Second = sum(Generation Elapsed) / sum(Output Duration)
Estimated Compute Seconds = Requested Duration × Seconds Per Output Second
```

执行时间来自 ComfyUI `execution_start → execution_success`，输出时长来自 ffprobe。总提交耗时包含 Prompt 优化、排队、下载，不作为纯生成速度。失败 / 取消 / 无时长的记录不进入估速。

电费默认关闭。开启后使用用户填写的平均整机功耗与电价：

```text
Electricity CNY = Compute Seconds / 3600 × Power W / 1000 × CNY Per kWh
```

例如 420 秒、300 W、¥1/kWh，电费约 ¥0.035。这里是公式示例，不代表本机实测。实际成功时间可写入生成记录的电费快照，但不冒充电表读数。

## Estimated / Calculated / Actual

| 字段 | 当前含义 |
| --- | --- |
| estimated_cost | 提交时按价格与请求计费单位估算的 API 金额 |
| calculated_cost | 任务结束保留提交计费快照的计算值，当前与 API estimate 一致 |
| actual_cost | Provider 账单；未提供账单则 null；本地 API 为 0 |
| cost_metadata | 价格、币种、本机估时、电费设置与费用明细快照 |
| generation_metadata | 配置、Mode、Intent、输入参数、Prompt 版本、本地任务信息 |

`calculated_cost` 并不证明扣费；未知价格下该值同样为 null。云 API 未返回真实账单时 History 显示 Actual 未知。现有云 Provider 尚未接入账单同步。

每条新记录保存 Project、Episode、Shot、Provider、Model、请求时长、分辨率、started_at、completed_at、总耗时、重试数与状态。H3 成功时另存实际输出时长与纯执行耗时。历史旧记录没有这些信息时保留未知，不补造数据。

## 生成确认与测试

涉及云模型时，UI 显示报价并等待明确确认。Backend 绑定 Shot / 模型 / 时长 / 分辨率 / Intent / 价格设置，对过期、变更与重复请求返回 409。未知费用可明确确认，但需要用户自己承担账户费用。

离线测试覆盖价格为空、日期与分辨率档、分币种、套餐分摊、Retry、成功历史估速、电费公式和 quote 消费。没有调用真实收费云视频 API。真实账单与本机成功视频速度仍需另外核实。
