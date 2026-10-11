# Example wadspaces

Two real wadspaces as the Builder keeps them: each `layers.json` holds the
template, the customization (when there is one) and the wadspace documents,
as `crates/wad-core/src/layers.rs` reads them.

| Example | Template | Customization | The wadspace |
|---|---|---|---|
| `cosmic-bodybuilding` | Writing (Obsidian) | none | its own background and the Writing project; Obsidian's sign-in isn't saved |
| `vanua-academy` | Dev (WadBrowser, VS Code) | VanuaAcademy Dev: Claude Code, the Firebase CLI, seven web apps | the VanuaAcademy project and named saved sign-ins, two of them shared (one Google sign-in for Firebase and Cloud, the Workspace one for Gmail, Drive and Workspace) |

```bash
images/build.sh --example vanua-academy   # the Dev template's image, then VanuaAcademy Dev's
```

`cargo xtask layer <layers.json> <dir>` writes the build folders (as wadd
would, without the web apps' icons, which wadd fetches from their sites),
and build.sh builds them with wadd's tags and labels, so wadd counts them as
built. The wadspace documents name projects by the ids your account gives
them, so `projects` here are placeholders.
