import { useTranslation } from "react-i18next";
import type { Artifact, ChangePlan } from "./api.js";
import { AiBadge, Card, Chip, EnvChip } from "./components.js";

// Artefacts d'une tâche (WORKFLOW.md §6). Ce sont des données écrites par un agent : elles sont
// affichées comme du texte, champ par champ, jamais interprétées comme du HTML.

type Spec = {
  problem: string;
  acceptanceCriteria: { id: string; given: string; when: string; then: string }[];
  outOfScope?: string[];
  assumptions?: string[];
};
type Design = {
  approach: string;
  steps: string[];
  files: { path: string; change: string; why: string }[];
  testPlan: { ac: string; level: string; test: string }[];
  rollback: string;
};
type Review = {
  verdict: string;
  summary: string;
  acVerdicts: { ac: string; status: string; note: string }[];
  findings: { severity: string; file: string; line?: number; comment: string }[];
};
type Triage = {
  type: string;
  size: string;
  estimatedRisk: string;
  ready: boolean;
  questions?: string[];
};

const toneOf = (status: string) =>
  status === "met" || status === "approve"
    ? "ok"
    : status === "missing" ||
        status === "blocker" ||
        status === "major" ||
        status === "request_changes"
      ? "crit"
      : "warn";

function SpecView({ spec }: { spec: Spec }) {
  const { t } = useTranslation();
  return (
    <div className="card-body stack">
      <p className="prose">{spec.problem}</p>
      <table className="table">
        <thead>
          <tr>
            <th>AC</th>
            <th>{t("artifact.given")}</th>
            <th>{t("artifact.when")}</th>
            <th>{t("artifact.then")}</th>
          </tr>
        </thead>
        <tbody>
          {spec.acceptanceCriteria.map((c) => (
            <tr key={c.id}>
              <td className="num">{c.id}</td>
              <td>{c.given}</td>
              <td>{c.when}</td>
              <td>{c.then}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DesignView({ design }: { design: Design }) {
  return (
    <div className="card-body stack">
      <p className="prose">{design.approach}</p>
      <ol className="ink-2" style={{ margin: 0, paddingLeft: 20 }}>
        {design.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <table className="table">
        <tbody>
          {design.files.map((f) => (
            <tr key={f.path}>
              <td>
                <code>{f.path}</code>
              </td>
              <td>
                <Chip>{f.change}</Chip>
              </td>
              <td className="ink-2">{f.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReviewView({ review }: { review: Review }) {
  const { t } = useTranslation();
  return (
    <div className="card-body stack">
      <div>
        <Chip tone={toneOf(review.verdict)}>{t(`status.${review.verdict}`, review.verdict)}</Chip>
      </div>
      <p className="prose">{review.summary}</p>
      <div className="rows">
        {review.acVerdicts.map((a) => (
          <div className="row" key={a.ac}>
            <span className="title num">{a.ac}</span>
            <Chip tone={toneOf(a.status)}>{t(`status.${a.status}`, a.status)}</Chip>
            {a.note && <span className="meta">{a.note}</span>}
          </div>
        ))}
        {review.findings.map((f, i) => (
          <div className="row" key={i}>
            <span className="title">{f.comment}</span>
            <Chip tone={toneOf(f.severity)}>{t(`status.${f.severity}`, f.severity)}</Chip>
            <span className="meta">
              <code>
                {f.file}
                {f.line ? `:${f.line}` : ""}
              </code>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

type ChangePlanContent = ChangePlan & { approvalRequired: boolean };
type PlanReport = {
  outcome: string;
  reason: string | null;
  steps: {
    label: string;
    phase: string;
    status: string;
    exitCode: number | null;
    durationMs: number | null;
  }[];
};

function ChangePlanView({ plan }: { plan: ChangePlanContent }) {
  const { t } = useTranslation();
  return (
    <div className="card-body stack">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <EnvChip environment={plan.environment} />
        <Chip>{plan.server}</Chip>
      </div>
      <p className="prose">{plan.goal}</p>
      <p className="muted">
        {t("plan.impact")} : {plan.impact}
      </p>
      <ol className="ink-2" style={{ margin: 0, paddingLeft: 20 }}>
        {plan.actions.map((a, i) => (
          <li key={i}>
            {a.kind === "command" ? (
              <code>{a.command}</code>
            ) : (
              <code>{`${t("plan.playbook")} ${a.name}`}</code>
            )}
          </li>
        ))}
      </ol>
      <p className="muted">
        {t("plan.verify")} : {plan.verify.join(" · ") || "—"}
      </p>
      <p className="muted">
        {t("plan.rollback")} : {plan.rollback.join(" · ") || "—"}
      </p>
    </div>
  );
}

function PlanReportView({ report }: { report: PlanReport }) {
  const { t } = useTranslation();
  return (
    <div className="card-body stack">
      <div>
        <Chip tone={report.outcome === "succeeded" ? "ok" : "crit"}>
          {t(`status.${report.outcome}`, report.outcome)}
        </Chip>
      </div>
      {report.reason && <p className="prose">{report.reason}</p>}
      <div className="rows">
        {report.steps
          .filter((s) => s.status !== "pending")
          .map((s, i) => (
            <div className="gate" key={i}>
              <span className="id">{s.phase}</span>
              <code style={{ overflowWrap: "anywhere" }}>{s.label}</code>
              <span className="ms">
                {s.durationMs === null ? "" : `${(s.durationMs / 1000).toFixed(1)} s`}
              </span>
              <Chip tone={s.status === "done" ? "ok" : s.status === "failed" ? "crit" : "neutral"}>
                {t(`status.${s.status}`, s.status)}
              </Chip>
            </div>
          ))}
      </div>
    </div>
  );
}

/** Dernière version de chaque artefact utile, dans l'ordre des phases. */
export function ArtifactCards({ artifacts }: { artifacts: Artifact[] }) {
  const { t } = useTranslation();
  const latest = (kind: string) => artifacts.filter((a) => a.kind === kind).at(-1);
  const triage = latest("triage");
  const spec = latest("spec");
  const design = latest("design");
  const review = latest("review");
  const questions = latest("questions");
  const build = latest("build");
  const changePlan = latest("change_plan");
  const planReport = latest("plan_report");
  const diagnosis = latest("diagnosis");
  const title = (label: string, a: Artifact) => (
    <>
      {label} v{a.version} <AiBadge />
    </>
  );
  return (
    <>
      {questions && (
        <Card title={title(t("task.questions"), questions)}>
          <ol className="card-body ink-2" style={{ paddingLeft: 36, margin: 0 }}>
            {(questions.content as { questions: string[] }).questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </Card>
      )}
      {triage && (
        <Card title={title(t("artifact.triage"), triage)}>
          <div className="card-body" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(() => {
              const tr = triage.content as Triage;
              return (
                <>
                  <Chip>{tr.type}</Chip>
                  <Chip>{t("artifact.size", { size: tr.size })}</Chip>
                  <Chip
                    tone={
                      tr.estimatedRisk === "high"
                        ? "crit"
                        : tr.estimatedRisk === "medium"
                          ? "warn"
                          : "neutral"
                    }
                  >
                    {tr.estimatedRisk}
                  </Chip>
                  <Chip tone={tr.ready ? "ok" : "warn"}>
                    {tr.ready ? t("artifact.ready") : t("artifact.not_ready")}
                  </Chip>
                </>
              );
            })()}
          </div>
        </Card>
      )}
      {spec && (
        <Card title={title(t("artifact.spec"), spec)}>
          <SpecView spec={spec.content as Spec} />
        </Card>
      )}
      {design && (
        <Card title={title(t("artifact.design"), design)}>
          <DesignView design={design.content as Design} />
        </Card>
      )}
      {build && (
        <Card title={title(t("artifact.build"), build)}>
          <div className="card-body">
            <p className="prose">{(build.content as { summary: string }).summary}</p>
          </div>
        </Card>
      )}
      {diagnosis && (
        <Card title={title(t("plan.diagnosis"), diagnosis)}>
          <div className="card-body">
            <p className="prose" style={{ whiteSpace: "pre-wrap" }}>
              {(diagnosis.content as { text: string }).text}
            </p>
          </div>
        </Card>
      )}
      {changePlan && (
        <Card title={title(t("plan.title"), changePlan)}>
          <ChangePlanView plan={changePlan.content as ChangePlanContent} />
        </Card>
      )}
      {planReport && (
        <Card title={t("plan.report")}>
          <PlanReportView report={planReport.content as PlanReport} />
        </Card>
      )}
      {review && (
        <Card title={title(t("task.review"), review)}>
          <ReviewView review={review.content as Review} />
        </Card>
      )}
    </>
  );
}
