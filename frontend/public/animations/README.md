# `.vrma` animations

Put VRM Animation clips (`.vrma`) here: when Tsukumo is in her VRM body she
blends them with her procedural motion (breathing, weight and gaze stay
hers). The file name says when to use them:

| Name | When |
|------|------|
| `greet*.vrma` (or `wave*`, `hello*`) | instead of the hand wave, when she appears or when you come back |
| `idle*.vrma` | now and then, among the spontaneous gestures (standing) |
| `dance*.vrma` | looping while Spotify plays, if "Dance to Spotify" is on |
| `inchino*.vrma` (or `bow*`) | when you thank her ("thanks", "grazie"...), and from the panel |
| `alza*.vrma` (or `here*`, `raise*`) | when you call her by name in wake-word mode, and from the panel |
| all the others | on request, from the buttons in Character → Make her do something |

Only the bone rotations are used: the clip's hip movement and expressions are
ignored, so the character doesn't leave the window and the face stays the
lip-sync's. Standing clips work best: sitting or lying down they don't start.

The flame doesn't use clips: they only apply to the optional VRM body.

## From any BVH

```
node scripts/bvh2vrma.mjs clip.bvh frontend/public/animations/greet-mine.vrma --trim
```

It recognizes Bandai Namco, Mixamo and CMU skeletons and the most common
names, and brings the clip to T-pose whatever the BVH's rest pose is (the first
frame must be the actor standing still). `--trim` removes the still wait
before and after the gesture; normally she keeps facing you even if the actor
turned, `--free-facing` avoids that.

Other sources: VRoid's (pixiv) free VRMA animation pack, or clips converted
from other formats. Check each one's licence: the `.vrma` files in this folder
never end up in the repository.

After adding or removing files, restart Tsukumo (or reload the character).
