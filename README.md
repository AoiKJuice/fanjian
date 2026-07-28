# 番鉴

番鉴是本地运行的番剧评分推荐系统。核心模型根据目标用户与训练用户在共同
作品上的评分残差计算相似度，再从正相似观众喜欢、目标用户未看过的作品中
生成推荐。标签、简介、封面和平台评分不参与亲和度排序。

当前模型包含：

- 134,143,996 条清洗评分；
- 989,203 名训练用户；
- 16,300 部达到评分样本门槛的作品；
- 30,677 个唯一 MAL ID，包含原模型全部 30,308 个 ID，并加入 369 个
  开放目录新增条目；
- surprise-weighted UserKNN、磁盘映射 CSR/CSC 索引和 affinity 校准。

在线入口：[aoikjuice.com/tools/anime-affinity/app](https://aoikjuice.com/tools/anime-affinity/app)。
在线页面只提供界面和安装入口；评分资料、模型查询和推荐计算在用户电脑上
完成。

## Windows 一键运行

要求：

- Windows 10/11；
- Python 3.12；
- Node.js 22.13 或更高版本；
- 首次安装至少 7 GiB 可用空间。

下载源码后双击 `启动番鉴.cmd`。首次运行会：

1. 创建 Python 环境并安装依赖；
2. 从 GitHub Release 下载约 1.48 GiB 的模型文件；
3. 校验分卷及模型内每个文件的 SHA-256；
4. 生成 Web 构建；
5. 启动本机 `127.0.0.1:8000` 推荐 API 和 `127.0.0.1:3000` 页面。

再次启动会直接使用本机模型和构建。停止服务时双击 `停止番鉴.cmd`。
下载中断后可以重新运行，已校验的分卷不会重复下载。需要自定义下载地址时，
将 `FANJIAN_MODEL_MIRROR` 设置为包含模型分卷的目录 URL。

## 命令行启动

```powershell
npm ci
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[test]"
npm run build
npm run api
npm run start
```

浏览器访问 `http://localhost:3000`。API 文档位于
`http://localhost:8000/docs`。

## 目录与模型构建

生产 API 默认读取
`data/processed/anime-model-open-2026-27`。模型下载清单位于
`scripts/model-release.json`。

从本地训练产物重建开放目录：

```powershell
.venv\Scripts\python.exe -m backend.training.build_open_catalog `
  data\processed\anime-model-current `
  data\raw\anime-offline-database\2026-27\anime-offline-database-minified.json.zst `
  data\raw\bangumi-data\0.3.216\package\dist\data.json `
  --output data\processed\anime-model-open-2026-27
```

构建脚本保持原模型 MAL ID 顺序，新增作品只追加到索引末尾。新增作品没有
足够用户评分时可以搜索和评分，但不会被协同过滤模型推荐。

## 验证

```powershell
npm run lint
npm run test
npm run test:e2e
npm run test:api
npm run build
npm audit --omit=dev
```

## 数据与许可

- User Animelist Dataset：CC BY 4.0；
- anime-offline-database 2026-27：ODbL 1.0 + DbCL 1.0；
- bangumi-data 0.3.216：CC BY 4.0。

Bangumi 评分、中文简介和封面地址按当前页面需要通过 Bangumi 官方 API
读取并保存在用户本机，不进入推荐排序。封面二进制文件不随模型分发。

详细说明：

- [数据与授权](docs/DATA.md)
- [模型归属说明](docs/MODEL_ATTRIBUTION.md)
- [模型卡](docs/MODEL_CARD.md)
- [实验执行](docs/EXPERIMENTS.md)
- [隐私](docs/PRIVACY.md)
