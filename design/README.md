# Design references

- Figma: https://www.figma.com/design/tPnpJCsmVqqYXYi55P8cO5/AIM---Charity-Directory?node-id=0-1&p=f
- Export the **desktop** and **mobile** frames as PNG into this folder (`desktop.png`, `mobile.png`).
- `preview-data/` is a build of the real Airtable rows with the *Website ready?* requirement switched off
  (`node scripts/build.mjs --ignore-ready`). It exists so the widget can be designed against real content
  while logos and founder photos are still being added. It is never deployed; `public/` is.
