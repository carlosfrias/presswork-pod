import {
  AI_DISCLOSURE_TEXT,
  FORBIDDEN_LISTING_TERMS,
  EXTERNAL_URL_PATTERN,
  SOCIAL_HANDLE_PATTERN,
  OFF_PLATFORM_PHRASES,
} from "@presswork/shared";
import { cn } from "@/lib/cn";

export interface ComplianceChecksProps {
  title: string | null;
  description: string | null;
  tags: string[] | null;
  priceUsd: number | null;
  printCostUsd?: number;
  mockupsFromActualDesign: boolean;
}

interface Check {
  label: string;
  pass: boolean;
  detail?: string;
}

export function runChecks(props: ComplianceChecksProps): Check[] {
  const text = `${props.title ?? ""} ${props.description ?? ""} ${(props.tags ?? []).join(" ")}`;
  // Strip the AI disclosure sentence before forbidden-term checks so legitimate
  // disclosure text doesn't trip on substrings like "hand-selected".
  const textForForbidden = text.replaceAll(AI_DISCLOSURE_TEXT, "").toLowerCase();
  const hasDisclosure = (props.description ?? "").includes(AI_DISCLOSURE_TEXT);
  const forbiddenHit = FORBIDDEN_LISTING_TERMS.find((t) =>
    new RegExp(`(?:^|[^A-Za-z0-9])${t.replaceAll(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?=$|[^A-Za-z0-9])`, "i").test(textForForbidden),
  );
  const urlHit = EXTERNAL_URL_PATTERN.test(text);
  const handleHit = SOCIAL_HANDLE_PATTERN.test(text);
  const phraseHit = OFF_PLATFORM_PHRASES.find((p) => text.toLowerCase().includes(p));
  const priceFloor =
    props.priceUsd != null && props.printCostUsd != null
      ? props.priceUsd >= props.printCostUsd * 2.5
      : true;

  return [
    { label: "AI disclosure present", pass: hasDisclosure },
    {
      label: "No forbidden terms",
      pass: !forbiddenHit,
      detail: forbiddenHit ? `Found: "${forbiddenHit}"` : undefined,
    },
    { label: "No external URLs", pass: !urlHit },
    { label: "No social handles", pass: !handleHit },
    {
      label: "No off-platform phrases",
      pass: !phraseHit,
      detail: phraseHit ? `Found: "${phraseHit}"` : undefined,
    },
    {
      label: "Mockups from actual design",
      pass: props.mockupsFromActualDesign,
    },
    {
      label: "Pricing floor (price ≥ 2.5× print cost)",
      pass: priceFloor,
    },
    { label: "Tags ≤ 13", pass: (props.tags?.length ?? 0) <= 13 },
    {
      label: "Title ≤ 140 chars",
      pass: (props.title?.length ?? 0) > 0 && (props.title?.length ?? 0) <= 140,
    },
  ];
}

export function ComplianceChecks(props: ComplianceChecksProps) {
  const checks = runChecks(props);
  const failed = checks.filter((c) => !c.pass).length;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-(--text-secondary)">Compliance</span>
        <span className={cn("tabular", failed > 0 ? "text-(--accent-bad)" : "text-(--accent-good)")}>
          {failed === 0 ? "all pass" : `${failed} failing`}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {checks.map((c) => (
          <li key={c.label} className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                c.pass ? "bg-(--accent-good)" : "bg-(--accent-bad)",
              )}
            />
            <span className={c.pass ? "text-(--text-muted)" : "text-(--accent-bad)"}>
              {c.label}
            </span>
            {c.detail && (
              <span className="text-(--text-faint) font-mono">— {c.detail}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
