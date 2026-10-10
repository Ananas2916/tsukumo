# An optional body for Tsukumo

Tsukumo is a flame and needs nothing here. If you want to give her a VRM body
she can enter and leave, copy a `.vrm` file into this folder and call it
**`avatar.vrm`**:

```
frontend/public/models/avatar.vrm
```

If the name is different, the backend still takes the first `.vrm` it finds in
here (see `GET /api/config` -> `avatar.default`). You can also drag a `.vrm`
straight onto the window to load it on the fly.

## Where to get a model

- **VRoid Studio** (free, Windows/macOS): create your own character and
  export it as VRM.
- **VRoid Hub** / **Booth**: models by other authors. Always check the
  licence: many forbid commercial use or modifications.

## Model requirements

Lip-sync needs the mouth blendshapes. VRoid models already have them:

| Viseme | VRM 0.x (morph target) | VRM 1.0 (expression preset) |
|--------|------------------------|-----------------------------|
| A      | `fcl_mth_a`            | `aa`                        |
| I      | `fcl_mth_i`            | `ih`                        |
| U      | `fcl_mth_u`            | `ou`                        |
| E      | `fcl_mth_e`            | `ee`                        |
| O      | `fcl_mth_o`            | `oh`                        |

The renderer uses the preset expressions when they exist, otherwise it drives
the `fcl_mth_*` morph targets directly. If both are missing, the avatar is
still shown: it just doesn't move its mouth.
