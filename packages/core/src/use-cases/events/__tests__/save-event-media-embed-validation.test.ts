import { describe, expect, it } from "vitest";

import { saveEventForHuman } from "../save-event-for-human";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";

const baseContent = (richTextDoc: unknown) => ({
  version: 1,
  sections: [
    {
      id: "sec-1",
      kind: "section",
      style: {
        background: "default",
        density: "normal",
        maxWidth: "prose",
        textAlign: "left",
      },
      layout: {
        type: "singleColumn",
        columns: [
          {
            blocks: [{ type: "richText", id: "blk-1", doc: richTextDoc }],
          },
        ],
      },
    },
  ],
});

const validYouTubeNode = {
  type: "mediaEmbed",
  attrs: {
    provider: "youtube",
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    externalId: "dQw4w9WgXcQ",
    renderMode: "iframe",
    kind: "video",
    aspectRatio: "16/9",
  },
};

function makeInput(content: unknown) {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    title: "Embed Test",
    startsAt: "2024-02-01T18:00:00.000Z",
    endsAt: "2024-02-01T19:00:00.000Z",
    location: { placeId: DEFAULT_PLACE_ID },
    clientKey: "embed-test-key-123",
    content,
  };
}

describe("save-event mediaEmbed validation", () => {
  it("accepts a body containing a valid YouTube embed", async () => {
    const { deps } = makeCreateEventTestContext();
    const content = baseContent({ type: "doc", content: [validYouTubeNode] });
    await expect(
      saveEventForHuman(deps, makeInput(content)),
    ).resolves.toBeDefined();
  });

  it("rejects a mediaEmbed with a sourceUrl outside the provider allowlist", async () => {
    const { deps } = makeCreateEventTestContext();
    const evilNode = {
      type: "mediaEmbed",
      attrs: {
        provider: "youtube",
        sourceUrl: "https://evil.com/watch?v=dQw4w9WgXcQ",
        embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        externalId: "dQw4w9WgXcQ",
        renderMode: "iframe",
      },
    };
    const content = baseContent({ type: "doc", content: [evilNode] });
    await expect(
      saveEventForHuman(deps, makeInput(content)),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects a mediaEmbed where embedUrl does not match parseEmbedUrl(sourceUrl)", async () => {
    const { deps } = makeCreateEventTestContext();
    const tamperedNode = {
      type: "mediaEmbed",
      attrs: {
        provider: "youtube",
        sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        // Tampered: claims YouTube but the embedUrl is wrong (different id).
        embedUrl: "https://www.youtube-nocookie.com/embed/aaaaaaaaaaa",
        externalId: "dQw4w9WgXcQ",
        renderMode: "iframe",
      },
    };
    const content = baseContent({ type: "doc", content: [tamperedNode] });
    await expect(
      saveEventForHuman(deps, makeInput(content)),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects a mediaEmbed missing required attrs (strict schema)", async () => {
    const { deps } = makeCreateEventTestContext();
    const missingAttrsNode = {
      type: "mediaEmbed",
      attrs: { provider: "youtube" },
    };
    const content = baseContent({ type: "doc", content: [missingAttrsNode] });
    await expect(
      saveEventForHuman(deps, makeInput(content)),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects a mediaEmbed where sourceUrl is not canonical", async () => {
    const { deps } = makeCreateEventTestContext();
    const nonCanonicalNode = {
      type: "mediaEmbed",
      attrs: {
        provider: "youtube",
        sourceUrl:
          "http://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=newsletter",
        embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        externalId: "dQw4w9WgXcQ",
        renderMode: "iframe",
      },
    };
    const content = baseContent({ type: "doc", content: [nonCanonicalNode] });
    await expect(
      saveEventForHuman(deps, makeInput(content)),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects a malformed nested mediaEmbed node", async () => {
    const { deps } = makeCreateEventTestContext();
    const content = baseContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mediaEmbed", attrs: { provider: "youtube" } }],
        },
      ],
    });
    await expect(
      saveEventForHuman(deps, makeInput(content)),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("rejects an extreme saved aspect ratio", async () => {
    const { deps } = makeCreateEventTestContext();
    const content = baseContent({
      type: "doc",
      content: [
        {
          ...validYouTubeNode,
          attrs: { ...validYouTubeNode.attrs, aspectRatio: "1/9999999999" },
        },
      ],
    });
    await expect(
      saveEventForHuman(deps, makeInput(content)),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
