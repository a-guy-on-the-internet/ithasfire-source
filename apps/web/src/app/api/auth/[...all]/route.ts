import { NextResponse, type NextRequest } from "next/server";

// This route exists to satisfy Next's generated type validator, but Ithas Fire's
// web client is configured to call Better Auth on the Fastify API directly.
//
// If you hit this route in dev, it's almost certainly a misconfiguration.
const notImplemented = (request: NextRequest) =>
  NextResponse.json(
    {
      error: "not_implemented",
      message:
        "Auth routes are served by the Fastify API. Configure the client to use the API base URL (e.g. http://localhost:3001/api/auth).",
      path: request.nextUrl.pathname,
    },
    { status: 501 },
  );

export const GET = notImplemented;
export const POST = notImplemented;
