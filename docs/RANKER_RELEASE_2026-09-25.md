# 浏览器推荐模型 2026-09-25

版本：`ease-risk-lambdamart-2026-09-25`。替换线上浏览器版 UserKNN 排序，
保留旧版读取能力和旧 Release。Windows Python API 的兼容模型没有随此发布替换。

## 冻结的算法

- 80,000 名关系训练用户建立完整精度 EASE 与三个条件评分矩阵；
  16,000 名独立用户训练风险模型和 LambdaMART，4,000 名审计用户不参与训练。
- 高分输入 ≥8，低分输入 ≤4；没有受支持的高分作品时返回空结果。
- 从符合排除、格式、年份及关联作品条件的目录中选 EASE 前 500 个候选，
  每个标题系列一个代表，再按 `0.7*z(EASE-0.3*risk)+0.3*z(LambdaMART)` 排序。
- 使用 `avoid_low` 200 棵树，原始 float32 矩阵与完整树阈值；没有压缩、重新训练或个人调参。
- 关系矩阵覆盖 10,105 部作品，搜索目录保留 30,677 部作品。
- 训练评分数指关系训练阶段的实际观察数，训练用户数为关系和排序训练用户总计 96,000。

排序分不是喜欢概率；界面按“排序分”显示，不再使用旧模型的亲和度 60 门槛。
支持数为作品在关系训练资料中的评分数，不虚构相似用户、证据作品或评分分布。
新版不提供校准后的置信度。已有“不感兴趣”和已记录作品继续排除。
Bangumi 实时评分筛选沿用主分支现有实现。

## 效果和限制

固定模型在另 1,200 名独立确认用户上，相对此前的压缩风险候选，
前 10 已知低分命中 173→154，Recall@20 均值提高约 0.64%；
相对完整精度风险模型 Recall 仍下降约 1.65%。这是历史留出结果，不能视为未来满意度保证。
原始更严格的零召回损失门槛未通过；该模型在另立并预先固定的有界损失确认协议下通过。

个人历史资料只用于用户要求的说明性比较，没有参与训练、选模或调参；不随模型发布。

## 发布验证

- 浏览器算法与 Python 参考输出核对 3,600 份独立确认资料及 12 份个人对照资料，
  在保持相同评分输入顺序时，前 100 名逐项一致。
- float32 的求和与标准差保持 NumPy 的运算规则；输入顺序会影响末位舍入，
  JavaScript 对象按数字键顺序提供评分。比较时必须使用相同输入顺序。
- 真正的生产 Web Worker 在 Chrome 中验证完整文件下载及 SHA-256 校验、OPFS 持久化、
  续作过滤、前 100 名、分页和无高分输入时的空结果。
- `npm test` 与生产构建通过。完整 `tsc --noEmit` 仍受已有的一个测试数据类型缺项及
  Cloudflare 全局类型缺失影响；本次修改的推荐程序没有新增类型错误。

验证工具：`scripts/verify_ranker.mjs` 与 `scripts/verify_ranker_browser.mjs`。
验证资料是本地输入，不能上传到公共仓库。发布包只有共享模型参数、目录和来源哈希。

## 打包与部署

导出依赖原项目 Python 环境与 LightGBM 4.7.0：

```powershell
python scripts/package_ranker.py --artifact PATH_TO_ORIGINAL_CATALOG --source PATH_TO_FROZEN_RISK_MODEL --ranker PATH_TO_FROZEN_RANKER --output release/ranker-20260925 --base-url https://github.com/AoiKJuice/fanjian/releases/download/model-2026-09-25
```

将输出文件作为 GitHub Release 附件，`browser-model-manifest.json` 同时保存为仓库的
`scripts/ranker-release.json`。每个模型文件有独立 SHA-256。遵循原有
[数据许可和归属](MODEL_ATTRIBUTION.md)，没有新增个人数据来源。

服务器文件目录 `/opt/fanjian-model/ranker-20260925/`。
生成 `browser-model-manifest.server.json`，只把每个文件的 `url` 改为
`/tools/anime-affinity/model/releases/model-2026-09-25/<文件名>`，保留大小与哈希。
`/opt/fanjian-model/current` 指向发布目录，Nginx 使用 `deploy/nginx.browser-model.conf`。
所有文件校验、Web 容器预检通过后才更新线上容器和清单。

老用户重新打开网页后会看到模型下载提示，需要下载新版共享模型；本机评分、收藏和
推荐历史仍在原 IndexedDB 中。旧 OPFS 文件保留，不能把清理用户个人资料当作模型升级步骤。
恢复旧版时，恢复旧容器和更新前的 Nginx 模型清单配置即可。
