# 番鉴

番鉴是本地运行的番剧评分推荐系统。核心模型根据目标用户与训练用户在共同
作品上的评分残差计算相似度，再从正相似观众喜欢、目标用户未看过的作品中
生成推荐。

模型包含：

- 134,143,996 条清洗评分；
- 989,203 名训练用户；
- 16,300 部达到评分样本门槛的作品；

## Windows 一键运行

要求：

- Windows 10/11；
- Python 3.12；
- Node.js 22.13 或更高版本；
- 首次安装至少 7 GiB 可用空间。


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

## 手机浏览器部署

服务器模式由 Nginx 提供网页和原始模型文件，模型下载到浏览器 OPFS，资料、
评分、收藏与推荐历史保存在 IndexedDB，推荐计算由 Web Worker 在设备内执行。
服务器不运行推荐 API。构建参数见 `deploy/docker-compose.web.yml`，模型目录清单
由以下命令生成：

```bash
python scripts/prepare_browser_model.py \
  /opt/fanjian-model/anime-model-open-2026-27 \
  --base-url /tools/anime-affinity/model
```

Nginx 模型下载配置见 `deploy/nginx.browser-model.conf`。

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

## 数据与许可

- User Animelist Dataset：CC BY 4.0；
- anime-offline-database 2026-27：ODbL 1.0 + DbCL 1.0；
- bangumi-data 0.3.216：CC BY 4.0。


详细说明：

- [数据与授权](docs/DATA.md)
- [模型归属说明](docs/MODEL_ATTRIBUTION.md)
- [模型卡](docs/MODEL_CARD.md)
- [实验执行](docs/EXPERIMENTS.md)
- [隐私](docs/PRIVACY.md)
