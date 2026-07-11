---
name: tiktok-mate-execute-job
description: 'TikTok Mate 操作执行流程。Use when: 向系统提交操作指令、查看操作执行结果、处理操作超时或失败'
user-invocable: true
---

# TikTok Mate 操作执行

## 适用场景
- 向 TikTok Mate 发出操作指令（采集、互动、导航等）
- 等待操作执行完毕并获取结果
- 操作超时或失败时的处理

## 流程步骤

### 1. 发起操作

通过 `startJob` 工具发起操作：

```
工具: startJob
参数:
  jobName: string (必填)  — 要执行的操作名称
  jobArgs: object (可选)  — 操作所需的额外参数
  jobAccount: string (可选) — 指定用哪个 TikTok 账号执行
```

**可执行的操作列表**（通过 `alive` 查看最新列表）：

| 操作名称 | 说明 |
|----------|------|
| `getAccountInfo` | 获取账号个人资料（bio、粉丝数、点赞数） |
| `getItemInfo` | 获取当前视频详情（播放、点赞、评论、分享） |
| `gotoFeed` | 进入首页 Feed 流 |
| `gotoNext` | 切换到下一个视频 |
| `hitLike` | 点赞当前视频 |
| `hitFav` | 收藏当前视频 |
| `hitFollow` | 关注当前创作者 |

**示例**：
```
startJob(jobName="getAccountInfo", jobAccount="userA")
→ 系统返回操作已接收，开始执行
```

### 2. 查看操作结果

调用 `getJob` 工具，传入操作 ID 来查询执行状态：

```
工具: getJob
参数:
  jobId: string (必填)  — 操作 ID
```

**等待方式**：
- 建议每 1~2 秒自动检查一次
- 最长等待 120 秒
- 状态变为「成功」或「失败」即结束等待

### 3. 解读操作结果

操作完成后，根据状态处理：

| 状态 | 含义 | 处理方式 |
|--------|------|----------|
| 成功 (succeed) | 操作顺利完成 | 读取返回的数据 |
| 失败 (failed) | 操作执行出错 | 查看错误信息 |
| 等待中 (queued) | 排队等待执行 | 继续等待 |
| 执行中 (running) | 正在执行 | 继续等待 |

**成功时的返回示例**：
```json
{
  "status": "succeed",
  "data": { "bio": "...", "followers": 1000, "likes": 5000 }
}
```

## 故障排查

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 操作一直排队中 | 没有在线浏览器扩展来执行 | 先用 `alive` 检查是否有在线账号 |
| 操作状态为失败 | 执行过程中出错 | 查看返回的错误信息 |
| 操作 ID 无效 | ID 错误或已过期 | 确认操作 ID 是否正确 |
| 操作超时 | 执行超过 120 秒 | 重新提交或检查浏览器扩展状态 |

## 参考

- 工具: `startJob` — 发起操作
- 工具: `getJob` — 查询操作结果
- 工具: `alive` — 查看可用的操作列表和在线账号
- [技术设计文档](../../TECHNICAL_DESIGN.md)
