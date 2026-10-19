/**
 * Calling the jobs service from the API: `POST <jobsServiceUrl>/jobs/<name>`.
 *
 * TWO gates stand in front of that route on Cloud Run, and both must pass:
 *
 *  1. Cloud Run IAM. The jobs service is not public; only service accounts
 *     with `roles/run.invoker` get through (the API runtime SA is one —
 *     `invoker_service_accounts.apiProxy` in infra/terraform/main.tf). IAM
 *     reads ONLY a Google-signed OIDC identity token in `Authorization`,
 *     minted here from the metadata server for the jobs service audience.
 *  2. The jobs app's own hook (`apps/jobs/src/app.ts`): the shared
 *     `X-Jobs-API-Key` header.
 *
 * `Authorization: Bearer <JOBS_API_KEY>` — what announcements and the CSV
 * export used to send — satisfies (2) but is not a Google token, so IAM
 * rejects it before the app ever sees it. Same scheme as the staff jobs
 * proxy (`routers/platform-jobs.ts`). Off GCP the metadata server is
 * unreachable, the token is omitted, and the local (IAM-less) jobs service
 * accepts the API key header alone.
 */

const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

export type JobsServiceRequestOptions = {
  /** Defaults to `process.env.JOBS_API_KEY`. */
  apiKey?: string | null;
  /** Test seam. */
  fetchImpl?: typeof fetch;
};

async function metadataIdToken(
  audience: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(
      `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}`,
      {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (!res.ok) return null;
    return (await res.text()).trim() || null;
  } catch {
    // Not on GCP (local dev).
    return null;
  }
}

/** Headers that get a request past Cloud Run IAM and the jobs app's key check. */
export async function jobsServiceHeaders(
  jobsServiceUrl: string,
  options: JobsServiceRequestOptions = {},
): Promise<Record<string, string>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey =
    options.apiKey === undefined
      ? (process.env.JOBS_API_KEY ?? null)
      : options.apiKey;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["X-Jobs-API-Key"] = apiKey;
  const audience = jobsServiceUrl.replace(/\/+$/, "");
  const idToken = await metadataIdToken(audience, fetchImpl);
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  return headers;
}

/** POST a job run to the jobs service. Returns the raw Response. */
export async function postJobToJobsService(
  jobsServiceUrl: string,
  jobName: string,
  payload: unknown,
  options: JobsServiceRequestOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = jobsServiceUrl.replace(/\/+$/, "");
  return fetchImpl(`${base}/jobs/${encodeURIComponent(jobName)}`, {
    method: "POST",
    headers: await jobsServiceHeaders(base, options),
    body: JSON.stringify(payload),
  });
}
