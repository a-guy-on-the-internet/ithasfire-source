import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

const COORDINATE_URL =
  "https://ithasfire.com/volunteers/coordinate/00000000-0000-4000-8000-000000000010";
const COMPLETE_URL =
  "https://ithasfire.com/auth/complete?email=new%40example.org&src=volunteer-coordinator";

describe("volunteer.group_coordinator_assigned", () => {
  it("renders the registry sample", async () => {
    const out = await render({
      templateId: "volunteer.group_coordinator_assigned",
      props: sampleInputFor("volunteer.group_coordinator_assigned"),
    });
    expect(out.html).toContain("<html");
    expect(out.text.trim().length).toBeGreaterThan(0);
  });

  it("names the assigner, the group and the ask, and links to the coordinator view", async () => {
    const out = await render({
      templateId: "volunteer.group_coordinator_assigned",
      props: {
        assignerName: "Sam Rivera",
        groupName: "Flyer crew",
        askTitle: "Street team",
        coordinateUrl: COORDINATE_URL,
        accountCompletionUrl: null,
      },
    });
    expect(out.subject).toBe(
      "Sam Rivera made you coordinator of Flyer crew for Street team",
    );
    expect(out.html).toContain("Sam Rivera");
    expect(out.html).toContain("Flyer crew");
    expect(out.html).toContain("Street team");
    expect(out.html).toContain(`href="${COORDINATE_URL}"`);
    expect(out.html).toContain("Open your group");
    expect(out.html).not.toContain("Create your account");
    // Calm copy: informational, no urgency.
    expect(out.html).not.toMatch(/urgent|expires|deadline|act now|hurry|asap/i);
  });

  it("omits the assigner cleanly when there is no display name", async () => {
    const out = await render({
      templateId: "volunteer.group_coordinator_assigned",
      props: {
        assignerName: null,
        groupName: "Flyer crew",
        askTitle: "Street team",
        coordinateUrl: COORDINATE_URL,
      },
    });
    expect(out.subject).toBe("You're now coordinating Flyer crew for Street team");
    expect(out.html).not.toContain("Assigned by");
    expect(out.html).not.toContain("null");
  });

  it("shows the create-account step for an invited coordinator without an account", async () => {
    const out = await render({
      templateId: "volunteer.group_coordinator_assigned",
      props: {
        assignerName: "Sam Rivera",
        groupName: "Flyer crew",
        askTitle: "Street team",
        coordinateUrl: COORDINATE_URL,
        accountCompletionUrl: COMPLETE_URL,
      },
    });
    expect(out.html).toContain("Create your account");
    expect(out.html).toContain(
      `href="${COMPLETE_URL.replace(/&/g, "&amp;")}"`,
    );
    // Completion doesn't redirect to the group, so the group link is there
    // too as a secondary text link.
    expect(out.html).toContain(`href="${COORDINATE_URL}"`);
    expect(out.html).not.toContain("Open your group");
  });

  it("escapes a hostile assigner name instead of rendering markup", async () => {
    const out = await render({
      templateId: "volunteer.group_coordinator_assigned",
      props: {
        assignerName: "<script>alert(1)</script>",
        groupName: "Flyer crew",
        askTitle: "Street team",
        coordinateUrl: COORDINATE_URL,
      },
    });
    expect(out.html).not.toContain("<script>alert(1)</script>");
  });
});
