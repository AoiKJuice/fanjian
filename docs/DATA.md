# 数据与授权

## 评分矩阵

训练数据来自
[User Animelist Dataset](https://www.kaggle.com/datasets/ramazanturann/user-animelist-dataset)。
数据集版本 1 标注为 CC BY 4.0。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `ratings.csv` | 2,254,824,347 | `2ee00f83262cd4cdb2d4a0f1661545307ccc956b01314df0d5e5232433339e68` |
| `animes.csv` | 10,816,239 | `5bec78930e6e7633156046338947954c7e619d9615116bec13d9fc4e04221175` |

148,064,215 条 1 至 10 分的有效原始评分经过以下处理：

- 同一用户和作品的重复评分取中位数；
- 用户至少有 20 条有效评分；
- 用户评分标准差至少为 0.5；
- 用户至少使用三个整数评分区间；
- 核心推荐作品至少有 20 名合格用户评分。

清洗后模型包含 134,143,996 条评分、989,203 名用户和 16,300 部达到
样本门槛的作品。评分矩阵中的未知作品映射数为 0。

## 开放作品目录

公开运行包的目录来自
[anime-offline-database 2026-27](https://github.com/manami-project/anime-offline-database/releases/tag/2026-27)，
许可为 ODbL 1.0 + DbCL 1.0。

下载文件：

- 文件：`anime-offline-database-minified.json.zst`
- 字节数：6,033,918
- SHA-256：`5672cef0fd729a7f7810fc9cf7d54007612aee83fbcf44dd370359c82db6373a`

该版本包含 30,570 个 MAL ID。构建程序保留旧模型全部 30,308 个 MAL ID
及其索引顺序，再加入 369 个新 ID；107 个旧 ID不在该开放目录版本中，
仍保留 ID 和基础标题。最终目录为 30,677 个唯一、非空 MAL ID。

目录中保存标题、格式、年份、集数、状态、标签、来源评分汇总和远程图片
URL。图片文件不进入运行包。目录新增作品的评分计数为 0，不会被模型伪造
为可推荐作品。

## 中文标题与 Bangumi

[bangumi-data 0.3.216](https://www.npmjs.com/package/bangumi-data)
按 CC BY 4.0 提供。本次文件 SHA-256 为
`2a09af88c283987a4fdf2e6120d8da1fe6dad63b7619e1145c34ac0a042f1cb4`。

构建结果包含 8,078 个唯一 Bangumi subject ID 到 MAL ID 的直接映射。
该映射用于：

- 显示中文和原文标题；
- 导入用户主动指定的 Bangumi 收藏；
- 读取当前推荐或详情页需要的 Bangumi 评分、中文简介和封面地址。

Bangumi 评分和简介通过官方 `GET /v0/subjects/{subject_id}` 接口读取，
遵循 `Retry-After`，并保存在用户本机 SQLite。第三方作品评分快照、
Bangumi 用户名和评论文本不随模型分发。

## 不进入公开运行包的数据

- Anime Dataset 2025：许可含非商业和相同方式共享约束；
- Tenrai 全量快照：服务条款不允许把响应重新发布为相似原始数据服务；
- Bangumi15M：公开下载的再分发许可不明确；
- 巴哈姆特逐用户评分：没有足够明确的公开再分发许可；
- 封面图片二进制文件和第三方简介快照。

这些数据不参与本次 GitHub Release 中的生产模型。保留在本地研究目录中的
历史文件也不会进入 Git。

## 运行文件

公开运行模型未包含原始 CSV、清洗 Parquet、矩阵分解训练权重和评测中间
文件。运行必需文件解压后共 3,243,438,915 字节，压缩分卷为
1,583,894,846 字节。`scripts/model-release.json` 记录分卷和每个运行文件
的 SHA-256。
