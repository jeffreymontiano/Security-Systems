import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/AuthContext";
import ModuleHeader from "../components/ModuleHeader";
import PurposeBar from "../components/PurposeBar";
import OpsRecordsTable from "./OpsRecordsTable";
import { DEPLOYMENT_TABS, DEPLOYMENT_CONFIG, DEPLOYMENT_LIST_KEYS, isOpsRecordTab } from "./deploymentShared";
import DutyDetailOrders from "./DutyDetailOrders";
import ConfidentialFooter from "../components/ConfidentialFooter";

const SUBTITLE = "Manage guard assignments and site coverage across all client locations";

export default function DeploymentPage() {
  const { isViewer, isAdmin } = useAuth();

  const [activeType, setActiveType] = useState(DEPLOYMENT_TABS[0].type);
  const [sites, setSites] = useState([]);
  const [dropdowns, setDropdowns] = useState(null); // null until loaded
  const [reloadKey, setReloadKey] = useState(0);

  const loadReference = useCallback(async () => {
    const [siteList, ...lists] = await Promise.all([
      api("/meta/sites").catch(() => []),
      ...DEPLOYMENT_LIST_KEYS.map((key) =>
        api(`/meta/dropdown/${key}`).then((v) => [key, v]).catch(() => [key, []])
      ),
    ]);
    setSites(siteList);
    setDropdowns(Object.fromEntries(lists));
  }, []);

  useEffect(() => { loadReference(); }, [loadReference]);

  const cfg = DEPLOYMENT_CONFIG[activeType];

  const actions = (
    <button className="btn btn-outline btn-sm" onClick={() => { loadReference(); setReloadKey((k) => k + 1); }}>Refresh</button>
  );

  return (
    <div className="module-view">
      <ModuleHeader icon="📍" iconBg="var(--gold)" title="Deployment & Post Management" subtitle={SUBTITLE} actions={actions} />
      <PurposeBar>Manage guard assignments and site coverage across all client locations.</PurposeBar>

      <div className="section-card" style={{ margin: "18px 32px 0" }}>
        <div className="section-head">Deployment Records</div>
        <div className="tabs" style={{ margin: 0, padding: "14px 18px 0" }}>
          {DEPLOYMENT_TABS.map((t) => (
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
          {dropdowns === null ? (
            <div className="empty-hint">Loading...</div>
          ) : isOpsRecordTab(cfg) ? (
            <OpsRecordsTable
              key={`${activeType}-${reloadKey}`}
              cfg={cfg}
              sites={sites}
              dropdowns={dropdowns}
              isViewer={isViewer}
              isAdmin={isAdmin}
            />
          ) : (
            <DutyDetailOrders key={`${activeType}-${reloadKey}`} sites={sites} />
          )}
        </div>
      </div>

      <ConfidentialFooter />
    </div>
  );
}
