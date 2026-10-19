/**
 * Sample data for the EventDetails email template storybook.
 * These samples demonstrate different configurations and content styles.
 */

import type { EventDetailsProps } from "../templates/EventDetails";

// Basic event - minimal info
export const basicEvent: EventDetailsProps = {
  eventTitle: "Tech Meetup",
  startsAtISO: "2025-03-15T18:00:00.000Z",
  eventUrl: "https://ithasfire.com/e/tech-meetup",
};

// Full event with all fields populated
export const fullEvent: EventDetailsProps = {
  eventTitle: "Sunset Session Vol. 03",
  startsAtISO: "2025-09-20T18:00:00.000Z",
  endsAtISO: "2025-09-20T23:00:00.000Z",
  timezone: "America/Los_Angeles",
  descriptionDoc: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Join us for an unforgettable evening at the rooftop space overlooking the city skyline.",
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "What to Expect" }],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Live DJ sets from " },
                  {
                    type: "text",
                    text: "local artists",
                    marks: [{ type: "bold" }],
                  },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Signature cocktails and food trucks" },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Golden hour photo opportunities" },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Doors open at 6pm. " },
          { type: "text", text: "21+ only", marks: [{ type: "italic" }] },
          { type: "text", text: ". Valid ID required." },
        ],
      },
    ],
  },
  venueName: "Skyline Rooftop",
  addressText: "123 Harbor Blvd, San Francisco, CA 94111",
  heroImageUrl:
    "https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?w=600&h=300&fit=crop",
  eventUrl: "https://ithasfire.com/e/sunset-session-vol-03",
  organizerName: "Sunset Collective",
};

// Conference with long description
export const conferenceEvent: EventDetailsProps = {
  eventTitle: "DevConf 2025: Building the Future",
  startsAtISO: "2025-06-12T09:00:00.000Z",
  endsAtISO: "2025-06-14T18:00:00.000Z",
  timezone: "America/New_York",
  descriptionDoc: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "DevConf is the premier developer conference bringing together the brightest minds in software engineering.",
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Conference Tracks" }],
      },
      {
        type: "orderedList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "AI & Machine Learning",
                    marks: [{ type: "bold" }],
                  },
                  {
                    type: "text",
                    text: " - Practical applications of generative AI",
                  },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Cloud Infrastructure",
                    marks: [{ type: "bold" }],
                  },
                  { type: "text", text: " - Scaling to billions of users" },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Developer Experience",
                    marks: [{ type: "bold" }],
                  },
                  { type: "text", text: " - Building tools developers love" },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Important Information" }],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Registration includes access to all sessions, workshops, and the networking dinner. ",
          },
          {
            type: "text",
            text: "Early bird pricing ends May 1st.",
            marks: [{ type: "bold" }],
          },
        ],
      },
      {
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: '"The best investment you can make is in your own knowledge." - Conference Motto',
                marks: [{ type: "italic" }],
              },
            ],
          },
        ],
      },
    ],
  },
  venueName: "Convention Center",
  addressText: "100 Convention Way, Boston, MA 02210",
  heroImageUrl:
    "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=600&h=300&fit=crop",
  eventUrl: "https://ithasfire.com/e/devconf-2025",
  organizerName: "DevConf Foundation",
};

// Music festival with links
export const musicFestival: EventDetailsProps = {
  eventTitle: "Summer Vibes Festival",
  startsAtISO: "2025-07-04T12:00:00.000Z",
  endsAtISO: "2025-07-06T23:59:00.000Z",
  timezone: "America/Chicago",
  descriptionDoc: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Three days of non-stop music, art, and celebration in the heart of the city.",
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Featured Artists" }],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Headliners include " },
          {
            type: "text",
            text: "The Midnight Echo",
            marks: [{ type: "bold" }],
          },
          { type: "text", text: ", " },
          { type: "text", text: "Neon Dreams", marks: [{ type: "bold" }] },
          { type: "text", text: ", and " },
          { type: "text", text: "Cosmic Groove", marks: [{ type: "bold" }] },
          { type: "text", text: ". Full lineup at " },
          {
            type: "text",
            text: "summervibes.com",
            marks: [
              {
                type: "link",
                attrs: { href: "https://summervibes.com/lineup" },
              },
            ],
          },
          { type: "text", text: "." },
        ],
      },
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: "What to Bring" }],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Sunscreen and sunglasses" }],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Comfortable shoes" }],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Valid photo ID" }],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Positive vibes only!" }],
              },
            ],
          },
        ],
      },
    ],
  },
  venueName: "Grant Park",
  addressText: "337 E. Randolph St, Chicago, IL 60601",
  heroImageUrl:
    "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=600&h=300&fit=crop",
  eventUrl: "https://ithasfire.com/e/summer-vibes-2025",
  organizerName: "Summer Vibes Productions",
};

// Simple workshop - no image, minimal description
export const workshopEvent: EventDetailsProps = {
  eventTitle: "Introduction to Pottery",
  startsAtISO: "2025-04-10T14:00:00.000Z",
  endsAtISO: "2025-04-10T17:00:00.000Z",
  timezone: "America/Denver",
  descriptionDoc: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Learn the basics of wheel throwing in this hands-on workshop. All materials provided. No experience necessary.",
          },
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Please wear clothes you don't mind getting dirty. ",
          },
          {
            type: "text",
            text: "Limited to 8 participants.",
            marks: [{ type: "italic" }],
          },
        ],
      },
    ],
  },
  venueName: "The Clay Studio",
  addressText: "456 Art District Lane, Denver, CO 80205",
  eventUrl: "https://ithasfire.com/e/pottery-workshop",
  organizerName: "The Clay Studio",
};

// Virtual event - no venue
export const virtualEvent: EventDetailsProps = {
  eventTitle: "Remote Work Masterclass",
  startsAtISO: "2025-05-20T17:00:00.000Z",
  endsAtISO: "2025-05-20T19:00:00.000Z",
  timezone: "UTC",
  descriptionDoc: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Join us online for a comprehensive guide to thriving in a remote work environment.",
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Topics Covered" }],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Setting up your home office" },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Time management techniques" }],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Async communication best practices" },
                ],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Work-life balance strategies" },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "A Zoom link will be sent 24 hours before the event.",
          },
        ],
      },
    ],
  },
  eventUrl: "https://ithasfire.com/e/remote-work-masterclass",
  organizerName: "Future of Work Institute",
};

export const allSamples = {
  basic: basicEvent,
  full: fullEvent,
  conference: conferenceEvent,
  festival: musicFestival,
  workshop: workshopEvent,
  virtual: virtualEvent,
};
