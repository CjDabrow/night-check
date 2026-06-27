// Finding model for the Night Check reviewer. Each static analyzer returns these,
// and both the web app and the CLI render them.

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL";

// Pillars we map Midnight findings onto: CONTRACT->SMART_LOGIC,
// PROOF_SERVER->INFRASTRUCTURE, SDK->WEB3.
export type Pillar = "SMART_LOGIC" | "INFRASTRUCTURE" | "WEB3";

export type Domain = "CONTRACT" | "PROOF_SERVER" | "SDK";

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface Finding {
  id: string;
  domain: Domain;
  pillar: Pillar;
  title: string;
  description: string;
  severity: Severity;
  /** Our vulnerability-taxonomy reference, e.g. "3.6 (ownPublicKey auth trap)". */
  taxonomyClass?: string;
  /** file:line + the offending snippet. */
  evidence?: string;
  line?: number;
  recommendation?: string;
  confidence: Confidence;
}

export interface AuditInput {
  contractSource?: string;
  contractFilename?: string;
  proofServerConfig?: string;
  sdkSource?: string;
}

export interface AuditSummary {
  total: number;
  bySeverity: Record<Severity, number>;
  byDomain: Record<Domain, number>;
}

export interface AuditResult {
  findings: Finding[];
  summary: AuditSummary;
  durationMs: number;
  /** which analyzers ran. */
  analyzers: string[];
  engineVersion: string;
}

export const SEVERITY_ORDER: Severity[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFORMATIONAL",
];

export function emptySummary(): AuditSummary {
  return {
    total: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFORMATIONAL: 0 },
    byDomain: { CONTRACT: 0, PROOF_SERVER: 0, SDK: 0 },
  };
}
