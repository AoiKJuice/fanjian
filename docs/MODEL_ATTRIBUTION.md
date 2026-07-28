# 番鉴模型数据说明

模型中的用户—作品评分矩阵来自 User Animelist Dataset，原数据集标注为
CC BY 4.0。模型对原始评分执行了去重、用户过滤、作品过滤、偏差校准、
残差计算和稀疏索引转换。

- 数据集：https://www.kaggle.com/datasets/ramazanturann/user-animelist-dataset
- 许可：https://creativecommons.org/licenses/by/4.0/
- 变更：148,064,215 条有效原始评分清洗为 134,143,996 条评分；
  重复用户—作品组合取中位数；过滤评分过少、标准差过低或评分区间不足的用户。

番剧目录来自 anime-offline-database 2026-27，按 ODbL 1.0 和 DbCL 1.0
提供。公开目录保留原模型全部 MAL ID，并加入该版本中的新增 MAL ID。

- 数据库：https://github.com/manami-project/anime-offline-database
- 许可：https://github.com/manami-project/anime-offline-database/blob/2026-27/LICENSE
- 变更：提取 MAL ID、标题、格式、年份、集数、状态、标签、评分汇总和图片 URL；
  保持训练索引中原有 MAL ID 的顺序。

Bangumi 与 MAL 的 ID 对照及中文标题来自 bangumi-data 0.3.216，按
CC BY 4.0 提供。

- 数据包：https://www.npmjs.com/package/bangumi-data
- 许可：https://creativecommons.org/licenses/by/4.0/
- 变更：只保留同时具有 Bangumi subject ID 和 MAL ID 的动画记录。

Bangumi 评分、中文简介和封面地址不包含在模型文件中。应用只在用户打开
推荐或详情时，通过 Bangumi 官方 API 读取所需条目并保存在用户本机。

封面图片本身可能受第三方版权保护。本模型只保存来源数据库提供的远程 URL，
不分发图片文件。
