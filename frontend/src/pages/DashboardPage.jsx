import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import KpiCard from "../components/KpiCard";
import OpsRecordsTable from "./OpsRecordsTable";
import { PieCard, TrendChart } from "./DashboardCharts";
import { M5_TABS, TREND_CONFIG, computeKpis, countBy } from "./dashboardShared";
import ConfidentialFooter from "../components/ConfidentialFooter";

const SUBTITLE = "Central Security Operations Management System";

export default function DashboardPage() {
  const { isViewer, isAdmin } = useAuth();

  const [incidents, setIncidents] = useState([]);
  const [sites, setSites] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const [activeType, setActiveType] = useState(M5_TABS[0].type);
  const [reloadKey, setReloadKey] = useState(0);

  const loadData = useCallback(async () => {
    const [inc, siteList] = await Promise.all([
      api("/incidents").catch(() => []),
      api("/meta/sites").catch(() => []),
    ]);
    setIncidents(inc);
    setSites(siteList);
    setLoaded(true);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const kpis = computeKpis(incidents);
  const cfg = M5_TABS.find((t) => t.type === activeType);

  function refresh() {
    loadData();
    setReloadKey((k) => k + 1);
  }

  const actions = <button className="btn btn-outline btn-sm" onClick={refresh}>Refresh</button>;

  return (
    <div className="module-view">
      <ModuleHeader icon="◉" iconBg="var(--blue)" title="Security Operations Dashboard" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Central command center providing real-time visibility across security operations.</PurposeBar>

      <div className="kpi-grid" data-cols="5">
        {kpis.map((k) => (
          <KpiCard key={k.label} label={k.label} value={k.value} note={k.note} tone={k.cls || "neutral"} icon={k.icon} />
        ))}
      </div>

      <div className="chart-grid">
        <PieCard title="Incidents by status" counts={countBy(incidents, "status")} />
        <PieCard title="Incidents by site" counts={countBy(incidents, "site")} />
        <PieCard title="Incidents by classification" counts={countBy(incidents, "classification")} />
        <PieCard title="Incidents by severity" counts={countBy(incidents, "severity")} />
      </div>

      <div className="section-card" style={{ margin: "18px 32px 0" }}>
        <div className="section-head">Trends</div>
        <div className="trend-grid">
          {Object.keys(TREND_CONFIG).map((type) => (
            <TrendChart key={`${type}-${reloadKey}`} type={type} sites={sites} />
          ))}
        </div>
      </div>

      <div className="section-card" style={{ margin: "18px 32px 0" }}>
        <div className="section-head">Operational Records</div>
        <div className="tabs" style={{ margin: 0, padding: "14px 18px 0" }}>
          {M5_TABS.map((t) => (
            <button
              key={t.type}
              className={`tab-btn ${activeType === t.type ? "active" : ""}`}
              onClick={() => setActiveType(t.type)}
            >
              {t.tab}
            </button>
          ))}
        </div>
        <div style={{ padding: "16px 18px" }}>
          {!loaded ? (
            <div className="empty-hint">Loading...</div>
          ) : (
            <OpsRecordsTable
              key={`${activeType}-${reloadKey}`}
              cfg={cfg}
              sites={sites}
              dropdowns={{}}
              isViewer={isViewer}
              isAdmin={isAdmin}
            />
          )}
        </div>
      </div>

      <ConfidentialFooter />
    </div>
  );
}
