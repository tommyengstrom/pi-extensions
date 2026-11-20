---
label: UI comparison
description: Compare a screenshot of the running app with a proposed mockup
---

# [Plan title]
<!-- Name the view and the proposed change. Ask for the running URL, viewport and relevant screen state unless already known. Never start the app or edit project code to stage a picture. -->

## Goal
<!-- Describe the problem and success criterion. At most 250 characters. -->

## Visual comparison
<!-- Use only explicitly permitted tools. Capture the running page with a browser screenshot tool that saves a local PNG or JPEG, outside the project (for example, Playwright MCP browser_take_screenshot with a local output directory). Inspect the screenshot. Never use a generated reconstruction as evidence of today's UI.
Before generating a mockup, explain that the screenshot will be sent to the image provider and that generation uses image quota. Obtain the user's consent before sending it. With consent and an available, permitted codex_generate_image, pass the screenshot in referencedImagePaths, request PNG and save globally. Keep the viewport and screen state the same; change only the proposed UI. Inspect the result.
Call plan_mode_import_visual directly and alone for each finished file: role before for the real screenshot, after for the mockup. Under the captions below paste only the exact returned links. This confined copy is not permission for other writes. If the app is unreachable, a required tool or permission is missing, or an image cannot be verified, ask for the specific missing file/permission or agreement to proceed without it. Note agreed omissions in words; never invent a picture or publish a placeholder link. -->
**Current — screenshot**

**Proposed — mockup**

<!-- Add a sentence telling the reader exactly what to compare. -->

## Changes
<!-- Describe the implementation decisions, accessibility implications and scope of the proposed change. -->

## Verification
<!-- State how to check the change at the same viewport and state. Include a rough range of changed lines (additions plus deletions across source, tests and docs); update it if scope changes materially. -->
