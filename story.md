# Track 2 Demo Storyline

## 核心概念

用户把一个真实的 TikTok 营销任务交给 Agent，并给出：

- 营销目标
- 产品素材
- 参考爆款视频
- Deadline
- 总预算

Agent 不直接依赖预设工具完成所有任务，而是在执行过程中判断自己缺少什么能力，并自主决定是否花钱采购。

当前 Demo 中，Agent 需要购买的是：

> **短视频营销内容生成能力**

Seller 内部使用自托管的 Hypit 来完成真实的视频生成。

---

## Demo 场景

用户是一家小型电商品牌，希望为一个新品制作 TikTok 营销视频。

用户输入类似：

> Create TikTok marketing creatives for this product.
>
> Goal: drive users to the product page.
>
> Deadline: tomorrow.
>
> Total budget: 3,000 sats.
>
> Here is an optional public product image.

Agent 获得：

- Product information
- Product images/assets
- Optional product image
- Marketing objective
- Deadline
- Spending budget

---

## Step 1 — Agent 理解营销任务

Agent 首先分析任务并生成 campaign brief，例如：

- Platform: TikTok
- Goal: product-page clicks
- Format: short-form vertical video
- Creative style: one of the four available production formats
- Deadline: tomorrow
- Budget: 3,000 sats

Agent 可以自行完成：

- 理解产品
- 选择适合目标和预算的制作套餐
- 生成适合该套餐的 hook 和文案
- 制定 creative direction
- 生成文案和营销 brief

---

## Step 2 — Agent 发现能力缺口

Agent 判断：

> 当前可以完成营销策划和创意设计，但缺少真正把参考视频结构转化为新产品营销视频的 production capability。

因此任务无法仅依靠 Agent 当前已有能力完成。

此时产生真实采购需求。

核心逻辑：

**Task**
→ **Plan**
→ **Capability gap detected**
→ **Need to buy external capability**

---

## Step 3 — Agent 评估 Seller 提供的服务

Seller 提供的是具体的营销视频生产服务。

例如：

| Package | Output | Price |
|---|---|---:|
| Basic Remix | 1 video variant | 900 sats |
| Performance Pack | 3 hook variants | 2,200 sats |
| Premium Pack | 5 variants + higher-quality generation | 3,800 sats |

Seller 背后使用：

> Self-hosted Hypit

来真正完成视频生成。

用户购买的是：

> **Video Production Capability**

而不是直接购买 “Hypit API”。

---

## Step 4 — Agent 做经济决策

Agent 根据以下因素自主选择服务：

- Marketing objective
- Budget
- Expected usefulness
- Number of variants
- Quality
- Deadline

例如：

用户预算：

> 3,000 sats

Agent 判断：

- Basic Remix 成本低，但只有一个 Hook，营销测试空间有限
- Premium Pack 超出预算
- Performance Pack 提供多个 Hook variant，同时仍在预算范围内

因此选择：

> **Performance Pack — 2,200 sats**

Agent 显示：

> Three hook variants give us more room to test different creative angles while staying within the campaign budget.

这是整个 Demo 中最重要的 **Agentic Decision**。

---

## Step 5 — Agent 自主支付

Agent：

1. 向 Seller 请求服务
2. Seller 创建 GoBTC Pay payment
3. Agent 使用自己的 Bitcoin wallet 支付
4. 真实发生 BTC mainnet transaction
5. Agent 检测 payment status
6. 当状态变为 `paid` 后自动继续

流程：

**Select service**
→ **Create payment**
→ **BTC payment**
→ **Status = paid**
→ **Unlock service**

整个过程不需要用户再次手动确认。

---

## Step 6 — Seller 真实完成服务

收到 `paid` 后：

Seller
→ 调用内部 self-hosted Hypit
→ 使用用户产品图片 + approved creative brief
→ 真实生成营销视频

例如生成：

- Variant A — pain-point hook
- Variant B — value / offer hook
- Variant C — visual hook

Seller 将真实生成的视频资产返回给 Buyer Agent。

---

## Step 7 — Agent 自动继续完成原始任务

支付和视频生成不是任务终点。

Agent 收到视频后继续完成用户最初的营销任务，例如：

- 整理生成的 creatives
- 标注不同 Hook 的设计目的
- 推荐测试顺序
- 汇总实际支出
- 展示剩余预算
- 输出最终 campaign package

最终结果类似：

> Campaign ready
>
> ✓ 3 TikTok creatives generated
> ✓ 3 different hook strategies
> ✓ Total spend: 2,200 sats
> ✓ Remaining budget: 800 sats
> ✓ Payment verified

---

# 整体 Workflow

**User Intent**

↓

**Agent understands marketing goal**

↓

**Agent analyzes the product goal and supplied image**

↓

**Agent creates campaign plan**

↓

**Agent discovers capability gap**

↓

**Agent evaluates purchasable video-production services**

↓

**Agent chooses service based on budget / value / deadline**

↓

**Agent autonomously pays with Bitcoin**

↓

**Seller detects `paid`**

↓

**Seller uses Hypit to generate real videos**

↓

**Agent receives the assets**

↓

**Agent continues and completes the marketing task**

---

# Story 的核心价值

这不是一个：

> “AI 调用 Hypit 生成视频”

的 Demo。

真正展示的是：

> **An AI agent that can recognize when it lacks a capability, decide whether that capability is worth buying, autonomously pay for it, and continue the original task after fulfillment.**

---

# 三个核心问题

整个产品需要始终回答好：

### 1. Why must the transaction happen?

Agent 缺少完成任务所需的视频 production capability。

不购买该能力，原始营销任务无法完整完成。

---

### 2. Why did the Agent choose this transaction?

Agent 根据：

- Budget
- Marketing objective
- Quality
- Number of variants
- Deadline

进行 trade-off，并选择最合适的服务。

---

### 3. Why can the user trust the Agent to pay autonomously?

用户预先定义：

- Total budget
- Spending limit
- Allowed task scope

Agent 只能在这些政策范围内自主消费。

同时系统保留：

- Payment status
- Transaction proof
- Spending record
- Remaining budget

---

# 3 分钟 Demo 的 Signature Moment

最重要的画面应该是：

> Agent 发现自己缺少视频生产能力
> → 比较不同服务和价格
> → 根据营销目标和预算做出选择
> → 自主支付 Bitcoin
> → `paid`
> → Hypit 开始真实生成视频
> → 视频出现
> → Agent 自动继续完成 campaign

理想效果：

> 即使评委忘记项目名称，也能记住：
>
> **“那个会自己判断该不该花钱购买创作能力，并用 Bitcoin 完成采购的 AI Agent。”**

---

# Hypit 在系统中的定位

Hypit 是：

> **Seller 内部使用的 self-hosted fulfillment engine**

不要把项目描述成：

> “出售 Hypit 服务的平台”

更推荐描述成：

> **The seller provides a video-production capability and uses Hypit internally to fulfill the request.**

Buyer、Seller 和 Hypit 当前都属于同一个 Hackathon prototype 系统。
