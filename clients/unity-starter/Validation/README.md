# Unity 6 validation package (not part of the runtime)

This folder checks that the Unity-only adapter (`FarmSceneLoader.ApplySnapshotPlan`) compiles and
behaves in Unity 6, using the verified sync from `Runtime/Core`. It is **not** shipped code:

- Its assembly (`Metafarm.Twin.Validation.asmdef`) compiles only when the scripting define
  `METAFARM_TWIN_VALIDATION` is set, and nothing references it (`autoReferenced: false`).
- It reads bundled samples through `SampleTransport`: no network, no tokens, no writes.
- `Engine/` (the step runner) has no Unity references and is built and tested in CI against a model
  scene (`ValidationRunnerTests`). `Unity/TwinValidationHarness.cs` needs the editor and is **not**
  compiled by CI.

**Status: Editor and IL2CPP player validation are pending** until someone runs the steps below
and records the result.

## Setup (once)

1. Unity 6 (6000.0 LTS or later), a new project from the **Universal 3D (URP)** template.
2. Package Manager → *Add package by name* → `com.unity.nuget.newtonsoft-json`.
3. Copy into the project:
   - `Runtime/` → `Assets/Metafarm/Twin/Runtime/`
   - `Validation/` → `Assets/Metafarm/Twin/Validation/` (including the `.asmdef`)
   - these files from `Samples/` → `Assets/Metafarm/Twin/Samples/` (byte for byte; do not open
     and re-save them, their SHA-256 is checked): `scene.sample.json`,
     `sync-commitments.sample.json`, `sync-a.content.sample.json` … `sync-f.content.sample.json`
4. *Project Settings → Player → Other Settings → Scripting Define Symbols*: add
   `METAFARM_TWIN_VALIDATION` for the platform you will test (Standalone at least). Apply.
5. New scene. Add an empty GameObject `Validation` with **Twin Validation Harness**. Drag the eight
   sample TextAssets into **Samples**. Leave **Run On Start** on. Save the scene and add it to
   *Build Settings → Scenes In Build* (only this scene).

## A. Compile gate (Editor)

- After the import and the define, the Console shows **0 errors and 0 warnings** from
  `Metafarm.Twin.Core`, `Metafarm.Twin.Unity` and `Metafarm.Twin.Validation`.
- Without the define, `Metafarm.Twin.Validation` is not compiled at all (expected).

## B. Editor run

Press Play. The Console shows one line per step, then a summary:

```
TWIN-VALIDATION START Unity 6000.x, …, Editor
TWIN-VALIDATION PASS 1 Load scene
TWIN-VALIDATION PASS 2 Initial A
TWIN-VALIDATION PASS 3 Updated B (mixed diff)
TWIN-VALIDATION PASS 4 UpToDate (same record again)
TWIN-VALIDATION PASS 5 Rollback (A while holding B)
TWIN-VALIDATION PASS 6 Conflict (C while holding B)
TWIN-VALIDATION PASS 7 Asset gain (4a: D after A)
TWIN-VALIDATION PASS 8 Asset loss (4b: E after A)
TWIN-VALIDATION PASS 9 Kind change (4c: F after A)
TWIN-VALIDATION ALL PASSED (9/9)
```

What each step checks: the sync outcome, the exact scene operations, that the drawn object ids match
an independent expectation, and on the next frame (after deferred `Destroy`) that the loader has one
GameObject per drawn id, no duplicate markers and exactly one boundary. Steps 5 and 6 also check that
a refused candidate changes neither the held state nor the scene. *Run validation* in the
component's context menu runs it again.

Pass: the summary line says `ALL PASSED (9/9)` and there are no exceptions in the Console.

## C. IL2CPP player run

1. *Player → Other Settings → Scripting Backend*: **IL2CPP**; keep the default *Managed Stripping
   Level*. Tick **Quit When Done** on the harness.
2. Build and run a **Development Build** for your desktop platform.
3. Open the player log (*Help → Open Player Log* paths: Windows
   `%USERPROFILE%\AppData\LocalLow\<company>\<product>\Player.log`, macOS
   `~/Library/Logs/<company>/<product>/Player.log`, Linux `~/.config/unity3d/<company>/<product>/Player.log`)
   and find the `TWIN-VALIDATION` lines. The process exits 0 when every step passed, 1 otherwise.

If steps fail only in the player with missing members or empty models, IL2CPP stripped fields that
Newtonsoft sets by reflection: add `Assets/link.xml` with
`<linker><assembly fullname="Metafarm.Twin.Core" preserve="all"/></linker>`, rebuild, and record
that it was needed.

## Record the result

| Item | Value |
| --- | --- |
| Unity version / platform / backend | |
| A. Compile gate (0 errors, 0 warnings) | pass / fail |
| B. Editor run (9/9) | pass / fail, failing steps |
| C. IL2CPP player run (9/9, exit 0) | pass / fail, link.xml needed? |
| Screenshots | hierarchy after step 3 and step 9 (*Run validation*, pause after the step) |

Until this table is filled in from an actual run, the Unity adapter is **unvalidated**.
