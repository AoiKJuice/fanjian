import {
  CheckCircle,
  Database,
  Flask,
  Gauge,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import { Metric, PageHeader } from "../../components/ui";

const experiments = [
  { model: "Bayesian Popularity", ndcg: "0.01180", recall: "0.03030", coverage: "0.29%", longtail: "0.08%", selected: false },
  { model: "mean-centered UserKNN", ndcg: "0.04726", recall: "0.07884", coverage: "5.32%", longtail: "0.45%", selected: true },
  { model: "surprise-weighted UserKNN", ndcg: "0.04305", recall: "0.07282", coverage: "11.37%", longtail: "1.18%", selected: false },
  { model: "biased matrix factorization", ndcg: "0.01123", recall: "0.01677", coverage: "13.94%", longtail: "10.99%", selected: false },
];

export default function ResearchPage() {
  return (
    <div className="page">
      <PageHeader
        title="研究视图"
      />
      <div className="research-notice">
        <CheckCircle size={24} weight="duotone" />
        <div>
          <strong>生产模型已通过独立测试集选择</strong>
          <p>surprise-weighted UserKNN 的长尾覆盖更高，但 NDCG@10 比普通 UserKNN 低 8.90%，超过预设容忍线，因此生产选择 mean-centered UserKNN。</p>
        </div>
      </div>
      <div className="metric-strip">
        <Metric value="989,203" label="训练用户" />
        <Metric value="134,143,996" label="训练评分" />
        <Metric value="16,300" label="有评分作品" />
        <Metric value="10,000" label="Bootstrap" />
      </div>
      <section className="section-block">
        <div className="section-heading">
          <div><p className="eyebrow">模型对照</p><h2>最终测试集</h2></div>
          <Flask size={25} weight="duotone" />
        </div>
        <div className="data-table-wrap">
          <table className="data-table research-table">
            <thead>
              <tr><th>模型</th><th>NDCG@10</th><th>Recall@20</th><th>Catalog coverage</th><th>Long-tail coverage</th><th>状态</th></tr>
            </thead>
            <tbody>
              {experiments.map((row) => (
                <tr key={row.model}>
                  <td><strong>{row.model}</strong></td>
                  <td>{row.ndcg}</td><td>{row.recall}</td><td>{row.coverage}</td><td>{row.longtail}</td>
                  <td>{row.selected ? <span className="status-label current">生产</span> : "对照"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="chart-note">评测使用固定 seed 20260727、80/20 用户内留出、每人最多 20 个测试项目，相关项目阈值为评分 ≥ 8。</p>
      </section>
      <div className="research-grid">
        <section className="section-block">
          <div className="section-heading">
            <div><p className="eyebrow">生产超参数</p><h2>mean-centered UserKNN</h2></div>
            <Gauge size={24} weight="duotone" />
          </div>
          <dl className="parameter-list">
            <div><dt>共同评分门槛</dt><dd>5</dd></div>
            <div><dt>相似度收缩 λ</dt><dd>10</dd></div>
            <div><dt>邻居数</dt><dd>50</dd></div>
            <div><dt>相似度范围</dt><dd>仅正相似</dd></div>
            <div><dt>不确定性惩罚 κ</dt><dd>0.50</dd></div>
          </dl>
        </section>
        <section className="section-block">
          <div className="section-heading">
            <div><p className="eyebrow">数据清单</p><h2>版本审计</h2></div>
            <Database size={24} weight="duotone" />
          </div>
          <ul className="audit-list">
            <li><CheckCircle size={18} weight="fill" /><div><strong>评分源文件</strong><p>148,170,496 行；SHA-256 已记录</p></div></li>
            <li><CheckCircle size={18} weight="fill" /><div><strong>重复处理</strong><p>3,384,712 条额外重复记录；冲突使用中位数</p></div></li>
            <li><CheckCircle size={18} weight="fill" /><div><strong>映射完整性</strong><p>训练评分未知 MAL ID 为 0</p></div></li>
            <li><WarningCircle size={18} weight="fill" /><div><strong>授权边界</strong><p>第三方原始数据不随源码分发，商业发布需要复核</p></div></li>
          </ul>
        </section>
      </div>
    </div>
  );
}
