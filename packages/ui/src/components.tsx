import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Fingerprint, Sparkles } from "lucide-react";
import { ApiError, stepUp, type TaskState } from "./api.js";

// Composants propres à Jules (DESIGN.md §7), sur les recettes du skill. Le texte venu d'un agent est
// toujours rendu comme du texte, jamais injecté comme du HTML (test/guards.test.ts le vérifie).

export type Tone = "ok" | "crit" | "warn" | "info" | "violet" | "neutral";

/** Sens des couleurs (DESIGN.md §4) : la même couleur veut toujours dire la même chose. */
export function stateTone(state: TaskState): Tone {
  if (
    [
      "awaiting_info",
      "awaiting_spec_approval",
      "awaiting_design_approval",
      "awaiting_human_review",
      "waiting_provider",
    ].includes(state)
  )
    return "warn";
  if (["blocked", "failed"].includes(state)) return "crit";
  if (state === "done") return "ok";
  if (state === "cancelled") return "neutral";
  return "info";
}

export function Chip({
  tone = "neutral",
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip ${tone === "neutral" ? "" : tone}`} title={title}>
      {children}
    </span>
  );
}

export function StateChip({ state }: { state: TaskState }) {
  const { t } = useTranslation();
  const tone = stateTone(state);
  return (
    <Chip tone={tone}>
      <span
        className={`dot ${tone === "neutral" || tone === "violet" ? "" : tone}`}
        aria-hidden="true"
      />
      {t(`state.${state}`)}
    </Chip>
  );
}

export function RiskChip({ risk }: { risk: "low" | "medium" | "high" | null }) {
  const { t } = useTranslation();
  if (!risk) return null;
  return (
    <Chip tone={risk === "high" ? "crit" : risk === "medium" ? "warn" : "neutral"}>
      {t(`risk.${risk}`)}
    </Chip>
  );
}

export function AiBadge() {
  const { t } = useTranslation();
  return (
    <Chip tone="violet">
      <Sparkles width={12} height={12} aria-hidden="true" />
      {t("task.ai")}
    </Chip>
  );
}

export function Card({
  title,
  icon,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {title !== undefined && (
        <div className="card-head">
          <h2 className="eyebrow" style={{ margin: 0 }}>
            {icon}
            {title}
          </h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Kpi({
  label,
  value,
  sub,
  dominant = false,
  progress,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  dominant?: boolean;
  progress?: { ratio: number };
}) {
  const ratio = progress ? Math.max(0, Math.min(1, progress.ratio)) : 0;
  return (
    <div className={`card kpi ${dominant ? "dominant" : ""}`}>
      <span className="eyebrow">{label}</span>
      <div className="kpi-val num">{value}</div>
      {sub !== undefined && <div className="kpi-sub">{sub}</div>}
      {progress && (
        <div
          className={`progress ${ratio >= 1 ? "crit" : ratio > 0.8 ? "warn" : ""}`}
          role="progressbar"
          aria-label={label}
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
    </div>
  );
}

export function EmptyState({ title, sub, text }: { title: string; sub: string; text: string }) {
  return (
    <div className="empty-state">
      <div>
        <h2>
          {title}
          <br />
          <span>{sub}</span>
        </h2>
        <p>{text}</p>
      </div>
    </div>
  );
}

const PHASES = [
  "triage",
  "spec",
  "design",
  "build",
  "verify",
  "review",
  "qa",
  "human",
  "learn",
] as const;
const PHASE_OF: Partial<Record<TaskState, number>> = {
  received: 0,
  triaging: 0,
  awaiting_info: 0,
  specifying: 1,
  awaiting_spec_approval: 1,
  designing: 2,
  awaiting_design_approval: 2,
  building: 3,
  verifying: 4,
  reviewing: 5,
  awaiting_human_review: 7,
  learning: 8,
  done: 9,
};

/** Les 9 phases : la courante pulse en bleu, une phase qui attend un humain est orange. */
export function PhaseTimeline({ state }: { state: TaskState }) {
  const { t } = useTranslation();
  const current = PHASE_OF[state] ?? -1;
  const waiting = stateTone(state) === "warn";
  return (
    <ol className="phases" aria-label={t("task.phases")}>
      {PHASES.map((phase, index) => {
        const status =
          index < current ? "done" : index === current ? (waiting ? "waiting" : "current") : "todo";
        return (
          <li
            key={phase}
            className={`phase ${status}`}
            aria-current={index === current ? "step" : undefined}
          >
            <div className="bar" />
            <span>
              {index === current && <span className="bullet" aria-hidden="true" />}
              {t(`phase.${phase}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

type Gate = {
  id: string;
  name: string;
  status: "pass" | "fail" | "warn" | "skip" | "pending";
  durationMs: number;
  details: string;
};
const GATE_TONE: Record<Gate["status"], Tone> = {
  pass: "ok",
  fail: "crit",
  warn: "warn",
  skip: "neutral",
  pending: "info",
};

export function GateReport({ results }: { results: Gate[] }) {
  const { t } = useTranslation();
  return (
    <div className="rows" style={{ padding: "0 18px 18px" }}>
      {results.map((g) => (
        <div className="gate" key={g.id}>
          <span className="id">{g.id}</span>
          <span>{g.name}</span>
          <span className="ms">{(g.durationMs / 1000).toFixed(1)} s</span>
          <Chip tone={GATE_TONE[g.status]}>{t(`status.${g.status}`)}</Chip>
          {g.details && (
            <details>
              <summary>{t("artifact.details")}</summary>
              <p className="prose">{g.details}</p>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

/** Diff unifié : ajouts sur fond ok, suppressions sur fond crit, numéros en ink-3. */
export function DiffViewer({ text }: { text: string }) {
  const rows: { kind: string; old: string; neu: string; line: string }[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git")) {
      rows.push({
        kind: "file",
        old: "",
        neu: "",
        line: line.replace(/^diff --git a\/(\S+) b\/\S+$/, "$1"),
      });
    } else if (line.startsWith("@@")) {
      const m = /-(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      oldLine = Number(m?.[1] ?? 0);
      newLine = Number(m?.[2] ?? 0);
      rows.push({ kind: "hunk", old: "", neu: "", line });
    } else if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file")
    ) {
      continue;
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", old: "", neu: String(newLine++), line });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", old: String(oldLine++), neu: "", line });
    } else if (line !== "") {
      rows.push({ kind: "ctx", old: String(oldLine++), neu: String(newLine++), line });
    }
  }
  return (
    <div className="diff" role="region" aria-label="diff" tabIndex={0}>
      <table>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.kind}>
              <td className="ln">{r.old}</td>
              <td className="ln">{r.neu}</td>
              <td>{r.line}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CostMeter({ cost, budget }: { cost: number; budget: number | null }) {
  const { t } = useTranslation();
  const ratio = budget ? cost / budget : 0;
  return (
    <Kpi
      label={t("task.cost")}
      value={`${cost.toFixed(2)} $`}
      sub={budget ? `${t("task.budget")} ${budget.toFixed(0)} $` : undefined}
      {...(budget ? { progress: { ratio } } : {})}
    />
  );
}

/** Dialogue modal natif : le focus reste dedans, Échap le ferme. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="dialog-title">
      <div className="dialog-body">
        <h3 id="dialog-title">{title}</h3>
        {children}
      </div>
      <div className="dialog-actions">{actions}</div>
    </dialog>
  );
}

/**
 * Exécute une action sensible : si l'api demande une passkey, le dialogue s'ouvre, puis l'action est
 * rejouée. Aucune approbation sensible ne se donne d'une seule touche (DESIGN.md §8).
 */
export function useSensitiveAction() {
  const { t } = useTranslation();
  const [pending, setPending] = useState<
    { purpose: string; run: () => Promise<unknown>; resolve: (ok: boolean) => void } | undefined
  >();
  const [error, setError] = useState<string | undefined>();

  const run = (purpose: string, action: () => Promise<unknown>) =>
    new Promise<boolean>((resolve) => {
      action()
        .then(() => {
          resolve(true);
        })
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.stepUp) {
            setError(undefined);
            setPending({ purpose, run: action, resolve });
          } else {
            resolve(false);
            throw e;
          }
        });
    });

  const dialog = (
    <Dialog
      open={pending !== undefined}
      onClose={() => {
        pending?.resolve(false);
        setPending(undefined);
      }}
      title={t("stepup.title")}
      actions={
        <>
          <button
            className="pill"
            onClick={() => {
              pending?.resolve(false);
              setPending(undefined);
            }}
          >
            {t("stepup.cancel")}
          </button>
          <button
            className="pill primary"
            onClick={() => {
              if (!pending) return;
              stepUp(pending.purpose)
                .then(() => pending.run())
                .then(() => {
                  pending.resolve(true);
                  setPending(undefined);
                })
                .catch((e: unknown) => {
                  setError(
                    e instanceof ApiError && e.status === 409
                      ? t("stepup.none")
                      : e instanceof Error
                        ? e.message
                        : String(e),
                  );
                });
            }}
          >
            <Fingerprint aria-hidden="true" />
            {t("stepup.confirm")}
          </button>
        </>
      }
    >
      <p className="ink-2">{t("stepup.text")}</p>
      {error && (
        <p role="alert" className="chip crit">
          {error}
        </p>
      )}
    </Dialog>
  );
  return { run, dialog };
}
