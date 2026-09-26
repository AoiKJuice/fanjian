# 番鉴

番鉴是本地运行的番剧评分推荐系统。浏览器版使用 EASE、低评分风险模型与
LambdaMART 组合排序，评分资料仍只保存在用户设备内。当前版本为
`ease-risk-lambdamart-2026-09-25`，模型下载约 1.66 GB，按行读取以控制内存。
所有用户共用冻结参数，没有按个人资料训练或调参。

最新浏览器模型见 [model-2026-09-25](https://github.com/AoiKJuice/fanjian/releases/tag/model-2026-09-25)，
文件大小、SHA-256 和下载地址见 `scripts/ranker-release.json`。
算法范围、验证与部署方式见 [模型发布说明](docs/RANKER_RELEASE_2026-09-25.md)。

以下 Windows Python API 启动方式仍使用兼容的旧 UserKNN 模型，
其下载清单为 `scripts/model-release.json`。两套模型版本分别标识，不混用文件。

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

服务器模式由 Nginx 提供网页和模型清单；模型大文件由 Cloudflare Worker 从
GitHub Release 流式传输，不占用网页服务器的出站带宽。
模型下载到浏览器 OPFS，资料、
评分、收藏与推荐历史保存在 IndexedDB，推荐计算由 Web Worker 在设备内执行。
服务器不运行推荐 API。构建参数见 `deploy/docker-compose.web.yml`，模型目录清单
旧 UserKNN 目录可由以下命令生成；新版发布步骤见上述发布说明：

```bash
python scripts/prepare_browser_model.py \
  /opt/fanjian-model/anime-model-open-2026-27 \
  --base-url https://fanjian-model.pjjzxcvbnm.workers.dev \
  --catalog-url-path catalog.json
```

新版模型 Worker 见 `deploy/cloudflare-ranker-worker.js`，部署命令为
`npx wrangler deploy -c deploy/wrangler.ranker.jsonc`。它只匹配新版模型下载路径，
不修改原有社区数据 Worker。原 UserKNN Worker 见 `deploy/cloudflare-model-worker.js`。
Nginx 配置见 `deploy/nginx.browser-model.conf`；保留的服务器模型目录仅用于故障恢复，
正常下载由 Cloudflare 路由直接处理；Nginx 不提供模型大文件。

“设置 → 数据与模型”按行显示正式发布的模型。模型下载支持暂停、继续和取消；
文件直接写入浏览器 OPFS，刷新或网络中断后从保存的位置继续。完整下载会核对
SHA-256，校验通过后才允许使用。取消只清除所选版本未完成的下载。
多个版本可同时保存在此设备，已下载版本可以离线切换；下载其他版本不会替换
当前模型。原有本地安装会自动识别，不复制大文件，不要求重新下载。

版本目录见 `app/lib/model-releases.json`，添加正式版本时更新目录并重新构建网页、
部署模型 Worker。当前选择和安装状态保存在本地，读取状态及推荐计算不请求服务器。

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
