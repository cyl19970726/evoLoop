const prefix = "evoloop-preflight-v1:";

type PreflightReport = {
  version: 1;
  code: string;
  category: string;
  actualBytes: number | null;
  limitBytes: number | null;
  source: { kind: string; id: string; revisionId: string | null } | null;
  modelStarted: false;
  nextAction: string;
};

export function preflightPresentation(summary: string): PreflightReport | null {
  if (!summary.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(summary.slice(prefix.length));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const report = value as Partial<PreflightReport>;
    if (report.version !== 1 || typeof report.code !== "string" || typeof report.category !== "string" ||
      report.modelStarted !== false || typeof report.nextAction !== "string") return null;
    return report as PreflightReport;
  } catch { return null; }
}
