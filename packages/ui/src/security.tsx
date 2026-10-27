import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fingerprint, ScanSearch, ShieldCheck, ShieldHalf } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  type AuditSummary,
  type Finding,
  type Me,
  type OrgSettings,
  type Repo,
  type SecurityMetrics,
  type Server,
} from "./api.js";
import {
  AiBadge,
  Card,
  Chip,
  EmptyState,
  Kpi,
  useSensitiveAction,
  type Tone,
} from "./components.js";

// Écrans Sécurité (M8, WORKFLOW.md §13) : findings et leur cycle de vie, audits, réglages. Aucune
// valeur secrète n'arrive jusqu'ici : seulement des chemins, des noms et des preuves masquées.

export const SEVERITY_TONE: Record<Finding["severity"], Tone> = {
  critical: "crit",
  high: "crit",
  medium: "warn",
  low: "neutral",
};
const STATUS_TONE: Record<Finding["status"], Tone> = {
  open: "warn",
  triaged: "warn",
  in_remediation: "info",
  resolved: "ok",
  accepted_risk: "neutral",
  false_positive: "neutral",
};
const ACTIVE: Finding["status"][] = ["open", "triaged", "in_remediation"];

function Decision({ finding, onDone }: { finding: Finding; onDone: (message: string) => void }) {
  const { t } = useTranslation();
  const sensitive = useSensitiveAction();
  const [note, setNote] = useState("");
  const [until, setUntil] = useState("");
  const decide = (decision: "accept_risk" | "false_positive" | "reopen") =>
    void sensitive
      .run("accepter un risque", () =>
        api(`/v1/findings/${finding.id}/decision`, {
          method: "POST",
          body: {
            decision,
            note,
            ...(decision === "accept_risk" && until
              ? { until: new Date(`${until}T23:59:59Z`).toISOString() }
              : {}),
          },
        }),
      )
      .then((ok) => {
        if (ok) {
          onDone(t("security.decided"));
        }
      });
  const reopenable = finding.status === "accepted_risk" || finding.status === "false_positive";
  const decidable = finding.status === "open" || finding.status === "triaged";
  if (!reopenable && !decidable) {
    return null;
  }
  return (
    <div className="stack" style={{ gridColumn: "1 / -1" }}>
      <input
        className="field"
        aria-label={t("security.note")}
        placeholder={t("security.note")}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {decidable && (
          <>
            <input
              className="field"
              type="date"
              aria-label={t("security.until_label")}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              style={{ maxWidth: 180 }}
            />
            <button
              className="pill sm"
              disabled={note.trim().length < 3 || !until}
              onClick={() => decide("accept_risk")}
            >
              <Fingerprint aria-hidden="true" />
              {t("security.accept")}
            </button>
            <button
              className="pill sm"
              disabled={note.trim().length < 3}
              onClick={() => decide("false_positive")}
            >
              {t("security.false_positive")}
            </button>
          </>
        )}
        {reopenable && (
          <button
            className="pill sm"
            disabled={note.trim().length < 3}
            onClick={() => decide("reopen")}
          >
            {t("security.reopen")}
          </button>
        )}
      </div>
      {decidable && <span className="muted">{t("security.accept_help")}</span>}
      {sensitive.dialog}
    </div>
  );
}

function FindingRow({
  finding,
  me,
  onDecided,
}: {
  finding: Finding;
  me: Me;
  onDecided: (message: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const overdue =
    finding.dueAt !== null &&
    ACTIVE.includes(finding.status) &&
    new Date(finding.dueAt) < new Date();
  const canDecide = me.role === "admin" || me.role === "maintainer";
  return (
    <div className="row">
      <span className="title">{finding.title}</span>
      <Chip tone={SEVERITY_TONE[finding.severity]}>{t(`severity.${finding.severity}`)}</Chip>
      <span className="meta">
        <Chip tone={STATUS_TONE[finding.status]}>{t(`status.${finding.status}`)}</Chip>
        <Chip>
          {t(`scope.${finding.scope}`)} · {finding.target}
        </Chip>
        <code>{finding.component}</code>
        <span>{finding.scanner}</span>
        {finding.dueAt && ACTIVE.includes(finding.status) && (
          <span>
            {t("security.due")} {new Date(finding.dueAt).toLocaleDateString(i18n.language)}
          </span>
        )}
        {overdue && <Chip tone="crit">{t("security.overdue_chip")}</Chip>}
        {finding.acceptedUntil && (
          <span>
            {t("security.until")}{" "}
            {new Date(finding.acceptedUntil).toLocaleDateString(i18n.language)}
          </span>
        )}
        {finding.falsePositiveSuggested && <Chip tone="violet">{t("security.fp_suggested")}</Chip>}
      </span>
      <p className="muted" style={{ gridColumn: "1 / -1", margin: 0 }}>
        {finding.evidence}
      </p>
      {finding.analysis && (
        <p className="ink-2" style={{ gridColumn: "1 / -1", margin: 0 }}>
          <AiBadge /> {finding.analysis}
        </p>
      )}
      {canDecide && (
        <Decision
          finding={finding}
          onDone={(message) => {
            // Le finding peut quitter la liste affichée : la confirmation vit au niveau de la carte.
            onDecided(message);
            void client.invalidateQueries({ queryKey: ["findings"] });
          }}
        />
      )}
    </div>
  );
}

function AuditLauncher() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<Repo[]>("/v1/repos") });
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api<Server[]>("/v1/servers") });
  const [target, setTarget] = useState("platform");
  const [notice, setNotice] = useState<string | undefined>();
  const launch = () => {
    const [scope, targetId] = target.split(":");
    void api("/v1/audits", {
      method: "POST",
      body: { scope, ...(targetId ? { targetId } : {}) },
    }).then(() => {
      setNotice(t("security.audit_sent"));
      void client.invalidateQueries({ queryKey: ["audits"] });
    });
  };
  return (
    <div className="card-body stack">
      <select
        className="field"
        aria-label={t("security.target")}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value="platform">{t("security.audit_platform")}</option>
        {(repos.data ?? []).map((r) => (
          <option key={r.id} value={`repo:${r.id}`}>
            {t("scope.repo")} · {r.fullName}
          </option>
        ))}
        {(servers.data ?? []).map((s) => (
          <option key={s.id} value={`server:${s.id}`}>
            {t("scope.server")} · {s.name}
          </option>
        ))}
      </select>
      <button className="pill primary" style={{ alignSelf: "flex-start" }} onClick={launch}>
        <ScanSearch aria-hidden="true" />
        {t("security.audit")}
      </button>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

export function SecurityPage({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const [filter, setFilter] = useState<"active" | "all" | "resolved">("active");
  const [decided, setDecided] = useState<string | undefined>();
  const findings = useQuery({
    queryKey: ["findings"],
    queryFn: () => api<Finding[]>("/v1/findings"),
  });
  const metrics = useQuery({
    queryKey: ["findings", "metrics"],
    queryFn: () => api<SecurityMetrics>("/v1/security/metrics"),
  });
  const audits = useQuery({
    queryKey: ["audits"],
    queryFn: () => api<AuditSummary[]>("/v1/audits"),
  });
  const m = metrics.data;
  const list = (findings.data ?? []).filter((f) =>
    filter === "all"
      ? true
      : filter === "resolved"
        ? f.status === "resolved"
        : ACTIVE.includes(f.status),
  );
  const canAudit = me.role === "admin" || me.role === "maintainer";
  return (
    <div className="stack">
      <h1 className="headline">{t("security.title")}</h1>
      <div className="kpi-row">
        <Kpi
          dominant
          label={t("security.open_serious")}
          value={m ? m.openBySeverity.critical + m.openBySeverity.high : "…"}
          sub={
            m
              ? `${t("severity.critical")} ${m.openBySeverity.critical} · ${t("severity.high")} ${m.openBySeverity.high}`
              : undefined
          }
        />
        <Kpi
          label={t("security.overdue")}
          value={m?.overdueShare === null || !m ? "—" : `${Math.round(m.overdueShare * 100)} %`}
        />
        <Kpi
          label={t("security.fix_time")}
          value={
            m?.meanDaysToFix.high === null || !m
              ? "—"
              : t("security.days", { value: m.meanDaysToFix.high })
          }
        />
        <Kpi label={t("security.reopened")} value={m ? m.reopened : "…"} />
      </div>
      <div className="grid-2">
        <Card
          title={t("security.findings")}
          icon={<ShieldHalf aria-hidden="true" />}
          actions={
            <div className="seg" role="group" aria-label={t("security.findings")}>
              {(["active", "all", "resolved"] as const).map((f) => (
                <button
                  key={f}
                  className={filter === f ? "on" : ""}
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {t(`security.${f}`)}
                </button>
              ))}
            </div>
          }
        >
          <div className="card-body rows">
            {decided && <p role="status">{decided}</p>}
            {list.length === 0 && (
              <EmptyState
                title={t("security.empty")}
                sub={t("security.empty_sub")}
                text={t("security.empty_text")}
              />
            )}
            {list.map((finding) => (
              <FindingRow key={finding.id} finding={finding} me={me} onDecided={setDecided} />
            ))}
          </div>
        </Card>
        <div className="stack">
          {canAudit && (
            <Card title={t("security.audit")} icon={<ScanSearch aria-hidden="true" />}>
              <AuditLauncher />
            </Card>
          )}
          <Card title={t("security.audits")} icon={<ShieldCheck aria-hidden="true" />}>
            <div className="card-body rows">
              {(audits.data ?? []).map((a) => (
                <div className="row" key={a.id}>
                  <span className="title">
                    {t(`scope.${a.scope}`, a.scope)} · {a.target}
                  </span>
                  <Chip
                    tone={a.status === "succeeded" ? "ok" : a.status === "failed" ? "crit" : "info"}
                  >
                    {t(`status.${a.status}`, a.status)}
                  </Chip>
                  <span className="meta">
                    <span>{a.trigger}</span>
                    <span>{new Date(a.createdAt).toLocaleString(i18n.language)}</span>
                    {a.summary.active !== undefined && (
                      <span>{t("security.active_count", { count: a.summary.active })}</span>
                    )}
                    {a.error && <span>{a.error}</span>}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

/** Réglages de l'organisation : approbation de la production et niveau de l'agent Sécurité (passkey). */
export function OrgSettingsCard() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const sensitive = useSensitiveAction();
  const settings = useQuery({
    queryKey: ["settings", "org"],
    queryFn: () => api<OrgSettings>("/v1/settings/org"),
  });
  const s = settings.data;
  const patch = (body: Partial<OrgSettings>) =>
    void sensitive
      .run("modifier les réglages de l'organisation", () =>
        api("/v1/settings/org", { method: "PATCH", body }),
      )
      .then(() => client.invalidateQueries({ queryKey: ["settings", "org"] }));
  const toggle = (
    label: string,
    help: string,
    value: boolean | undefined,
    key: "fourEyes" | "githubProductionApproval",
  ) => (
    <div className="stack" style={{ gap: 6 }}>
      <span>{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {([true, false] as const).map((v) => (
          <button
            key={String(v)}
            className={value === v ? "on" : ""}
            aria-pressed={value === v}
            onClick={() => patch({ [key]: v })}
          >
            {v ? t("org.on") : t("org.off")}
          </button>
        ))}
      </div>
      <span className="muted">{help}</span>
    </div>
  );
  return (
    <Card title={t("org.title")} icon={<Fingerprint aria-hidden="true" />}>
      <div className="card-body stack">
        {toggle(t("org.four_eyes"), t("org.four_eyes_help"), s?.fourEyes, "fourEyes")}
        {toggle(
          t("org.github_prod"),
          t("org.github_prod_help"),
          s?.githubProductionApproval,
          "githubProductionApproval",
        )}
        <div className="stack" style={{ gap: 6 }}>
          <span>{t("org.security_level")}</span>
          <div className="seg" role="group" aria-label={t("org.security_level")}>
            {(["S0", "S1"] as const).map((level) => (
              <button
                key={level}
                className={s?.securityLevel === level ? "on" : ""}
                aria-pressed={s?.securityLevel === level}
                onClick={() => patch({ securityLevel: level })}
              >
                {level}
              </button>
            ))}
          </div>
        </div>
        {sensitive.dialog}
      </div>
    </Card>
  );
}
