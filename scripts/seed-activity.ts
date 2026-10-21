import dotenv from "dotenv";

dotenv.config({ quiet: true });

// Run after `npm run db:seed`. Everything goes through the HTTP API, so audit logs,
// pool debits, wallet credits, and reputation all come from the real services.
const API = process.env.SEED_API_URL || "http://localhost:5000/api/v1";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "Admin@12345";
const DEMO_PASSWORD = "Demo@12345";

type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type Session = { token: string; userId: string };
type Program = { id: string; title: string; poolBalance: number };

class RequestFailed extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.token && { Authorization: `Bearer ${opts.token}` }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json()) as { message: string; data: T; errors?: { code?: string }[] };
  if (!res.ok) {
    throw new RequestFailed(
      res.status,
      json.errors?.[0]?.code,
      `${method} ${path}: ${res.status} ${json.message}`,
    );
  }
  return json.data;
}

async function login(email: string, password: string): Promise<Session> {
  const data = await call<{ accessToken: string; user: { id: string } }>("POST", "/auth/login", {
    body: { email, password },
  });
  return { token: data.accessToken, userId: data.user.id };
}

async function ensureAccount(email: string, name: string, role: "RESEARCHER" | "PROGRAM_OWNER") {
  try {
    await call("POST", "/auth/register", { body: { email, name, role, password: DEMO_PASSWORD } });
  } catch (error) {
    if (!(error instanceof RequestFailed && error.status === 409)) throw error;
  }
  return login(email, DEMO_PASSWORD);
}

const dollars = (amount: number) => amount * 100;

const RULES =
  "Test only against accounts you own. Stop and report as soon as you can read another " +
  "customer's data. No denial-of-service or social engineering.";

type ProgramSpec = {
  title: string;
  description: string;
  inScope: string[];
  outOfScope: string[];
  tiers: [number, number, number, number];
  // Statuses to walk through after the tiers are set. DRAFT is the starting point.
  path: ("ACTIVE" | "PAUSED" | "CLOSED")[];
};

async function createProgram(owner: Session, spec: ProgramSpec) {
  const isLive = spec.path.at(-1) === "ACTIVE";
  const program = await call<Program>("POST", "/programs", {
    token: owner.token,
    body: {
      title: spec.title,
      description: spec.description,
      scope: {
        inScope: spec.inScope,
        outOfScope: spec.outOfScope,
        ...(isLive && { rules: RULES }),
      },
    },
  });
  const [low, medium, high, critical] = spec.tiers.map(dollars);
  await call("PUT", `/programs/${program.id}/reward-tiers`, {
    token: owner.token,
    body: {
      tiers: [
        { severity: "LOW", amount: low },
        { severity: "MEDIUM", amount: medium },
        { severity: "HIGH", amount: high },
        { severity: "CRITICAL", amount: critical },
      ],
    },
  });
  for (const status of spec.path) {
    await call("PATCH", `/programs/${program.id}/status`, {
      token: owner.token,
      body: { status },
    });
  }
  return program;
}

type Writeup = { summary: string; steps: string[]; impact: string };

const writeup = (r: Writeup) =>
  [
    "## Summary",
    r.summary,
    "",
    "## Steps to reproduce",
    ...r.steps.map((step, i) => `${i + 1}. ${step}`),
    "",
    "## Impact",
    r.impact,
  ].join("\n");

type TriageStep = {
  status: "TRIAGING" | "NEEDS_INFO" | "ACCEPTED" | "REJECTED" | "DUPLICATE";
  severity?: Severity;
  note?: string;
  duplicateOf?: number;
};

type ReportSpec = {
  researcher: "riley" | "sam" | "priya";
  program: "WEB" | "MOB" | "NWC";
  title: string;
  writeup: Writeup;
  triage: TriageStep[];
  reward?: boolean;
};

const PROGRAMS: ProgramSpec[] = [
  {
    title: "Acme Mobile Banking",
    description:
      "Bounty for the Acme Bank mobile apps and the API behind them. We pay most for account " +
      "takeover and anything that moves money.",
    inScope: ["mobile-api.acme.test", "Acme Bank iOS app", "Acme Bank Android app"],
    outOfScope: ["Third-party analytics SDKs"],
    tiers: [150, 600, 2_000, 6_000],
    path: ["ACTIVE"],
  },
  {
    title: "Acme Partner API",
    description:
      "Covers the API our logistics partners use to book and track shipments. Paused while we " +
      "migrate partners to v2.",
    inScope: ["partners.acme.test"],
    outOfScope: ["sandbox.partners.acme.test"],
    tiers: [100, 400, 1_200, 4_000],
    path: ["ACTIVE", "PAUSED"],
  },
  {
    title: "Acme Admin Console",
    description: "Internal console for support staff. Launching after the SSO rollout.",
    inScope: ["admin.acme.test"],
    outOfScope: [],
    tiers: [200, 800, 2_500, 8_000],
    path: [],
  },
  {
    title: "Northwind Checkout",
    description:
      "Hosted checkout and payments API for Northwind merchants. Card data never touches our " +
      "servers, so focus on logic flaws and access control.",
    inScope: ["checkout.northwind.test", "api.northwind.test"],
    outOfScope: ["status.northwind.test"],
    tiers: [200, 750, 2_500, 7_500],
    path: ["ACTIVE"],
  },
  {
    title: "Northwind Legacy Portal",
    description: "The old merchant portal. Closed after we retired it in September.",
    inScope: ["legacy.northwind.test"],
    outOfScope: [],
    tiers: [50, 200, 800, 2_000],
    path: ["ACTIVE", "CLOSED"],
  },
];

// Numbered as in the plan; the index + 1 is the report number used by duplicateOf and COMMENTS.
const REPORTS: ReportSpec[] = [
  {
    researcher: "riley",
    program: "WEB",
    title: "Stored XSS in support ticket subject",
    writeup: {
      summary:
        "The agent dashboard renders the ticket subject as HTML, so markup a customer puts in " +
        "the subject runs in the support agent's session.",
      steps: [
        "Sign in as a customer at app.acme.test and open a new support ticket.",
        "Put an HTML tag with an event handler in the subject and submit.",
        "Sign in as a support agent and open the ticket queue. The handler runs.",
      ],
      impact:
        "An attacker can act as any agent who opens the queue, including reading other " +
        "customers' tickets.",
    },
    triage: [{ status: "TRIAGING" }, { status: "ACCEPTED", severity: "HIGH" }],
    reward: true,
  },
  {
    researcher: "riley",
    program: "WEB",
    title: "IDOR on /api/invoices/:id exposes other customers' invoices",
    writeup: {
      summary:
        "GET /api/invoices/:id on api.acme.test checks that you are signed in but not that the " +
        "invoice belongs to you.",
      steps: [
        "Create two customer accounts, A and B, and place an order with each.",
        "Signed in as A, request the invoice id that belongs to B.",
        "The API returns B's invoice with name, address, and order lines.",
      ],
      impact:
        "Any signed-in customer can read any invoice. Invoice ids are sequential, so the whole " +
        "set can be listed.",
    },
    triage: [{ status: "TRIAGING" }, { status: "ACCEPTED", severity: "CRITICAL" }],
    reward: true,
  },
  {
    researcher: "riley",
    program: "WEB",
    title: "Open redirect through the login next parameter",
    writeup: {
      summary:
        "The login page at app.acme.test sends you to whatever URL the next parameter holds, " +
        "including other domains.",
      steps: [
        "Open the login page with next set to an external domain you control.",
        "Sign in with a test account.",
        "The browser lands on the external domain.",
      ],
      impact:
        "A phishing link can start on the real Acme login page and end on a lookalike site " +
        "after the victim signs in.",
    },
    triage: [{ status: "TRIAGING" }, { status: "NEEDS_INFO" }],
  },
  {
    researcher: "riley",
    program: "WEB",
    title: "Password reset endpoint has no rate limit",
    writeup: {
      summary:
        "POST /api/password-reset on api.acme.test accepts unlimited requests for the same " +
        "email address.",
      steps: [
        "Send 200 reset requests for your own test account in one minute.",
        "Every request returns 200, and your inbox receives 200 reset emails.",
      ],
      impact:
        "Anyone can flood a customer's inbox with reset emails and burn through the mail " +
        "provider's sending quota.",
    },
    triage: [],
  },
  {
    researcher: "riley",
    program: "WEB",
    title: "Clickjacking on the account settings page",
    writeup: {
      summary: "The account settings page on app.acme.test appears to load inside a frame.",
      steps: [
        "Create a local HTML page that frames the settings page.",
        "Open the local page while signed in to app.acme.test.",
      ],
      impact: "A framing page could trick a customer into changing account settings.",
    },
    triage: [
      {
        status: "REJECTED",
        note: "The settings page already sends frame-ancestors 'none'.",
      },
    ],
  },
  {
    researcher: "riley",
    program: "NWC",
    title: "CSRF on the saved payment method form",
    writeup: {
      summary:
        "The form that removes a saved payment method on checkout.northwind.test has no CSRF " +
        "token, and the session cookie goes out on cross-site requests.",
      steps: [
        "Sign in to checkout.northwind.test and save a test card.",
        "From another site, submit a form that posts to the remove-card endpoint.",
        "The saved card disappears from the account.",
      ],
      impact:
        "A malicious page can remove a shopper's saved cards and push them back to manual " +
        "entry at checkout.",
    },
    triage: [{ status: "TRIAGING" }],
  },
  {
    researcher: "sam",
    program: "WEB",
    title: "SQL injection in the order search filter",
    writeup: {
      summary:
        "The status filter on the order search page at app.acme.test reaches the SQL query " +
        "without parameter binding.",
      steps: [
        "Sign in as a customer and open order search.",
        "Change the status filter value in the request to text the app does not expect.",
        "The response contains a database error that quotes part of the query.",
      ],
      impact:
        "An attacker can read tables the order search query can reach, including other " +
        "customers' orders.",
    },
    triage: [{ status: "TRIAGING" }, { status: "ACCEPTED", severity: "MEDIUM" }],
  },
  {
    researcher: "sam",
    program: "WEB",
    title: "Script injection through the ticket subject field",
    writeup: {
      summary:
        "Markup in a support ticket subject runs when an agent views the ticket list on " +
        "app.acme.test.",
      steps: [
        "Open a support ticket with HTML in the subject.",
        "View the ticket queue as an agent.",
      ],
      impact: "An attacker can run script in a support agent's browser session.",
    },
    triage: [{ status: "DUPLICATE", duplicateOf: 1 }],
  },
  {
    researcher: "sam",
    program: "MOB",
    title: "Certificate pinning missing on the Android app",
    writeup: {
      summary:
        "The Acme Bank Android app trusts any certificate authority installed on the device " +
        "when it talks to mobile-api.acme.test.",
      steps: [
        "Install a user certificate authority on a test device.",
        "Route the device through an intercepting proxy that uses that authority.",
        "Sign in to the app. The proxy shows the API traffic in clear text.",
      ],
      impact:
        "On a device with a rogue authority installed, someone on the network can read and " +
        "change banking traffic.",
    },
    triage: [],
  },
  {
    researcher: "priya",
    program: "WEB",
    title: "Session stays valid after a password change",
    writeup: {
      summary:
        "Changing your password on app.acme.test leaves existing sessions on other devices " +
        "signed in.",
      steps: [
        "Sign in to the same test account in two browsers.",
        "Change the password in the first browser.",
        "Reload the second browser. It stays signed in and can still load account pages.",
      ],
      impact:
        "A customer who changes their password after a compromise does not lock out the " +
        "attacker's session.",
    },
    triage: [{ status: "TRIAGING" }, { status: "ACCEPTED", severity: "LOW" }],
    reward: true,
  },
  {
    researcher: "priya",
    program: "WEB",
    title: "Stack traces in 500 responses from the export API",
    writeup: {
      summary:
        "When an export fails, api.acme.test returns the full stack trace in the response " +
        "body.",
      steps: [
        "Request an export at /api/exports with an end date before the start date.",
        "The 500 response lists file paths, framework versions, and an internal hostname.",
      ],
      impact:
        "The trace hands an attacker the framework versions and internal layout they need to " +
        "plan other attacks.",
    },
    triage: [{ status: "TRIAGING" }],
  },
  {
    researcher: "priya",
    program: "NWC",
    title: "Webhook endpoint accepts unsigned events",
    writeup: {
      summary:
        "The payment webhook on api.northwind.test processes events with a missing or wrong " +
        "signature header.",
      steps: [
        "Send a payment.succeeded event for one of your test orders without a signature.",
        "The endpoint returns 200, and the order shows as paid.",
      ],
      impact: "Anyone who knows an order id can mark it paid without paying.",
    },
    triage: [],
  },
];

type CommentAuthor = "admin" | "owner" | "northwind" | "riley";

// Each comment posts after its report's triage, in this order.
const COMMENTS: { report: number; author: CommentAuthor; body: string }[] = [
  {
    report: 1,
    author: "owner",
    body: "We shipped escaping on the ticket subject this morning. Can you confirm the fix on your test account?",
  },
  { report: 1, author: "riley", body: "Confirmed. The payload now renders as text." },
  {
    report: 2,
    author: "admin",
    body: "Reproduced with two test customers. Rated Critical: any signed-in customer can read any invoice.",
  },
  {
    report: 3,
    author: "admin",
    body: "Which redirect targets did you test? Send the full login URL you used and the page you landed on.",
  },
  {
    report: 6,
    author: "northwind",
    body: "Our team is checking whether the SameSite cookie change from last week covers this.",
  },
  {
    report: 7,
    author: "admin",
    body: "Accepted as Medium. The injection works, but the query runs read-only against a replica.",
  },
  { report: 8, author: "admin", body: "Same root cause as an earlier report on this program." },
];

async function findOwnProgram(owner: Session, title: string) {
  const programs = await call<Program[]>(
    "GET",
    `/programs?mine=true&search=${encodeURIComponent(title)}`,
    { token: owner.token },
  );
  return programs.find((program) => program.title === title);
}

async function reward(admin: Session, reportId: string, label: string) {
  try {
    await call("POST", `/reports/${reportId}/reward`, { token: admin.token });
    return true;
  } catch (error) {
    const skippable = ["INSUFFICIENT_POOL", "ALREADY_REWARDED"];
    if (!(error instanceof RequestFailed && error.code && skippable.includes(error.code))) {
      throw error;
    }
    console.warn(`Skipped payout for ${label}: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log(`Seeding demo activity through ${API}`);
  const admin = await login("admin@bugbounty.dev", ADMIN_PASSWORD);
  const owner = await login("owner@bugbounty.dev", DEMO_PASSWORD);
  const riley = await login("researcher@bugbounty.dev", DEMO_PASSWORD);
  const northwind = await ensureAccount(
    "northwind@bugbounty.dev",
    "Northwind Labs",
    "PROGRAM_OWNER",
  );
  const sam = await ensureAccount("sam@bugbounty.dev", "Sam Okafor", "RESEARCHER");
  const priya = await ensureAccount("priya@bugbounty.dev", "Priya Nair", "RESEARCHER");

  if (await findOwnProgram(owner, "Acme Mobile Banking")) {
    console.log("Demo activity already present");
    return;
  }

  const web = await findOwnProgram(owner, "Acme Web Application");
  if (!web) throw new Error("Acme Web Application not found. Run `npm run db:seed` first.");

  const created: Record<string, Program> = {};
  for (const spec of PROGRAMS) {
    const programOwner = spec.title.startsWith("Northwind") ? northwind : owner;
    created[spec.title] = await createProgram(programOwner, spec);
  }
  const programIds = {
    WEB: web.id,
    MOB: created["Acme Mobile Banking"].id,
    NWC: created["Northwind Checkout"].id,
  };

  const researchers = { riley, sam, priya };
  const reportIds: string[] = [];
  for (const spec of REPORTS) {
    const report = await call<{ id: string }>("POST", "/reports", {
      token: researchers[spec.researcher].token,
      body: {
        programId: programIds[spec.program],
        title: spec.title,
        description: writeup(spec.writeup),
      },
    });
    reportIds.push(report.id);
  }

  const authors: Record<CommentAuthor, Session> = { admin, owner, northwind, riley };
  const finalStatus: Record<string, number> = {};
  for (const [index, spec] of REPORTS.entries()) {
    const id = reportIds[index];
    for (const step of spec.triage) {
      await call("PATCH", `/reports/${id}/status`, {
        token: admin.token,
        body: {
          status: step.status,
          ...(step.severity && { severity: step.severity }),
          ...(step.note && { note: step.note }),
          ...(step.duplicateOf && { duplicateOfId: reportIds[step.duplicateOf - 1] }),
        },
      });
    }
    for (const comment of COMMENTS.filter((c) => c.report === index + 1)) {
      await call("POST", `/reports/${id}/comments`, {
        token: authors[comment.author].token,
        body: { body: comment.body },
      });
    }
    const status = spec.triage.at(-1)?.status ?? "NEW";
    finalStatus[status] = (finalStatus[status] ?? 0) + 1;
  }

  for (const [index, spec] of REPORTS.entries()) {
    if (!spec.reward || !(await reward(admin, reportIds[index], `report #${index + 1}`))) continue;
    finalStatus.ACCEPTED -= 1;
    finalStatus.REWARDED = (finalStatus.REWARDED ?? 0) + 1;
  }

  const pool = await call<Program>("GET", `/programs/${web.id}`, { token: owner.token });
  console.log(`Programs created: ${PROGRAMS.length}`);
  console.log(`Reports by status: ${JSON.stringify(finalStatus)}`);
  console.log(`Acme Web Application pool: $${(pool.poolBalance / 100).toFixed(2)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
