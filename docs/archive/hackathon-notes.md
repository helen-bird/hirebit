# Hackathon notes (historical)

These are the original challenge notes, not a current setup or acceptance checklist. The
[README](../../README.md), [production acceptance](../PRODUCTION_ACCEPTANCE.md), and
[payment lifecycle](../PAYMENT_LIFECYCLE.md) distinguish implemented, simulated, and unverified
behavior. Organizer-approved payment simulation during the GoBTC outage is documented there.

# build guide
https://pioneers.agnic.ai/build/bitcoin-pay

# Track 2 项目优化标准

目标：在保证核心闭环真实可运行的基础上，让项目更有机会进入 Finalist。

## 1. Real：真实可验证

项目必须真实完成：

- Agent 拥有 Bitcoin wallet
- 真实 BTC mainnet payment
- Agent 能识别 `paid`
- 支付成功后自动继续任务
- 能展示 transaction proof / txid
- 明确区分哪些是真实能力，哪些是 mocked

原则：

> 核心交易链路必须真实，不能只做 UI 演示或假支付。

---

## 2. Necessary：支付必须是任务关键路径

支付不能只是“把信用卡换成 Bitcoin”。

需要满足：

- Agent 必须购买某个商品、服务、API、资源或能力，才能继续完成任务
- 支付成功应直接触发后续资源获取或任务执行
- 删除 payment 后，核心 workflow 应明显不成立

自检问题：

> 如果把 payment 这一步删掉，产品是不是基本还能正常工作？

如果答案是“是”，说明支付还不够核心。

---

## 3. Intelligent：Agent 要做有意义的经济决策

Agent 不应只是机械执行付款。

尽量体现：

- 比较多个候选资源 / provider
- 考虑价格、质量、速度、deadline 等因素
- 在预算约束下做 trade-off
- 自主决定买什么、向谁买、花多少钱
- 决策结果会真实影响后续任务

目标：

> 让评委看到 Agent 在“做经济决策”，而不是只在“调用支付 API”。

---

## 4. Defensible：自主支付必须可控、可信

Agent 有自主权，同时要体现 guardrails。

优先考虑：

- Spending limit / budget
- Merchant 或 resource allowlist
- Payment policy
- Duplicate-payment protection
- Idempotency
- Retry without double spending
- `paid` 与 `settled` 状态管理
- Decision log / audit trail
- Transaction proof

核心问题：

> 为什么用户可以放心让这个 Agent 自己花钱？

---

## 5. Sharp Pain：场景必须解决一个具体问题

避免泛化的“万能购物 Agent”。

场景应能清楚回答：

- 用户是谁？
- 用户在什么具体场景下遇到问题？
- 现有方案为什么麻烦、慢或成本高？
- Agent + autonomous payment 为什么明显更好？

一句话应能讲清：

> For [specific user], when [specific situation], the agent solves [specific pain].

---

## 6. Signature Moment：必须有一个能被记住的 Demo 画面

3 分钟 Demo 中要设计一个非常清楚的高光时刻。

理想结构：

1. Agent 面临一个真实任务
2. 出现多个购买选择
3. Agent 基于预算 / deadline / quality 做选择
4. 自主发起 BTC payment
5. Payment 变为 `paid`
6. 资源立即解锁
7. Agent 自动继续并完成任务

目标：

> 即使评委忘记项目名，也能记住“那个会自己判断该把 Bitcoin 花在哪里的 Agent”。

# Hypit 开源代码使用注意事项

目标：在 Hackathon 中把 Hypit 作为内部视频生成能力使用，同时避免违反其许可证限制。https://github.com/hypit-ai

## 1. 可以做的事情

可以：

- 免费使用 Hypit 开源代码
- 自己部署 Hypit
- 修改 Hypit 代码用于自己的项目
- 把 Hypit 作为自己应用的内部 backend capability
- 在单一项目 / 单一 workspace 中调用 Hypit
- 使用 Hypit 生成视频用于 Hackathon Demo
- 商业使用 Hypit 生成的输出内容，但仍需遵守底层第三方模型/API的条款

Hackathon 推荐架构：

User
→ Buyer Agent
→ 发现需要视频生成能力
→ 向内部 Video Seller 支付 BTC
→ Seller 调用 Hypit
→ Hypit 真实生成视频
→ Seller 返回结果
→ Buyer Agent 继续任务

---

## 2. 不要把 Hypit 直接包装成公开 SaaS

Hypit 使用的是修改版 Apache 2.0 License，其中对 hosted service 有额外限制。

未经授权，不要：

- 把 Hypit 部署成面向多个外部用户的 SaaS
- 给多个第三方用户提供独立 workspace
- 提供公开的 “Hypit-as-a-Service”
- 让任意外部 Agent 付钱后调用你的 Hypit 实例
- 直接把 Hypit 本身作为收费产品或组件出售

即使暂时不收费，只要多个外部主体分别使用独立 workspace，也可能属于受限制的 multi-tenant hosted service。

---

## 3. Hackathon 中 Seller 的定位

推荐将 Seller 定义成：

> 我们项目内部的 Video Generation Provider。

不要把产品描述成：

> 一个出售 Hypit 服务的平台。

更好的表达：

> The seller provides a video-generation capability and uses Hypit internally to fulfill the request.

重点展示：

- Agent 自主采购能力
- Bitcoin payment
- Payment 后真实执行服务
- 视频真实生成

而不是把“转售 Hypit”作为商业模式。

---

## 4. Buyer 和 Seller 最好都属于同一个 Hackathon 系统

为了降低许可证风险：

- Buyer Agent 是我们自己的
- Seller 是我们自己的
- Hypit 部署也是我们自己的
- Seller 目前只服务于这个 Demo / 项目
- 不开放成公共第三方服务

因此当前架构属于：

**single-project / internal backend use**

而不是公开经营 Hypit SaaS。

---

## 5. 保留 Hypit 的版权和品牌信息

如果 Hypit 原有代码、UI、CLI、报告或 manifest 中包含：

- Hypit 名称
- Copyright notice
- License notice
- Attribution
- Logo / branding

不要擅自删除或修改许可证要求保留的信息。

如果修改或分发 Hypit 代码，也需要继续遵守原许可证中的 attribution 和 derivative-work 要求。

---

## 6. 区分 Hypit 与第三方模型/API的授权

Hypit 本身免费，不代表整个生成链路免费。

Hypit 可能调用：

- 视频生成模型
- 图片生成模型
- LLM
- TTS / voice API
- 云服务

需要分别检查这些第三方服务的：

- API 费用
- Commercial use policy
- Generated content ownership
- Rate limits
- Redistribution restrictions

Hypit License 不能替代这些第三方条款。

---

## 7. 生成内容的版权风险仍需单独考虑

尤其是我们计划做：

> “复刻爆款视频”

需要避免直接复制受版权保护的内容。

优先设计成：

- 学习视频的结构
- 学习节奏 / hook / shot pattern
- 替换人物
- 替换商品
- 替换文案
- 替换素材
- 重新生成画面和声音

不要把 Demo 做成对原视频素材的直接复制、下载、重新分发。

---

## 8. Submission 中如实说明 Hypit 的角色

建议在 README / Deck 中明确：

> Video generation is powered by the open-source Hypit project, which is self-hosted and used as an internal capability provider in this prototype.

并明确我们自己开发的部分，例如：

- Buyer Agent
- Capability selection logic
- Budget / spending policy
- GoBTC Pay integration
- Seller/payment workflow
- `paid` status handling
- Retry / idempotency
- Agent orchestration

避免给评委造成“整个视频生成系统都是我们自己开发的”这种误解。
